import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { resolve, relative, isAbsolute } from 'path'
import { getDb } from './db'

// Hermes ACP (Agent Client Protocol) integration — Milestone 6.
//
// `hermes acp --accept-hooks` starts a JSON-RPC 2.0 server on its own stdio;
// we spawn it once (singleton) and reuse the process across sessions. Wire
// format: one JSON object per newline (NDJSON).
//
// Protocol flow per conversation turn:
//   us → initialize (once, on connect)
//   us → session/new  { cwd, mcpServers }  → { sessionId }
//   us → session/prompt { sessionId, prompt } → (blocks until done)
//   agent → session/update notifications (streaming chunks, `params.update`)
//   agent → session/request_permission, fs/*, terminal/* (we respond inline)
//
// Connection lifecycle: connect() on first send; auto-reconnects on crash.
// All state is scoped to the singleton; tests can call disconnectHermes() to
// reset between runs.

const IS_WIN = process.platform === 'win32'
const SSH_EXE = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'

// ---- Public types -----------------------------------------------------------

export interface RemoteHermesConfig {
  mode: 'local' | 'remote'
  sshHost: string
  sshUser: string
  sshKeyPath: string
  hermesPath: string
}

export interface HermesCheck {
  wsl2: boolean
  installed: boolean
  connected: boolean
  version?: string
  distro?: string
  error?: string
}

export interface HermesActivity {
  ts: number
  kind: string // 'tool' | 'thought' | 'plan' | 'error'
  message: string
}

export interface HermesPlanEntry {
  content: string
  status: string // 'pending' | 'in_progress' | 'completed' (per ACP `plan` update)
}

export type HermesEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'activity'; activity: HermesActivity }
  | { kind: 'error'; message: string }
  | { kind: 'model'; name: string }
  | { kind: 'usage'; used: number; size: number }
  | { kind: 'commands'; commands: Array<{ name: string; description: string; hint?: string }> }
  | { kind: 'plan'; entries: HermesPlanEntry[] }
  | { kind: 'permissionRequest'; request: HermesPermissionRequest }

// ---- Permission modes --------------------------------------------------------
// Configurable autonomy levels, modeled after Claude Code's permission modes.
// Mode 1 asks before everything; mode 5 asks only for genuinely dangerous ops.

export type HermesPermissionMode = 1 | 2 | 3 | 4 | 5
export type HermesActionKind = 'read' | 'create' | 'edit' | 'execute' | 'destructive' | 'catastrophic'

export interface HermesPermissionRequest {
  requestId: string
  action: HermesActionKind
  title: string
}

const DEFAULT_HERMES_PERMISSION_MODE: HermesPermissionMode = 3

// Kinds listed for a mode are the ones that still require approval at that mode.
// Anything not listed is auto-approved.
const APPROVAL_MATRIX: Record<HermesPermissionMode, ReadonlySet<HermesActionKind>> = {
  1: new Set(['read', 'create', 'edit', 'execute', 'destructive', 'catastrophic']),
  2: new Set(['edit', 'execute', 'destructive', 'catastrophic']),
  3: new Set(['execute', 'destructive', 'catastrophic']),
  4: new Set(['destructive', 'catastrophic']),
  5: new Set(['catastrophic']),
}

function hermesRequiresApproval(mode: HermesPermissionMode, kind: HermesActionKind): boolean {
  return APPROVAL_MATRIX[mode].has(kind)
}

// Smallest mode that would auto-approve this kind of action (catastrophic never
// auto-approves at any mode — the loop below falls through to 5, which still asks).
function modeThatAutoApproves(kind: HermesActionKind): HermesPermissionMode {
  for (const m of [1, 2, 3, 4, 5] as HermesPermissionMode[]) {
    if (!hermesRequiresApproval(m, kind)) return m
  }
  return 5
}

