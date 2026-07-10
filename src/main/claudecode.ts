import { spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isE2EFakeEnabled } from './e2e'

// Milestone 5 — Claude Code launcher.
//
// Drives the Claude Code CLI headless under the user's *subscription* login —
// never API billing. We pass no API key; the CLI authenticates itself (OAuth /
// host auth refresh), which `init.apiKeySource: "none"` confirms at runtime.
//
// Invocation: `claude -p <prompt> --output-format stream-json --verbose
//              --permission-mode acceptEdits` in the project folder (cwd).
// The CLI emits newline-delimited JSON events on stdout:
//   {type:"system",subtype:"init", model, session_id, cwd, ...}
//   {type:"assistant", message:{ content:[ {type:"text"|"tool_use", ...} ] }, error? }
//   {type:"user",      message:{ content:[ {type:"tool_result", ...} ] } }
//   {type:"result", subtype, is_error, result, total_cost_usd, permission_denials, ... }
// We normalize those into a small CCEvent stream the renderer can render as
// streaming text + an activity log of tool calls, and detect the
// not-installed / not-logged-in cases so the UI can show clear setup guidance.
//
// Like the indexer/extractor, this runs only in the Electron main process and
// routes any memory write through the single queue in knowledge.ts (done by the
// caller in ipc.ts, using summarizeRun()).

const IS_WIN = process.platform === 'win32'
const CLAUDE_EXE = IS_WIN ? 'claude.exe' : 'claude'

function isFakeClaudeCode(): boolean {
  return isE2EFakeEnabled('E2E_FAKE_CLAUDE_CODE')
}

// ---- normalized events -----------------------------------------------------
export interface FileDiff {
  path: string
  before: string | null // null for newly created files
  after: string
}

export interface ActivityEntry {
  name: string // tool name (Write, Edit, Bash, Read, …)
  summary: string // short, human-readable arg (file path, command, …)
  ok?: boolean // set when the matching tool_result arrives
  diff?: FileDiff // set for file write/edit tools once the tool completes successfully
}

export type CCEvent =
  | { kind: 'system'; summary: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string }
  | { kind: 'tool-result'; id: string; ok: boolean; summary: string }
  | { kind: 'file_diff'; toolCallId: string; path: string; before: string | null; after: string }
  | { kind: 'error'; message: string }

export interface CCCheck {
  installed: boolean
  version?: string
  bin?: string
  error?: string
}

export interface RunResult {
  ok: boolean
  result: string
  activity: ActivityEntry[]
  cost?: number
  loginRequired?: boolean
  error?: string
}

// ---- binary resolution -----------------------------------------------------
// The CLI is often NOT on PATH on Windows. Resolve it explicitly: an override,
// then the native installer's versioned exe (newest), then the npm global shim,
// then bare `claude` (relying on PATH via a shell as a last resort).
export function resolveClaudeBin(): string {
  const override = process.env.AIWORKSPACE_CLAUDE_BIN
  if (override && existsSync(override)) return override

  const candidates: string[] = []
  const appData = process.env.APPDATA
  if (appData) {
    // Native installer: %APPDATA%\Claude\claude-code\<version>\claude.exe
    const ccDir = join(appData, 'Claude', 'claude-code')
    if (existsSync(ccDir)) {
      try {
        const versions = readdirSync(ccDir)
          .filter((d) => existsSync(join(ccDir, d, CLAUDE_EXE)))
          .sort(compareVersionsDesc)
        for (const v of versions) candidates.push(join(ccDir, v, CLAUDE_EXE))
      } catch {
        /* unreadable dir — fall through to other candidates */
      }
    }
    // npm global install
    candidates.push(join(appData, 'npm', IS_WIN ? 'claude.cmd' : 'claude'))
  }
  if (!IS_WIN) {
    candidates.push(join(process.env.HOME ?? '', '.local', 'bin', 'claude'))
    candidates.push('/usr/local/bin/claude')
  }

  for (const c of candidates) if (existsSync(c)) return c
  return 'claude' // last resort: PATH lookup via shell
}

// Tools whose `file_path` input is written wholesale/patched in place, so a
// before/after diff can be captured around them.
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

/** Whether a resolved bin can be spawned directly (no shell, prompt safe as argv). */
function isDirectExe(bin: string): boolean {
  return !IS_WIN || bin.toLowerCase().endsWith('.exe')
}

