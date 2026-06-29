import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { networkInterfaces } from 'os'
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { getDb } from './db'
import * as projects from './projects'
import * as knowledge from './knowledge'
import { defaultChatModel, listModels, streamChat, streamCloudChat, type ChatMessage } from './ollama'
import { GLOBAL_PROJECT_ID, GLOBAL_PROJECT_NAME, isGlobalProjectId } from '../shared/globalWorkspace'
import { fallbackTitleFromText, isGenericSessionTitle } from '../shared/sessionTitles'

type HostMode = 'local' | 'private'

export interface WebCompanionConfig {
  enabled: boolean
  hostMode: HostMode
  port: number
}

export interface WebCompanionStatus extends WebCompanionConfig {
  running: boolean
  bindHost: string
  localUrl: string
  privateUrls: string[]
  tokenConfigured: boolean
  tokenMasked: string | null
  error: string | null
}

const META = {
  enabled: 'web_companion_enabled',
  hostMode: 'web_companion_host_mode',
  port: 'web_companion_port',
  token: 'web_companion_token',
}

const DEFAULT_PORT = 8765
const MAX_BODY_BYTES = 64 * 1024

let server: Server | null = null
let runningConfig: WebCompanionConfig | null = null
let lastError: string | null = null
const chatAborts = new Map<string, AbortController>()

function readMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function writeMeta(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(key, value)
}

function readConfig(): WebCompanionConfig {
  const envEnabled = process.env.AIWORKSPACE_WEB_COMPANION === '1'
  const enabled = envEnabled || readMeta(META.enabled) === 'true'
  const rawMode = readMeta(META.hostMode)
  const hostMode: HostMode = rawMode === 'private' ? 'private' : 'local'
  const rawPort = Number(readMeta(META.port) ?? DEFAULT_PORT)
  const port = Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535 ? rawPort : DEFAULT_PORT
  return { enabled, hostMode, port }
}

function bindHost(mode: HostMode): string {
  return mode === 'private' ? '0.0.0.0' : '127.0.0.1'
}

function getToken(): string | null {
  return readMeta(META.token)
}

function ensureToken(): string {
  const existing = getToken()
  if (existing) return existing
  const token = randomBytes(24).toString('base64url')
  writeMeta(META.token, token)
  return token
}

function maskToken(token: string | null): string | null {
  if (!token) return null
  return `${token.slice(0, 4)}...${token.slice(-4)}`
}

function safeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function localUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

function privateUrls(port: number): string[] {
  const urls: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      urls.push(`http://${entry.address}:${port}`)
    }
  }
  return urls
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function bearer(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

function isAuthed(req: IncomingMessage): boolean {
  const token = getToken()
  const presented = bearer(req)
  return Boolean(token && presented && safeCompare(presented, token))
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAuthed(req)) return true
  sendJson(res, 401, { error: 'Authentication required' })
  return false
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
}

function safeProject(projectId: string | null | undefined): string {
  if (!projectId || isGlobalProjectId(projectId)) {
    projects.ensureGlobalProject()
    return GLOBAL_PROJECT_ID
  }
  const row = getDb().prepare('SELECT id FROM projects WHERE id = ? AND status = ?').get(projectId, 'active') as
    | { id: string }
    | undefined
  if (!row) throw new Error('Unknown project')
  return row.id
}

function assertChatSession(sessionId: string, projectId?: string): void {
  const row = getDb().prepare('SELECT id, project_id, mode FROM sessions WHERE id = ?').get(sessionId) as
    | { id: string; project_id: string; mode: string }
    | undefined
  if (!row || row.mode !== 'chat') throw new Error('Unknown chat session')
  if (projectId && row.project_id !== projectId) throw new Error('Session does not belong to this project')
}

function serializeMessage(row: any) {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    role: String(row.role),
    content: String(row.content),
    model: row.model ? String(row.model) : null,
    created_at: Number(row.created_at),
  }
}

function buildSystemPrompt(content: string, contextBlock: string): string {
  return [
    'You are the Chat mode of AI Workspace, a local-first workspace for planning, research, and preparing work.',
    'Be concrete, useful, and clear. Ask clarifying questions when needed.',
    'Use the provided workspace knowledge when it is relevant, and do not claim access to files or tools that are not exposed in this web companion.',
    '',
    contextBlock,
    '',
    `Current user message: ${content}`,
  ].filter(Boolean).join('\n')
}

