import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getDb } from './db'

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  type?: 'stdio' | 'sse' | 'http'
}

export interface McpServer {
  name: string
  config: McpServerConfig
  enabled: boolean
  transport: 'stdio' | 'sse' | 'http'
  status: 'unknown' | 'checking' | 'ok' | 'error'
  statusMessage?: string
  lastChecked?: number
}

type McpCheckResult = { status: 'ok' | 'error'; message: string }

const ENABLED_STATE_KEY = 'mcp_enabled_state'

export function getClaudeConfigPath(): string {
  const appData = process.env.APPDATA
  const localAppData = process.env.LOCALAPPDATA
  const home = process.env.USERPROFILE ?? process.env.HOME
  const candidates = [
    appData ? join(appData, 'Claude', 'claude_desktop_config.json') : null,
    appData ? join(appData, 'Claude Desktop', 'claude_desktop_config.json') : null,
    localAppData ? join(localAppData, 'Claude', 'claude_desktop_config.json') : null,
    home ? join(home, '.config', 'Claude', 'claude_desktop_config.json') : null,
    home ? join(home, '.claude', 'claude_desktop_config.json') : null,
  ].filter((p): p is string => Boolean(p))

  return candidates.find((p) => existsSync(p)) ?? candidates[0] ?? join(process.cwd(), 'claude_desktop_config.json')
}

export function readMcpServers(): Record<string, McpServerConfig> {
  try {
    const path = getClaudeConfigPath()
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown }
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) return {}
    return parsed.mcpServers as Record<string, McpServerConfig>
  } catch {
    return {}
  }
}

export function writeMcpServers(servers: Record<string, McpServerConfig>): void {
  const path = getClaudeConfigPath()
  let fullConfig: Record<string, unknown> = {}
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fullConfig = parsed as Record<string, unknown>
      }
    }
  } catch {
    fullConfig = {}
  }

  fullConfig.mcpServers = servers
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(fullConfig, null, 2)}\n`, 'utf8')
  renameSync(tmpPath, path)
}

export async function checkMcpServer(name: string, config: McpServerConfig): Promise<McpCheckResult> {
  if (config.url) return checkHttpServer(config.url)
  if (!config.command?.trim()) return { status: 'error', message: 'Missing command' }
  return checkStdioServer(name, config)
}

export function getEnabledState(): Record<string, boolean> {
  try {
    const row = getDb()
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(ENABLED_STATE_KEY) as { value: string } | undefined
    if (!row?.value) return {}
    const parsed = JSON.parse(row.value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, boolean>
  } catch {
    return {}
  }
}

export function setEnabledState(state: Record<string, boolean>): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .run(ENABLED_STATE_KEY, JSON.stringify(state))
}

async function checkHttpServer(url: string): Promise<McpCheckResult> {
  const base = url.replace(/\/+$/, '')
  const urls = [`${base}/health`, base]
  let lastError = ''
  for (const candidate of urls) {
    try {
      const res = await fetch(candidate, { method: 'GET', signal: AbortSignal.timeout(5000) })
      if (res.ok) return { status: 'ok', message: `HTTP ${res.status}` }
      lastError = `HTTP ${res.status}`
    } catch (err: any) {
      lastError = err?.message ?? String(err)
    }
  }
  return { status: 'error', message: lastError || 'HTTP check failed' }
}

function resolveCommand(cmd: string): string {
  if (process.platform !== 'win32') return cmd
  const cmdExt = cmd + '.cmd'
  const searchPaths = [
    ...(process.env.PATH || '').split(';'),
    'C:\\Program Files\\nodejs',
    join(process.env.APPDATA || '', 'npm'),
  ]
  for (const dir of searchPaths) {
    const withExt = join(dir, cmdExt)
    if (existsSync(withExt)) return withExt
    const plain = join(dir, cmd)
    if (existsSync(plain)) return plain
  }
  return cmd
}

function checkStdioServer(_name: string, config: McpServerConfig): Promise<McpCheckResult> {
  const cmd = config.command!.trim()

  // node is always available — we're running inside it
  if (cmd === 'node') {
    return Promise.resolve({ status: 'ok', message: `Command found: ${process.execPath}` })
  }

  // npx / npm are bundled with node
  if (cmd === 'npx' || cmd === 'npm' || cmd === 'npx.cmd' || cmd === 'npm.cmd') {
    if (existsSync(process.execPath)) {
      return Promise.resolve({ status: 'ok', message: `Command found: node @ ${process.execPath}` })
    }
    return Promise.resolve({ status: 'error', message: `Command not found: ${cmd}` })
  }

  // For all other commands, try to resolve and check if the file exists
  const resolved = resolveCommand(cmd)
  if (existsSync(resolved)) {
    return Promise.resolve({ status: 'ok', message: `Command found: ${resolved}` })
  }
  return Promise.resolve({ status: 'error', message: `Command not found: ${cmd}` })
}