// ---- installation check ----------------------------------------------------
export function checkClaudeCode(): Promise<CCCheck> {
  return new Promise((resolve) => {
    if (isFakeClaudeCode()) {
      resolve({ installed: true, version: 'fake-claude-code', bin: 'fake-claude' })
      return
    }
    const bin = resolveClaudeBin()
    const shell = !isDirectExe(bin)
    let out = ''
    let err = ''
    let settled = false
    const done = (r: CCCheck) => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }

    let child
    try {
      child = spawn(bin, ['--version'], { shell, windowsHide: true })
    } catch (e: any) {
      done({ installed: false, error: String(e?.message ?? e) })
      return
    }
    child.stdout?.on('data', (d) => (out += d.toString()))
    child.stderr?.on('data', (d) => (err += d.toString()))
    child.on('error', (e: any) => {
      done({
        installed: false,
        bin,
        error:
          e?.code === 'ENOENT'
            ? 'Claude Code CLI was not found on this machine.'
            : String(e?.message ?? e)
      })
    })
    child.on('close', (code) => {
      if (code === 0 && /\d+\.\d+/.test(out)) done({ installed: true, version: out.trim(), bin })
      else done({ installed: false, bin, error: (err || out).trim() || `exited with code ${code}` })
    })
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      done({ installed: false, bin, error: 'Timed out checking the Claude Code CLI.' })
    }, 10000)
  })
}