export function getHermesPermissionMode(): HermesPermissionMode {
  try {
    const db = getDb()
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('hermes_permission_mode') as
      | { value: string }
      | undefined
    const n = Number(row?.value)
    return (n >= 1 && n <= 5 ? n : DEFAULT_HERMES_PERMISSION_MODE) as HermesPermissionMode
  } catch {
    return DEFAULT_HERMES_PERMISSION_MODE
  }
}

export function setHermesPermissionMode(mode: HermesPermissionMode): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .run('hermes_permission_mode', String(mode))
}

// "Always allow this session" bumps the effective mode for the rest of the app
// session (our own session id, stable across turns) without touching the saved
// default. In-memory only — never persisted.
const sessionModeOverrides = new Map<string, HermesPermissionMode>()

function effectiveHermesMode(sessionId: string): HermesPermissionMode {
  const override = sessionModeOverrides.get(sessionId)
  const saved = getHermesPermissionMode()
  return override != null && override > saved ? override : saved
}

export function bumpHermesSessionOverride(sessionId: string, kind: HermesActionKind): void {
  const needed = modeThatAutoApproves(kind)
  const current = effectiveHermesMode(sessionId)
  if (needed > current) sessionModeOverrides.set(sessionId, needed)
}

// ---- Permission classification ------------------------------------------------
// Best-effort: the request_permission params shape isn't formally pinned down for
// this Hermes ACP build, so we read several plausible field names defensively.

const CATASTROPHIC_PATTERNS: RegExp[] = [
  /\bforce\b[\s\S]{0,20}\bpush\b/i,
  /\bpush\b[\s\S]{0,12}--force/i,
  /\bpush\b[\s\S]{0,6}(^|\s)-f(\s|$)/i,
  /rm\s+-rf\s+(\/|~|\*|\$HOME)/i,
  /del\s+\/s\s+\/q/i,
  /format\s+[a-z]:/i,
  /drop\s+(table|database)/i,
  /truncate\s+table/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-z]*d[a-z]*f/i
]

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/i, /\bdel\b/i, /\bremove-item\b/i, /\bunlink\b/i,
  /\bdrop\b/i, /\bkill\b/i, /\bshutdown\b/i, /\breboot\b/i,
  /\bchmod\b/i, /\bchown\b/i
]

function matchesAny(patterns: RegExp[], text: string): boolean {
  return text.length > 0 && patterns.some((re) => re.test(text))
}

function extractActionText(params: any): string {
  const toolCall = params?.toolCall ?? {}
  const rawInput = toolCall.rawInput ?? params?.rawInput ?? {}
  const parts = [
    toolCall.title, toolCall.description, params?.title, params?.description,
    rawInput.command, Array.isArray(rawInput.args) ? rawInput.args.join(' ') : rawInput.args
  ]
  return parts.filter((p) => typeof p === 'string' && p).join(' ')
}

function extractActionPath(params: any): string | undefined {
  const toolCall = params?.toolCall ?? {}
  const rawInput = toolCall.rawInput ?? params?.rawInput ?? {}
  const loc = Array.isArray(toolCall.locations) ? toolCall.locations[0] : undefined
  return loc?.path ?? rawInput.path ?? rawInput.file_path ?? params?.path
}

function classifyHermesAction(params: any): HermesActionKind {
  const text = extractActionText(params)
  if (matchesAny(CATASTROPHIC_PATTERNS, text)) return 'catastrophic'

  const rawKind = String(params?.toolCall?.kind ?? params?.kind ?? '').toLowerCase()

  if (rawKind === 'delete' || rawKind === 'move') return 'destructive'
  if (matchesAny(DESTRUCTIVE_PATTERNS, text)) return 'destructive'

  if (rawKind === 'read' || rawKind === 'search' || rawKind === 'think' || rawKind === 'fetch') return 'read'
  if (rawKind === 'edit') {
    const path = extractActionPath(params)
    if (path) {
      try { return existsSync(path) ? 'edit' : 'create' } catch { /* fall through to text heuristic */ }
    }
    return /\bcreate\b|\bnew file\b/i.test(text) ? 'create' : 'edit'
  }
  // 'execute', 'other', or unclassified — treat as a command run (conservative default).
  return 'execute'
}

