import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron'
import { randomUUID } from 'crypto'
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { join, extname, basename, dirname } from 'path'
import type { IPty } from 'node-pty'
import { getDb, getDbPath } from './db'
import * as projects from './projects'
import * as knowledge from './knowledge'
import { startWatcher } from './indexer'
import { extractFromSession, consolidateMemories } from './extractor'
import { listModels, streamChat, streamCloudChat, chat, defaultChatModel, ollamaStatus, analyzeImage, ChatMessage } from './ollama'
import { checkClaudeCode, runClaudeCode, summarizeRun, type CCEvent } from './claudecode'
import { checkCodex, runCodex, summarizeCodexRun, type CodexEvent, type CodexSandboxMode } from './codex'
import {
  checkMcpServer,
  getClaudeConfigPath,
  getEnabledState,
  readMcpServers,
  setEnabledState,
  writeMcpServers,
  type McpServerConfig
} from './mcp'
import {
  checkHermes,
  connectHermes,
  disconnectHermes,
  hermesConnected,
  runHermesPrompt,
  summarizeHermesRun,
  getHermesConfig,
  testHermesConnection,
  type HermesEvent,
  type RemoteHermesConfig
} from './hermes'
import { GLOBAL_PROJECT_ID, isGlobalProjectId } from '../shared/globalWorkspace'
import { fallbackTitleFromText, isGenericSessionTitle } from '../shared/sessionTitles'
import {
  configureWebCompanion,
  getWebCompanionStatus,
  regenerateWebCompanionToken,
  type WebCompanionConfig
} from './webCompanion'

// ---- PTY lifecycle (Phase F) ----
interface PtyEntry { pty: IPty; win: BrowserWindow | null }
const ptyMap = new Map<string, PtyEntry>()

// ---- Research pipeline helpers -----------------------------------------------

function getSearxngUrl(): string {
  try {
    const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get('searxng_url') as
      | { value: string }
      | undefined
    if (row?.value) return row.value.replace(/\/+$/, '')
  } catch { /* db not ready */ }
  const envUrl = process.env.SEARXNG_URL
  if (envUrl) return envUrl.replace(/\/+$/, '')
  return 'http://localhost:8080'
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function killAllPtys(): void {
  for (const [, entry] of ptyMap) {
    try { entry.pty.kill() } catch {}
  }
  ptyMap.clear()
}

function emitActivity(
  win: BrowserWindow | null,
  source: 'CHAT' | 'HERMES' | 'CODE' | 'INDEXER' | 'MEMORY' | 'RESEARCH',
  message: string
) {
  win?.webContents.send('activity:log', { source, message, timestamp: Date.now() })
}

type SettingKind = 'string' | 'number' | 'boolean' | 'select' | 'secret'

interface SettingDefinition {
  key: string
  kind: SettingKind
  defaultValue: string
  secret?: boolean
  options?: string[]
}

const SETTING_DEFINITIONS: Record<string, SettingDefinition> = {
  ui_theme: { key: 'ui_theme', kind: 'select', defaultValue: 'system', options: ['system', 'dark', 'light'] },
  ui_density: { key: 'ui_density', kind: 'select', defaultValue: 'comfortable', options: ['comfortable', 'compact'] },
  ui_font_scale: { key: 'ui_font_scale', kind: 'select', defaultValue: '100', options: ['95', '100', '110', '120'] },
  ui_reduced_motion: { key: 'ui_reduced_motion', kind: 'boolean', defaultValue: 'false' },
  workspace_startup: { key: 'workspace_startup', kind: 'select', defaultValue: 'last', options: ['last', 'global'] },
  workspace_confirm_destructive: { key: 'workspace_confirm_destructive', kind: 'boolean', defaultValue: 'true' },
  workspace_panel_hints: { key: 'workspace_panel_hints', kind: 'boolean', defaultValue: 'true' },
  agent_default: { key: 'agent_default', kind: 'select', defaultValue: 'codex', options: ['codex', 'claudecode', 'hermes'] },
  agent_save_outputs_to_knowledge: { key: 'agent_save_outputs_to_knowledge', kind: 'boolean', defaultValue: 'true' },
  agent_show_advanced_logs: { key: 'agent_show_advanced_logs', kind: 'boolean', defaultValue: 'false' },
  searxng_url: { key: 'searxng_url', kind: 'string', defaultValue: 'http://localhost:8080' },
  research_default_scope: { key: 'research_default_scope', kind: 'select', defaultValue: 'both', options: ['web', 'local', 'both'] },
  research_result_limit: { key: 'research_result_limit', kind: 'number', defaultValue: '8' },
  editor_font_size: { key: 'editor_font_size', kind: 'number', defaultValue: '13' },
  editor_tab_size: { key: 'editor_tab_size', kind: 'number', defaultValue: '2' },
  editor_word_wrap: { key: 'editor_word_wrap', kind: 'boolean', defaultValue: 'true' },
  terminal_start_dir: { key: 'terminal_start_dir', kind: 'select', defaultValue: 'project', options: ['project', 'app'] },
  keyboard_shortcuts: { key: 'keyboard_shortcuts', kind: 'string', defaultValue: '' },
  ollama_cloud_key: { key: 'ollama_cloud_key', kind: 'secret', defaultValue: '', secret: true },
}

function readMeta(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row?.value ?? null
}

function writeMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .run(key, value)
}

function deleteMeta(key: string): void {
  getDb().prepare('DELETE FROM app_meta WHERE key = ?').run(key)
}

function validateSetting(def: SettingDefinition, rawValue: string): string {
  const value = String(rawValue ?? '')
  if (def.kind === 'boolean') return value === 'true' ? 'true' : 'false'
  if (def.kind === 'select') return def.options?.includes(value) ? value : def.defaultValue
  if (def.kind === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return def.defaultValue
    return String(Math.round(n))
  }
  if (def.key === 'searxng_url') {
    const trimmed = value.trim().replace(/\/+$/, '')
    if (!trimmed) return def.defaultValue
    try {
      const u = new URL(trimmed)
      if (!['http:', 'https:'].includes(u.protocol)) return def.defaultValue
      return trimmed
    } catch {
      return def.defaultValue
    }
  }
  return value
}

function publicSettingValue(key: string): string | null {
  const def = SETTING_DEFINITIONS[key]
  if (!def) return null
  if (def.secret) return null
  return readMeta(key) ?? def.defaultValue
}

function secretStatus(key: string): { configured: boolean; masked: string | null } {
  const value = readMeta(key)
  if (!value) return { configured: false, masked: null }
  const tail = value.slice(-4)
  return { configured: true, masked: `•••• ${tail}` }
}

function buildSettingsSnapshot() {
  const values: Record<string, string | null> = {}
  const secrets: Record<string, { configured: boolean; masked: string | null }> = {}
  for (const def of Object.values(SETTING_DEFINITIONS)) {
    if (def.secret) secrets[def.key] = secretStatus(def.key)
    else values[def.key] = publicSettingValue(def.key)
  }
  return { values, secrets }
}

