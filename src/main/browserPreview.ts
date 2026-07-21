import { request } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserPreviewDetectionResult, BrowserPreviewScriptSuggestion } from '../shared/ipcTypes'

const COMMON_PORTS = [5173, 3000, 4173, 5174]
const MAX_PACKAGE_BYTES = 256 * 1024
const PROBE_TIMEOUT_MS = 450
const MAX_PROBE_PORTS = 12

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

export function isLocalPreviewUrl(input: string): boolean {
  try {
    const parsed = new URL(input)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      loopbackHostname(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}

export function normalizePreviewUrl(input: string): string {
  const raw = input.trim()
  if (!raw) throw new Error('Enter a local preview URL.')
  const withScheme = /^(localhost|127\.0\.0\.1)(:\d+)?(?:\/|$)/i.test(raw) || /^\[::1\](?::\d+)?(?:\/|$)/i.test(raw)
    ? `http://${raw}`
    : raw
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error('Enter a valid local preview URL, such as http://localhost:5173.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Preview mode only allows local HTTP or HTTPS URLs.')
  }
  if (!loopbackHostname(parsed.hostname)) {
    throw new Error('Preview mode blocks non-local URLs. Use localhost, 127.0.0.1, or [::1].')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Preview URLs cannot include credentials.')
  }
  return parsed.href
}

function packageManagerFor(projectPath: string, packageManager: unknown): 'npm' | 'pnpm' | 'yarn' {
  if (typeof packageManager === 'string') {
    if (packageManager.startsWith('pnpm@')) return 'pnpm'
    if (packageManager.startsWith('yarn@')) return 'yarn'
  }
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function commandFor(manager: 'npm' | 'pnpm' | 'yarn', script: string): string {
  if (manager === 'npm') return `npm run ${script}`
  return `${manager} ${script}`
}

function portsFromText(text: string): number[] {
  const ports: number[] = []
  const patterns = [/(?:--port(?:=|\s+)|\s-p\s+)(\d{2,5})/g, /localhost:(\d{2,5})/g, /127\.0\.0\.1:(\d{2,5})/g]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const port = Number(match[1])
      if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.push(port)
    }
  }
  return ports
}

function probeUrl(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      res.resume()
      finish(true)
    })
    req.once('timeout', () => {
      req.destroy()
      finish(false)
    })
    req.once('error', () => finish(false))
    req.end()
  })
}

function safeRootFiles(projectPath: string): string[] {
  try {
    return readdirSync(projectPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export async function detectProjectPreview(projectPath: string): Promise<BrowserPreviewDetectionResult> {
  const rootFiles = safeRootFiles(projectPath)
  const lowerFiles = new Set(rootFiles.map((name) => name.toLowerCase()))
  const signals: string[] = []
  const suggestions: BrowserPreviewScriptSuggestion[] = []
  const inferredPorts: number[] = []
  let packageText = ''

  const packagePath = join(projectPath, 'package.json')
  if (lowerFiles.has('package.json')) {
    try {
      if (statSync(packagePath).size <= MAX_PACKAGE_BYTES) {
        packageText = readFileSync(packagePath, 'utf8')
        const pkg = JSON.parse(packageText) as { scripts?: Record<string, unknown>; packageManager?: unknown }
        const manager = packageManagerFor(projectPath, pkg.packageManager)
        const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
        for (const script of ['dev', 'start', 'preview'] as const) {
          if (typeof scripts[script] !== 'string') continue
          suggestions.push({ script, command: commandFor(manager, script), packageManager: manager })
          inferredPorts.push(...portsFromText(scripts[script] as string))
        }
        signals.push('package.json')
      }
    } catch {
      signals.push('package.json (unreadable)')
    }
  }

  const frameworkConfigs: Array<{ pattern: RegExp; label: string; port: number }> = [
    { pattern: /^vite\.config\./i, label: 'Vite', port: 5173 },
    { pattern: /^next\.config\./i, label: 'Next.js', port: 3000 },
    { pattern: /^astro\.config\./i, label: 'Astro', port: 4321 },
    { pattern: /^svelte\.config\./i, label: 'Svelte', port: 5173 },
  ]
  for (const config of frameworkConfigs) {
    const match = rootFiles.find((name) => config.pattern.test(name))
    if (!match) continue
    signals.push(`${config.label} (${match})`)
    inferredPorts.push(config.port)
    try {
      const filePath = join(projectPath, match)
      if (statSync(filePath).size <= MAX_PACKAGE_BYTES) inferredPorts.push(...portsFromText(readFileSync(filePath, 'utf8')))
    } catch { /* metadata signal is still useful */ }
  }

  // Tests can isolate detection from unrelated workstation services. Production
  // always includes the common presets and any project-inferred ports.
  const testPorts = process.env.E2E_PREVIEW_PROBE_PORTS
    ?.split(',')
    .map((value) => Number(value.trim()))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
  const portSource = testPorts?.length ? testPorts : [...inferredPorts, ...COMMON_PORTS]
  const ports = [...new Set(portSource)].slice(0, MAX_PROBE_PORTS)
  const candidates = ports.map((port) => `http://localhost:${port}`)
  const results = await Promise.all(candidates.map(async (url) => ({ url: `${url}/`, ok: await probeUrl(url) })))

  return {
    urls: results.filter((result) => result.ok).map((result) => result.url),
    suggestions,
    signals,
    probedPorts: ports,
    timeoutMs: PROBE_TIMEOUT_MS,
  }
}
