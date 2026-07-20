import { execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'child_process'
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs'
import { extname, join } from 'path'
import { isE2EFakeEnabled } from './e2e'
import { relativizeToProject } from './claudecode'
import type { McpServerConfig } from './mcp'

// Codex panel — drives the Codex CLI headless under the user's *ChatGPT*
// subscription login (never API billing). Mirrors the Claude Code launcher
// (claudecode.ts): a per-turn `codex exec --json` run that streams normalized
// events the renderer can show as streaming text + an activity log, with the
// turn persisted as messages by the caller in ipc.ts.
//
// Each `codex exec` invocation is a separate process, but the CLI supports
// server-side session resume: the first run's `thread.started` event carries
// a `thread_id`, and passing that id to `codex exec resume <id> <prompt>`
// continues the same conversation with full model context (no client-side
// prompt stitching needed). The caller (ipc.ts) persists the thread id per
// session and passes it back in as `opts.threadId` on later turns.

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

// ---- normalized events -----------------------------------------------------
export interface CodexActivityEntry {
  name: string // tool name / step
  summary: string // short, human-readable arg
  ok?: boolean
}

// Real plan rate limits parsed from the CLI's rollout files
// (~/.codex/sessions/**/rollout-*.jsonl, last token_count line):
// primary = the weekly window, secondary = the 5-hour window when present.
export interface CodexRateLimitWindow {
  kind: 'primary' | 'secondary'
  usedPercent: number
  windowMinutes?: number
  resetsAt?: number // unix seconds
}
export interface CodexPlanUsage { planType?: string; windows: CodexRateLimitWindow[] }

export type CodexEvent =
  | { kind: 'system'; summary: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'usage'; used: number; total?: number | null; plan?: CodexPlanUsage }
  | { kind: 'error'; message: string }

export interface CodexCheck {
  installed: boolean
  version?: string
  bin?: string
  error?: string
}

export interface CodexRunResult {
  ok: boolean
  result: string
  activity: CodexActivityEntry[]
  usedTokens?: number
  loginRequired?: boolean
  trustRequired?: boolean
  error?: string
  threadId?: string
}

const IS_WIN = process.platform === 'win32'
const CODEX_EXE = IS_WIN ? 'codex.exe' : 'codex'
const CODEX_NOT_FOUND =
  'Codex CLI not found. Open a new PowerShell and run `where.exe codex`. If found, restart AI Workspace. Or set AI_WORKSPACE_CODEX_PATH to the full codex path.'
const CODEX_TRUST_ERROR =
  'Codex refused to run because this folder is not trusted or is not a Git repository.'
const CODEX_AUTH_ERROR =
  'Codex CLI is installed but not logged in. Open a terminal and run `codex login`, then sign in with your ChatGPT subscription.'
let fakeCodexRunCounter = 0

// ---- E2E fakes -------------------------------------------------------------
function isFakeCodex() {
  return isE2EFakeEnabled('E2E_FAKE_CODEX')
}
function isMissingCodexFake() {
  return isE2EFakeEnabled('E2E_MISSING_CODEX')
}
function isTrustErrorFake() {
  return isE2EFakeEnabled('E2E_CODEX_TRUST_ERROR')
}

function isAuthError(text: string) {
  return /not logged in|please run .?codex login|unauthorized|authentication failed|forbidden/i.test(text)
}
function isTrustError(text: string) {
  return /not inside a trusted directory|skip-git-repo-check|not a git repository/i.test(text)
}
function cleanText(text: string) {
  return text.replace(/\r\n/g, '\n').trim()
}
function shouldShowDiagnostic(text: string) {
  const trimmed = cleanText(text)
  if (!trimmed) return false
  if (/^Reading additional input from stdin/i.test(trimmed)) return false
  return true
}
function executableExists(bin: string) {
  return bin === 'codex' || existsSync(bin)
}
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// Codex reports tool calls as an opaque arguments blob. Pull out the fields a
// human actually scans for (paths relativized to the project, the command
// line) and fall back to clipped JSON for everything else — mirrors
// summarizeToolInput in claudecode.ts.
function summarizeCodexToolArgs(args: unknown, projectPath: string): string {
  if (args == null) return ''
  let parsed: unknown = args
  if (typeof args === 'string') {
    try { parsed = JSON.parse(args) } catch { return clip(args, 140) }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>
    const path = o.file_path ?? o.path ?? o.filename
    if (typeof path === 'string' && path) return relativizeToProject(path, projectPath)
    if (typeof o.command === 'string' && o.command) return clip(o.command, 140)
    if (Array.isArray(o.command)) return clip(o.command.join(' '), 140)
    if (typeof o.pattern === 'string' && o.pattern) return o.pattern
  }
  return clip(JSON.stringify(parsed), 140)
}

// ---- binary resolution -----------------------------------------------------
export function resolveCodexBin(): string {
  const override = process.env.AI_WORKSPACE_CODEX_PATH || process.env.CODEX_PATH || process.env.AIWORKSPACE_CODEX_BIN
  if (override && existsSync(override)) return override

  const candidates: string[] = []
  const localAppData = process.env.LOCALAPPDATA
  const appData = process.env.APPDATA
  if (localAppData) candidates.push(join(localAppData, 'Programs', 'Codex', CODEX_EXE))
  if (appData) {
    const codexDir = join(appData, 'Codex')
    if (existsSync(codexDir)) {
      try {
        const versions = readdirSync(codexDir)
          .filter((d) => existsSync(join(codexDir, d, CODEX_EXE)))
          .sort(compareVersionsDesc)
        for (const version of versions) candidates.push(join(codexDir, version, CODEX_EXE))
      } catch {
        /* fall through to PATH */
      }
    }
  }
  if (IS_WIN) {
    try {
      const found = execFileSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      candidates.push(...found)
    } catch {
      /* PATH may not include Codex yet */
    }
  }

  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return 'codex'
}

function quoteCmdArg(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`
}

function needsCmdQuote(arg: string): boolean {
  return arg === '' || /[\s"&()^|<>]/.test(arg)
}

function buildSpawnArgs(
  bin: string,
  args: string[]
): { cmd: string; spawnArgs: string[]; useShell: boolean } {
  const ext = extname(bin).toLowerCase()
  const isCmd = ext === '.cmd' || ext === '.bat'

  if (isCmd || IS_WIN) {
    const quotedArgs = args.map((arg) => {
      if (arg.startsWith('-') && !needsCmdQuote(arg)) return arg
      return needsCmdQuote(arg) ? quoteCmdArg(arg) : arg
    })
    const fullCmd = [quoteCmdArg(bin), ...quotedArgs].join(' ')
    return { cmd: fullCmd, spawnArgs: [], useShell: true }
  }

  return { cmd: bin, spawnArgs: args, useShell: false }
}

function spawnCodex(
  bin: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {}
): ChildProcessWithoutNullStreams {
  const { cmd, spawnArgs, useShell } = buildSpawnArgs(bin, args)
  return spawn(cmd, spawnArgs, { ...options, shell: useShell, windowsHide: true })
}

// ---- installation check ----------------------------------------------------
export function checkCodex(): Promise<CodexCheck> {
  return new Promise((resolve) => {
    if (isFakeCodex() || isTrustErrorFake()) {
      resolve({ installed: true, version: 'fake-codex' })
      return
    }
    if (isMissingCodexFake()) {
      resolve({ installed: false, error: CODEX_NOT_FOUND })
      return
    }
    const bin = resolveCodexBin()
    if (!executableExists(bin)) {
      resolve({ installed: false, error: CODEX_NOT_FOUND })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const done = (r: CodexCheck) => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnCodex(bin, ['--version'])
    } catch (e: any) {
      done({ installed: false, bin, error: e?.code === 'ENOENT' ? CODEX_NOT_FOUND : String(e?.message ?? e) })
      return
    }
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e: any) => {
      done({ installed: false, bin, error: e?.code === 'ENOENT' ? CODEX_NOT_FOUND : String(e?.message ?? e) })
    })
    child.on('close', (code) => {
      if (code === 0) done({ installed: true, version: out.trim() || undefined, bin })
      else done({ installed: false, bin, error: (err || out).trim() || `exited with code ${code}` })
    })
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      done({ installed: false, bin, error: 'Timed out checking the Codex CLI.' })
    }, 10000)
  })
}

// ---- run -------------------------------------------------------------------
// Read the CLI's own session rollout (jsonl transcript) for the given thread
// and extract the last token_count record: model_context_window plus the
// plan's rate-limit windows. Returns null when anything is missing/unreadable
// — the meter simply shows the token count without a bar in that case.
function parseCodexRollout(threadId: string): { total: number | null; plan?: CodexPlanUsage } | null {
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME
    if (!home) return null
    const root = join(home, '.codex', 'sessions')
    if (!existsSync(root)) return null
    // Rollouts live under sessions/YYYY/MM/DD/rollout-*<threadId>.jsonl.
    const candidates: { path: string; mtime: number }[] = []
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p, depth + 1)
        else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl') && e.name.includes(threadId)) {
          try {
            candidates.push({ path: p, mtime: statSync(p).mtimeMs })
          } catch {
            /* vanished — skip */
          }
        }
      }
    }
    walk(root, 0)
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.mtime - a.mtime)
    const file = candidates[0].path
    // token_count records are appended per turn — the tail is enough.
    const size = statSync(file).size
    const len = Math.min(size, 256 * 1024)
    const buf = Buffer.alloc(len)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buf, 0, len, size - len)
    } finally {
      closeSync(fd)
    }
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"type":"token_count"')) continue
      try {
        const parsed = JSON.parse(line)
        const info = parsed?.info
        const total =
          info && typeof info.model_context_window === 'number' && info.model_context_window > 0
            ? info.model_context_window
            : null
        const rl = parsed?.rate_limits
        let plan: CodexPlanUsage | undefined
        if (rl && typeof rl === 'object') {
          const windows: CodexRateLimitWindow[] = []
          for (const kind of ['primary', 'secondary'] as const) {
            const w = rl[kind]
            if (w && typeof w === 'object' && typeof w.used_percent === 'number') {
              windows.push({
                kind,
                usedPercent: w.used_percent,
                windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : undefined,
                resetsAt: typeof w.resets_at === 'number' ? w.resets_at : undefined,
              })
            }
          }
          plan = { planType: typeof rl.plan_type === 'string' ? rl.plan_type : undefined, windows }
        }
        return { total, plan }
      } catch {
        continue // truncated/partial line — try the previous one
      }
    }
    return null
  } catch {
    return null
  }
}

export function runCodex(opts: {
  projectPath: string
  prompt: string
  systemInstruction?: string
  sandbox?: CodexSandboxMode
  skipGitRepoCheck?: boolean
  model?: string
  // Per-spawn reasoning effort, injected as a `-c model_reasoning_effort=…`
  // TOML override (same mechanism as buildCodexMcpArgs). This intentionally
  // overrides any global model_reasoning_effort in ~/.codex/config.toml for
  // app-initiated runs so the picker value is deterministic.
  effort?: string
  // Per-spawn service tier: 'priority' injects `-c service_tier="priority"`
  // (Codex fast mode). Anything else is the standard tier — no override.
  speed?: string
  imagePaths?: string[]
  // MCP servers to expose to this session, keyed by name. Codex has no
  // --mcp-config file flag; instead each server is injected as ephemeral,
  // per-spawn `-c mcp_servers.<name>.*` TOML overrides (see buildCodexMcpArgs).
  // Built by the caller from the source-of-truth launch configs in mcp.ts.
  mcpServers?: Record<string, McpServerConfig>
  onEvent: (e: CodexEvent) => void
  signal?: AbortSignal
  /** Thread id from a prior turn's `thread.started` event — resumes that Codex session instead of starting a fresh one. */
  threadId?: string
}): Promise<CodexRunResult> {
  const sandbox: CodexSandboxMode =
    opts.sandbox === 'workspace-write' || opts.sandbox === 'danger-full-access' ? opts.sandbox : 'read-only'

  // E2E fakes — exercise the full UI flow without a real CLI or login.
  if (isFakeCodex() || isTrustErrorFake()) {
    if (isTrustErrorFake() && !opts.skipGitRepoCheck) {
      opts.onEvent({ kind: 'error', message: CODEX_TRUST_ERROR })
      return Promise.resolve({ ok: false, result: CODEX_TRUST_ERROR, activity: [], trustRequired: true, error: CODEX_TRUST_ERROR })
    }
    if (isTrustErrorFake()) {
      const text = `Fake Codex ran with skipGitRepoCheck: ${opts.prompt}`
      opts.onEvent({ kind: 'text', text })
      return Promise.resolve({ ok: true, result: text, activity: [] })
    }
    const activity: CodexActivityEntry[] = [{ name: 'codex', summary: `sandbox: ${sandbox}`, ok: true }]
    opts.onEvent({ kind: 'tool', name: 'codex', summary: `sandbox: ${sandbox}` })
    fakeCodexRunCounter += 1
    const text = `Fake Codex received: ${opts.prompt}\nFake Codex run #${fakeCodexRunCounter}\nsandbox=${sandbox} skipGitRepoCheck=${opts.skipGitRepoCheck === true} model=${opts.model ?? 'default'} effort=${opts.effort ?? 'default'} speed=${opts.speed ?? 'standard'}`
    opts.onEvent({ kind: 'text', text })
    opts.onEvent({
      kind: 'usage',
      used: 169_800,
      total: 258_400,
      plan: {
        planType: 'plus',
        windows: [
          { kind: 'secondary', usedPercent: 99, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 600 },
          { kind: 'primary', usedPercent: 18, windowMinutes: 10_080, resetsAt: Math.floor(Date.now() / 1000) + 259_200 },
        ],
      },
    })
    return Promise.resolve({ ok: true, result: text, activity })
  }

  return new Promise((resolve) => {
    const bin = resolveCodexBin()
    const agentPrompt = opts.systemInstruction ? `${opts.prompt}\n\n${opts.systemInstruction}` : opts.prompt
    // Codex v0.139.0+ command format: codex exec --json -C <cwd> -s <sandbox> -m <model>
    // Prompt MUST be the last positional argument — never via stdin, including when -i flags are present.
    //
    // `codex exec resume <thread-id>` continues a prior session server-side —
    // it inherits that session's cwd/sandbox, so -C/-s are not passed (and
    // are in fact rejected by the `resume` subcommand).
    const args = opts.threadId ? ['exec', 'resume', opts.threadId, '--json'] : ['exec', '--json', '-C', opts.projectPath, '-s', sandbox]
    if (opts.model) args.push('-m', opts.model)
    if (opts.effort) args.push('-c', `model_reasoning_effort=${tomlLiteral(opts.effort)}`)
    // Approval policy: this app drives `codex exec` non-interactively, so there
    // is no human to grant an escalation. Force `never` (Codex's own recommended
    // value for non-interactive runs) so the model doesn't waste a turn asking
    // for approval it can never receive — verified against the real binary that
    // `on-request` under a read-only sandbox just burns a turn and still can't
    // act. This does NOT loosen anything: the sandbox (`-s`) remains the sole
    // real safety boundary; `never` only means "don't bother asking". The `-a`
    // flag itself is rejected by `exec`, so this must go through `-c`.
    args.push('-c', `approval_policy=${tomlLiteral('never')}`)
    if (opts.speed === 'priority') args.push('-c', `service_tier=${tomlLiteral('priority')}`)
    if (opts.skipGitRepoCheck) args.push('--skip-git-repo-check')
    // MCP servers as ephemeral `-c mcp_servers.*` overrides (Codex has no
    // --mcp-config file flag). Additive on top of the user's ~/.codex/config.toml.
    args.push(...buildCodexMcpArgs(opts.mcpServers))
    for (const imgPath of opts.imagePaths ?? []) args.push('-i', imgPath)
    args.push(agentPrompt)
    const spawnSpec = buildSpawnArgs(bin, args)
    console.error(
      '[codex] spawning:',
      JSON.stringify(spawnSpec.cmd),
      'args:',
      JSON.stringify(spawnSpec.spawnArgs),
      'shell:',
      spawnSpec.useShell
    )

    const activity: CodexActivityEntry[] = []
    let streamedText = ''
    let usedTokens: number | undefined
    let threadId = opts.threadId
    let emittedAssistantText = false
    let stdoutBuf = ''
    let rawStdout = ''
    let stderr = ''
    let settled = false
    let child: ChildProcessWithoutNullStreams | null = null

    const finish = (result: CodexRunResult) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }

    const processLine = (rawLine: string) => {
      const trimmed = rawLine.trim()
      if (!trimmed) return
      rawStdout += trimmed + '\n'

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        // Non-JSON output — treat as plain text.
        streamedText += (streamedText ? '\n' : '') + trimmed
        opts.onEvent({ kind: 'text', text: trimmed })
        emittedAssistantText = true
        return
      }

      switch (parsed.type as string | undefined) {
        case 'thread.started':
          if (typeof parsed.thread_id === 'string') threadId = parsed.thread_id
          opts.onEvent({ kind: 'system', summary: 'Thread started' })
          break
        case 'turn.started':
          opts.onEvent({ kind: 'system', summary: 'Thinking…' })
          break
        case 'item.completed': {
          const item = parsed.item as Record<string, unknown> | undefined
          if (!item) break
          if (item.type === 'agent_message') {
            const text = (item.text as string | undefined) ?? ''
            if (text) {
              streamedText += (streamedText ? '\n' : '') + text
              opts.onEvent({ kind: 'text', text })
              emittedAssistantText = true
            }
          } else if (item.type === 'tool_call') {
            const name = (item.name as string | undefined) ?? 'tool_call'
            const summary = summarizeCodexToolArgs(item.arguments, opts.projectPath)
            activity.push({ name, summary, ok: true })
            opts.onEvent({ kind: 'tool', name, summary })
          }
          break
        }
        case 'turn.completed': {
          const usage = parsed.usage as Record<string, number> | undefined
          if (usage) {
            usedTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0)
            opts.onEvent({ kind: 'usage', used: usedTokens })
          }
          break
        }
      }
    }

    try {
      child = spawn(spawnSpec.cmd, spawnSpec.spawnArgs, {
        cwd: opts.projectPath,
        shell: spawnSpec.useShell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (e: any) {
      const message = e?.code === 'ENOENT' ? CODEX_NOT_FOUND : `Codex failed to start: ${e?.message ?? e}`
      opts.onEvent({ kind: 'error', message })
      finish({ ok: false, result: '', activity, error: message })
      return
    }

    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString()
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    })
    child.stderr.on('data', (d) => {
      const text = cleanText(d.toString())
      if (!shouldShowDiagnostic(text)) return
      stderr += text + '\n'
      opts.onEvent({ kind: 'tool', name: 'codex stderr', summary: clip(text, 160) })
    })
    child.on('error', (e: any) => {
      const message = e?.code === 'ENOENT' ? CODEX_NOT_FOUND : `Codex failed to start: ${e?.message ?? e}`
      opts.onEvent({ kind: 'error', message })
      finish({ ok: false, result: '', activity, error: message })
    })
    child.on('close', (code) => {
      if (stdoutBuf.trim()) processLine(stdoutBuf)
      stdoutBuf = ''
      if (code === 0) {
        if (!emittedAssistantText) {
          streamedText = 'Codex finished without assistant output.'
          opts.onEvent({ kind: 'text', text: streamedText })
        }
        // Final usage event with the real context window size + plan rate
        // limits, read from the CLI's own rollout file for this thread.
        if (threadId) {
          const rollout = parseCodexRollout(threadId)
          if (rollout) {
            opts.onEvent({ kind: 'usage', used: usedTokens ?? 0, total: rollout.total, plan: rollout.plan })
          } else if (usedTokens !== undefined) {
            opts.onEvent({ kind: 'usage', used: usedTokens, total: null })
          }
        }
        finish({ ok: true, result: streamedText, activity, usedTokens, threadId })
      } else {
        const raw = (stderr || rawStdout).trim()
        const trust = isTrustError(raw)
        const auth = isAuthError(raw)
        const message = trust
          ? CODEX_TRUST_ERROR
          : auth
          ? CODEX_AUTH_ERROR
          : raw || `Codex exited with code ${code}.`
        opts.onEvent({ kind: 'error', message })
        finish({ ok: false, result: message, activity, error: message, trustRequired: trust, loginRequired: auth, threadId })
      }
    })

    if (opts.signal) {
      if (opts.signal.aborted) child.kill()
      else opts.signal.addEventListener('abort', () => child?.kill())
    }

    child.stdin.end()
  })
}

