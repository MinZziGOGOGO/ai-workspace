import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { resolve, relative, isAbsolute } from 'path'
import { getDb } from './db'
import { isE2EFakeEnabled } from './e2e'

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

function isFakeHermes(): boolean {
  return isE2EFakeEnabled('E2E_FAKE_HERMES')
}

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
  toolName?: string
  status?: 'running' | 'done' | 'error'
  args?: unknown
  result?: string
  details?: unknown
}

export interface HermesPlanEntry {
  content: string
  status: string // 'pending' | 'in_progress' | 'completed' (per ACP `plan` update)
}

// A model as advertised by `session/new` / `session/load`. `id` is the raw ACP
// id (provider-prefixed, e.g. `custom:gemma4:12b`); `switchId` is what we must
// actually send to `session/set_model` — see toSwitchableModelId().
export interface HermesModelInfo {
  id: string
  switchId: string
  name: string
  description?: string
}

// Effort levels accepted by Hermes's parse_reasoning_effort (hermes_constants.py).
// 'default' is our own passthrough: don't send a config option at all.
export const HERMES_EFFORT_LEVELS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type HermesEffort = (typeof HERMES_EFFORT_LEVELS)[number]

export function isHermesEffort(value: string): value is HermesEffort {
  return (HERMES_EFFORT_LEVELS as readonly string[]).includes(value)
}

// Hermes's own `parse_model_input` splits a model id on the LAST colon, so the
// provider-prefixed ids it advertises round-trip incorrectly whenever the model
// name itself contains a colon — every Ollama tag does. Verified against 0.16.0:
// sending `custom:gemma4:12b` leaves the session on model "12b" with provider
// "auto" (a broken agent), while sending the bare `gemma4:12b` switches cleanly
// and keeps the session's provider. So: strip the provider prefix when the
// remaining name still contains a colon; otherwise the full id is safe and
// preserves cross-provider switches (e.g. `anthropic:claude-opus-4-8`).
export function toSwitchableModelId(rawId: string): string {
  const firstColon = rawId.indexOf(':')
  if (firstColon < 0) return rawId
  const bare = rawId.slice(firstColon + 1)
  return bare.includes(':') ? bare : rawId
}

export type HermesEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'activity'; activity: HermesActivity }
  | { kind: 'error'; message: string }
  | { kind: 'model'; name: string }
  | { kind: 'models'; models: HermesModelInfo[]; currentId: string }
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

function compactJson(value: unknown, max = 220): string {
  if (value === undefined || value === null || value === '') return ''
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    return raw.length > max ? `${raw.slice(0, max - 3)}...` : raw
  } catch {
    return String(value)
  }
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function toolNameFromUpdate(update: any): string {
  const toolCall = update?.toolCall ?? update?.tool_call ?? update?.call ?? {}
  const rawInput = toolCall.rawInput ?? toolCall.input ?? update?.rawInput ?? update?.input ?? update?.args ?? {}
  const name = firstText(
    update?.toolName,
    update?.tool_name,
    update?.name,
    update?.title,
    toolCall.name,
    toolCall.toolName,
    toolCall.title,
    rawInput.command,
    rawInput.path,
    rawInput.file_path,
    rawInput.query
  )
  if (name && name.toLowerCase() !== 'tool') return name
  return 'Remote tool'
}

function toolArgsFromUpdate(update: any): unknown {
  const toolCall = update?.toolCall ?? update?.tool_call ?? update?.call ?? {}
  return update?.args ?? update?.input ?? update?.params ?? toolCall.rawInput ?? toolCall.input ?? undefined
}

function toolResultFromUpdate(update: any): string {
  return compactJson(update?.result ?? update?.output ?? update?.response ?? update?.content?.text ?? update?.error, 480)
}