// ---- run -------------------------------------------------------------------
export function runClaudeCode(opts: {
  projectPath: string
  prompt: string
  // Model picker → `--model`. Effort → the CLI's native `--effort` flag
  // (low|medium|high|xhigh|max); omit for "normal" so the default is preserved.
  // Thinking toggle → MAX_THINKING_TOKENS in the child env, the supported way to
  // enable extended thinking headlessly (there is no `--thinking` CLI flag).
  model?: string
  effort?: string
  thinking?: boolean
  onEvent: (e: CCEvent) => void
  signal?: AbortSignal
}): Promise<RunResult> {
  if (isFakeClaudeCode()) {
    const activity: ActivityEntry[] = [{ name: 'Write', summary: 'e2e-claude-output.txt', ok: true }]
    const before = existsSync(join(opts.projectPath, 'e2e-claude-output.txt'))
      ? readFileSync(join(opts.projectPath, 'e2e-claude-output.txt'), 'utf8')
      : null
    const after = `Fake Claude Code modified files for: ${opts.prompt}\n`
    writeFileSync(join(opts.projectPath, 'e2e-claude-output.txt'), after, 'utf8')
    activity[0].diff = { path: join(opts.projectPath, 'e2e-claude-output.txt'), before, after }
    opts.onEvent({ kind: 'system', summary: 'Fake Claude Code session started', model: opts.model })
    opts.onEvent({ kind: 'tool', id: 'fake-write', name: 'Write', summary: 'e2e-claude-output.txt' })
    opts.onEvent({ kind: 'tool-result', id: 'fake-write', ok: true, summary: 'wrote e2e-claude-output.txt' })
    opts.onEvent({ kind: 'file_diff', toolCallId: 'fake-write', path: join(opts.projectPath, 'e2e-claude-output.txt'), before, after })
    const result = `Fake Claude Code completed: ${opts.prompt}`
    opts.onEvent({ kind: 'text', text: result })
    return Promise.resolve({ ok: true, result, activity })
  }
  return new Promise((resolve) => {
    const bin = resolveClaudeBin()
    const direct = isDirectExe(bin)
    const baseArgs = [
      '--output-format',
      'stream-json',
      '--verbose',
      // Auto-approve file creation/edits so headless tasks can actually write,
      // while still surfacing (and not auto-running) anything riskier.
      '--permission-mode',
      'acceptEdits'
    ]
    if (opts.model) baseArgs.push('--model', opts.model)
    if (opts.effort) baseArgs.push('--effort', opts.effort)

    // Prefer passing the prompt as a real argv arg when we can spawn the exe
    // directly (no shell ⇒ no injection). For the shell fallbacks (npm .cmd /
    // bare `claude` on Windows) feed the prompt over stdin so it never touches
    // a command line.
    const args = direct ? ['-p', opts.prompt, ...baseArgs] : ['-p', ...baseArgs]

    const activity: ActivityEntry[] = []
    // Tool calls that write a file: keyed by tool_use id so the matching
    // tool_result can pair the pre-execution snapshot with the post-execution
    // content and produce a diff. `entry` is the same object pushed into
    // `activity`, so attaching `diff` there also persists it in the log.
    const pendingDiffs = new Map<string, { path: string; before: string | null; entry: ActivityEntry }>()
    let streamedText = ''
    let resultText = ''
    let cost: number | undefined
    let sawResult = false
    let ok = false
    let loginRequired = false
    let stderr = ''
    let stdoutBuf = ''

    const env = opts.thinking
      ? { ...process.env, MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS || '10000' }
      : process.env

    let child
    try {
      child = spawn(bin, args, { cwd: opts.projectPath, shell: !direct, windowsHide: true, env })
    } catch (e: any) {
      const message = `Failed to launch Claude Code: ${e?.message ?? e}`
      opts.onEvent({ kind: 'error', message })
      resolve({ ok: false, result: '', activity, error: message })
      return
    }

    const markLastPending = (resultOk: boolean) => {
      for (let i = activity.length - 1; i >= 0; i--) {
        if (activity[i].ok === undefined) {
          activity[i].ok = resultOk
          return
        }
      }
    }

    const detectLogin = (text: string) => {
      if (/not logged in|please run \/login|authentication_failed|invalid api key|unauthorized/i.test(text))
        loginRequired = true
    }

    const handleLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg: any
      try {
        msg = JSON.parse(trimmed)
      } catch {
        return // non-JSON noise — ignore
      }
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            opts.onEvent({
              kind: 'system',
              model: msg.model,
              summary: `Session started${msg.model ? ` · ${msg.model}` : ''}`
            })
          }
          break
        case 'assistant': {
          if (msg.error) detectLogin(String(msg.error))
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'text' && b.text) {
              streamedText += b.text
              detectLogin(b.text)
              opts.onEvent({ kind: 'text', text: b.text })
            } else if (b.type === 'tool_use') {
              const summary = summarizeToolInput(b.name, b.input)
              const entry: ActivityEntry = { name: b.name, summary }
              activity.push(entry)
              opts.onEvent({ kind: 'tool', id: b.id ?? '', name: b.name, summary })

              if (FILE_WRITE_TOOLS.has(b.name) && typeof b.input?.file_path === 'string' && b.id) {
                const filePath = b.input.file_path
                let before: string | null = null
                try {
                  if (existsSync(filePath)) before = readFileSync(filePath, 'utf8')
                } catch {
                  /* unreadable before content — fall back to treating it as unavailable */
                }
                pendingDiffs.set(b.id, { path: filePath, before, entry })
              }
            }
          }
          break
        }
        case 'user': {
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'tool_result') {
              const resultOk = !b.is_error
              markLastPending(resultOk)
              opts.onEvent({
                kind: 'tool-result',
                id: b.tool_use_id ?? '',
                ok: resultOk,
                summary: resultSummary(b.content)
              })

              const pending = pendingDiffs.get(b.tool_use_id ?? '')
              if (pending) {
                pendingDiffs.delete(b.tool_use_id ?? '')
                if (resultOk) {
                  try {
                    const after = readFileSync(pending.path, 'utf8')
                    pending.entry.diff = { path: pending.path, before: pending.before, after }
                    opts.onEvent({
                      kind: 'file_diff',
                      toolCallId: b.tool_use_id ?? '',
                      path: pending.path,
                      before: pending.before,
                      after
                    })
                  } catch {
                    /* file gone or unreadable after the tool ran — skip the diff */
                  }
                }
              }
            }
          }
          break
        }
        case 'result': {
          sawResult = true
          cost = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined
          resultText = typeof msg.result === 'string' ? msg.result : streamedText
          ok = msg.subtype === 'success' && !msg.is_error
          detectLogin(resultText)
          if (Array.isArray(msg.permission_denials)) {
            for (const d of msg.permission_denials) {
              const tool = d?.tool_name ?? d?.name ?? 'tool'
              opts.onEvent({ kind: 'error', message: `Permission denied: ${tool}` })
            }
          }
          break
        }
      }
    }

    child.stdout?.on('data', (d) => {
      stdoutBuf += d.toString()
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop() ?? ''
      for (const l of lines) handleLine(l)
    })
    child.stderr?.on('data', (d) => (stderr += d.toString()))

    child.on('error', (e: any) => {
      const message =
        e?.code === 'ENOENT'
          ? 'Claude Code CLI was not found. Install it, then run `claude login`.'
          : `Claude Code failed to start: ${e?.message ?? e}`
      opts.onEvent({ kind: 'error', message })
      resolve({ ok: false, result: '', activity, error: message })
    })

    child.on('close', (code) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf)
      detectLogin(stderr)

      if (loginRequired) {
        const message =
          'Claude Code is installed but not logged in. Open a terminal and run `claude login`, ' +
          'then sign in with your Claude subscription (Pro/Max — not an API key).'
        opts.onEvent({ kind: 'error', message })
        return resolve({ ok: false, result: resultText || streamedText, activity, cost, loginRequired: true, error: message })
      }
      if (!sawResult && (code ?? 0) !== 0) {
        const message = stderr.trim() || `Claude Code exited with code ${code}.`
        opts.onEvent({ kind: 'error', message })
        return resolve({ ok: false, result: resultText || streamedText, activity, cost, error: message })
      }
      resolve({
        ok,
        result: resultText || streamedText,
        activity,
        cost,
        error: ok ? undefined : stderr.trim() || undefined
      })
    })

    if (opts.signal) {
      if (opts.signal.aborted) child.kill()
      else opts.signal.addEventListener('abort', () => child.kill())
    }

    // Provide the prompt (stdin for shell fallbacks) and always close stdin so
    // the CLI doesn't wait ~3s for piped input that isn't coming.
    if (!direct) child.stdin?.write(opts.prompt)
    child.stdin?.end()
  })
}

