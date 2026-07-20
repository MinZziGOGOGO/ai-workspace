import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { extname, join } from 'path'
import { getDb } from './db'
import { isE2EFakeEnabled } from './e2e'
import {
  buildPermissionResult,
  classifyAcpAction,
  compactJson,
  describeAcpAction,
  firstText,
  modeThatAutoApproves,
  planEntriesFromUpdate,
  requiresApproval,
  toolArgsFromUpdate,
  toolNameFromUpdate,
  toolResultFromUpdate,
  type AcpActionKind,
  type AcpPermissionMode
} from './acpPermissions'

export interface KimiCheck {
  installed: boolean
  version?: string
  bin?: string
  error?: string
}

const IS_WIN = process.platform === 'win32'
const KIMI_NOT_FOUND =
  'Kimi Code CLI not found. Install it, open a new PowerShell, and run `where.exe kimi`. If found, restart AI Workspace.'

// isE2EFakeEnabled additionally requires AIWORKSPACE_TEST_USER_DATA and denies
// packaged Electron builds (see e2e.ts) — the same guard Hermes/Codex use, so
// a stray env var inherited from the shell can never flip a real install into
// fake mode.
function isFakeKimi() {
  return isE2EFakeEnabled('E2E_FAKE_KIMI') && process.env.E2E_MISSING_KIMI !== '1'
}

function isMissingKimiFake() {
  return isE2EFakeEnabled('E2E_MISSING_KIMI')
}

function parseVersion(text: string): string | undefined {
  const match = text.match(/\d+\.\d+(?:\.\d+)?/)
  return match ? match[0] : undefined
}

function commandExists(bin: string): boolean {
  if (bin !== 'kimi') return existsSync(bin)
  if (!IS_WIN) return true
  try {
    const found = execFileSync('where.exe', ['kimi'], { encoding: 'utf8', windowsHide: true })
    return Boolean(found.trim())
  } catch {
    return false
  }
}

export function resolveKimiBin(): string {
  const override = process.env.AIWORKSPACE_KIMI_BIN || process.env.KIMI_PATH
  if (override && existsSync(override)) return override

  const candidates: string[] = []
  const appData = process.env.APPDATA
  const localAppData = process.env.LOCALAPPDATA
  const home = process.env.USERPROFILE || process.env.HOME
  if (appData) candidates.push(join(appData, 'npm', IS_WIN ? 'kimi.cmd' : 'kimi'))
  if (localAppData) candidates.push(join(localAppData, 'Programs', 'Kimi Code', IS_WIN ? 'kimi.exe' : 'kimi'))
  // Verified against the real installer (kimi-code CLI 0.27.0): its device-code
  // login / auto-updater installs to ~/.kimi-code/bin, which is not added to
  // PATH, so `where.exe kimi` misses it unless the user manually adds it.
  if (home) candidates.push(join(home, '.kimi-code', 'bin', IS_WIN ? 'kimi.exe' : 'kimi'))

  if (IS_WIN) {
    try {
      const found = execFileSync('where.exe', ['kimi'], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      candidates.push(...found)
    } catch {
      /* PATH lookup may fail; fall through to bare command. */
    }
  }

  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return 'kimi'
}

function spawnKimi(bin: string, args: string[], extraEnv?: Record<string, string>): ChildProcessWithoutNullStreams {
  const ext = extname(bin).toLowerCase()
  const shell = IS_WIN && (bin === 'kimi' || ext === '.cmd' || ext === '.bat')
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env
  return spawn(bin, args, { shell, windowsHide: true, env }) as ChildProcessWithoutNullStreams
}

export function checkKimi(): Promise<KimiCheck> {
  return new Promise((resolve) => {
    if (isFakeKimi()) {
      resolve({ installed: true, version: 'fake-kimi-code', bin: 'kimi' })
      return
    }
    if (isMissingKimiFake()) {
      resolve({ installed: false, error: KIMI_NOT_FOUND })
      return
    }

    const bin = resolveKimiBin()
    if (!commandExists(bin)) {
      resolve({ installed: false, bin, error: KIMI_NOT_FOUND })
      return
    }

    let out = ''
    let err = ''
    let settled = false
    const done = (result: KimiCheck) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnKimi(bin, ['--version'])
    } catch (error: any) {
      done({ installed: true, bin, error: String(error?.message ?? error) })
      return
    }

    child.stdout.on('data', (data) => (out += data.toString()))
    child.stderr.on('data', (data) => (err += data.toString()))
    child.on('error', () => done({ installed: true, bin }))
    child.on('close', () => {
      const text = `${out}\n${err}`.trim()
      done({ installed: true, bin, version: parseVersion(text) ?? (text ? text.split(/\r?\n/)[0] : undefined) })
    })

    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already exited */
      }
      done({ installed: true, bin })
    }, 2000)
  })
}