function describeHermesAction(params: any, kind: HermesActionKind): string {
  const toolCall = params?.toolCall ?? {}
  const rawInput = toolCall.rawInput ?? params?.rawInput ?? {}
  const title: string | undefined = toolCall.title ?? params?.title
  if (title) return title
  const command: string | undefined = rawInput.command
  if (command) return `Run command \`${command}\``
  const path = extractActionPath(params)
  if (path) {
    const verb = kind === 'create' ? 'Create' : kind === 'edit' ? 'Edit' : kind === 'read' ? 'Read' : 'Delete'
    return `${verb} \`${path}\``
  }
  return `Perform a ${kind} action`
}

// This Hermes ACP build responds to permission requests with a plain
// `{ granted }` boolean. If a future build sends the richer ACP `options` array,
// respond in that shape instead so we don't silently break either variant.
function buildPermissionResult(params: any, approved: boolean): any {
  const options: any[] = Array.isArray(params?.options) ? params.options : []
  if (options.length > 0) {
    const wanted = approved ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
    const opt = options.find((o: any) => wanted.includes(o?.kind)) ?? options[0]
    return { outcome: { outcome: 'selected', optionId: opt?.optionId } }
  }
  return { granted: approved }
}

export interface AcpRunResult {
  ok: boolean
  text: string
  stopReason?: string
  error?: string
}

// ---- Config helpers ---------------------------------------------------------

export function getHermesConfig(): RemoteHermesConfig {
  try {
    const db = getDb()
    const get = (key: string): string => {
      const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined
      return row?.value ?? ''
    }
    return {
      mode: (get('hermes_mode') || 'local') as 'local' | 'remote',
      sshHost: get('hermes_ssh_host'),
      sshUser: get('hermes_ssh_user') || 'martin',
      sshKeyPath: get('hermes_ssh_key') || 'C:\\Users\\marti\\.ssh\\id_ed25519',
      hermesPath: get('hermes_hermes_path') || '/home/martin/.local/bin/hermes',
    }
  } catch {
    return { mode: 'local', sshHost: '', sshUser: 'martin', sshKeyPath: 'C:\\Users\\marti\\.ssh\\id_ed25519', hermesPath: '/home/martin/.local/bin/hermes' }
  }
}

// ---- SSH helpers ------------------------------------------------------------