// ---- post-task summary -----------------------------------------------------
// Built after a run so the caller can persist a durable memory item (through the
// single write queue). Never trusts the model's prose alone: it records the
// concrete tools used and files touched alongside the outcome text.
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Create'])

export function summarizeRun(prompt: string, run: RunResult): { title: string; content: string; files: string[] } {
  const files = [...new Set(run.activity.filter((a) => FILE_TOOLS.has(a.name)).map((a) => a.summary))]

  const counts = new Map<string, number>()
  for (const a of run.activity) counts.set(a.name, (counts.get(a.name) ?? 0) + 1)
  const tools = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n}×${c}` : n))

  const lines = [`Task: ${prompt.trim()}`]
  if (files.length) lines.push(`Files changed: ${files.join(', ')}`)
  if (tools.length) lines.push(`Tools used: ${tools.join(', ')}`)
  const outcome = (run.result || '').trim()
  if (outcome) lines.push(`Outcome: ${outcome.length > 600 ? outcome.slice(0, 600) + '…' : outcome}`)
  if (!run.ok && run.error) lines.push(`Note: ${run.error}`)

  return {
    title: `Claude Code: ${prompt.trim().slice(0, 56) || 'task'}`,
    content: lines.join('\n'),
    files
  }
}

// ---- helpers ---------------------------------------------------------------
function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return name
  if (input.file_path) return String(input.file_path)
  if (input.path) return String(input.path)
  if (input.command) return clip(String(input.command), 140)
  if (input.pattern) return String(input.pattern)
  if (input.url) return String(input.url)
  if (input.prompt) return clip(String(input.prompt), 100)
  return clip(JSON.stringify(input), 120)
}

function resultSummary(content: any): string {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content))
    text = content.map((c) => (typeof c === 'string' ? c : (c?.text ?? ''))).join(' ')
  return clip(text.replace(/\s+/g, ' ').trim(), 160)
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// ---- checkpoints (git-based rollback) --------------------------------------
// Before a headless task runs, the caller (ipc.ts) records the project's
// current HEAD so the user can undo everything the task did. We only ever
// do this against a clean working tree — never on top of the user's own
// uncommitted changes — and rollback is a plain `git reset --hard`, so both
// sides of this are intentionally simple, inspectable git operations.
function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn('git', args, { cwd, windowsHide: true })
    } catch (e: any) {
      resolve({ code: 1, stdout: '', stderr: String(e?.message ?? e) })
      return
    }
    child.stdout?.on('data', (d) => (out += d.toString()))
    child.stderr?.on('data', (d) => (err += d.toString()))
    child.on('error', (e: any) => resolve({ code: 1, stdout: out, stderr: String(e?.message ?? e) }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: out, stderr: err }))
  })
}

export async function isGitRepo(projectPath: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '--git-dir'], projectPath)
  return r.code === 0
}

export async function isGitClean(projectPath: string): Promise<boolean> {
  const r = await runGit(['status', '--porcelain'], projectPath)
  return r.code === 0 && r.stdout.trim() === ''
}

export async function getHeadCommit(projectPath: string): Promise<string | null> {
  const r = await runGit(['rev-parse', 'HEAD'], projectPath)
  return r.code === 0 ? r.stdout.trim() : null
}

export async function gitResetHard(projectPath: string, commitHash: string): Promise<{ success: boolean; error?: string }> {
  const r = await runGit(['reset', '--hard', commitHash], projectPath)
  return r.code === 0 ? { success: true } : { success: false, error: r.stderr.trim() || `git reset exited with code ${r.code}` }
}

export type CheckpointAttempt =
  | { ok: true; commitHash: string }
  | { ok: false; reason: 'not-git' | 'dirty' | 'error'; error?: string }

/** Best-effort checkpoint attempt: never throws, never touches a dirty tree. */
export async function tryCreateCheckpoint(projectPath: string): Promise<CheckpointAttempt> {
  try {
    if (!(await isGitRepo(projectPath))) return { ok: false, reason: 'not-git' }
    if (!(await isGitClean(projectPath))) return { ok: false, reason: 'dirty' }
    const commitHash = await getHeadCommit(projectPath)
    if (!commitHash) return { ok: false, reason: 'error', error: 'Could not resolve HEAD commit' }
    return { ok: true, commitHash }
  } catch (e: any) {
    return { ok: false, reason: 'error', error: String(e?.message ?? e) }
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