export function buildKimiPtyCommand(bin: string): { command: string; args: string[] } {
  if (!IS_WIN) return { command: bin, args: [] }
  const escaped = bin.replace(/'/g, "''")
  return {
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& '${escaped}'`]
  }
}

export function fakeKimiSessionLines(): string[] {
  return [
    'Fake Kimi Code session ready.',
    'Running in terminal mode for E2E verification.',
    'Model: kimi-for-coding',
    'Use /login in a real Kimi session to authenticate.'
  ]
}

// ============================================================================
// Kimi ACP (Agent Client Protocol) integration.
//
// `kimi acp` starts a JSON-RPC 2.0 server on its own stdio (verified against
// the real installed binary, kimi-code CLI 0.27.0: `kimi acp --help` only
// lists `--login`/`-h`; a live JSON-RPC handshake over spawned stdio pipes
// confirmed `initialize` -> `session/new` -> `session/prompt` all work as
// documented). Unlike Hermes, this is a plain local Windows/PATH binary: no
// WSL, no SSH, no remote mode. We spawn `resolveKimiBin()` directly with raw
// stdio pipes (never through buildKimiPtyCommand/PowerShell — that wrapper is
// for the interactive `kimi login` terminal task only, ACP needs a bare
// child_process with pipe stdio).
//
// Auth is NOT interactive-inline over the ACP channel: the ACP server expects
// prior authentication (`kimi login` device-code OAuth, or an API key) and
// returns an AUTH_REQUIRED error (-32000) otherwise. See runKimiLogin() below
// for the separate interactive login flow.
// ============================================================================

export type KimiActionKind = AcpActionKind
export type KimiPermissionMode = AcpPermissionMode

export interface KimiActivity {
  ts: number
  kind: string // 'tool' | 'thought' | 'plan' | 'error'
  message: string
  toolName?: string
  status?: 'running' | 'done' | 'error'
  args?: unknown
  result?: string
  details?: unknown
}

export interface KimiPlanEntry {
  content: string
  status: string
}

export interface KimiPermissionRequest {
  requestId: string
  action: KimiActionKind
  title: string
}

export interface KimiConfigChoice { value: string; name: string; description?: string }
export interface KimiConfigSelect { id: string; name: string; currentValue?: string; options: KimiConfigChoice[] }

export type KimiEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'activity'; activity: KimiActivity }
  | { kind: 'error'; message: string }
  | { kind: 'model'; name: string }
  | { kind: 'usage'; used: number; size: number }
  | { kind: 'commands'; commands: Array<{ name: string; description: string; hint?: string }> }
  | { kind: 'plan'; entries: KimiPlanEntry[] }
  | { kind: 'permissionRequest'; request: KimiPermissionRequest }
  | { kind: 'configOptions'; options: KimiConfigSelect[] }

export interface AcpRunResult {
  ok: boolean
  text: string
  stopReason?: string
  error?: string
}

const DEFAULT_KIMI_PERMISSION_MODE: KimiPermissionMode = 3

export function getKimiPermissionMode(): KimiPermissionMode {
  try {
    const db = getDb()
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('kimi_permission_mode') as
      | { value: string }
      | undefined
    const n = Number(row?.value)
    return (n >= 1 && n <= 5 ? n : DEFAULT_KIMI_PERMISSION_MODE) as KimiPermissionMode
  } catch {
    return DEFAULT_KIMI_PERMISSION_MODE
  }
}

export function setKimiPermissionMode(mode: KimiPermissionMode): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .run('kimi_permission_mode', String(mode))
}

// Plan mode is an orthogonal dimension to the 1–5 autonomy tier: it drives
// Kimi's *native* ACP `mode` (session/set_config_option → 'plan'), telling the
// server to do read-only planning and never execute tools. It is deliberately
// separate from the tier because the tier drives our client-side approval
// matrix, whereas plan changes server-side behavior. When plan is off, the
// native mode is set back to 'default' (see runKimiPrompt), which keeps the
// server asking for permission on every tool so our matrix stays the effective
// gate. We never set the native 'auto'/'yolo' modes: verified against the real
// binary, those execute tools WITHOUT sending session/request_permission at all
// (0 prompts), which would bypass our classification — including the
// catastrophic-command gate — so mapping any tier to them would weaken gating.
export function getKimiPlanMode(): boolean {
  try {
    const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get('kimi_plan_mode') as
      | { value: string }
      | undefined
    return row?.value === 'true'
  } catch {
    return false
  }
}

export function setKimiPlanMode(on: boolean): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .run('kimi_plan_mode', on ? 'true' : 'false')
}

// "Always allow this session" bumps the effective mode for the rest of the app
// session (our own session id, stable across turns) without touching the saved
// default. In-memory only — never persisted.
const sessionModeOverrides = new Map<string, KimiPermissionMode>()

function effectiveKimiMode(sessionId: string): KimiPermissionMode {
  const override = sessionModeOverrides.get(sessionId)
  const saved = getKimiPermissionMode()
  return override != null && override > saved ? override : saved
}

export function bumpKimiSessionOverride(sessionId: string, kind: KimiActionKind): void {
  const needed = modeThatAutoApproves(kind)
  const current = effectiveKimiMode(sessionId)
  if (needed > current) sessionModeOverrides.set(sessionId, needed)
}

// ---- Auth ---------------------------------------------------------------
// Two auth paths, matching what the ACP server can actually consume:
//   - OAuth device-code login via a separate interactive `kimi login` CLI
//     invocation (cannot be driven through the ACP JSON-RPC channel itself).
//   - API key, stored the same way this app stores every other plaintext
//     secret (app_meta — see ollama_cloud_key in src/main/ollama.ts /
//     src/main/ipc.ts SETTING_DEFINITIONS). Passed to `kimi acp` as an env
//     var at spawn time (MOONSHOT_API_KEY / KIMI_API_KEY) — best-effort,
//     unverified against a real binary: the docs describe config-file-based
//     alternative providers but don't confirm an env-var fallback exists.

export type KimiAuthMethod = 'oauth' | 'apikey'

export function getKimiAuthMethod(): KimiAuthMethod {
  try {
    const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get('kimi_auth_method') as
      | { value: string }
      | undefined
    return row?.value === 'apikey' ? 'apikey' : 'oauth'
  } catch {
    return 'oauth'
  }
}

export function setKimiAuthMethod(method: KimiAuthMethod): void {
  getDb().prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('kimi_auth_method', method)
}

// Main-process-only: never sent to the renderer as plaintext. The renderer
// only ever sees "configured: true/false" via checkKimiAuth(), same masking
// discipline as the generic settings.summary() secret fields.
export function getKimiApiKey(): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get('kimi_api_key') as
      | { value: string }
      | undefined
    return row?.value || null
  } catch {
    return null
  }
}

export function setKimiApiKey(key: string): void {
  getDb().prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('kimi_api_key', key)
}

export interface KimiAuthStatus {
  method: KimiAuthMethod
  configured: boolean
  detail?: string
}

// Best-effort: we cannot probe the real `kimi` binary's auth state without
// running it (and even then, only a live `acp`/`login` attempt would tell us
// for sure — there is no documented standalone "am I logged in" check). For
// OAuth we track "has runKimiLogin() ever completed successfully" as a proxy;
// for API key we simply check whether one is saved.
export function checkKimiAuth(): KimiAuthStatus {
  const method = getKimiAuthMethod()
  if (method === 'apikey') {
    const configured = Boolean(getKimiApiKey())
    return { method, configured, detail: configured ? undefined : 'No API key saved.' }
  }
  let done = false
  try {
    const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get('kimi_oauth_done') as
      | { value: string }
      | undefined
    done = row?.value === 'true'
  } catch { /* ignore */ }
  return { method, configured: done, detail: done ? undefined : 'Run "kimi login" to authenticate.' }
}

export type KimiLoginEvent =
  | { kind: 'status'; message: string }
  | { kind: 'deviceCode'; url: string; code: string }
  | { kind: 'done'; success: boolean; error?: string }

// Spawns `kimi login` as a plain child process (not the ACP session) and
// best-effort parses its stdout for a device-code URL + code, so the renderer
// can display them. UNVERIFIED: the exact subcommand name and output format
// were not observable in this environment (no `kimi` binary installed); this
// is our best interpretation of the documented device-code OAuth flow
// (`/login` inside the interactive CLI maps to a `kimi login` subcommand).
export async function runKimiLogin(onEvent: (e: KimiLoginEvent) => void): Promise<{ success: boolean; error?: string }> {
  if (isFakeKimi()) {
    onEvent({ kind: 'status', message: 'Starting fake Kimi login…' })
    onEvent({ kind: 'deviceCode', url: 'https://kimi.moonshot.ai/device', code: 'FAKE-1234' })
    await delay(50)
    getDb().prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('kimi_oauth_done', 'true')
    onEvent({ kind: 'done', success: true })
    return { success: true }
  }

  const bin = resolveKimiBin()
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let child: ChildProcess
    const finish = (result: { success: boolean; error?: string }) => {
      if (settled) return
      settled = true
      if (result.success) {
        try { getDb().prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run('kimi_oauth_done', 'true') } catch { /* ignore */ }
      }
      onEvent({ kind: 'done', success: result.success, error: result.error })
      resolve(result)
    }

    try {
      child = spawnKimi(bin, ['login'])
    } catch (e: any) {
      finish({ success: false, error: `Failed to spawn kimi login: ${e?.message ?? e}` })
      return
    }

    onEvent({ kind: 'status', message: 'Waiting for Kimi to print a device code…' })

    const scanForDeviceCode = (chunk: string) => {
      out += chunk
      // Best-effort regexes — unverified against real output. Looks for a
      // URL and a short alphanumeric/dash code near each other in the text.
      const urlMatch = out.match(/https?:\/\/\S+/)
      const codeMatch = out.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{6,10})\b/)
      if (urlMatch && codeMatch) {
        onEvent({ kind: 'deviceCode', url: urlMatch[0].replace(/[.,)]+$/, ''), code: codeMatch[1] as string })
      }
    }

    child.stdout?.on('data', (d: Buffer) => scanForDeviceCode(d.toString()))
    child.stderr?.on('data', (d: Buffer) => scanForDeviceCode(d.toString()))
    child.on('error', (e: any) => finish({ success: false, error: e?.message ?? String(e) }))
    child.on('close', (code) => finish({ success: code === 0, error: code === 0 ? undefined : `kimi login exited with code ${code}` }))

    // Device-code logins wait on the user visiting a URL; give this generous
    // headroom before giving up so we don't cut off a real interactive wait.
    setTimeout(() => {
      if (settled) return
      try { child.kill() } catch { /* already exited */ }
      finish({ success: false, error: 'Timed out waiting for kimi login to complete (5 min).' })
    }, 5 * 60_000)
  })
}

// ---- Permission classification (delegates to the shared module) --------

function classifyKimiAction(params: any): KimiActionKind {
  return classifyAcpAction(params, (p) => existsSync(p))
}

// ---- ACP client class -----------------------------------------------------

type PendingEntry = { resolve: (v: any) => void; reject: (e: Error) => void }

// Extract the current model id + display name from an ACP configOptions list
// (the {id:'model', category:'model'} select in kimi-code 0.27.x).
function modelFromConfigOptions(configOptions: any[]): { id?: string; name?: string } {
  if (!Array.isArray(configOptions)) return {}
  const select = configOptions.find((o: any) => o?.id === 'model' || o?.category === 'model')
  if (!select) return {}
  const id = typeof select.currentValue === 'string' ? select.currentValue : undefined
  const options: any[] = Array.isArray(select.options) ? select.options : []
  const matched = options.find((o: any) => o?.value === id)
  return { id, name: matched?.name ?? id }
}

// Every NON-model, user-actionable select in an ACP configOptions list (e.g. a
// multi-level thinking effort on builds that expose one), in a shape the
// renderer's picker can drill into. Tolerant: entries without an id are dropped
// rather than guessed at.
//
// Two categories are deliberately excluded:
//   - The native permission `mode` select (id/category 'mode' — default/plan/
//     auto/yolo on kimi-code 0.27.x) is surfaced as the composer's dedicated
//     permission-mode control (see nativeModeFrom), not as a generic drill-in
//     row, so it can't appear as a stray duplicate alongside that control.
//   - Single-option selects (< 2 choices) are dropped because the user can't
//     change them — they'd render as a pointless drill-in row. Verified against
//     the real 0.27.x binary: the `thinking` select reports only [{value:'on'}]
//     for every current model (k3's config.toml support_efforts of low/high/max
//     are NOT surfaced through ACP), so it's non-actionable and hidden.
function configSelectsFrom(configOptions: any[]): KimiConfigSelect[] {
  if (!Array.isArray(configOptions)) return []
  const selects: KimiConfigSelect[] = []
  for (const raw of configOptions) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue
    if (raw.id === 'model' || raw.category === 'model') continue
    if (raw.id === 'mode' || raw.category === 'mode') continue
    const options: KimiConfigChoice[] = (Array.isArray(raw.options) ? raw.options : [])
      .filter((o: any) => typeof o?.value === 'string' && o.value)
      .map((o: any) => ({
        value: o.value,
        name: typeof o.name === 'string' && o.name ? o.name : o.value,
        description: typeof o.description === 'string' && o.description ? o.description : undefined
      }))
    if (options.length < 2) continue
    selects.push({
      id: raw.id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
      currentValue: typeof raw.currentValue === 'string' ? raw.currentValue : undefined,
      options
    })
  }
  return selects
}

// The native permission `mode` select (default/plan/auto/yolo), extracted
// separately from configSelectsFrom so it drives the dedicated permission
// control rather than a generic drill-in row. Returns the current value and the
// set of offered values so runKimiPrompt can decide whether a set is needed.
function nativeModeFrom(configOptions: any[]): { current?: string; values: string[] } {
  if (!Array.isArray(configOptions)) return { values: [] }
  const sel = configOptions.find((o: any) => o?.id === 'mode' || o?.category === 'mode')
  if (!sel) return { values: [] }
  const values: string[] = (Array.isArray(sel.options) ? sel.options : [])
    .map((o: any) => o?.value)
    .filter((v: any) => typeof v === 'string' && v)
  return { current: typeof sel.currentValue === 'string' ? sel.currentValue : undefined, values }
}

class KimiAcpClient {
  private proc: ChildProcess | null = null
  private nextId = 0
  private pending = new Map<number, PendingEntry>()
  private updateListeners = new Map<string, (update: any) => void>()
  private eventListeners = new Map<string, (e: KimiEvent) => void>()
  private ourSessionByAcp = new Map<string, string>()
  private projectPathByAcp = new Map<string, string>()
  private pendingPermissions = new Map<string, { msgId: number; params: any }>()
  private buf = ''
  private _version?: string
  private _connected = false

  get connected(): boolean { return this._connected }
  get version(): string | undefined { return this._version }

  async connect(extraArgs: string[] = [], env?: Record<string, string>): Promise<void> {
    if (this._connected) return

    const bin = resolveKimiBin()
    try {
      this.proc = spawnKimi(bin, ['acp', ...extraArgs], env)
    } catch (e: any) {
      throw new Error(`Failed to spawn kimi acp: ${e?.message ?? e}`)
    }

    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr!.on('data', (d: Buffer | string) => {
      const msg = (typeof d === 'string' ? d : d.toString()).trim()
      if (msg) console.error('[kimi acp stderr]', msg)
    })
    this.proc.on('close', () => this.onClose())
    this.proc.on('error', (e: any) => {
      this._connected = false
      for (const [, h] of this.pending) h.reject(new Error(`ACP error: ${e?.message ?? e}`))
      this.pending.clear()
    })

    await delay(400)
    if (!this.proc || this.proc.killed) throw new Error('kimi acp exited immediately after spawn')

    const resp = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'ai-workspace', version: '1.0.0' },
      capabilities: {}
    }, 15_000)

    this._version = resp?.agentInfo?.version
    this._connected = true
  }

  disconnect(): void {
    this._connected = false
    try { this.proc?.kill() } catch { /* already gone */ }
    this.proc = null
  }

  async newSession(cwd: string, mcpServers: object[] = []): Promise<{ sessionId: string; modelName?: string; currentModelId?: string; configSelects: KimiConfigSelect[]; nativeMode: { current?: string; values: string[] } }> {
    const result = await this.request('session/new', { cwd, mcpServers }, 20_000)
    // kimi-code 0.27.x shape: result.configOptions is a list of selects; the
    // model select ({id:'model', category:'model'}) carries currentValue and
    // options [{value,name}]. Verified against the live ACP server.
    const configOptions: any[] = Array.isArray(result?.configOptions) ? result.configOptions : []
    const modelSelect = configOptions.find((o: any) => o?.id === 'model' || o?.category === 'model')
    let modelName: string | undefined
    let currentModelId: string | undefined
    if (modelSelect) {
      currentModelId = typeof modelSelect.currentValue === 'string' ? modelSelect.currentValue : undefined
      const options: any[] = Array.isArray(modelSelect.options) ? modelSelect.options : []
      const matched = options.find((o: any) => o?.value === currentModelId)
      modelName = matched?.name ?? currentModelId ?? undefined
    }
    if (!modelName) {
      // Legacy fallback for older servers that exposed availableModels /
      // currentModelId at the top level instead of configOptions.
      const models: any[] = result?.availableModels ?? []
      const currentId: string = result?.currentModelId ?? ''
      const matched = models.find((m: any) => m.id === currentId)
      const raw = matched?.name ?? matched?.id ?? currentId
      modelName = raw || undefined
      currentModelId = currentModelId ?? (currentId || undefined)
    }
    this.projectPathByAcp.set(result.sessionId, cwd)
    return { sessionId: result.sessionId, modelName, currentModelId, configSelects: configSelectsFrom(configOptions), nativeMode: nativeModeFrom(configOptions) }
  }

  // Per-session model switch (ACP session/set_config_option). Returns the
  // updated configOptions array so the caller can reflect the real state.
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<any[]> {
    const result = await this.request('session/set_config_option', { sessionId, configId, value }, 15_000)
    return Array.isArray(result?.configOptions) ? result.configOptions : []
  }

  async sendPrompt(
    acpSessionId: string,
    text: string,
    onEvent: (e: KimiEvent) => void,
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
        if (typeof t === 'string' && t) onEvent({ kind: 'thought', text: t })
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
            toolName: name === 'Tool' && note ? undefined : name,
            status: 'running',
            args,
            details: update
          }
        })
      } else if (su === 'tool_call') {
        const name = toolNameFromUpdate(update)
        const res = toolResultFromUpdate(update)
        onEvent({
          kind: 'activity',
          activity: {
            ts: Date.now(),
            kind: 'tool',
            message: res ? `✓ ${name}: ${res}` : `✓ ${name}`,
            toolName: name,
            status: 'done',
            result: res || undefined,
            details: update
          }
        })
      } else if (su === 'plan' || su === 'plan_update' || su === 'task_list' || su === 'todo_update' || inferredPlanEntries.length > 0) {
        const entries = inferredPlanEntries
        const active = entries.find((e: any) => e.status === 'in_progress') ?? entries[0]
        if (active?.content) onEvent({ kind: 'activity', activity: { ts: Date.now(), kind: 'plan', message: active.content } })
        if (entries.length > 0) onEvent({ kind: 'plan', entries })
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
      } else if (su === 'config_option_update') {
        // Emitted after session/set_config_option — reflect the real current
        // model back to the UI (kimi-code 0.27.x, verified live), plus any
        // non-model selects so the picker's drill-in rows stay current.
        const { name } = modelFromConfigOptions(update?.configOptions)
        if (name) onEvent({ kind: 'model', name })
        const selects = configSelectsFrom(update?.configOptions)
        if (selects.length > 0) onEvent({ kind: 'configOptions', options: selects })
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

  private onClose(): void {
    this._connected = false
    this.proc = null
    for (const [, h] of this.pending) h.reject(new Error('Kimi ACP process exited'))
    this.pending.clear()
    this.updateListeners.clear()
    this.eventListeners.clear()
    this.ourSessionByAcp.clear()
    this.projectPathByAcp.clear()
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
    try { this.proc.stdin.write(JSON.stringify(msg) + '\n') } catch { /* process died */ }
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

    if (method === 'session/update' && !hasId) {
      const sessionId: string = msg.params?.sessionId ?? ''
      const update = msg.params?.update
      if (update) this.updateListeners.get(sessionId)?.call(null, update)
      return
    }

    if (method && hasId) {
      this.handleAgentRequest(msg)
      return
    }

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

  // Same algorithm as HermesAcpClient.confineToProject in hermes.ts, kept
  // as a separate small copy rather than a shared import — no WSL /mnt/
  // rewriting is needed here since Kimi runs Windows-side directly.
  private static confineToProject(projectPath: string, requestedPath: string): string | null {
    if (!projectPath || !requestedPath) return null
    const path = require('path') as typeof import('path')
    const root = path.resolve(projectPath)
    const target = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(root, requestedPath)
    const rel = path.relative(root, target)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
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
      const safePath = projectPath ? KimiAcpClient.confineToProject(projectPath, filePath) : undefined
      if (!safePath) {
        console.error('[kimi] fs/read_text_file denied – path outside project root:', filePath)
        this.sendLine({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Path outside project root' } })
        return
      }
      let content = ''
      try { content = require('fs').readFileSync(safePath, 'utf8') } catch { /* missing file */ }
      this.sendLine({ jsonrpc: '2.0', id, result: { content } })
    } else if (method === 'fs/write_text_file') {
      const filePath: string = params?.path ?? params?.uri ?? ''
      const acpSessionId: string = params?.sessionId ?? ''
      const projectPath =
        this.projectPathByAcp.get(acpSessionId) ??
        (this.projectPathByAcp.size === 1 ? [...this.projectPathByAcp.values()][0] : undefined)
      const safePath = projectPath ? KimiAcpClient.confineToProject(projectPath, filePath) : undefined
      if (!safePath) {
        console.error('[kimi] fs/write_text_file denied – path outside project root:', filePath)
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

  private handlePermissionRequest(id: number, params: any): void {
    const acpSessionId: string = params?.sessionId ?? ''
    const ourSessionId = this.ourSessionByAcp.get(acpSessionId) ?? acpSessionId
    const kind = classifyKimiAction(params)
    const mode = effectiveKimiMode(ourSessionId)

    if (!requiresApproval(mode, kind)) {
      this.sendLine({ jsonrpc: '2.0', id, result: buildPermissionResult(params, true) })
      return
    }

    const requestId = randomUUID()
    this.pendingPermissions.set(requestId, { msgId: id, params })
    const title = describeAcpAction(params, kind)
    this.eventListeners.get(acpSessionId)?.({ kind: 'permissionRequest', request: { requestId, action: kind, title } })
  }
}

// ---- Singleton + exported API ---------------------------------------------

let _client: KimiAcpClient | null = null
const fakePermissionRequests = new Map<string, (approved: boolean) => void>()

export async function connectKimi(extraArgs: string[] = [], env?: Record<string, string>): Promise<{ connected: boolean; version?: string; error?: string }> {
  if (isFakeKimi()) return { connected: true, version: 'fake-kimi-code' }
  try {
    if (_client?.connected) return { connected: true, version: _client.version }
    if (_client) { _client.disconnect(); _client = null }
    _client = new KimiAcpClient()
    await _client.connect(extraArgs, env)
    return { connected: true, version: _client.version }
  } catch (e: any) {
    _client = null
    return { connected: false, error: e?.message ?? String(e) }
  }
}

export function disconnectKimi(): void {
  _client?.disconnect()
  _client = null
}

export function kimiConnected(): boolean {
  if (isFakeKimi()) return true
  return _client?.connected ?? false
}

export function kimiVersion(): string | undefined {
  return _client?.version
}

// ---- runKimiPrompt ----------------------------------------------------------

export async function runKimiPrompt(opts: {
  sessionId: string
  projectPath: string
  prompt: string
  systemInstruction?: string
  /** ACP model id from the picker (e.g. 'kimi-code/k3') — applied per-session. */
  model?: string
  /** Non-model config selects (keyed by configOption id) — applied like model. */
  configValues?: Record<string, string>
  mcpServers?: object[]
  authEnv?: Record<string, string>
  onEvent: (e: KimiEvent) => void
  signal?: AbortSignal
}): Promise<AcpRunResult> {
  if (isFakeKimi()) {
    const requestId = randomUUID()
    if (opts.model) opts.onEvent({ kind: 'model', name: opts.model })
    // Deterministic config selects mirroring a newer kimi-code build's
    // session/new shape, with the caller's chosen values applied.
    const fakeSelects: KimiConfigSelect[] = [
      {
        id: 'thinking_effort',
        name: 'Thinking effort',
        currentValue: opts.configValues?.thinking_effort ?? 'max',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'max', name: 'Max' }
        ]
      },
      {
        id: 'conversation_capacity',
        name: 'Conversation capacity',
        currentValue: opts.configValues?.conversation_capacity ?? 'standard',
        options: [
          { value: 'standard', name: 'Standard' },
          { value: 'extended', name: 'Extended' }
        ]
      }
    ]
    opts.onEvent({ kind: 'configOptions', options: fakeSelects })
    // /compact is honored as a normal prompt by the real ACP server (verified
    // live) — mirror that here: a compaction summary, no tool/permission step.
    if (opts.prompt.trim() === '/compact') {
      const text = 'Compaction completed.\n- Messages compacted: 2\n- Tokens after: 12'
      opts.onEvent({ kind: 'text', text })
      opts.onEvent({ kind: 'usage', used: 12_000, size: 262_144 })
      return { ok: true, text, stopReason: 'end_turn' }
    }
    // Plan mode ⇒ native 'plan': read-only planning, the server never executes
    // a tool, so there is no blocking permission request (matches the real
    // binary, where only ExitPlanMode is ever surfaced).
    if (getKimiPlanMode()) {
      opts.onEvent({ kind: 'plan', entries: [{ content: `Plan for: ${opts.prompt}`, status: 'in_progress' }] })
      const text = `Fake Kimi plan (read-only): ${opts.prompt}\nmodel=${opts.model ?? 'default'} nativeMode=plan`
      opts.onEvent({ kind: 'text', text })
      opts.onEvent({ kind: 'usage', used: 8_000, size: 262_144 })
      return { ok: true, text, stopReason: 'end_turn' }
    }
    opts.onEvent({
      kind: 'permissionRequest',
      request: { requestId, action: 'execute', title: 'Run command `npm test`' }
    })
    const approved = await new Promise<boolean>((resolve) => {
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
      opts.onEvent({ kind: 'error', message: 'Fake Kimi permission denied' })
      return { ok: false, text: '', error: 'Fake Kimi permission denied' }
    }
    const configSuffix = Object.entries(opts.configValues ?? {})
      .map(([k, v]) => ` ${k}=${v}`)
      .join('')
    const text = `Fake Kimi approved and completed: ${opts.prompt}\nmodel=${opts.model ?? 'default'}${configSuffix}`
    opts.onEvent({ kind: 'activity', activity: { ts: Date.now(), kind: 'tool', message: 'npm test', toolName: 'npm test', status: 'running', args: { command: 'npm test' } } })
    opts.onEvent({ kind: 'text', text })
    opts.onEvent({ kind: 'usage', used: 32_000, size: 262_144 })
    return { ok: true, text, stopReason: 'end_turn' }
  }

  const agentPrompt = opts.systemInstruction ? `${opts.prompt}\n\n${opts.systemInstruction}` : opts.prompt

  if (!_client?.connected) {
    const r = await connectKimi([], opts.authEnv)
    if (!r.connected) return { ok: false, text: '', error: r.error ?? 'Failed to connect to Kimi.' }
  }

  let acpSessionId: string
  try {
    const session = await _client!.newSession(opts.projectPath, opts.mcpServers ?? [])
    acpSessionId = session.sessionId
    if (session.modelName) opts.onEvent({ kind: 'model', name: session.modelName })
    if (session.configSelects.length > 0) opts.onEvent({ kind: 'configOptions', options: session.configSelects })
    // ACP config is per-session: every session/new starts at the config.toml
    // default, so a non-default picker selection must be re-applied each run.
    // A rejected/unknown value only logs — the send proceeds with the default.
    if (opts.model && opts.model !== session.currentModelId) {
      try {
        const updated = await _client!.setConfigOption(acpSessionId, 'model', opts.model)
        const { name } = modelFromConfigOptions(updated)
        opts.onEvent({ kind: 'model', name: name ?? opts.model })
      } catch (e: any) {
        console.error('[kimi] session/set_config_option failed:', e?.message ?? e)
      }
    }
    // Same re-apply rule for the non-model selects (thinking effort etc.).
    // Only ids the server actually reported are sent; values already at the
    // session default are skipped.
    for (const [configId, value] of Object.entries(opts.configValues ?? {})) {
      const select = session.configSelects.find((s) => s.id === configId)
      if (!select || select.currentValue === value) continue
      if (!select.options.some((o) => o.value === value)) continue
      try {
        const updated = await _client!.setConfigOption(acpSessionId, configId, value)
        const selects = configSelectsFrom(updated)
        if (selects.length > 0) opts.onEvent({ kind: 'configOptions', options: selects })
      } catch (e: any) {
        console.error(`[kimi] session/set_config_option ${configId} failed:`, e?.message ?? e)
      }
    }
    // Drive Kimi's native permission mode. Only the two modes that compose
    // safely with our client-side approval matrix are ever set (see
    // getKimiPlanMode's comment): 'plan' (read-only, strictly more restrictive)
    // or 'default' (server asks for every tool, so our matrix stays the gate).
    // Setting 'default' explicitly also defends a resumed/altered session that
    // was left in a looser native mode. 'auto'/'yolo' are never set.
    const wantNativeMode = getKimiPlanMode() ? 'plan' : 'default'
    if (session.nativeMode.values.includes(wantNativeMode) && session.nativeMode.current !== wantNativeMode) {
      try {
        await _client!.setConfigOption(acpSessionId, 'mode', wantNativeMode)
      } catch (e: any) {
        console.error('[kimi] session/set_config_option mode failed:', e?.message ?? e)
      }
    }
  } catch (e: any) {
    return { ok: false, text: '', error: `session/new failed: ${e?.message ?? e}` }
  }

  try {
    const { stopReason, text } = await _client!.sendPrompt(acpSessionId, agentPrompt, opts.onEvent, opts.signal, opts.sessionId)
    return { ok: true, text, stopReason }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    opts.onEvent({ kind: 'error', message: msg })
    return { ok: false, text: '', error: msg }
  }
}

export function respondKimiPermission(requestId: string, approved: boolean): boolean {
  const fake = fakePermissionRequests.get(requestId)
  if (fake) {
    fake(approved)
    return true
  }
  return _client?.respondPermission(requestId, approved) ?? false
}

export function summarizeKimiRun(prompt: string, run: AcpRunResult): { title: string; content: string } {
  const lines = [`Task: ${prompt.trim()}`]
  lines.push(`Status: ${run.ok ? 'completed' : 'failed'}`)
  if (run.stopReason && run.stopReason !== 'end_turn') lines.push(`Stop: ${run.stopReason}`)
  const outcome = (run.text || '').trim()
  if (outcome) lines.push(`Outcome: ${outcome.length > 600 ? outcome.slice(0, 600) + '…' : outcome}`)
  if (!run.ok && run.error) lines.push(`Error: ${run.error}`)
  return { title: `Kimi: ${prompt.trim().slice(0, 56) || 'task'}`, content: lines.join('\n') }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
