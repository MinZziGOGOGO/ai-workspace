import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { extname, join } from 'path'

export interface KimiCheck {
  installed: boolean
  version?: string
  bin?: string
  error?: string
}

const IS_WIN = process.platform === 'win32'
const KIMI_NOT_FOUND =
  'Kimi Code CLI not found. Install it, open a new PowerShell, and run `where.exe kimi`. If found, restart AI Workspace.'

function isFakeKimi() {
  return process.env.E2E_FAKE_KIMI === '1' && process.env.E2E_MISSING_KIMI !== '1'
}

function isMissingKimiFake() {
  return process.env.E2E_MISSING_KIMI === '1'
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
  if (appData) candidates.push(join(appData, 'npm', IS_WIN ? 'kimi.cmd' : 'kimi'))
  if (localAppData) candidates.push(join(localAppData, 'Programs', 'Kimi Code', IS_WIN ? 'kimi.exe' : 'kimi'))

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

function spawnKimi(bin: string, args: string[]): ChildProcessWithoutNullStreams {
  const ext = extname(bin).toLowerCase()
  const shell = IS_WIN && (bin === 'kimi' || ext === '.cmd' || ext === '.bat')
  return spawn(bin, args, { shell, windowsHide: true })
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