async function buildDiagnosticsReport() {
  const db = getDb()
  const projectCount = (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number } | undefined)?.n ?? 0
  const sessionCount = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number } | undefined)?.n ?? 0
  const memoryCount = (db.prepare('SELECT COUNT(*) AS n FROM memory_items').get() as { n: number } | undefined)?.n ?? 0
  const [ollama, codex, claude, hermes] = await Promise.all([
    ollamaStatus().catch((e: any) => ({ connected: false, defaultModel: null, error: String(e?.message ?? e) })),
    checkCodex().catch((e: any) => ({ installed: false, error: String(e?.message ?? e) })),
    checkClaudeCode().catch((e: any) => ({ installed: false, error: String(e?.message ?? e) })),
    checkHermes().catch((e: any) => ({ wsl2: false, installed: false, connected: false, error: String(e?.message ?? e) })),
  ])
  return {
    app: {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: `${process.platform} ${process.arch}`,
      userData: app.getPath('userData'),
      databasePath: getDbPath(),
    },
    counts: { projects: projectCount, sessions: sessionCount, memories: memoryCount },
    providers: { ollama, codex, claudeCode: claude, hermes },
    webCompanion: (() => {
      const status = getWebCompanionStatus()
      return {
        enabled: status.enabled,
        running: status.running,
        hostMode: status.hostMode,
        port: status.port,
        bindHost: status.bindHost,
        tokenConfigured: status.tokenConfigured,
        tokenMasked: status.tokenMasked,
        error: status.error,
      }
    })(),
    settings: buildSettingsSnapshot(),
  }
}


