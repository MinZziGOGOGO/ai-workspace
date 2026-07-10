import { execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { extname, join } from 'path'

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

export type CodexEvent =
  | { kind: 'system'; summary: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'usage'; used: number }
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

// ---- E2E fakes -------------------------------------------------------------
function isFakeCodex() {
  return process.env.E2E_FAKE_CODEX === '1'
}
function isMissingCodexFake() {
  return process.env.E2E_MISSING_CODEX === '1'
}
function isTrustErrorFake() {
  return process.env.E2E_CODEX_TRUST_ERROR === '1'
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
export function runCodex(opts: {
  projectPath: string
  prompt: string
  sandbox?: CodexSandboxMode
  skipGitRepoCheck?: boolean
  model?: string
  imagePaths?: string[]
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
    const text = `Fake Codex received: ${opts.prompt}\nsandbox=${sandbox} skipGitRepoCheck=${opts.skipGitRepoCheck === true}`
    opts.onEvent({ kind: 'text', text })
    return Promise.resolve({ ok: true, result: text, activity })
  }

  return new Promise((resolve) => {
    const bin = resolveCodexBin()
    // Codex v0.139.0+ command format: codex exec --json -C <cwd> -s <sandbox> -m <model>
    // Prompt MUST be the last positional argument — never via stdin, including when -i flags are present.
    //
    // `codex exec resume <thread-id>` continues a prior session server-side —
    // it inherits that session's cwd/sandbox, so -C/-s are not passed (and
    // are in fact rejected by the `resume` subcommand).
    const args = opts.threadId ? ['exec', 'resume', opts.threadId, '--json'] : ['exec', '--json', '-C', opts.projectPath, '-s', sandbox]
    if (opts.model) args.push('-m', opts.model)
    if (opts.skipGitRepoCheck) args.push('--skip-git-repo-check')
    for (const imgPath of opts.imagePaths ?? []) args.push('-i', imgPath)
    args.push(opts.prompt)
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
            const summary = item.arguments != null ? clip(JSON.stringify(item.arguments), 140) : ''
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

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d) return d
  }
  return 0
}