function planEntriesFromUpdate(update: any): HermesPlanEntry[] {
  const candidates = [
    update?.entries,
    update?.plan?.entries,
    update?.plan,
    update?.todos,
    update?.tasks,
    update?.items,
    update?.content?.entries
  ]
  const rawEntries = candidates.find((value) => Array.isArray(value)) as any[] | undefined
  if (!rawEntries) return []
  return rawEntries
    .map((entry) => ({
      content: String(entry?.content ?? entry?.title ?? entry?.text ?? entry?.description ?? '').trim(),
      status: String(entry?.status ?? entry?.state ?? (entry?.done ? 'completed' : 'pending')).trim() || 'pending'
    }))
    .filter((entry) => entry.content)
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

// ---- Per-session Hermes settings (persisted) --------------------------------
// Columns added in db.ts: hermes_acp_session_id, hermes_model, hermes_effort.

export interface HermesSessionSettings {
  acpSessionId?: string
  model?: string
  effort?: HermesEffort
}

export function getHermesSessionSettings(sessionId: string): HermesSessionSettings {
  try {
    const row = getDb()
      .prepare('SELECT hermes_acp_session_id, hermes_model, hermes_effort FROM sessions WHERE id = ?')
      .get(sessionId) as { hermes_acp_session_id?: string; hermes_model?: string; hermes_effort?: string } | undefined
    const effort = row?.hermes_effort
    return {
      acpSessionId: row?.hermes_acp_session_id || undefined,
      model: row?.hermes_model || undefined,
      effort: effort && isHermesEffort(effort) ? effort : undefined
    }
  } catch {
    return {}
  }
}

function updateHermesSessionColumn(sessionId: string, column: 'hermes_acp_session_id' | 'hermes_model' | 'hermes_effort', value: string | null): void {
  try {
    getDb().prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run(value, sessionId)
  } catch {
    /* session row may not exist yet (first turn creates it) — non-fatal */
  }
}

export function setHermesSessionModel(sessionId: string, model: string): void {
  updateHermesSessionColumn(sessionId, 'hermes_model', model || null)
}

export function setHermesSessionEffort(sessionId: string, effort: HermesEffort): void {
  updateHermesSessionColumn(sessionId, 'hermes_effort', effort === 'default' ? null : effort)
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
  if (isFakeHermes()) {
    return { wsl2: true, installed: true, connected: true, version: 'fake-hermes', distro: 'Ubuntu' }
  }
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
  // ACP session id → collector that swallows agent text while a slash command
  // is in flight, so command output never reaches the turn transcript.
  private commandSinks = new Map<string, { text: string }>()
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

  // `session/new` and `session/load` both answer with a `models` block
  // ({ availableModels, currentModelId }) — verified against 0.16.0, which
  // returns the live Ollama catalog for the `custom` provider. Earlier versions
  // of this client read `result.availableModels` (one level too shallow) and so
  // always fell back to an empty list.
  private static readModelState(result: any): { models: HermesModelInfo[]; currentId: string; currentName?: string } {
    const block = result?.models ?? result ?? {}
    const raw: any[] = Array.isArray(block.availableModels) ? block.availableModels : []
    const currentId: string = String(block.currentModelId ?? '')
    const models: HermesModelInfo[] = raw
      .map((m: any) => {
        const id = String(m?.modelId ?? m?.id ?? '')
        return {
          id,
          switchId: toSwitchableModelId(id),
          name: String(m?.name ?? id),
          description: typeof m?.description === 'string' ? m.description : undefined
        }
      })
      .filter((m) => m.id)
    const current = models.find((m) => m.id === currentId)
    return { models, currentId, currentName: current?.name || currentId || undefined }
  }

  async newSession(cwd: string, mcpServers: object[] = []): Promise<{ sessionId: string; modelName?: string; models: HermesModelInfo[]; currentId: string }> {
    const result = await this.request('session/new', { cwd, mcpServers }, 20_000)
    const state = HermesAcpClient.readModelState(result)
    this.projectPathByAcp.set(result.sessionId, cwd)
    return { sessionId: result.sessionId, modelName: state.currentName, models: state.models, currentId: state.currentId }
  }

  // Re-attach to a previously created ACP session. Hermes replays the whole
  // prior conversation as `session/update` notifications *before* answering
  // (per the ACP spec) — we deliberately call this with no turn listener
  // registered so that replay is discarded instead of being appended to the
  // transcript we already have in SQLite.
  // Returns null when the id is unknown to Hermes (e.g. its state.db was reset).
  async loadSession(acpSessionId: string, cwd: string, mcpServers: object[] = []): Promise<{ modelName?: string; models: HermesModelInfo[]; currentId: string } | null> {
    try {
      const result = await this.request('session/load', { sessionId: acpSessionId, cwd, mcpServers }, 60_000)
      if (result == null) return null
      const state = HermesAcpClient.readModelState(result)
      this.projectPathByAcp.set(acpSessionId, cwd)
      return { modelName: state.currentName, models: state.models, currentId: state.currentId }
    } catch {
      return null
    }
  }

  async setModel(acpSessionId: string, modelId: string): Promise<void> {
    // Rebuilding the agent can take a moment on first use; 0.16.0 answered in
    // ~850ms locally, but a cold provider resolve is slower.
    await this.request('session/set_model', { sessionId: acpSessionId, modelId }, 60_000)
  }

  async setReasoningEffort(acpSessionId: string, effort: HermesEffort): Promise<void> {
    if (effort === 'default') return
    await this.request(
      'session/set_config_option',
      { sessionId: acpSessionId, configId: 'reasoning_effort', value: effort },
      60_000
    )
  }

  // Run one of Hermes's own slash commands (/context, /compact, /steer …).
  // These travel as an ordinary `session/prompt`; the adapter intercepts any
  // text starting with '/' and answers locally without calling the model, so
  // this is safe to issue *concurrently with a live turn* — which is exactly
  // how /steer is meant to be used (measured: 3ms while a turn was running).
  //
  // The reply comes back as an `agent_message_chunk` on the same session, i.e.
  // on the same stream as the live turn's output. We divert chunks into a sink
  // for the (very short) duration of the command so the command's own text
  // never lands in the transcript. Any live-turn text emitted inside that
  // window is diverted too; the window is milliseconds, and the alternative
  // (leaking "⏩ Steer queued…" into the conversation) is worse.
  async runCommand(acpSessionId: string, command: string): Promise<string> {
    const sink = { text: '' }
    this.commandSinks.set(acpSessionId, sink)
    try {
      await this.request('session/prompt', { sessionId: acpSessionId, prompt: [{ type: 'text', text: command }] }, 120_000)
    } finally {
      this.commandSinks.delete(acpSessionId)
    }
    return sink.text.trim()
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
      const inferredPlanEntries = planEntriesFromUpdate(update)
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
        const name = toolNameFromUpdate(update)
        const args = toolArgsFromUpdate(update)
        const argsPreview = compactJson(args, 100)
        const note = firstText(update?.content?.text, update?.message, update?.description, update?.statusText)
        onEvent({
          kind: 'activity',
          activity: {
            ts: Date.now(),
            kind: 'tool',
            message: argsPreview ? `${name}(${argsPreview})` : note ?? name,
            toolName: name === 'Remote tool' && note ? undefined : name,
            status: 'running',
            args,
            details: update
          }
        })
      } else if (su === 'tool_call') {
        // Tool completed - show a brief result note
        const name = toolNameFromUpdate(update)
        const res = toolResultFromUpdate(update)
        if (res) {
          onEvent({
            kind: 'activity',
            activity: {
              ts: Date.now(),
              kind: 'tool',
              message: `✓ ${name}: ${res}`,
              toolName: name,
              status: 'done',
              result: res,
              details: update
            }
          })
        } else {
          onEvent({
            kind: 'activity',
            activity: {
              ts: Date.now(),
              kind: 'tool',
              message: `✓ ${name}`,
              toolName: name,
              status: 'done',
              details: update
            }
          })
        }
      } else if (su === 'plan' || su === 'plan_update' || su === 'task_list' || su === 'todo_update' || inferredPlanEntries.length > 0) {
        const entries = inferredPlanEntries
        const active = entries.find((e: any) => e.status === 'in_progress') ?? entries[0]
        if (active?.content) {
          onEvent({ kind: 'activity', activity: { ts: Date.now(), kind: 'plan', message: active.content } })
        }
        if (entries.length > 0) {
          onEvent({
            kind: 'plan',
            entries
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
    this.projectPathByAcp.clear()
    this.pendingPermissions.clear()
    this.commandSinks.clear()
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
      if (!update) return
      // A slash command in flight claims the agent's text output: its reply
      // arrives on the same stream as any live turn, and it must not reach the
      // transcript. Handled here rather than in the turn listener because
      // commands are usually issued while the session is idle, when no turn
      // listener exists at all.
      const sink = this.commandSinks.get(sessionId)
      if (sink && update?.sessionUpdate === 'agent_message_chunk') {
        const t = update?.content?.text
        if (typeof t === 'string') sink.text += t
        return
      }
      this.updateListeners.get(sessionId)?.call(null, update)
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

  // Returns the resolved absolute Windows path when requestedPath is inside
  // projectPath, or null if it would escape the root (same algorithm as
  // normalizeWorkspacePath in ipc.ts — kept separate to avoid a circular import).
  // Handles WSL /mnt/X/ paths by converting them to Windows drive paths first.
  private static confineToProject(projectPath: string, requestedPath: string): string | null {
    if (!projectPath || !requestedPath) return null
    const p = IS_WIN && requestedPath.startsWith('/mnt/')
      ? (() => {
          const m = requestedPath.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i)
          return m ? `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}` : requestedPath
        })()
      : requestedPath
    const root = resolve(projectPath)
    const target = isAbsolute(p) ? resolve(p) : resolve(root, p)
    const rel = relative(root, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    return target
  }

  private handleAgentRequest(msg: any): void {
    const { id, method, params } = msg
    if (method === 'session/request_permission') {
      this.handlePermissionRequest(id, params)
    } else if (method === 'fs/read_text_file') {
      const filePath: string = params?.path ?? params?.uri ?? ''
      const acpSessionId: string = params?.sessionId ?? ''
      const projectPath =
        this.projectPathByAcp.get(acpSessionId) ??
        (this.projectPathByAcp.size === 1 ? [...this.projectPathByAcp.values()][0] : undefined)
      const safePath = projectPath ? HermesAcpClient.confineToProject(projectPath, filePath) : undefined
      if (!safePath) {
        console.error('[hermes] fs/read_text_file denied – path outside project root:', filePath)
        this.sendLine({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Path outside project root' } })
        return
      }
      let content = ''
      try { content = readFileSync(safePath, 'utf8') } catch {}
      this.sendLine({ jsonrpc: '2.0', id, result: { content } })
    } else if (method === 'fs/write_text_file') {
      // The OS-level write is performed by Hermes in WSL; this handler only vets
      // the path and acknowledges. Still confine to project root for consistency.
      const filePath: string = params?.path ?? params?.uri ?? ''
      const acpSessionId: string = params?.sessionId ?? ''
      const projectPath =
        this.projectPathByAcp.get(acpSessionId) ??
        (this.projectPathByAcp.size === 1 ? [...this.projectPathByAcp.values()][0] : undefined)
      const safePath = projectPath ? HermesAcpClient.confineToProject(projectPath, filePath) : undefined
      if (!safePath) {
        console.error('[hermes] fs/write_text_file denied – path outside project root:', filePath)
        this.sendLine({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Path outside project root' } })
        return
      }
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
const fakePermissionRequests = new Map<string, (approved: boolean) => void>()

export async function connectHermes(distro = 'Ubuntu'): Promise<{ connected: boolean; version?: string; error?: string }> {
  if (isFakeHermes()) return { connected: true, version: 'fake-hermes' }
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
  if (isFakeHermes()) return true
  return _client?.connected ?? false
}

export function hermesVersion(): string | undefined {
  return _client?.version
}

// ---- Session reuse ----------------------------------------------------------
// One ACP session per app session, not one per turn. `session/new` on every
// prompt (the previous behavior) meant Hermes started from zero each time: no
// server-side history, /context and /compact permanently meaningless, and any
// model or effort we set discarded a moment later.
//
// The ACP id is persisted in `sessions.hermes_acp_session_id`, so we re-attach
// with `session/load` across app restarts and Hermes restarts, falling back to
// `session/new` when Hermes no longer knows the id.

export async function ensureHermesSession(
  ourSessionId: string,
  projectPath: string,
  mcpServers: object[],
  onEvent?: (e: HermesEvent) => void
): Promise<string> {
  if (!_client?.connected) throw new Error('Hermes is not connected')
  const settings = getHermesSessionSettings(ourSessionId)

  let acpSessionId = ''
  let models: HermesModelInfo[] = []
  let currentId = ''
  let modelName: string | undefined
  let reattached = false

  if (settings.acpSessionId) {
    const loaded = await _client.loadSession(settings.acpSessionId, projectPath, mcpServers)
    if (loaded) {
      acpSessionId = settings.acpSessionId
      models = loaded.models
      currentId = loaded.currentId
      modelName = loaded.modelName
      reattached = true
    }
  }

  if (!acpSessionId) {
    const created = await _client.newSession(projectPath, mcpServers)
    acpSessionId = created.sessionId
    models = created.models
    currentId = created.currentId
    modelName = created.modelName
    updateHermesSessionColumn(ourSessionId, 'hermes_acp_session_id', acpSessionId)
  }

  // Re-apply the user's picks. A brand-new Hermes session always starts on the
  // configured defaults, and a re-attached one may have been rebuilt by Hermes
  // since we last set them, so this runs either way — it is a no-op when the
  // session is already on the wanted model.
  if (settings.model) {
    const wanted = models.find((m) => m.id === settings.model || m.switchId === settings.model)
    const switchId = wanted?.switchId ?? toSwitchableModelId(settings.model)
    const alreadyCurrent = reattached && (currentId === settings.model || toSwitchableModelId(currentId) === switchId)
    if (!alreadyCurrent) {
      try {
        await _client.setModel(acpSessionId, switchId)
        modelName = wanted?.name ?? settings.model
      } catch (e: any) {
        // Hermes refused the stored model (e.g. its context window is too
        // small). Forget it rather than re-attempting the same doomed switch on
        // every future turn; the session continues on whatever it is already
        // running, which the 'model' event below reports honestly.
        setHermesSessionModel(ourSessionId, '')
        onEvent?.({ kind: 'error', message: `Could not switch to ${settings.model}: ${cleanAcpError(e)}` })
      }
    }
  }

  if (settings.effort && settings.effort !== 'default') {
    try {
      await _client.setReasoningEffort(acpSessionId, settings.effort)
    } catch (e: any) {
      onEvent?.({ kind: 'error', message: `Could not set reasoning effort: ${e?.message ?? e}` })
    }
  }

  if (models.length > 0) onEvent?.({ kind: 'models', models, currentId: settings.model ?? currentId })
  if (modelName) onEvent?.({ kind: 'model', name: modelName })
  return acpSessionId
}

// Live ACP session for an app session, if one is currently attached. Used by
// the IPC layer to apply a setting immediately instead of at the next turn.
function liveAcpSessionId(ourSessionId: string): string | undefined {
  if (!_client?.connected) return undefined
  return getHermesSessionSettings(ourSessionId).acpSessionId
}

// Apply a model choice, persisting it only once Hermes has accepted it.
// Hermes rejects some models outright — an embedding model, for instance, fails
// with "context window of 2,048 tokens, which is below the minimum 64,000" —
// and persisting such a choice would make every later turn retry a switch that
// can never succeed. When no session is attached yet there is nothing to
// validate against, so the choice is stored and vetted at the next attach.
export async function applyHermesModel(ourSessionId: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
  const acpSessionId = liveAcpSessionId(ourSessionId)
  if (!acpSessionId) {
    setHermesSessionModel(ourSessionId, modelId)
    return { ok: true }
  }
  try {
    await _client!.setModel(acpSessionId, toSwitchableModelId(modelId))
    setHermesSessionModel(ourSessionId, modelId)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: cleanAcpError(e) }
  }
}

// ACP errors arrive as "ACP -32603: Internal error – {"details":"…"}". The
// details are the part worth showing a user (Hermes explains *why* a model was
// refused); the JSON-RPC envelope is noise.
function cleanAcpError(e: any): string {
  const raw = e?.message ?? String(e)
  const match = raw.match(/"details"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (match?.[1]) {
    try { return JSON.parse(`"${match[1]}"`).trim() } catch { return match[1].trim() }
  }
  return raw
}

export async function applyHermesEffort(ourSessionId: string, effort: HermesEffort): Promise<{ ok: boolean; error?: string }> {
  setHermesSessionEffort(ourSessionId, effort)
  const acpSessionId = liveAcpSessionId(ourSessionId)
  if (!acpSessionId || effort === 'default') return { ok: true }
  try {
    await _client!.setReasoningEffort(acpSessionId, effort)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

// Run a Hermes slash command for an app session. `/steer` and `/queue` are
// meant to be used while a turn is running; `/context` and `/compact` while
// idle. Returns Hermes's own reply text.
export async function runHermesCommand(ourSessionId: string, command: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const acpSessionId = liveAcpSessionId(ourSessionId)
  if (!acpSessionId) return { ok: false, error: 'No active Hermes session yet — send a message first.' }
  try {
    return { ok: true, text: await _client!.runCommand(acpSessionId, command) }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

// ---- runHermesPrompt -------------------------------------------------------
// Connect if needed, reuse (or open) the ACP session, stream events back.

export async function runHermesPrompt(opts: {
  sessionId: string
  projectPath: string
  prompt: string
  systemInstruction?: string
  mcpServers?: object[]
  onEvent: (e: HermesEvent) => void
  signal?: AbortSignal
  distro?: string
}): Promise<AcpRunResult> {
  if (isFakeHermes()) {
    const requestId = randomUUID()
    opts.onEvent({
      kind: 'permissionRequest',
      request: { requestId, action: 'execute', title: 'Run command `npm test`' }
    })
    const approved = await new Promise<boolean>((resolve) => {
      fakePermissionRequests.set(requestId, resolve)
      const timeout = setTimeout(() => {
        fakePermissionRequests.delete(requestId)
        resolve(false)
      }, 30_000)
      fakePermissionRequests.set(requestId, (value) => {
        clearTimeout(timeout)
        resolve(value)
      })
    })
    fakePermissionRequests.delete(requestId)
    if (!approved) {
      opts.onEvent({ kind: 'error', message: 'Fake Hermes permission denied' })
      return { ok: false, text: '', error: 'Fake Hermes permission denied' }
    }
    const text = `Fake Hermes approved and completed: ${opts.prompt}`
    opts.onEvent({ kind: 'activity', activity: { ts: Date.now(), kind: 'tool', message: 'npm test', toolName: 'npm test', status: 'running', args: { command: 'npm test' } } })
    opts.onEvent({ kind: 'text', text })
    return { ok: true, text, stopReason: 'end_turn' }
  }
  const agentPrompt = opts.systemInstruction ? `${opts.prompt}\n\n${opts.systemInstruction}` : opts.prompt
  // Ensure connected
  if (!_client?.connected) {
    const r = await connectHermes(opts.distro ?? 'Ubuntu')
    if (!r.connected) {
      return { ok: false, text: '', error: r.error ?? 'Failed to connect to Hermes.' }
    }
  }

  let acpSessionId: string
  try {
    acpSessionId = await ensureHermesSession(opts.sessionId, opts.projectPath, opts.mcpServers ?? [], opts.onEvent)
  } catch (e: any) {
    return { ok: false, text: '', error: `Could not open a Hermes session: ${e?.message ?? e}` }
  }

  try {
    const { stopReason, text } = await _client!.sendPrompt(
      acpSessionId,
      agentPrompt,
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
  const fake = fakePermissionRequests.get(requestId)
  if (fake) {
    fake(approved)
    return true
  }
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