export function registerIpc(): void {
  // ---- filesystem (Phase D: Navigator file tree) ----
  const FS_IGNORE = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'workspace.db', '.aiworkspace.json'])
  ipcMain.handle('fs:readDir', (_e, dirPath: string) => {
    try {
      return readdirSync(dirPath, { withFileTypes: true })
        .filter(e => !FS_IGNORE.has(e.name) && !e.name.endsWith('.map'))
        .map(e => ({ name: e.name, isDir: e.isDirectory(), path: join(dirPath, e.name) }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    } catch {
      return []
    }
  })

  // Phase E: read/write files for the Editor panel
  ipcMain.handle('fs:readFile', (_e, filePath: string) => {
    try {
      const stat = statSync(filePath)
      if (stat.size > 500 * 1024) return { error: 'File too large (>500KB)' }
      const buf = readFileSync(filePath)
      const checkLen = Math.min(512, buf.length)
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) return { error: 'Binary file' }
      }
      return { content: buf.toString('utf-8'), size: stat.size }
    } catch (e: any) {
      return { error: String(e?.message ?? e) }
    }
  })

  ipcMain.handle('fs:writeFile', (_e, filePath: string, content: string) => {
    try {
      writeFileSync(filePath, content, 'utf-8')
      return { success: true }
    } catch (e: any) {
      return { error: String(e?.message ?? e) }
    }
  })

  // ---- file picker & reader ----
  ipcMain.handle('files:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('files:read', async (_e, filePath: string) => {
    const stats = statSync(filePath)
    if (stats.size > 10 * 1024 * 1024) throw new Error('File too large (max 10MB)')
    const ext = extname(filePath).toLowerCase()
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico']
    if (imageExts.includes(ext)) {
      const buffer = readFileSync(filePath)
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp', '.ico': 'image/x-icon'
      }
      return { type: 'image', name: basename(filePath), size: stats.size, mimeType: mimeTypes[ext] ?? 'image/jpeg', base64: buffer.toString('base64'), ext, filePath }
    }
    try {
      const content = readFileSync(filePath, 'utf-8')
      return { type: 'text', name: basename(filePath), size: stats.size, content, ext }
    } catch {
      const buffer = readFileSync(filePath)
      return { type: 'binary', name: basename(filePath), size: stats.size, base64: buffer.toString('base64'), ext }
    }
  })

  ipcMain.handle('files:copyToProject', async (_e, sourcePath: string, projectPath: string) => {
    const tmpDir = join(projectPath, '.ai-workspace-tmp')
    mkdirSync(tmpDir, { recursive: true })
    const fileName = basename(sourcePath)
    const destPath = join(tmpDir, fileName)
    copyFileSync(sourcePath, destPath)
    return destPath
  })

  ipcMain.handle('ollama:analyzeImage', (_e, model: string, base64: string, mimeType: string, prompt: string) =>
    analyzeImage(model, base64, mimeType, prompt)
  )

  // ---- projects ----
  ipcMain.handle('projects:list', () => projects.listProjects())
  ipcMain.handle('projects:global', () => projects.openProject(GLOBAL_PROJECT_ID))
  ipcMain.handle('projects:create', (_e, name: string, parentDir: string) =>
    projects.createProject(name, parentDir)
  )
  ipcMain.handle('projects:import', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return projects.importFolder(result.filePaths[0])
  })
  ipcMain.handle('projects:open', (_e, id: string) => {
    const project = projects.openProject(id)
    // The global workspace is a DB sentinel, not a folder-backed project.
    // Never start the file watcher/indexer for it.
    if (!isGlobalProjectId(project.id)) startWatcher(project.id, project.path)
    return project
  })
  ipcMain.handle('projects:archive', (_e, id: string, archived: boolean) =>
    projects.setArchived(id, archived)
  )
  ipcMain.handle('projects:pickFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // ---- models ----
  ipcMain.handle('models:list', () => listModels())
  ipcMain.handle('models:listCloud', async () => {
    try {
      const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get('ollama_cloud_key') as { value: string } | undefined
      const apiKey = row?.value
      if (!apiKey) return []
      const res = await fetch('https://ollama.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) return []
      const data = await res.json() as { data?: { id: string }[] }
      return (data.data ?? []).map((m) => ({ id: m.id, name: m.id }))
    } catch {
      return []
    }
  })
  ipcMain.handle('ollama:status', () => ollamaStatus())
  // One-shot, non-streaming completion (offline-tolerant; returns null if the
  // host/model is unavailable). Routed through ollama.ts like all model access —
  // used for side calls such as the Chat tab's follow-up suggestions. Read-only:
  // it never touches sessions or the DB.
  ipcMain.handle('ollama:complete', (_e, model: string, messages: ChatMessage[], timeoutMs?: number) =>
    chat(model, messages, timeoutMs)
  )

  // ---- MCP server registry ----------------------------------------------------
  // Claude Desktop's config remains the source of truth. This app only tracks
  // local UI enabled/disabled state in app_meta.
  ipcMain.handle('mcp:list', async () => {
    const servers = readMcpServers()
    const enabled = getEnabledState()
    return Object.entries(servers).map(([name, config]) => ({
      name,
      config,
      enabled: enabled[name] !== false,
      transport: config.url ? (config.type || 'sse') : 'stdio',
      status: 'unknown',
      statusMessage: undefined,
      lastChecked: undefined
    }))
  })

  ipcMain.handle('mcp:add', async (_e, name: string, config: McpServerConfig) => {
    const servers = readMcpServers()
    servers[name] = config
    writeMcpServers(servers)
    return { success: true }
  })

  ipcMain.handle('mcp:remove', async (_e, name: string) => {
    const servers = readMcpServers()
    delete servers[name]
    writeMcpServers(servers)

    const enabled = getEnabledState()
    delete enabled[name]
    setEnabledState(enabled)
    return { success: true }
  })

  ipcMain.handle('mcp:setEnabled', async (_e, name: string, enabled: boolean) => {
    const state = getEnabledState()
    state[name] = enabled
    setEnabledState(state)
    return { success: true }
  })

  ipcMain.handle('mcp:check', async (_e, name: string) => {
    const servers = readMcpServers()
    if (!servers[name]) return { status: 'error', message: 'Server not found' }
    return checkMcpServer(name, servers[name])
  })

  ipcMain.handle('mcp:checkAll', async () => {
    const servers = readMcpServers()
    const results: Record<string, { status: string; message: string }> = {}
    await Promise.all(
      Object.entries(servers).map(async ([name, config]) => {
        results[name] = await checkMcpServer(name, config)
      })
    )
    return results
  })

  ipcMain.handle('mcp:getConfigPath', () => getClaudeConfigPath())

  // ---- sessions / chat ----
  ipcMain.handle('sessions:list', (_e, projectId: string, mode: string) =>
    getDb()
      .prepare(`SELECT * FROM sessions WHERE project_id = ? AND mode = ? ORDER BY created_at DESC`)
      .all(projectId, mode)
  )
  ipcMain.handle('sessions:create', (_e, projectId: string, mode: string, title: string) => {
    if (isGlobalProjectId(projectId)) projects.ensureGlobalProject()
    const session = { id: randomUUID(), project_id: projectId, mode, title, created_at: Date.now() }
    getDb()
      .prepare(`INSERT INTO sessions (id, project_id, mode, title, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(session.id, session.project_id, session.mode, session.title, session.created_at)
    return session
  })
  ipcMain.handle('sessions:rename', (_e, id: string, title: string) => {
    getDb().prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, id)
  })
  ipcMain.handle('sessions:delete', (_e, id: string) => {
    const db = getDb()
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id)
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
  })
  ipcMain.handle('messages:list', (_e, sessionId: string) =>
    getDb().prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at`).all(sessionId)
  )

  // Track in-flight chat streams so a Stop can cancel them.
  const chatAborts = new Map<string, AbortController>()
  ipcMain.handle('chat:abort', (_e, sessionId: string) => {
    chatAborts.get(sessionId)?.abort()
  })

  // Streaming chat: persists the user message, retrieves knowledge context,
  // streams model output to the renderer, persists the assistant message.
  ipcMain.handle(
    'chat:send',
    async (event, args: { sessionId: string; projectId: string; model: string; content: string; images?: string[] }) => {
      const db = getDb()
      const win = BrowserWindow.fromWebContents(event.sender)
      const now = Date.now()
      db.prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), args.sessionId, 'user', args.content, null, now)

      // Retrieval step: ground the model in workspace knowledge before answering.
      // For the __global__ sentinel, "project" scope resolves to shared/global
      // memory (project_id NULL) without mixing in any folder-backed project.
      const memories = await knowledge.searchMemory(args.content, 'project', args.projectId, 5)
      const contextBlock =
        memories.length > 0
          ? `Relevant project knowledge:\n${memories.map((m) => `- [${m.type}] ${m.title}: ${m.content}`).join('\n')}`
          : ''

      const history = db
        .prepare(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at`)
        .all(args.sessionId) as ChatMessage[]
      const messagesRaw: ChatMessage[] = [
        {
          role: 'system',
          content:
            `You are the Chat mode of a local-first AI workspace. You help plan, research and prepare work ` +
            `for the Hermes agent and Claude Code. Be concrete and ask clarifying questions when planning.\n\n` +
            `Whenever you present answer choices that the user is expected to choose from, use structured interactive blocks. ` +
            `This applies to random questions, quizzes, design questions, clarification questions, and surveys. ` +
            `If asking one selectable clarification question, emit one fenced clarification block. If asking one general selectable question, emit one fenced choice_question block. ` +
            `If asking multiple selectable questions, emit one fenced questionnaire block. Do not output plain A) B) C) D) or numbered multiple-choice text when the user is expected to answer interactively. ` +
            `Keep options short. Include freewrite where useful. Do not force interactive blocks for normal explanations. ` +
            `Do not ask too many questions unless the user explicitly asks for lots of questions. Use "single" unless multiple answers are genuinely allowed.\n\n` +
            `Clarification format:\n` +
            '```clarification\n' +
            '{\n' +
            '  "id": "short-stable-id",\n' +
            '  "question": "What should I clarify?",\n' +
            '  "mode": "single",\n' +
            '  "options": ["Option A", "Option B", "Something else"],\n' +
            '  "allowFreewrite": true,\n' +
            '  "freewriteLabel": "Describe your answer"\n' +
            '}\n' +
            '```\n' +
            `General single-question format:\n` +
            '```choice_question\n' +
            '{\n' +
            '  "id": "random-tree-question",\n' +
            '  "question": "What is the largest living species of tree by trunk volume?",\n' +
            '  "mode": "single",\n' +
            '  "options": ["Coast Redwood", "Giant Sequoia", "Amazonian Ceiba", "European Oak"],\n' +
            '  "allowFreewrite": false\n' +
            '}\n' +
            '```\n' +
            `Multi-question format:\n` +
            '```questionnaire\n' +
            '{\n' +
            '  "id": "short-stable-id",\n' +
            '  "title": "A few questions",\n' +
            '  "questions": [\n' +
            '    {\n' +
            '      "id": "tone",\n' +
            '      "question": "What tone should this have?",\n' +
            '      "mode": "single",\n' +
            '      "options": ["Professional", "Friendly", "Playful"],\n' +
            '      "allowFreewrite": true,\n' +
            '      "freewriteLabel": "Other tone"\n' +
            '    }\n' +
            '  ]\n' +
            '}\n' +
            '```\n' +
            `Example: if the user says "give me a random question with 4 possible answers", emit a choice_question block like the tree-volume example above, not plain A/B/C/D markdown. ` +
            `Only ask for clarification when it is needed; otherwise answer normally.\n\n${contextBlock}`
        },
        ...history
      ]
      // Attach native-vision images to the last user message so the model sees them.
      const messages: ChatMessage[] = messagesRaw
      if (args.images && args.images.length > 0) {
        const lastUserIdx = messages.map(m => m.role).lastIndexOf('user')
        if (lastUserIdx !== -1) messages[lastUserIdx] = { ...messages[lastUserIdx], images: args.images }
      }

      emitActivity(win, 'CHAT', `Sending to ${args.model.startsWith('cloud:') ? args.model.slice(6) : args.model}…`)
      const controller = new AbortController()
      chatAborts.set(args.sessionId, controller)
      let full = ''
      try {
        const isCloud = args.model.startsWith('cloud:')
        if (isCloud) {
          const cloudModel = args.model.slice(6)
          const keyRow = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('ollama_cloud_key') as { value: string } | undefined
          const apiKey = keyRow?.value ?? ''
          for await (const token of streamCloudChat(cloudModel, messages, apiKey, controller.signal)) {
            full += token
            win?.webContents.send('chat:token', { sessionId: args.sessionId, token })
          }
        } else {
          for await (const token of streamChat(args.model, messages, controller.signal)) {
            full += token
            win?.webContents.send('chat:token', { sessionId: args.sessionId, token })
          }
        }
      } catch (err: any) {
        // A user-initiated Stop arrives as an abort: keep the partial text
        // (persisted below) and finish cleanly instead of reporting an error.
        if (!controller.signal.aborted) {
          chatAborts.delete(args.sessionId)
          win?.webContents.send('chat:error', { sessionId: args.sessionId, error: String(err?.message ?? err) })
          return null
        }
      } finally {
        chatAborts.delete(args.sessionId)
      }
      // Persist whatever was produced — the full turn, or the partial up to Stop.
      if (full.trim()) {
        db.prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), args.sessionId, 'assistant', full, args.model, Date.now())
      }
      // Estimate total context tokens from all persisted messages in this session.
      const allMsgs = db.prepare('SELECT content FROM messages WHERE session_id = ?').all(args.sessionId) as { content: string }[]
      const estimatedTokens = allMsgs.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0)
      win?.webContents.send('chat:usage', { used: estimatedTokens, max: null })
      win?.webContents.send('chat:done', { sessionId: args.sessionId })
      if (full.trim()) emitActivity(win, 'CHAT', `Response complete (${Math.ceil(full.length / 5)} tokens est.)`)
      return full
    }
  )

  // ---- knowledge ----
  ipcMain.handle('memory:list', (_e, projectId: string | null) => knowledge.listMemory(projectId))
  ipcMain.handle('memory:save', async (event, input: Parameters<typeof knowledge.saveMemory>[0]) => {
    const item = await knowledge.saveMemory(input)
    const win = BrowserWindow.fromWebContents(event.sender)
    emitActivity(win, 'MEMORY', `Memory written (${item.type})`)
    win?.webContents.send('memory:saved', { title: item.title, type: item.type })
    return item
  })
  ipcMain.handle('memory:delete', (_e, id: string) => knowledge.deleteMemory(id))
  ipcMain.handle('memory:count', (_e, projectId: string) => knowledge.countMemory(projectId))
  ipcMain.handle('memory:clearProject', (_e, projectId: string) =>
    knowledge.clearProjectMemory(projectId)
  )
  ipcMain.handle(
    'memory:search',
    (_e, query: string, scope: knowledge.SearchScope, projectId: string | null) =>
      knowledge.searchMemory(query, scope, projectId)
  )

  // M4: extract durable knowledge from a finished chat session. On success,
  // nudge the Knowledge panel to refresh via the same channel the indexer uses.
  ipcMain.handle('memory:extract', async (event, projectId: string | null, sessionId: string) => {
    const items = await extractFromSession(projectId, sessionId)
    if (items.length > 0) {
      const win = BrowserWindow.fromWebContents(event.sender)
      win?.webContents.send('index:updated', { projectIds: [projectId ?? GLOBAL_PROJECT_ID] })
    }
    return items
  })
  ipcMain.handle('memory:consolidate', (_e, projectId: string | null) => consolidateMemories(projectId))

  // ---- Codex panel ----
  // Drives the Codex CLI headless under the user's ChatGPT subscription login.
  // Mirrors the Claude Code launcher: each send is a one-shot `codex exec` run,
  // streamed as structured events and persisted as session messages so past
  // work is reviewable. Command selection and cwd ownership stay in the main
  // process; the renderer provides only project identity, prompt, and sandbox.
  ipcMain.handle('codex:check', () => checkCodex())

  ipcMain.handle('codex:messages', (_e, sessionId: string) =>
    getDb().prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at`).all(sessionId)
  )

  // Track in-flight Codex runs so a Stop can kill the child process.
  const codexAborts = new Map<string, AbortController>()
  ipcMain.handle('codex:abort', (_e, sessionId: string) => {
    codexAborts.get(sessionId)?.abort()
  })

  ipcMain.handle(
    'codex:send',
    async (
      event,
      args: {
        sessionId: string
        projectId: string
        prompt: string
        sandbox?: CodexSandboxMode
        skipGitRepoCheck?: boolean
        model?: string
        imagePaths?: string[]
      }
    ) => {
      const db = getDb()
      const win = BrowserWindow.fromWebContents(event.sender)
      if (isGlobalProjectId(args.projectId)) {
        win?.webContents.send('codex:done', {
          sessionId: args.sessionId,
          ok: false,
          error: 'Open a project to use Codex.'
        })
        return null
      }
      const insertMsg = (role: string, content: string, model: string | null) => {
        const id = randomUUID()
        db
          .prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, args.sessionId, role, content, model, Date.now())
        return id
      }

      // Title the session from its first user message, replacing "New task".
      const prior = db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`)
        .get(args.sessionId) as { n: number }
      const userMsgId = insertMsg('user', args.prompt, null)
      if (prior.n === 0) {
        const current = db.prepare(`SELECT title FROM sessions WHERE id = ?`).get(args.sessionId) as
          | { title: string }
          | undefined
        const title = fallbackTitleFromText(args.prompt) ?? 'New task'
        if (isGenericSessionTitle(current?.title)) {
          db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, args.sessionId)
        }
      }

      const project = db.prepare(`SELECT path FROM projects WHERE id = ?`).get(args.projectId) as
        | { path: string }
        | undefined
      if (!project?.path || !existsSync(project.path)) {
        win?.webContents.send('codex:done', { sessionId: args.sessionId, error: 'Project folder not found.' })
        return null
      }

      const controller = new AbortController()
      codexAborts.set(args.sessionId, controller)
      const run = await runCodex({
        projectPath: project.path,
        prompt: args.prompt,
        sandbox: args.sandbox,
        skipGitRepoCheck: args.skipGitRepoCheck,
        model: args.model,
        imagePaths: args.imagePaths,
        signal: controller.signal,
        onEvent: (e: CodexEvent) => {
          win?.webContents.send('codex:event', { sessionId: args.sessionId, event: e })
          if (e.kind === 'tool') emitActivity(win, 'CODE', `Codex ${e.name}: ${e.summary.slice(0, 80)}`)
          else if (e.kind === 'system') emitActivity(win, 'CODE', `Codex: ${e.summary}`)
          else if (e.kind === 'error') emitActivity(win, 'CODE', `Codex error: ${e.message.slice(0, 80)}`)
        }
      })
      codexAborts.delete(args.sessionId)

      // A trust block is a pre-run gate, not real work: drop the turn entirely so
      // the user can enable the trust toggle and resend without cluttered history.
      if (run.trustRequired) {
        db.prepare(`DELETE FROM messages WHERE id = ?`).run(userMsgId)
        win?.webContents.send('codex:done', {
          sessionId: args.sessionId,
          ok: false,
          trustRequired: true,
          error: run.error
        })
        return null
      }

      // Persist the activity log and the result text for review on reload.
      if (run.activity.length > 0) insertMsg('tool', JSON.stringify(run.activity), 'codex')
      insertMsg('assistant', run.result || run.error || '(no output)', 'codex')

      // Save a durable summary to memory after real work. Skip pure setup
      // failures (not found / not logged in / untrusted) — nothing to record.
      let memorySaved = false
      if (!run.loginRequired && !run.trustRequired && (run.ok || run.activity.length > 0)) {
        const { title, content } = summarizeCodexRun(args.prompt, run)
        await knowledge.saveMemory({
          projectId: args.projectId,
          type: 'task',
          title,
          content,
          source: 'codex',
          tags: ['codex']
        })
        memorySaved = true
        win?.webContents.send('index:updated', { projectIds: [args.projectId] })
      }

      emitActivity(win, 'CODE', run.ok ? `Codex task complete: ${args.prompt.slice(0, 60)}` : 'Codex task failed')
      win?.webContents.send('codex:done', {
        sessionId: args.sessionId,
        ok: run.ok,
        loginRequired: run.loginRequired ?? false,
        trustRequired: run.trustRequired ?? false,
        memorySaved,
        error: run.ok ? undefined : run.error
      })
      return run.result
    }
  )

  // ---- Claude Code (M5) ----
  // Is the CLI installed/usable? (Login state is only knowable from a real run.)
  ipcMain.handle('claudecode:check', () => checkClaudeCode())

  // Track in-flight Claude Code runs so a Stop can kill the child process.
  const ccAborts = new Map<string, AbortController>()
  ipcMain.handle('claudecode:abort', (_e, sessionId: string) => {
    ccAborts.get(sessionId)?.abort()
  })

  // Run a headless Claude Code task in the project folder, streaming structured
  // events to the renderer. Persists the turn (prompt + activity log + result)
  // as messages so past work is reviewable, and saves a durable task summary to
  // memory through the single write queue.
  ipcMain.handle(
    'claudecode:send',
    async (
      event,
      args: {
        sessionId: string
        projectId: string
        prompt: string
        injectMemory?: boolean
        model?: string
        effort?: 'normal' | 'high' | 'max'
        thinking?: boolean
      }
    ) => {
      const db = getDb()
      const win = BrowserWindow.fromWebContents(event.sender)
      if (isGlobalProjectId(args.projectId)) {
        win?.webContents.send('claudecode:done', {
          sessionId: args.sessionId,
          ok: false,
          error: 'Claude Code needs a project folder. Open a project workspace to use it.'
        })
        return null
      }
      const insertMsg = (role: string, content: string, model: string | null) =>
        db
          .prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), args.sessionId, role, content, model, Date.now())

      // Title the session from its first user message (Claude.ai-style preview),
      // replacing the "New task" placeholder. Detected by the absence of any
      // prior user turn so re-runs in the same session never re-title it.
      const prior = db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`)
        .get(args.sessionId) as { n: number }

      // Persist the user's typed prompt (not the injected context block).
      insertMsg('user', args.prompt, null)

      if (prior.n === 0) {
        const current = db.prepare(`SELECT title FROM sessions WHERE id = ?`).get(args.sessionId) as { title: string } | undefined
        const title = fallbackTitleFromText(args.prompt) ?? 'New task'
        if (isGenericSessionTitle(current?.title)) {
          db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, args.sessionId)
        }
      }

      const project = db.prepare(`SELECT path FROM projects WHERE id = ?`).get(args.projectId) as
        | { path: string }
        | undefined
      if (!project) {
        win?.webContents.send('claudecode:done', { sessionId: args.sessionId, error: 'Project not found.' })
        return null
      }

      // "Inject memory": prepend the project context snapshot to the task.
      let prompt = args.prompt
      if (args.injectMemory) {
        const block = knowledge.formatProjectContext(knowledge.getProjectContext(args.projectId))
        if (block) prompt = `${block}\n\n---\n\nTask:\n${args.prompt}`
      }

      // Effort → the CLI's native `--effort` levels. "normal" omits the flag to
      // preserve the default; "high"/"max" map straight onto CLI effort levels.
      const effort = args.effort === 'high' ? 'high' : args.effort === 'max' ? 'max' : undefined

      const controller = new AbortController()
      ccAborts.set(args.sessionId, controller)
      const run = await runClaudeCode({
        projectPath: project.path,
        prompt,
        model: args.model,
        effort,
        thinking: args.thinking,
        signal: controller.signal,
        onEvent: (e: CCEvent) => {
          win?.webContents.send('claudecode:event', { sessionId: args.sessionId, event: e })
          if (e.kind === 'tool') emitActivity(win, 'CODE', `${e.name}: ${e.summary.slice(0, 80)}`)
          else if (e.kind === 'system') emitActivity(win, 'CODE', e.summary.slice(0, 80))
          else if (e.kind === 'error') emitActivity(win, 'CODE', `Error: ${e.message.slice(0, 80)}`)
        }
      })
      ccAborts.delete(args.sessionId)

      // Persist the activity log (for review on reload) and the result text.
      if (run.activity.length > 0) insertMsg('tool', JSON.stringify(run.activity), 'claude-code')
      insertMsg('assistant', run.result || run.error || '(no output)', 'claude-code')

      // After a real task, save a durable summary to memory. Skip pure setup
      // failures (not logged in / not found) — there's nothing worth recording.
      let memorySaved = false
      if (!run.loginRequired && (run.ok || run.activity.length > 0)) {
        const { title, content } = summarizeRun(args.prompt, run)
        await knowledge.saveMemory({
          projectId: args.projectId,
          type: 'task',
          title,
          content,
          source: 'claudecode',
          tags: ['claudecode']
        })
        memorySaved = true
        win?.webContents.send('index:updated', { projectIds: [args.projectId] })
      }

      emitActivity(win, 'CODE', run.ok ? `Task complete: ${args.prompt.slice(0, 60)}` : `Task failed`)
      win?.webContents.send('claudecode:done', {
        sessionId: args.sessionId,
        ok: run.ok,
        loginRequired: run.loginRequired ?? false,
        memorySaved,
        error: run.ok ? undefined : run.error
      })
      return run.result
    }
  )

  // ---- Hermes (M6) — ACP stdio ----
  // Hermes runs in WSL2 via `hermes acp --accept-hooks` (stdin/stdout JSON-RPC).
  // No HTTP server or polling; one long-lived process shared across sessions.

  ipcMain.handle('hermes:check', () => checkHermes())

  // Cheap connected-state query for the poll loop — returns immediately without
  // spawning wsl.exe when the ACP process is already alive.
  ipcMain.handle('hermes:health', () => ({ ok: hermesConnected() }))

  // Explicit connect (called by the "Connect" button in the UI).
  ipcMain.handle('hermes:connect', async (_e, distro?: string) => {
    const check = await checkHermes()
    return connectHermes(distro ?? check.distro ?? 'Ubuntu')
  })

  // Read all hermes_* config keys from app_meta.
  ipcMain.handle('hermes:getConfig', (): RemoteHermesConfig => getHermesConfig())

  // Write all hermes_* config keys to app_meta; disconnect any active connection.
  ipcMain.handle('hermes:setConfig', (_e, config: RemoteHermesConfig) => {
    const db = getDb()
    const set = (key: string, value: string) =>
      db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(key, value)
    set('hermes_mode', config.mode)
    set('hermes_ssh_host', config.sshHost)
    set('hermes_ssh_user', config.sshUser)
    set('hermes_ssh_key', config.sshKeyPath)
    set('hermes_hermes_path', config.hermesPath)
    disconnectHermes()
  })

  // Test SSH reachability using the provided (or stored) config.
  ipcMain.handle('hermes:testConnection', async (_e, config?: RemoteHermesConfig) =>
    testHermesConnection(config)
  )

  // Track in-flight runs by our session id so abort can cancel them.
  const hermesAborts = new Map<string, AbortController>()
  ipcMain.handle('hermes:abort', (_e, sessionId: string) => {
    hermesAborts.get(sessionId)?.abort()
  })

  // Send a prompt to Hermes, stream events back, persist the turn, save memory.
  ipcMain.handle(
    'hermes:send',
    async (
      event,
      args: { sessionId: string; projectId: string; prompt: string; injectMemory?: boolean }
    ) => {
      const db = getDb()
      const win = BrowserWindow.fromWebContents(event.sender)
      if (isGlobalProjectId(args.projectId)) {
        win?.webContents.send('hermes:done', {
          sessionId: args.sessionId,
          ok: false,
          error: 'Hermes needs a project folder. Open a project workspace to use it.'
        })
        return null
      }
      const insertMsg = (role: string, content: string, model: string | null) =>
        db
          .prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), args.sessionId, role, content, model, Date.now())

      // Title the session from its first user message (mirrors Claude Code tab).
      const prior = db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`)
        .get(args.sessionId) as { n: number }
      insertMsg('user', args.prompt, null)
      if (prior.n === 0) {
        const title = args.prompt.trim().replace(/\s+/g, ' ').slice(0, 50) || 'New task'
        db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, args.sessionId)
      }

      const project = db
        .prepare(`SELECT path FROM projects WHERE id = ?`)
        .get(args.projectId) as { path: string } | undefined

      let prompt = args.prompt
      if (args.injectMemory) {
        const block = knowledge.formatProjectContext(knowledge.getProjectContext(args.projectId))
        if (block) prompt = `${block}\n\n---\n\nTask:\n${args.prompt}`
      }

      // Resolve the knowledge MCP server paths for session/new.
      // Hermes (Linux) will spawn Windows node.exe via WSL interop.
      const mcpServers = await resolveHermesMcpServers()

      const controller = new AbortController()
      hermesAborts.set(args.sessionId, controller)

      const run = await runHermesPrompt({
        projectPath: project?.path ?? process.cwd(),
        prompt,
        mcpServers,
        signal: controller.signal,
        onEvent: (e: HermesEvent) => {
          win?.webContents.send('hermes:event', { sessionId: args.sessionId, event: e })
          if (e.kind === 'usage') win?.webContents.send('hermes:usage', { used: e.used, max: e.size })
          else if (e.kind === 'activity') emitActivity(win, 'HERMES', `${e.activity.kind}: ${e.activity.message.slice(0, 80)}`)
          else if (e.kind === 'error') emitActivity(win, 'HERMES', `Error: ${e.message.slice(0, 80)}`)
          else if (e.kind === 'model') emitActivity(win, 'HERMES', `Model: ${e.name}`)
        }
      })
      hermesAborts.delete(args.sessionId)

      // Persist the result. `run.text` is the assembled streaming response.
      insertMsg('assistant', run.text || run.error || '(no output)', 'hermes')

      let memorySaved = false
      if (run.ok || run.text) {
        const { title, content } = summarizeHermesRun(args.prompt, run)
        await knowledge.saveMemory({
          projectId: args.projectId,
          type: 'task',
          title,
          content,
          source: 'hermes',
          tags: ['hermes']
        })
        memorySaved = true
        win?.webContents.send('index:updated', { projectIds: [args.projectId] })
      }

      win?.webContents.send('hermes:done', {
        sessionId: args.sessionId,
        ok: run.ok,
        memorySaved,
        error: run.ok ? undefined : run.error
      })
      return run.text || null
    }
  )

  // ---- Terminal (Phase F) ----
  // node-pty is a native module — use require() so Electron-vite doesn't try to
  // bundle it. It must only be loaded in the main process.
  ipcMain.handle('terminal:create', (event, projectPath: string | null) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePty = require('node-pty') as typeof import('node-pty')
    const id = randomUUID()
    const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
    const cwd = projectPath && existsSync(projectPath) ? projectPath : process.cwd()
    const win = BrowserWindow.fromWebContents(event.sender)
    const pty = nodePty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as Record<string, string>
    })
    pty.onData((data: string) => {
      win?.webContents.send('terminal:data', { id, data })
    })
    pty.onExit(() => {
      ptyMap.delete(id)
      win?.webContents.send('terminal:exit', { id })
    })
    ptyMap.set(id, { pty, win })
    return { id }
  })

  ipcMain.handle('terminal:write', (_e, id: string, data: string) => {
    ptyMap.get(id)?.pty.write(data)
  })

  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    const entry = ptyMap.get(id)
    if (entry) {
      try { entry.pty.resize(Math.max(1, cols), Math.max(1, rows)) } catch {}
    }
  })

  ipcMain.handle('terminal:close', (_e, id: string) => {
    const entry = ptyMap.get(id)
    if (entry) {
      try { entry.pty.kill() } catch {}
      ptyMap.delete(id)
    }
  })

  // ---- Settings (typed app_meta wrapper; secrets are write-only to renderer) ---
  ipcMain.handle('settings:get', (_e, key: string) => publicSettingValue(key))

  ipcMain.handle('settings:getMany', (_e, keys: string[]) => {
    const out: Record<string, string | null> = {}
    for (const key of keys) out[key] = publicSettingValue(key)
    return out
  })

  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    const def = SETTING_DEFINITIONS[key]
    if (!def) throw new Error(`Unsupported setting: ${key}`)
    const clean = validateSetting(def, value)
    if (def.secret && !clean) deleteMeta(key)
    else writeMeta(key, clean)
  })

  ipcMain.handle('settings:setMany', (_e, values: Record<string, string>) => {
    for (const [key, value] of Object.entries(values)) {
      const def = SETTING_DEFINITIONS[key]
      if (!def) throw new Error(`Unsupported setting: ${key}`)
      const clean = validateSetting(def, value)
      if (def.secret && !clean) deleteMeta(key)
      else writeMeta(key, clean)
    }
  })

  ipcMain.handle('settings:delete', (_e, key: string) => {
    if (!SETTING_DEFINITIONS[key]) throw new Error(`Unsupported setting: ${key}`)
    deleteMeta(key)
  })

  ipcMain.handle('settings:summary', () => buildSettingsSnapshot())
  ipcMain.handle('settings:diagnostics', () => buildDiagnosticsReport())

  // ---- Web Companion ---------------------------------------------------------
  // Optional mobile Chat surface. This intentionally exposes only its own
  // lifecycle/config controls to the desktop renderer; browser clients get a
  // separate, authenticated, narrow HTTP API in webCompanion.ts.
  ipcMain.handle('webCompanion:status', () => getWebCompanionStatus())
  ipcMain.handle('webCompanion:configure', (_e, config: Partial<WebCompanionConfig>) =>
    configureWebCompanion(config)
  )
  ipcMain.handle('webCompanion:regenerateToken', () => regenerateWebCompanionToken())

  // ---- Research pipeline ------------------------------------------------------
  let researchController: AbortController | null = null

  ipcMain.handle('research:cancel', () => {
    researchController?.abort()
    researchController = null
  })

  ipcMain.handle(
    'research:start',
    async (
      event,
      args: {
        topic: string
        scope: 'web' | 'local' | 'both'
        projectId: string | null
        saveToProject: boolean
      }
    ) => {
      researchController?.abort()
      researchController = new AbortController()
      const signal = researchController.signal

      const emit = (stage: string, status: 'running' | 'done' | 'error', detail: string) => {
        if (event.sender.isDestroyed()) return
        event.sender.send('research:progress', { stage, status, detail })
      }

      try {
        // Stage 1: Plan
        emit('plan', 'running', 'Planning search queries...')

        const model = await defaultChatModel()
        if (!model) {
          emit('plan', 'error', 'No local model available. Start Ollama and pull a model.')
          return
        }
        if (signal.aborted) return

        let queries: string[] = [args.topic]
        if (args.scope !== 'local') {
          const planResult = await chat(
            model,
            [
              {
                role: 'system',
                content:
                  "You are a research assistant. Break down the user's research topic into 3-5 specific search queries that together would give comprehensive coverage. Return ONLY a JSON array of strings, no other text."
              },
              { role: 'user', content: `Topic: ${args.topic}` }
            ],
            30000
          )
          if (signal.aborted) return
          if (planResult) {
            try {
              const s = planResult.indexOf('[')
              const e = planResult.lastIndexOf(']')
              if (s !== -1 && e !== -1) {
                const parsed = JSON.parse(planResult.slice(s, e + 1))
                if (Array.isArray(parsed) && parsed.length > 0) {
                  queries = parsed.filter((q): q is string => typeof q === 'string').slice(0, 5)
                }
              }
            } catch { /* use topic as single query */ }
          }
        }

        emit('plan', 'done', `${queries.length} ${queries.length === 1 ? 'query' : 'queries'} ready`)
        if (signal.aborted) return

        // Stage 2: Search
        emit('search', 'running', 'Searching...')

        interface SearchResult { title: string; url: string; content: string; isLocal?: boolean }
        const allResults: SearchResult[] = []
        const seenUrls = new Set<string>()
        let webOk = true

        if (args.scope === 'web' || args.scope === 'both') {
          const searxngUrl = getSearxngUrl()
          for (const query of queries) {
            if (signal.aborted) return
            try {
              const searchUrl = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&engines=google,duckduckgo&language=en`
              const res = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) })
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              const data = await res.json() as {
                results?: Array<{ title?: string; url?: string; content?: string }>
              }
              for (const r of (data.results ?? []).slice(0, 5)) {
                const rUrl = r.url ?? ''
                if (!rUrl || seenUrls.has(rUrl)) continue
                seenUrls.add(rUrl)
                allResults.push({ title: r.title ?? rUrl, url: rUrl, content: r.content ?? '' })
              }
            } catch (e: any) {
              if (signal.aborted) return
              webOk = false
              emit(
                'search',
                'error',
                `SearXNG unreachable: ${e?.message ?? String(e)}. Falling back to local knowledge.`
              )
              break
            }
          }
        }

        // Local knowledge — always include if scope includes it, or if web failed
        if (args.scope === 'local' || args.scope === 'both' || !webOk) {
          const localItems = await knowledge.searchMemory(args.topic, 'project', args.projectId, 8)
          for (const item of localItems) {
            const kUrl = `knowledge://${item.id}`
            if (seenUrls.has(kUrl)) continue
            seenUrls.add(kUrl)
            allResults.push({
              title: item.title,
              url: kUrl,
              content: item.content,
              isLocal: true
            })
          }
        }

        if (signal.aborted) return

        if (allResults.length === 0) {
          emit('search', 'error', 'No results found. Check SearXNG or add local knowledge.')
          return
        }

        emit('search', 'done', `Found ${allResults.length} ${allResults.length === 1 ? 'result' : 'results'}`)

        // Stage 3: Read
        emit('read', 'running', `Reading sources (0/${allResults.length})...`)

        interface ProcessedSource { title: string; url: string; bullets: string }
        const processed: ProcessedSource[] = []

        for (let i = 0; i < allResults.length; i++) {
          if (signal.aborted) return
          const src = allResults[i]
          emit('read', 'running', `Reading sources (${i + 1}/${allResults.length})...`)

          let content = src.content
          if (!src.isLocal) {
            try {
              const pageRes = await fetch(src.url, {
                signal: AbortSignal.timeout(5000),
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai-workspace-research/1.0)' }
              })
              if (pageRes.ok) content = stripHtml(await pageRes.text())
            } catch { /* use SearXNG snippet */ }
          }

          const bullets = await chat(
            model,
            [
              {
                role: 'system',
                content: `Extract the most important facts, data points, and insights from this source relevant to: ${args.topic}. Be concise. Return 3-5 bullet points maximum.`
              },
              { role: 'user', content: `${src.title}\n${content.slice(0, 2000)}` }
            ],
            30000
          )
          if (signal.aborted) return
          processed.push({
            title: src.title,
            url: src.url,
            bullets: bullets ?? `- Source: ${src.title}`
          })
        }

        emit('read', 'done', `Analyzed ${processed.length} sources`)
        if (signal.aborted) return

        // Stage 4: Synthesize
        emit('synthesize', 'running', 'Synthesizing findings...')

        // Guard against prompts that exceed what small local models can handle.
        const MAX_FINDINGS_LEN = 6000
        let sourcesText = processed
          .map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.bullets}`)
          .join('\n\n')
        if (sourcesText.length > MAX_FINDINGS_LEN) {
          sourcesText = sourcesText.slice(0, MAX_FINDINGS_LEN) + '\n... [truncated for length]'
        }

        let reportBody: string | null = null
        try {
          reportBody = await chat(
            model,
            [
              {
                role: 'system',
                content:
                  'You are a research analyst. Write a comprehensive research report in markdown format. Include: a summary section, key findings with source citations, and a deeper analysis section. Use the sources provided. Be factual and cite sources by number.'
              },
              {
                role: 'user',
                content: `Topic: ${args.topic}\n\nSources and findings:\n${sourcesText}`
              }
            ],
            120000
          )
          if (reportBody === null) {
            console.error('[research] synthesis returned null — model may be unavailable or timed out')
          }
        } catch (err) {
          console.error('[research] synthesis error:', err)
        }
        if (signal.aborted) return

        const dateStr = new Date().toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })
        const sourcesList = processed.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n')

        // Fallback: structured bullet points grouped by source when the model didn't respond.
        const bodySection = reportBody ?? [
          '### Findings from Sources',
          '',
          processed.map(s => `**${s.title}**\n${s.bullets}`).join('\n\n'),
        ].join('\n')

        const fullReport = [
          `## ${args.topic}`,
          '',
          `*Researched ${dateStr} · ${processed.length} sources*`,
          '',
          bodySection,
          '',
          '### Sources',
          sourcesList,
        ].join('\n')

        emit('synthesize', 'done', 'Report ready')
        if (signal.aborted) return

        // Stage 5: Save
        emit('save', 'running', 'Saving to knowledge base...')

        let savedCount = 0
        try {
          await knowledge.saveMemory({
            projectId: args.saveToProject ? args.projectId : null,
            type: 'research',
            title: args.topic,
            content: fullReport,
            source: 'research',
            tags: ['research', 'deep-research']
          })
          savedCount++

          for (const src of processed.slice(0, 5)) {
            if (signal.aborted) break
            await knowledge.saveMemory({
              projectId: args.saveToProject ? args.projectId : null,
              type: 'research-finding',
              title: `${args.topic}: ${src.title}`.slice(0, 120),
              content: src.bullets,
              source: 'research',
              tags: ['research', 'finding']
            })
            savedCount++
          }
        } catch (e: any) {
          emit('save', 'error', `Save failed: ${e?.message ?? String(e)}`)
        }

        if (signal.aborted) return
        emit('save', 'done', `Saved ${savedCount} items to knowledge base`)
        emit('done', 'done', fullReport)
      } catch (e: any) {
        if (!signal.aborted) emit('error', 'error', e?.message ?? String(e))
      } finally {
        researchController = null
      }
    }
  )

  // ---- Layout presets ----
  type StoredPreset = { id: string; name: string; created_at: number; layout: unknown; openIds: string[]; workspaceId: string }

  function getStoredPresets(): StoredPreset[] {
    try {
      const raw = readMeta('layout_presets')
      if (!raw) return []
      return JSON.parse(raw) as StoredPreset[]
    } catch {
      return []
    }
  }

  ipcMain.handle('presets:list', () => getStoredPresets())

  ipcMain.handle('presets:save', (_e, name: string, layout: unknown, openIds: string[], workspaceId: string) => {
    const all = getStoredPresets()
    const preset: StoredPreset = { id: randomUUID(), name, created_at: Date.now(), layout, openIds, workspaceId }
    all.push(preset)
    writeMeta('layout_presets', JSON.stringify(all))
    return preset
  })

  ipcMain.handle('presets:load', (_e, id: string) => {
    return getStoredPresets().find(p => p.id === id) ?? null
  })

  ipcMain.handle('presets:delete', (_e, id: string) => {
    const filtered = getStoredPresets().filter(p => p.id !== id)
    writeMeta('layout_presets', JSON.stringify(filtered))
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  // ---- Instruction file editor ----
  ipcMain.handle('instructions:read', async (_e, filePath: string) => {
    try {
      if (!existsSync(filePath)) return { exists: false, content: '' }
      const content = readFileSync(filePath, 'utf-8')
      return { exists: true, content }
    } catch (err) {
      return { exists: false, content: '', error: String(err) }
    }
  })

  ipcMain.handle('instructions:write', async (_e, filePath: string, content: string) => {
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, content, 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('instructions:getPath', async (_e, agentId: string, projectPath: string) => {
    const fileNames: Record<string, string> = {
      'claudecode': 'CLAUDE.md',
      'hermes':     'HERMES.md',
      'codex':      'CODEX.md',
      'shared':     'AI.md',
      'app':        'D:\\ClaudeProjects\\ai-workspace\\CLAUDE.md'
    }
    const fileName = fileNames[agentId]
    if (!fileName) return null
    if (agentId === 'app') return fileName
    return join(projectPath, fileName)
  })

  // ---- MCP Registry proxy (renderer cannot fetch external URLs due to CSP) ----
  ipcMain.handle('registry:search', async (_e, query: string, cursor: string) => {
    const base = 'https://registry.modelcontextprotocol.io/v0'
    const cleanQuery = String(query ?? '').trim()
    const cleanCursor = String(cursor ?? '').trim()
    let url = `${base}/servers?limit=20`
    if (cleanQuery) url += `&search=${encodeURIComponent(cleanQuery)}`
    if (cleanCursor) url += `&cursor=${encodeURIComponent(cleanCursor)}`

    if (process.env.E2E_FAKE_REGISTRY === '1') {
      const fakeQuery = cleanQuery || 'github'
      return {
        servers: [{
          server: {
            id: `mock-${fakeQuery}-${cleanCursor || 'first'}`,
            name: `@modelcontextprotocol/server-${fakeQuery}`,
            title: `${fakeQuery} MCP Server`,
            description: `Mock registry result for ${fakeQuery}.`,
            packages: [{ registry_name: 'npm', name: `@modelcontextprotocol/server-${fakeQuery}`, version: '1.0.0' }],
            repository: { url: 'https://example.com/mcp' },
            updated_at: '2026-01-02T00:00:00.000Z'
          }
        }],
        metadata: { nextCursor: cleanCursor ? null : 'cursor-2' }
      }
    }

    let res: Response
    try {
      res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      })
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error('Registry request timed out. Try again in a moment.')
      }
      throw new Error(`Registry network failure: ${err?.message ?? String(err)}`)
    }

    if (!res.ok) throw new Error(`Registry returned HTTP ${res.status}`)

    let data: unknown
    try {
      data = await res.json()
    } catch {
      throw new Error('Registry returned invalid JSON.')
    }

    if (!data || typeof data !== 'object' || !Array.isArray((data as any).servers)) {
      throw new Error('Registry returned an unexpected response shape.')
    }
    const metadata = (data as any).metadata
    if (metadata !== undefined && (metadata === null || typeof metadata !== 'object')) {
      throw new Error('Registry returned invalid pagination metadata.')
    }
    return data
  })
}