function runSshCheck(config: RemoteHermesConfig): Promise<boolean> {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve(false)
    const args = [
      '-i', config.sshKeyPath,
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${config.sshUser}@${config.sshHost}`,
      `${config.hermesPath} acp --check`
    ]
    let stdout = ''
    let child: ChildProcess
    try {
      child = spawn(SSH_EXE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      return resolve(false)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => { stdout += d })
    child.stderr?.on('data', () => {}) // SSH connection noise — discard
    child.on('error', () => resolve(false))
    const t = setTimeout(() => {
      try { child.kill() } catch {}
      resolve(false)
    }, 10_000)
    child.on('close', (code) => {
      clearTimeout(t)
      resolve(code === 0 && stdout.includes('OK'))
    })
  })
}

export async function testHermesConnection(config?: RemoteHermesConfig): Promise<{ success: boolean; error?: string }> {
  const cfg = config ?? getHermesConfig()
  if (cfg.mode !== 'remote') return { success: false, error: 'Not in remote mode' }
  if (!cfg.sshHost) return { success: false, error: 'No SSH host configured' }
  const ok = await runSshCheck(cfg)
  return ok ? { success: true } : { success: false, error: 'Cannot reach remote Hermes via SSH' }
}

// ---- WSL helpers ------------------------------------------------------------

function runWsl(args: string[], timeoutMs = 8000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve({ code: null, out: '' })
    const stdout: Buffer[] = []
    let child: ChildProcess
    try {
      child = spawn('wsl.exe', args, { windowsHide: true })
    } catch {
      return resolve({ code: null, out: '' })
    }
    child.stdout?.on('data', (d: Buffer) => stdout.push(d))
    child.stderr?.on('data', () => {}) // discard — mixing stderr bytes misaligns UTF-16LE pairs
    child.on('error', () => resolve({ code: null, out: '' }))
    const t = setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ code: null, out: '' })
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out: Buffer.concat(stdout).toString('utf16le').replace(/\0/g, '') })
    })
  })
}

async function wslDistros(): Promise<string[]> {
  const { code, out } = await runWsl(['-l', '-q'])
  if (code !== 0) return []
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

function pickDistro(distros: string[]): string | undefined {
  return (
    distros.find((d) => /ubuntu/i.test(d)) ??
    distros.find((d) => !/docker/i.test(d)) ??
    distros[0]
  )
}

// ---- checkHermes ------------------------------------------------------------
// Quick when already connected (no WSL/SSH spawn). Expensive only on first call
// or after disconnection (needs to probe WSL + binary + config presence).

export async function checkHermes(): Promise<HermesCheck> {
  const config = getHermesConfig()

  console.error('[checkHermes] called, IS_WIN=%s mode=%s connected=%s', IS_WIN, config.mode, _client?.connected ?? false)

  if (_client?.connected) {
    if (config.mode === 'remote') {
      return { wsl2: false, installed: true, connected: true, version: _client.version }
    }
    return { wsl2: true, installed: true, connected: true, version: _client.version, distro: _client.distro }
  }

  if (config.mode === 'remote') {
    if (!config.sshHost) {
      return { wsl2: false, installed: false, connected: false, error: 'No SSH host configured' }
    }
    const ok = await runSshCheck(config)
    if (ok) return { wsl2: false, installed: true, connected: false }
    return { wsl2: false, installed: false, connected: false, error: 'Cannot reach remote Hermes' }
  }

  // Local mode
  if (!IS_WIN) {
    return { wsl2: true, installed: false, connected: false, error: 'Non-Windows: WSL2 not applicable.' }
  }

  const distros = await wslDistros()
  console.error('[checkHermes] distros=%j', distros)
  if (distros.length === 0) {
    return { wsl2: false, installed: false, connected: false, error: 'WSL2 was not detected on this machine.' }
  }
  const distro = pickDistro(distros)!

  // Check binary + config + marker via three separate exit-code-only calls.
  // No stdout read → no encoding issues. Each `test -f` exits 0 if the file exists.
  const [binR, markerR, cfgR] = await Promise.all([
    runWsl(['-d', distro, '--', 'test', '-f', '/home/marti/.local/bin/hermes']),
    runWsl(['-d', distro, '--', 'test', '-f', '/home/marti/.ai-workspace-hermes/installed']),
    runWsl(['-d', distro, '--', 'test', '-f', '/home/marti/.hermes/config.yaml']),
  ])
  console.error('[checkHermes] bin=%s marker=%s cfg=%s', binR.code, markerR.code, cfgR.code)
  const hasBin = binR.code === 0
  const hasCfg = cfgR.code === 0
  const hasMarker = markerR.code === 0

  if (!hasBin || !hasMarker) {
    return {
      wsl2: true, installed: false, connected: false, distro,
      error: 'Hermes is not installed. Run scripts/setup-hermes.ps1.'
    }
  }
  if (!hasCfg) {
    return {
      wsl2: true, installed: false, connected: false, distro,
      error: 'Hermes binary found but config missing (~/.hermes/config.yaml). Re-run setup-hermes.ps1.'
    }
  }

  return { wsl2: true, installed: true, connected: false, distro, error: 'Hermes is not connected yet.' }
}

// ---- ACP client class -------------------------------------------------------

type PendingEntry = { resolve: (v: any) => void; reject: (e: Error) => void }

class HermesAcpClient {
  readonly distro: string
  private config: RemoteHermesConfig
  private proc: ChildProcess | null = null
  private nextId = 0
  private pending = new Map<number, PendingEntry>()
  // ACP session id → listener for session/update notifications
  private updateListeners = new Map<string, (update: any) => void>()
  // ACP session id → raw event sink, used for out-of-band events (permission requests)
  private eventListeners = new Map<string, (e: HermesEvent) => void>()
  // ACP session id → our own (stable, cross-turn) session id, for permission-mode lookups
  private ourSessionByAcp = new Map<string, string>()
  // ACP session id → project root (Windows path) used for fs/* path confinement
  private projectPathByAcp = new Map<string, string>()
  // requestId (ours) → the ACP request awaiting a renderer decision
  private pendingPermissions = new Map<string, { msgId: number; params: any }>()
  private buf = ''
  private _version?: string
  private _connected = false

  constructor(config: RemoteHermesConfig, distro = 'Ubuntu') {
    this.config = config
    this.distro = config.mode === 'remote' ? '' : distro
  }

  get connected(): boolean { return this._connected }
  get version(): string | undefined { return this._version }

  async connect(): Promise<void> {
    if (this._connected) return

    if (this.config.mode === 'remote') {
      const args = [
        '-i', this.config.sshKeyPath,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=yes',
        '-o', 'ServerAliveInterval=30',
        `${this.config.sshUser}@${this.config.sshHost}`,
        `${this.config.hermesPath} acp --accept-hooks`
      ]
      try {
        this.proc = spawn(SSH_EXE, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (e: any) {
        throw new Error(`Failed to spawn SSH: ${e?.message ?? e}`)
      }
    } else {
      const cmd = 'export PATH="$HOME/.local/bin:$PATH"; exec hermes acp --accept-hooks'
      try {
        this.proc = spawn('wsl.exe', ['-d', this.distro, '--', 'bash', '-lc', cmd], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (e: any) {
        throw new Error(`Failed to spawn hermes acp: ${e?.message ?? e}`)
      }
    }

    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk))
    // stderr: SSH prints "Warning: Permanently added..." and other noise — log but never parse as ACP
    this.proc.stderr!.on('data', (d: Buffer | string) => {
      const msg = (typeof d === 'string' ? d : d.toString()).trim()
      if (msg) console.error('[hermes stderr]', msg)
    })
    this.proc.on('close', () => this.onClose())
    this.proc.on('error', (e: any) => {
      this._connected = false
      for (const [, h] of this.pending) h.reject(new Error(`ACP error: ${e?.message ?? e}`))
      this.pending.clear()
    })

    // Give the process 600 ms to start before sending initialize
    await delay(600)
    if (!this.proc || this.proc.killed) throw new Error('hermes acp exited immediately after spawn')

    // Remote Hermes can take up to ~60s to start (Linear MCP OAuth, tool registration)
    const initTimeout = this.config.mode === 'remote' ? 120_000 : 10_000
    const resp = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'ai-workspace', version: '1.0.0' },
      capabilities: {}
    }, initTimeout)

    this._version = resp?.agentInfo?.version
    this._connected = true
  }

  disconnect(): void {
    this._connected = false
    try { this.proc?.kill() } catch {}
    this.proc = null
  }

  async newSession(cwd: string, mcpServers: object[] = []): Promise<{ sessionId: string; modelName?: string }> {
    const result = await this.request('session/new', { cwd, mcpServers }, 20_000)
    const models: any[] = result?.availableModels ?? []
    const currentId: string = result?.currentModelId ?? ''
    const matched = models.find((m: any) => m.id === currentId)
    const raw = matched?.name ?? matched?.id ?? currentId
    const modelName: string | undefined = raw || undefined
    this.projectPathByAcp.set(result.sessionId, cwd)
    return { sessionId: result.sessionId, modelName }
  }

  async sendPrompt(
    acpSessionId: string,
    text: string,
    onEvent: (e: HermesEvent) => void,
    signal?: AbortSignal,
    ourSessionId?: string
  ): Promise<{ stopReason: string; text: string }> {
    let assembled = ''

    this.eventListeners.set(acpSessionId, onEvent)
    this.ourSessionByAcp.set(acpSessionId, ourSessionId ?? acpSessionId)

    this.updateListeners.set(acpSessionId, (update: any) => {
      const su: string = update?.sessionUpdate ?? ''
      if (su === 'agent_message_chunk') {
        const t = update?.content?.text
        if (typeof t === 'string' && t) {
          assembled += t
          onEvent({ kind: 'text', text: t })
        }
      } else if (su === 'agent_thought_chunk') {
        const t = update?.content?.text
        if (typeof t === 'string' && t) {
          onEvent({ kind: 'thought', text: t })
        }
      } else if (su === 'tool_call_update') {
        const name: string = update?.toolName ?? update?.name ?? 'tool'
        const args = update?.args ? JSON.stringify(update.args).slice(0, 100) : ''
        onEvent({ kind: 'activity', activity: { ts: Date.now(), kind: 'tool', message: args ? `${name}(${args})` : name } })
      } else if (su === 'tool_call') {
        // Tool completed - show a brief result note
        const name: string = update?.toolName ?? update?.name ?? 'tool'
        const res = String(update?.result ?? '').slice(0, 120)
        if (res) onEvent({ kind: 'activity', activity: { ts: Date.now(), kind: 'tool', message: `✓ ${name}: ${res}` } })
      } else if (su === 'plan') {
        const entries: any[] = update?.entries ?? []
        const active = entries.find((e: any) => e.status === 'in_progress') ?? entries[0]
        if (active?.content) {
          onEvent({ kind: 'activity', activity: { ts: Date.now(), kind: 'plan', message: active.content } })
        }
        if (entries.length > 0) {
          onEvent({
            kind: 'plan',
            entries: entries.map((e: any) => ({ content: String(e.content ?? ''), status: String(e.status ?? 'pending') }))
          })
        }
      } else if (su === 'usage_update') {
        const size: number = update?.size ?? 0
        const used: number = update?.used ?? 0
        if (size > 0) onEvent({ kind: 'usage', used, size })
      } else if (su === 'available_commands_update') {
        const cmds: any[] = update?.availableCommands ?? []
        if (cmds.length > 0) {
          onEvent({
            kind: 'commands',
            commands: cmds.map((c: any) => ({
              name: String(c.name ?? ''),
              description: String(c.description ?? ''),
              hint: c.input?.hint ? String(c.input.hint) : undefined
            }))
          })
        }
      }
    })

    if (signal) {
      signal.addEventListener('abort', () => {
        this.cancelSession(acpSessionId)
        this.updateListeners.delete(acpSessionId)
      }, { once: true })
    }

    try {
      const result = await this.request('session/prompt', { sessionId: acpSessionId, prompt: [{ type: 'text', text }] }, 15 * 60_000)
      return { stopReason: result?.stopReason ?? 'end_turn', text: assembled }
    } finally {
      this.updateListeners.delete(acpSessionId)
      this.eventListeners.delete(acpSessionId)
      this.ourSessionByAcp.delete(acpSessionId)
    }
  }

  // Called from the renderer (via IPC) once the user has decided on a pending
  // permission request. Returns false if the request is unknown (e.g. already
  // resolved, or the process restarted since it was raised).
  respondPermission(requestId: string, approved: boolean): boolean {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return false
    this.pendingPermissions.delete(requestId)
    this.sendLine({ jsonrpc: '2.0', id: pending.msgId, result: buildPermissionResult(pending.params, approved) })
    return true
  }

  cancelSession(acpSessionId: string): void {
    if (!this._connected) return
    this.sendNotification('session/cancel', { sessionId: acpSessionId })
  }

  // ---- private ---------------------------------------------------------------

  private onClose(): void {
    this._connected = false
    this.proc = null
    for (const [, h] of this.pending) h.reject(new Error('Hermes ACP process exited'))
    this.pending.clear()
    this.updateListeners.clear()
    this.eventListeners.clear()
    this.ourSessionByAcp.clear()
    this.pendingPermissions.clear()
    this.buf = ''
  }

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v) },
        reject: (e) => { clearTimeout(t); reject(e) }
      })
      this.sendLine({ jsonrpc: '2.0', id, method, params })
    })
  }

  private sendNotification(method: string, params: unknown): void {
    this.sendLine({ jsonrpc: '2.0', method, params })
  }

  private sendLine(msg: object): void {
    if (!this.proc?.stdin?.writable) return
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n')
    } catch { /* process died */ }
  }

  private onData(chunk: string): void {
    this.buf += chunk
    const lines = this.buf.split('\n')
    this.buf = lines.pop()!
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { this.handleMessage(JSON.parse(trimmed)) } catch { /* bad JSON */ }
    }
  }

  private handleMessage(msg: any): void {
    const method: string | undefined = msg.method
    const hasId = 'id' in msg

    // Notification from agent: streaming session update
    if (method === 'session/update' && !hasId) {
      const sessionId: string = msg.params?.sessionId ?? ''
      const update = msg.params?.update        // singular per ACP spec
      if (update) this.updateListeners.get(sessionId)?.call(null, update)
      return
    }

    // Agent-side request — we must respond (permissions, file I/O, terminal)
    if (method && hasId) {
      this.handleAgentRequest(msg)
      return
    }

    // Response to one of our requests
    if (hasId) {
      const h = this.pending.get(msg.id)
      if (!h) return
      this.pending.delete(msg.id)
      if ('error' in msg) {
        const err = msg.error
        h.reject(new Error(`ACP ${err?.code}: ${err?.message}${err?.data ? ' – ' + JSON.stringify(err.data) : ''}`))
      } else {
        h.resolve(msg.result)
      }
    }
  }

  private handleAgentRequest(msg: any): void {
    const { id, method, params } = msg
    if (method === 'session/request_permission') {
      this.handlePermissionRequest(id, params)
    } else if (method === 'fs/read_text_file') {
      // Serve file content for in-project paths; empty string for anything else
      const filePath: string = params?.path ?? params?.uri ?? ''
      let content = ''
      try {
        const { readFileSync } = require('fs') as typeof import('fs')
        content = readFileSync(filePath.startsWith('/mnt/') ? filePath : filePath, 'utf8')
      } catch {}
      this.sendLine({ jsonrpc: '2.0', id, result: { content } })
    } else if (method === 'fs/write_text_file') {
      // The OS-level write already happened; this just acknowledges the RPC
      this.sendLine({ jsonrpc: '2.0', id, result: {} })
    } else if (method?.startsWith('terminal/')) {
      this.sendLine({ jsonrpc: '2.0', id, result: null })
    } else {
      this.sendLine({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
    }
  }

  // Gate on the current permission mode (global default, bumped by any
  // "always allow this session" override). Read-only/create actions stay
  // auto-approved in the default mode so the common path never blocks on UI.
  private handlePermissionRequest(id: number, params: any): void {
    const acpSessionId: string = params?.sessionId ?? ''
    const ourSessionId = this.ourSessionByAcp.get(acpSessionId) ?? acpSessionId
    const kind = classifyHermesAction(params)
    const mode = effectiveHermesMode(ourSessionId)

    if (!hermesRequiresApproval(mode, kind)) {
      this.sendLine({ jsonrpc: '2.0', id, result: buildPermissionResult(params, true) })
      return
    }

    const requestId = randomUUID()
    this.pendingPermissions.set(requestId, { msgId: id, params })
    const title = describeHermesAction(params, kind)
    this.eventListeners.get(acpSessionId)?.({ kind: 'permissionRequest', request: { requestId, action: kind, title } })
  }
}

// ---- Singleton + exported API ----------------------------------------------

let _client: HermesAcpClient | null = null

export async function connectHermes(distro = 'Ubuntu'): Promise<{ connected: boolean; version?: string; error?: string }> {
  const config = getHermesConfig()
  try {
    if (_client?.connected) return { connected: true, version: _client.version }
    // Recreate client so it picks up the current config (mode, SSH settings, distro)
    if (_client) { _client.disconnect(); _client = null }
    _client = new HermesAcpClient(config, config.mode === 'local' ? distro : 'remote')
    await _client.connect()
    return { connected: true, version: _client.version }
  } catch (e: any) {
    _client = null
    return { connected: false, error: e?.message ?? String(e) }
  }
}

export function disconnectHermes(): void {
  _client?.disconnect()
  _client = null
}

export function hermesConnected(): boolean {
  return _client?.connected ?? false
}

export function hermesVersion(): string | undefined {
  return _client?.version
}

// ---- runHermesPrompt -------------------------------------------------------
// Connect if needed, open an ACP session, send the prompt, stream events back.

export async function runHermesPrompt(opts: {
  sessionId: string
  projectPath: string
  prompt: string
  mcpServers?: object[]
  onEvent: (e: HermesEvent) => void
  signal?: AbortSignal
  distro?: string
}): Promise<AcpRunResult> {
  // Ensure connected
  if (!_client?.connected) {
    const r = await connectHermes(opts.distro ?? 'Ubuntu')
    if (!r.connected) {
      return { ok: false, text: '', error: r.error ?? 'Failed to connect to Hermes.' }
    }
  }

  let acpSessionId: string
  try {
    const session = await _client!.newSession(opts.projectPath, opts.mcpServers ?? [])
    acpSessionId = session.sessionId
    if (session.modelName) opts.onEvent({ kind: 'model', name: session.modelName })
  } catch (e: any) {
    return { ok: false, text: '', error: `session/new failed: ${e?.message ?? e}` }
  }

  try {
    const { stopReason, text } = await _client!.sendPrompt(
      acpSessionId,
      opts.prompt,
      opts.onEvent,
      opts.signal,
      opts.sessionId
    )
    return { ok: true, text, stopReason }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    opts.onEvent({ kind: 'error', message: msg })
    return { ok: false, text: '', error: msg }
  }
}

// Resolve a pending permission request raised by the current Hermes run (if
// any). Returns false if the request is unknown — e.g. the client reconnected
// since the request was raised, or the renderer double-fired the response.
export function respondHermesPermission(requestId: string, approved: boolean): boolean {
  return _client?.respondPermission(requestId, approved) ?? false
}

// ---- summarize for durable memory ------------------------------------------

export function summarizeHermesRun(
  prompt: string,
  run: AcpRunResult
): { title: string; content: string } {
  const lines = [`Task: ${prompt.trim()}`]
  lines.push(`Status: ${run.ok ? 'completed' : 'failed'}`)
  if (run.stopReason && run.stopReason !== 'end_turn') lines.push(`Stop: ${run.stopReason}`)
  const outcome = (run.text || '').trim()
  if (outcome) lines.push(`Outcome: ${outcome.length > 600 ? outcome.slice(0, 600) + '…' : outcome}`)
  if (!run.ok && run.error) lines.push(`Error: ${run.error}`)
  return {
    title: `Hermes: ${prompt.trim().slice(0, 56) || 'task'}`,
    content: lines.join('\n')
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
