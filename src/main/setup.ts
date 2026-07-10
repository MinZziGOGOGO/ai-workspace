import { spawn } from 'child_process'
import { getDb } from './db'

// First-run setup wizard support: detect which CLI tools / local servers are
// available so the wizard can show honest guidance instead of guessing.
//
// Every probe is best-effort with a short timeout (2s max) and never throws —
// a missing tool is a normal state, not an error. The renderer additionally
// caps the whole detection round at 5s, so nothing here may hang.

const IS_WIN = process.platform === 'win32'

export interface ToolStatus {
  installed: boolean
  version?: string
}

export interface ToolDetection {
  claudeCode: ToolStatus
  codex: ToolStatus
  kimi: ToolStatus
  ollama: ToolStatus
  hermes: ToolStatus
}

const PROBE_TIMEOUT_MS = 2000

// Run a command, collect stdout+stderr, resolve null on any failure/timeout.
function runProbe(cmd: string, args: string[], useShell: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (v: string | null) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    let child
    try {
      child = spawn(cmd, args, { shell: useShell, windowsHide: true })
    } catch {
      done(null)
      return
    }
    child.stdout?.on('data', (d) => (out += d.toString()))
    child.stderr?.on('data', (d) => (out += d.toString()))
    child.on('error', () => done(null))
    const t = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      done(null)
    }, PROBE_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(t)
      done(code === 0 ? out : null)
    })
  })
}

// Is the tool on PATH? `where` on Windows, `which` elsewhere.
async function toolOnPath(name: string): Promise<boolean> {
  const out = await runProbe(IS_WIN ? 'where.exe' : 'which', [name], false)
  return Boolean(out && out.trim())
}

function parseVersion(text: string | null): string | undefined {
  if (!text) return undefined
  const m = text.match(/\d+\.\d+(?:\.\d+)?/)
  return m ? m[0] : undefined
}

// `where`/`which` then `<tool> --version`. Shell lookup for the version call so
// Windows .cmd shims resolve without path quoting.
async function probeCommand(name: string): Promise<ToolStatus> {
  if (!(await toolOnPath(name))) return { installed: false }
  const version = parseVersion(await runProbe(name, ['--version'], true))
  return { installed: true, version }
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// Ollama: a reachable local server beats a PATH hit (it proves it is running).
async function detectOllama(): Promise<ToolStatus> {
  const version = await fetchJson('http://localhost:11434/api/version')
  if (version) return { installed: true, version: parseVersion(String(version.version ?? '')) }
  const tags = await fetchJson('http://localhost:11434/api/tags')
  if (tags) return { installed: true }
  return probeCommand('ollama')
}

// Hermes: try the local status endpoint, then fall back to a PATH check.
async function detectHermes(): Promise<ToolStatus> {
  const status = await fetchJson('http://localhost:9119/api/status')
  if (status) return { installed: true, version: parseVersion(String(status.version ?? '')) }
  return probeCommand('hermes')
}

export async function detectCliTools(): Promise<ToolDetection> {
  // E2E fake: deterministic results so the wizard flow can be tested without
  // real CLIs or network probes (mirrors E2E_FAKE_CODEX in codex.ts).
  if (process.env.E2E_FAKE_SETUP_TOOLS === '1') {
    return {
      claudeCode: { installed: true, version: '1.2.3' },
      codex: { installed: false },
      kimi: { installed: process.env.E2E_MISSING_KIMI !== '1', version: process.env.E2E_MISSING_KIMI === '1' ? undefined : 'fake-kimi-code' },
      ollama: { installed: true, version: '0.1.45' },
      hermes: { installed: false }
    }
  }
  const safe = (p: Promise<ToolStatus>) => p.catch((): ToolStatus => ({ installed: false }))
  const [claudeCode, codex, kimi, ollama, hermes] = await Promise.all([
    safe(probeCommand('claude')),
    safe(probeCommand('codex')),
    safe(probeCommand('kimi')),
    safe(detectOllama()),
    safe(detectHermes())
  ])
  return { claudeCode, codex, kimi, ollama, hermes }
}

// ---- wizard completion flag (app_meta) ---------------------------------------

const WIZARD_KEY = 'setup_wizard_completed'

export async function setupWizardComplete(): Promise<boolean> {
  // E2E: existing suites assert on the workspace shell immediately after
  // launch; without this they would all trip over the first-run wizard.
  if (process.env.E2E_SKIP_SETUP_WIZARD === '1') return true
  try {
    const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get(WIZARD_KEY) as
      | { value: string }
      | undefined
    return row?.value === 'true'
  } catch {
    return false
  }
}

export async function markSetupWizardComplete(complete = true): Promise<void> {
  const db = getDb()
  if (complete) db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(WIZARD_KEY, 'true')
  else db.prepare('DELETE FROM app_meta WHERE key = ?').run(WIZARD_KEY)
}