// ---- post-task summary -----------------------------------------------------
const FILE_TOOLS = new Set(['apply_patch', 'write_file', 'edit', 'create'])

export function summarizeCodexRun(prompt: string, run: CodexRunResult): { title: string; content: string } {
  const counts = new Map<string, number>()
  for (const a of run.activity) counts.set(a.name, (counts.get(a.name) ?? 0) + 1)
  const tools = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
  const files = [...new Set(run.activity.filter((a) => FILE_TOOLS.has(a.name)).map((a) => a.summary))]

  const lines = [`Task: ${prompt.trim()}`]
  if (files.length) lines.push(`Files changed: ${files.join(', ')}`)
  if (tools.length) lines.push(`Tools used: ${tools.join(', ')}`)
  const outcome = (run.result || '').trim()
  if (outcome) lines.push(`Outcome: ${outcome.length > 600 ? outcome.slice(0, 600) + '…' : outcome}`)
  if (!run.ok && run.error) lines.push(`Note: ${run.error}`)

  return {
    title: `Codex: ${prompt.trim().slice(0, 56) || 'task'}`,
    content: lines.join('\n')
  }
}

// ---- MCP wiring ------------------------------------------------------------
// Codex reads MCP servers from ~/.codex/config.toml ([mcp_servers.*]) or from
// `-c` config overrides. There is no `--mcp-config <file>` flag. We inject the
// bundled servers per-spawn via `-c mcp_servers.<name>.*` so nothing is written
// to the user's persistent config. Each `-c` value is parsed by Codex as TOML.
export function buildCodexMcpArgs(servers?: Record<string, McpServerConfig>): string[] {
  if (!servers) return []
  const out: string[] = []
  for (const [name, cfg] of Object.entries(servers)) {
    const base = `mcp_servers.${name}`
    if (cfg.command) out.push('-c', `${base}.command=${tomlLiteral(cfg.command)}`)
    if (cfg.args?.length) out.push('-c', `${base}.args=[${cfg.args.map(tomlLiteral).join(', ')}]`)
    if (cfg.env && Object.keys(cfg.env).length > 0) {
      const inline = Object.entries(cfg.env)
        .map(([k, v]) => `${tomlBareKey(k)} = ${tomlLiteral(v)}`)
        .join(', ')
      out.push('-c', `${base}.env={ ${inline} }`)
    }
  }
  return out
}

// TOML string value. Prefer a literal string (single quotes, no escape
// processing) so Windows backslash paths survive verbatim; fall back to a basic
// string only when the value itself contains a single quote.
function tomlLiteral(s: string): string {
  if (!s.includes("'") && !s.includes('\n')) return `'${s}'`
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
}

// Env var names are bare keys (A–Z, 0–9, _, -). Quote anything unexpected.
function tomlBareKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlLiteral(k)
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d) return d
  }
  return 0
}