// ---- MCP server path resolution --------------------------------------------
// Builds the mcpServers array for session/new so Hermes can reach the knowledge
// MCP server. Resolves paths lazily (once per send that needs them); errors are
// non-fatal (Hermes still works without MCP, just without shared memory).
async function resolveHermesMcpServers(): Promise<object[]> {
  if (process.platform !== 'win32') return []
  // Remote mode: Hermes runs on a native Linux machine over SSH, not WSL2.
  // It cannot reach the Windows-side node process for stdio MCP, and WSL interop
  // is unavailable on remote machines. The renderer handles memory injection
  // client-side instead (fetch + prepend context as a system message).
  if (getHermesConfig().mode === 'remote') return []
  try {
    const { execSync } = require('child_process') as typeof import('child_process')
    const { app } = require('electron') as typeof import('electron')
    const path = require('path') as typeof import('path')

    const nodeExe = execSync('where node', { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim()
    if (!nodeExe) throw new Error('node not found on PATH')

    // checkHermes() is already statically imported; use it to find the active distro.
    const check = await checkHermes()
    const distro = check.distro ?? 'Ubuntu'

    const nodeWsl = execSync(`wsl.exe -d ${distro} wslpath -a "${nodeExe}"`, { encoding: 'utf8' }).trim()
    const serverCjs = path.join(__dirname, '../mcp/server.cjs')
    const serverWin = serverCjs.replace(/\\/g, '/')
    const dbDir = app.getPath('userData').replace(/\\/g, '/')

    return [{
      name: 'ai-workspace-knowledge',
      command: nodeWsl,
      args: [serverWin],
      env: [{ name: 'AIWORKSPACE_DB_DIR', value: dbDir }]
    }]
  } catch (e) {
    console.warn('[hermes] resolveHermesMcpServers failed:', e)
    return []
  }
}