async function handleChatSend(body: any, res: ServerResponse): Promise<void> {
  const projectId = safeProject(String(body.projectId ?? GLOBAL_PROJECT_ID))
  const sessionId = String(body.sessionId ?? '')
  const content = String(body.content ?? '').trim()
  let model = String(body.model ?? '').trim()
  if (!sessionId || !content) throw new Error('sessionId and content are required')
  assertChatSession(sessionId, projectId)
  if (!model) model = await defaultChatModel() ?? ''
  if (!model) throw new Error('No chat model is available. Start Ollama or configure a model first.')

  const db = getDb()
  const now = Date.now()
  const prior = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`).get(sessionId) as { n: number }
  db.prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), sessionId, 'user', content, null, now)
  if (prior.n === 0) {
    db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(fallbackTitleFromText(content), sessionId)
  }

  const memories = await knowledge.searchMemory(content, 'project', projectId, 5)
  const contextBlock =
    memories.length > 0
      ? `Relevant project knowledge:\n${memories.map((m) => `- [${m.type}] ${m.title}: ${m.content}`).join('\n')}`
      : ''
  const history = db
    .prepare(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId) as ChatMessage[]
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(content, contextBlock) },
    ...history,
  ]

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  })
  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  const controller = new AbortController()
  chatAborts.set(sessionId, controller)
  let full = ''
  try {
    const isCloud = model.startsWith('cloud:')
    if (isCloud) {
      const keyRow = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('ollama_cloud_key') as { value: string } | undefined
      const apiKey = keyRow?.value ?? ''
      if (!apiKey) throw new Error('Ollama Cloud is not configured.')
      for await (const token of streamCloudChat(model.slice(6), messages, apiKey, controller.signal)) {
        full += token
        sendEvent('token', { token })
      }
    } else {
      for await (const token of streamChat(model, messages, controller.signal)) {
        full += token
        sendEvent('token', { token })
      }
    }
  } catch (e: any) {
    if (!controller.signal.aborted) {
      sendEvent('error', { error: String(e?.message ?? e) })
      return
    }
  } finally {
    chatAborts.delete(sessionId)
  }

  if (full.trim()) {
    db.prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), sessionId, 'assistant', full, model, Date.now())
  }
  sendEvent('done', { sessionId })
  res.end()
}

async function routeApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = parseUrl(req)
  const path = url.pathname

  if (req.method === 'GET' && path === '/api/status') {
    const status = getWebCompanionStatus()
    sendJson(res, 200, {
      running: status.running,
      hostMode: status.hostMode,
      localUrl: status.localUrl,
      privateUrls: status.hostMode === 'private' ? status.privateUrls : [],
      requiresAuth: true,
    })
    return
  }

  if (req.method === 'POST' && path === '/api/login') {
    const body = await readBody(req)
    const token = getToken()
    if (token && safeCompare(String(body.token ?? ''), token)) {
      sendJson(res, 200, { ok: true, token: body.token })
    } else {
      sendJson(res, 401, { error: 'Invalid access token' })
    }
    return
  }

  if (!requireAuth(req, res)) return

  if (req.method === 'GET' && path === '/api/projects') {
    const rows = projects.listProjects().filter((p) => p.status === 'active')
    sendJson(res, 200, {
      projects: [
        { id: GLOBAL_PROJECT_ID, name: GLOBAL_PROJECT_NAME, kind: 'global' },
        ...rows.map((p) => ({ id: p.id, name: p.name, kind: 'project' })),
      ],
    })
    return
  }

  if (req.method === 'GET' && path === '/api/models') {
    const models = await listModels()
    sendJson(res, 200, { models: models.filter((m) => !m.includes('embed')) })
    return
  }

  if (req.method === 'GET' && path === '/api/chat/sessions') {
    const projectId = safeProject(url.searchParams.get('projectId'))
    const rows = getDb()
      .prepare(`SELECT * FROM sessions WHERE project_id = ? AND mode = 'chat' ORDER BY created_at DESC`)
      .all(projectId)
    sendJson(res, 200, { sessions: rows })
    return
  }

  if (req.method === 'POST' && path === '/api/chat/sessions') {
    const body = await readBody(req)
    const projectId = safeProject(String(body.projectId ?? GLOBAL_PROJECT_ID))
    const title = String(body.title ?? 'New chat').slice(0, 80)
    const session = { id: randomUUID(), project_id: projectId, mode: 'chat', title, created_at: Date.now() }
    getDb()
      .prepare(`INSERT INTO sessions (id, project_id, mode, title, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(session.id, session.project_id, session.mode, session.title, session.created_at)
    sendJson(res, 200, { session })
    return
  }

  if (req.method === 'GET' && path === '/api/chat/messages') {
    const sessionId = String(url.searchParams.get('sessionId') ?? '')
    assertChatSession(sessionId)
    const rows = getDb().prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at`).all(sessionId)
    sendJson(res, 200, { messages: rows.map(serializeMessage) })
    return
  }

  if (req.method === 'POST' && path === '/api/chat/send') {
    await handleChatSend(await readBody(req), res)
    return
  }

  if (req.method === 'POST' && path === '/api/chat/stop') {
    const body = await readBody(req)
    chatAborts.get(String(body.sessionId ?? ''))?.abort()
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === 'POST' && path === '/api/knowledge/save') {
    const body = await readBody(req)
    const projectId = safeProject(String(body.projectId ?? GLOBAL_PROJECT_ID))
    const content = String(body.content ?? '').trim()
    if (!content) throw new Error('content is required')
    const item = await knowledge.saveMemory({
      projectId: isGlobalProjectId(projectId) ? null : projectId,
      type: 'note',
      title: String(body.title ?? content.slice(0, 60)).slice(0, 120),
      content,
      source: 'web-companion',
      tags: ['web-companion'],
    })
    sendJson(res, 200, { item: { id: item.id, title: item.title, type: item.type } })
    return
  }

  sendJson(res, 404, { error: 'Not found' })
}

function serveWebUi(res: ServerResponse): void {
  sendText(res, 200, WEB_UI_HTML, 'text/html; charset=utf-8')
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = parseUrl(req)
    if (url.pathname.startsWith('/api/')) {
      await routeApi(req, res)
      return
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      serveWebUi(res)
      return
    }
    sendJson(res, 404, { error: 'Not found' })
  } catch (e: any) {
    if (!res.headersSent) sendJson(res, 400, { error: String(e?.message ?? e) })
    else res.end()
  }
}

export async function startWebCompanion(config = readConfig()): Promise<WebCompanionStatus> {
  if (!config.enabled) {
    await stopWebCompanion()
    runningConfig = config
    return getWebCompanionStatus()
  }
  ensureToken()
  await stopWebCompanion()
  lastError = null
  runningConfig = config
  server = createServer((req, res) => void handleRequest(req, res))
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(config.port, bindHost(config.hostMode), () => resolve())
  }).catch((e) => {
    lastError = String((e as any)?.message ?? e)
    server = null
  })
  return getWebCompanionStatus()
}

export function stopWebCompanion(): Promise<void> {
  for (const controller of chatAborts.values()) controller.abort()
  chatAborts.clear()
  return new Promise((resolve) => {
    if (!server) {
      resolve()
      return
    }
    const closing = server
    server = null
    closing.close(() => resolve())
  })
}

export async function initWebCompanionFromConfig(): Promise<WebCompanionStatus> {
  return startWebCompanion(readConfig())
}

export async function configureWebCompanion(input: Partial<WebCompanionConfig>): Promise<WebCompanionStatus> {
  const current = readConfig()
  const next: WebCompanionConfig = {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
    hostMode: input.hostMode === 'private' ? 'private' : input.hostMode === 'local' ? 'local' : current.hostMode,
    port: Number.isInteger(input.port) && input.port! >= 1024 && input.port! <= 65535 ? input.port! : current.port,
  }
  writeMeta(META.enabled, String(next.enabled))
  writeMeta(META.hostMode, next.hostMode)
  writeMeta(META.port, String(next.port))
  if (next.enabled) ensureToken()
  return startWebCompanion(next)
}

export function regenerateWebCompanionToken(): { token: string; status: WebCompanionStatus } {
  const token = randomBytes(24).toString('base64url')
  writeMeta(META.token, token)
  return { token, status: getWebCompanionStatus() }
}

export function getWebCompanionStatus(): WebCompanionStatus {
  const config = runningConfig ?? readConfig()
  const token = getToken()
  return {
    ...config,
    running: Boolean(server?.listening),
    bindHost: bindHost(config.hostMode),
    localUrl: localUrl(config.port),
    privateUrls: privateUrls(config.port),
    tokenConfigured: Boolean(token),
    tokenMasked: maskToken(token),
    error: lastError,
  }
}

const WEB_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>AI Workspace Web Companion</title>
  <style>
    :root { color-scheme: dark; --bg:#0d0d0d; --panel:#161616; --panel2:#1f1f1f; --border:#2c2c2c; --text:#e8e6e3; --muted:#9a9896; --dim:#67635f; --accent:#d9a05b; --danger:#e06c75; font-family: Inter, Segoe UI, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body, #app { height: 100%; margin: 0; }
    body { background: var(--bg); color: var(--text); }
    button, input, textarea, select { font: inherit; }
    button { border: 1px solid var(--border); background: var(--panel2); color: var(--text); border-radius: 7px; padding: 10px 12px; min-height: 42px; }
    button.primary { background: var(--accent); color: #171512; border-color: transparent; font-weight: 700; }
    button.ghost { background: transparent; color: var(--muted); }
    input, textarea, select { width: 100%; border: 1px solid var(--border); background: var(--panel2); color: var(--text); border-radius: 7px; padding: 11px 12px; }
    textarea { resize: none; min-height: 46px; max-height: 160px; }
    .app { height: 100%; display: flex; flex-direction: column; padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom); }
    .top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 8px; min-height: 54px; padding: 8px 10px; background: var(--panel); border-bottom: 1px solid var(--border); }
    .brand { min-width: 0; flex: 1; }
    .brand strong { display: block; font-size: 14px; }
    .brand span { display: block; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { width: 8px; height: 8px; border-radius: 999px; background: #5fbf77; flex: none; }
    .main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .login { min-height: 100%; display: grid; align-content: center; gap: 14px; padding: 22px; }
    .login h1 { margin: 0; font-size: 24px; }
    .login p { color: var(--muted); line-height: 1.45; margin: 0; }
    .drawer { position: fixed; inset: 0 auto 0 0; width: min(86vw, 360px); z-index: 20; background: var(--panel); border-right: 1px solid var(--border); transform: translateX(-105%); transition: transform 150ms ease; padding: calc(env(safe-area-inset-top) + 12px) 12px 12px; display: flex; flex-direction: column; gap: 14px; }
    .drawer.open { transform: translateX(0); }
    .shade { position: fixed; inset: 0; z-index: 19; background: rgba(0,0,0,.48); }
    .drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .drawer h2 { margin: 0; font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .list { display: flex; flex-direction: column; gap: 6px; overflow: auto; }
    .row { text-align: left; min-height: 44px; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
    .row.active { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
    .row small { color: var(--dim); }
    .messages { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 10px 12px; display: flex; flex-direction: column; gap: 10px; }
    .msg { max-width: 92%; border: 1px solid var(--border); border-radius: 8px; padding: 10px 11px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    .msg.user { align-self: flex-end; background: color-mix(in srgb, var(--accent) 15%, var(--panel2)); }
    .msg.assistant { align-self: flex-start; background: var(--panel); }
    .msg .actions { display: flex; gap: 6px; margin-top: 8px; }
    .msg .actions button { min-height: 32px; padding: 5px 8px; font-size: 12px; }
    .empty { margin: auto; max-width: 320px; text-align: center; color: var(--muted); line-height: 1.5; }
    .composer { flex: none; border-top: 1px solid var(--border); background: var(--panel); padding: 9px 10px calc(9px + env(safe-area-inset-bottom)); display: grid; gap: 8px; }
    .composer-row { display: flex; gap: 8px; align-items: flex-end; }
    .composer-row textarea { flex: 1; }
    .error { margin: 8px 10px 0; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--danger) 50%, var(--border)); color: var(--text); background: color-mix(in srgb, var(--danger) 12%, transparent); border-radius: 7px; }
    .meta-row { display: flex; gap: 8px; align-items: center; }
    .meta-row select { min-height: 38px; padding: 7px 8px; }
    .offline .status { background: var(--danger); }
    @media (min-width: 720px) { .msg { max-width: 720px; } .messages, .composer, .top { padding-left: max(18px, calc((100vw - 760px)/2)); padding-right: max(18px, calc((100vw - 760px)/2)); } }
  </style>
</head>
<body>
<div id="app"></div>
<script>
const state = { token: localStorage.getItem('aiw.web.token') || '', authed: false, projects: [], projectId: '__global__', sessions: [], sessionId: '', messages: [], models: [], model: '', streaming: '', busy: false, drawer: false, error: '', online: true };
const $ = (s) => document.querySelector(s);
function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  return fetch(path, Object.assign({}, opts, { headers }));
}
async function json(path, opts) {
  const res = await api(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function render() {
  const app = $('#app');
  if (!state.authed) {
    app.innerHTML = '<div class="login"><h1>AI Workspace</h1><p>Web Companion connects to Chat on this computer. Enter the access token from desktop Settings.</p><input id="token" type="password" placeholder="Access token" value="' + esc(state.token) + '"><button class="primary" id="login">Connect</button>' + (state.error ? '<div class="error">' + esc(state.error) + '</div>' : '') + '</div>';
    $('#login').onclick = login;
    $('#token').oninput = e => state.token = e.target.value;
    return;
  }
  const project = state.projects.find(p => p.id === state.projectId);
  app.innerHTML = '<div class="app' + (state.online ? '' : ' offline') + '"><header class="top"><button class="ghost" id="menu">Menu</button><div class="brand"><strong>AI Workspace</strong><span>' + esc(project?.name || 'Global Workspace') + (state.busy ? ' · Streaming' : ' · Connected') + '</span></div><span class="status"></span><button class="ghost" id="new">New</button></header><main class="main">' + (state.error ? '<div class="error">' + esc(state.error) + '</div>' : '') + '<div class="messages" id="messages">' + messagesHtml() + '</div><div class="composer"><div class="meta-row"><select id="model">' + modelOptions() + '</select></div><div class="composer-row"><textarea id="input" placeholder="Message AI Workspace..."></textarea>' + (state.busy ? '<button id="stop">Stop</button>' : '<button class="primary" id="send">Send</button>') + '</div></div></main>' + drawerHtml() + '</div>';
  $('#menu').onclick = () => { state.drawer = true; render(); };
  $('#new').onclick = newSession;
  $('#model').onchange = e => state.model = e.target.value;
  if ($('#send')) $('#send').onclick = () => send();
  if ($('#stop')) $('#stop').onclick = stop;
  const input = $('#input');
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  if ($('#shade')) $('#shade').onclick = () => { state.drawer = false; render(); };
  document.querySelectorAll('[data-project]').forEach(b => b.onclick = () => selectProject(b.dataset.project));
  document.querySelectorAll('[data-session]').forEach(b => b.onclick = () => selectSession(b.dataset.session));
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard.writeText(state.messages.find(m => m.id === b.dataset.copy)?.content || b.dataset.copyText || ''));
  document.querySelectorAll('[data-save]').forEach(b => b.onclick = () => saveKnowledge(b.dataset.save));
  const scroller = $('#messages');
  scroller.scrollTop = scroller.scrollHeight;
}
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function messagesHtml() {
  if (!state.sessionId) return '<div class="empty">Choose New Chat or pick a previous session from the menu.</div>';
  const items = state.messages.map(m => '<div class="msg ' + esc(m.role) + '">' + esc(m.content) + (m.role === 'assistant' ? '<div class="actions"><button data-copy="' + esc(m.id) + '">Copy</button><button data-save="' + esc(m.id) + '">Save to Knowledge</button></div>' : '') + '</div>');
  if (state.streaming) items.push('<div class="msg assistant">' + esc(state.streaming) + '</div>');
  if (!items.length) items.push('<div class="empty">This chat is ready.</div>');
  return items.join('');
}
function drawerHtml() {
  return (state.drawer ? '<div class="shade" id="shade"></div>' : '') + '<aside class="drawer ' + (state.drawer ? 'open' : '') + '"><div class="drawer-head"><h2>Workspace</h2><button class="ghost" onclick="state.drawer=false;render()">Close</button></div><div class="list">' + state.projects.map(p => '<button class="row ' + (p.id === state.projectId ? 'active' : '') + '" data-project="' + esc(p.id) + '"><span>' + esc(p.name) + '</span><small>' + esc(p.kind === 'global' ? 'Shared workspace' : 'Trusted project') + '</small></button>').join('') + '</div><div class="drawer-head"><h2>Chats</h2></div><div class="list">' + state.sessions.map(s => '<button class="row ' + (s.id === state.sessionId ? 'active' : '') + '" data-session="' + esc(s.id) + '"><span>' + esc(s.title) + '</span><small>' + new Date(s.created_at).toLocaleString() + '</small></button>').join('') + '</div></aside>';
}
function modelOptions() { return (state.models.length ? state.models : ['']).map(m => '<option value="' + esc(m) + '" ' + (m === state.model ? 'selected' : '') + '>' + esc(m || 'No local models found') + '</option>').join(''); }
async function login() {
  try {
    await json('/api/login', { method: 'POST', body: JSON.stringify({ token: state.token }) });
    localStorage.setItem('aiw.web.token', state.token);
    state.authed = true; state.error = '';
    await loadAll();
  } catch(e) { state.error = e.message; render(); }
}
async function loadAll() {
  try {
    const [projects, models] = await Promise.all([json('/api/projects'), json('/api/models')]);
    state.projects = projects.projects; state.models = models.models; state.model = state.model || state.models[0] || '';
    await loadSessions();
  } catch(e) { state.error = e.message; }
  render();
}
async function loadSessions() {
  const data = await json('/api/chat/sessions?projectId=' + encodeURIComponent(state.projectId));
  state.sessions = data.sessions; state.sessionId = state.sessions[0]?.id || ''; state.messages = [];
  if (state.sessionId) await loadMessages();
}
async function loadMessages() {
  const data = await json('/api/chat/messages?sessionId=' + encodeURIComponent(state.sessionId));
  state.messages = data.messages;
}
async function newSession() {
  const data = await json('/api/chat/sessions', { method: 'POST', body: JSON.stringify({ projectId: state.projectId, title: 'New chat' }) });
  state.sessions.unshift(data.session); state.sessionId = data.session.id; state.messages = []; state.drawer = false; render();
}
async function selectProject(id) { state.projectId = id; state.drawer = false; await loadSessions(); render(); }
async function selectSession(id) { state.sessionId = id; state.drawer = false; await loadMessages(); render(); }
async function send() {
  const input = $('#input'); const content = input.value.trim(); if (!content || state.busy) return;
  if (!state.sessionId) await newSession();
  state.busy = true; state.error = ''; state.streaming = ''; state.messages.push({ id: 'tmp-' + Date.now(), role: 'user', content }); render();
  try {
    const res = await api('/api/chat/send', { method: 'POST', body: JSON.stringify({ projectId: state.projectId, sessionId: state.sessionId, model: state.model, content }) });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || 'Send failed');
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    while (true) {
      const r = await reader.read(); if (r.done) break; buf += decoder.decode(r.value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop() || '';
      for (const part of parts) {
        const ev = part.split('\n').find(l => l.startsWith('event: '))?.slice(7);
        const raw = part.split('\n').find(l => l.startsWith('data: '))?.slice(6);
        const data = raw ? JSON.parse(raw) : {};
        if (ev === 'token') { state.streaming += data.token; render(); }
        if (ev === 'error') throw new Error(data.error || 'Model error');
      }
    }
    state.streaming = ''; await loadMessages();
  } catch(e) { state.error = e.message; }
  state.busy = false; render();
}
async function stop() { await json('/api/chat/stop', { method: 'POST', body: JSON.stringify({ sessionId: state.sessionId }) }); }
async function saveKnowledge(id) {
  const msg = state.messages.find(m => m.id === id); if (!msg) return;
  try { await json('/api/knowledge/save', { method: 'POST', body: JSON.stringify({ projectId: state.projectId, content: msg.content, title: msg.content.slice(0, 60) }) }); state.error = 'Saved to Knowledge'; }
  catch(e) { state.error = e.message; }
  render();
}
(async function boot() { if (state.token) { try { state.authed = true; await loadAll(); } catch { state.authed = false; render(); } } else render(); window.addEventListener('offline', () => { state.online = false; render(); }); window.addEventListener('online', () => { state.online = true; render(); }); })();
</script>
</body>
</html>`
