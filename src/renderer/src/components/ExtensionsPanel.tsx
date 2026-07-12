import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { HubSkillResult, McpServer, McpServerConfig, SkillItem } from '../types'
import { useToast } from './ToastContext'

type ExtTab = 'mcp' | 'skills' | 'agents'
type FormType = 'stdio' | 'http'
type EnvRow = { key: string; value: string }

interface FormState {
  originalName?: string
  name: string
  type: FormType
  command: string
  argsText: string
  url: string
  env: EnvRow[]
  error: string
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'stdio',
  command: '',
  argsText: '',
  url: '',
  env: [],
  error: ''
}

const QUICK_ADDS: Array<{
  name: string
  description: string
  config: McpServerConfig
  builtin?: boolean
  // Which bundled server this card resolves; drives the "already configured"
  // check and which main-process config resolver quickAdd calls.
  builtinKind?: 'knowledge' | 'browser'
  builtinServerName?: string
}> = [
  {
    name: 'Filesystem',
    description: 'Access local files and folders',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }
  },
  {
    name: 'GitHub',
    description: 'Read repos, issues, and PRs',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }
  },
  {
    name: 'Brave Search',
    description: 'Web search via Brave API',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] }
  },
  {
    name: 'PostgreSQL',
    description: 'Query your database',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] }
  },
  {
    name: 'AI Workspace Knowledge',
    description: 'Your workspace knowledge base',
    // Placeholder only — quickAdd resolves the real server.cjs path via IPC.
    config: { command: 'node', args: [] },
    builtin: true,
    builtinKind: 'knowledge',
    builtinServerName: 'ai-workspace-knowledge'
  },
  {
    name: 'AI Workspace Browser',
    description: 'Let agents drive the Browser panel',
    // Placeholder only — quickAdd resolves the real browser-server.cjs config via IPC.
    config: { command: 'node', args: [] },
    builtin: true,
    builtinKind: 'browser',
    builtinServerName: 'ai-workspace-browser'
  }
]

// ── Registry ──────────────────────────────────────────────────────────────────

const REG_CATEGORIES = [
  { label: 'All', search: '', description: 'Browse the registry without a category hint.' },
  { label: 'Developer Tools', search: 'github', description: 'Repository, issue, and development workflow servers.' },
  { label: 'Data & Storage', search: 'postgres', description: 'Databases, storage systems, and query tools.' },
  { label: 'Communication', search: 'slack', description: 'Messaging, team chat, and notification integrations.' },
  { label: 'Web & Search', search: 'search', description: 'Search, browser, crawling, and web lookup tools.' },
  { label: 'AI & ML', search: 'llm', description: 'Model, embedding, and AI workflow integrations.' },
  { label: 'Productivity', search: 'notion', description: 'Notes, docs, project tracking, and workspace apps.' },
  { label: 'Files & Docs', search: 'filesystem', description: 'File, document, and local content helpers.' },
]

interface RegistryPackage {
  registry_name?: string
  name?: string
  version?: string
  [key: string]: unknown
}

interface RegistryRemote {
  type?: string
  url?: string
  [key: string]: unknown
}

interface RegistryServer {
  id?: string
  name?: string
  title?: string
  description?: string
  publisher?: { name?: string; url?: string }
  packages?: RegistryPackage[]
  repository?: { url?: string }
  remotes?: RegistryRemote[]
  homepage?: string
  version?: string
  created_at?: string
  updated_at?: string
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

interface RegistryResult {
  server: RegistryServer
  _meta?: Record<string, any>
}

interface RegistryResponse {
  servers?: RegistryResult[]
  metadata?: { nextCursor?: string | null }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formFromConfig(name: string, config: McpServerConfig): FormState {
  const isHttp = Boolean(config.url)
  return {
    originalName: name,
    name,
    type: isHttp ? 'http' : 'stdio',
    command: config.command ?? '',
    argsText: (config.args ?? []).join(' '),
    url: config.url ?? '',
    env: Object.entries(config.env ?? {}).map(([key, value]) => ({ key, value })),
    error: ''
  }
}

function configFromForm(form: FormState): McpServerConfig {
  const env = form.env.reduce<Record<string, string>>((acc, row) => {
    const key = row.key.trim()
    if (key) acc[key] = row.value
    return acc
  }, {})

  if (form.type === 'http') {
    return {
      url: form.url.trim(),
      type: 'sse',
      ...(Object.keys(env).length ? { env } : {})
    }
  }

  const args = form.argsText
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter(Boolean)
  return {
    command: form.command.trim(),
    ...(args.length ? { args } : {}),
    ...(Object.keys(env).length ? { env } : {})
  }
}

function validateForm(form: FormState): string {
  if (!form.name.trim()) return 'Server name is required'
  if (/\s/.test(form.name.trim())) return 'Server name cannot contain spaces'
  if (form.type === 'stdio' && !form.command.trim()) return 'Command is required for stdio servers'
  if (form.type === 'http') {
    if (!form.url.trim()) return 'URL is required for HTTP/SSE servers'
    if (!/^https?:\/\//i.test(form.url.trim())) return 'URL must start with http:// or https://'
  }
  return ''
}

function statusLabel(server: McpServer): string {
  if (server.status === 'checking') return 'Checking'
  if (server.status === 'ok') return 'OK'
  if (server.status === 'error') return 'Error'
  return 'Unknown'
}

function formatTime(ts?: number): string {
  if (!ts) return 'Not checked yet'
  return new Date(ts).toLocaleString()
}

function formatRegistryDate(value?: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function registryOfficialMeta(result?: RegistryResult | null): Record<string, any> | null {
  return result?._meta?.['io.modelcontextprotocol.registry/official'] ?? null
}

function registryUpdatedDate(result: RegistryResult): string | null {
  const srv = result.server
  const official = registryOfficialMeta(result)
  return formatRegistryDate(
    srv.updated_at ??
      srv.updatedAt ??
      official?.updatedAt ??
      official?.publishedAt ??
      official?.statusChangedAt
  )
}

function registryServerTitle(server: RegistryServer): string {
  return server.title?.trim() || server.name?.trim() || 'Untitled MCP server'
}

function registryServerName(server: RegistryServer): string {
  return server.name?.trim() || server.id?.trim() || 'unknown-server'
}

function registryHasDistinctTitle(server: RegistryServer): boolean {
  const title = server.title?.trim()
  return Boolean(title && title !== registryServerName(server))
}

function registryPackageLabel(pkg: RegistryPackage): string {
  const registry = pkg.registry_name?.trim()
  if (registry && pkg.version) return `${registry} · ${pkg.version}`
  if (registry) return registry
  if (pkg.version) return `Version ${pkg.version}`
  return 'Package metadata'
}

function firstInstallableNpmPackage(server: RegistryServer): RegistryPackage | null {
  return server.packages?.find((pkg) => {
    const registry = pkg.registry_name?.toLowerCase() ?? ''
    return Boolean(pkg.name?.trim()) && (registry === 'npm' || registry.includes('npm'))
  }) ?? null
}

function installSnippet(server: RegistryServer): string | null {
  const pkg = firstInstallableNpmPackage(server)
  return pkg?.name ? `npx -y ${pkg.name}` : null
}

function registryPrimaryPackageName(server: RegistryServer): string | null {
  return firstInstallableNpmPackage(server)?.name ?? server.packages?.find((pkg) => pkg.name?.trim())?.name ?? null
}

function registryRemoteLabel(server: RegistryServer): string | null {
  const remote = server.remotes?.find((item) => item.url?.trim()) ?? server.remotes?.[0]
  if (!remote) return null
  return remote.type?.trim() || 'remote'
}

function registryRemoteUrl(server: RegistryServer): string | null {
  return server.remotes?.find((item) => item.url?.trim())?.url?.trim() ?? null
}

function registryResultKey(result: RegistryResult, index = 0): string {
  const server = result.server
  return server.id?.trim() || server.name?.trim() || `${registryServerTitle(server)}-${index}`
}

function safeRegistryConfigName(server: RegistryServer): string {
  return registryServerName(server)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'mcp-server'
}

function registryConfigSnippet(server: RegistryServer): string | null {
  const pkg = firstInstallableNpmPackage(server)
  if (!pkg?.name) return null
  const name = safeRegistryConfigName(server)
  return JSON.stringify({
    mcpServers: {
      [name]: {
        command: 'npx',
        args: ['-y', pkg.name]
      }
    }
  }, null, 2)
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ExtensionsPanel(props: { active?: boolean }) {
  const active = props.active ?? true
  const { addToast } = useToast()
  const [tab, setTab] = useState<ExtTab>('mcp')
  const [servers, setServers] = useState<McpServer[]>([])
  const [configPath, setConfigPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState<FormState | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addFormRef = useRef<HTMLDivElement>(null)

  // Registry state
  const [regSearch, setRegSearch] = useState('')
  const [regSearchEffective, setRegSearchEffective] = useState('')
  const [regCategory, setRegCategory] = useState(0)
  const [regCursors, setRegCursors] = useState<string[]>([])
  const [regCurrentCursor, setRegCurrentCursor] = useState('')
  const [regNextCursor, setRegNextCursor] = useState<string | null>(null)
  const [regServers, setRegServers] = useState<RegistryResult[]>([])
  const [regLoading, setRegLoading] = useState(false)
  const [regError, setRegError] = useState<string | null>(null)
  const [regExpanded, setRegExpanded] = useState<string | null>(null)
  const [regSelected, setRegSelected] = useState<RegistryResult | null>(null)
  const [regRetryToken, setRegRetryToken] = useState(0)
  const [featuredOpen, setFeaturedOpen] = useState(false)
  const regRequestSeq = useRef(0)

  const errorCount = servers.filter((s) => s.status === 'error').length
  const serverNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers])
  const activeRegCategory = REG_CATEGORIES[regCategory]
  const effectiveRegistryQuery = regSearchEffective.trim() || activeRegCategory.search
  const registryQuerySource = regSearchEffective.trim()
    ? 'Manual search'
    : activeRegCategory.search
      ? 'Category search'
      : 'All servers'

  async function loadServers(checkAll = false) {
    setLoading(true)
    try {
      const [list, path] = await Promise.all([
        window.api.mcp.list(),
        window.api.mcp.getConfigPath()
      ])
      setServers(list)
      setConfigPath(path)
      if (checkAll && list.length > 0) await runCheckAll(list)
    } finally {
      setLoading(false)
    }
  }

  async function runCheckAll(baseList = servers) {
    setServers((prev) => prev.map((s) => ({ ...s, status: 'checking', statusMessage: undefined })))
    const results = await window.api.mcp.checkAll()
    const checkedAt = Date.now()
    setServers((prev) => (prev.length > 0 ? prev : baseList).map((s) => {
      const result = results[s.name]
      if (!result) return s
      return {
        ...s,
        status: result.status === 'ok' ? 'ok' : 'error',
        statusMessage: result.message,
        lastChecked: checkedAt
      }
    }))
  }

  async function checkOne(name: string) {
    setServers((prev) => prev.map((s) => s.name === name ? { ...s, status: 'checking' } : s))
    const result = await window.api.mcp.check(name)
    setServers((prev) => prev.map((s) => s.name === name
      ? {
          ...s,
          status: result.status === 'ok' ? 'ok' : 'error',
          statusMessage: result.message,
          lastChecked: Date.now()
        }
      : s
    ))
  }

  useEffect(() => {
    if (!active) return
    void loadServers(true)
  }, [active])

  useEffect(() => {
    return () => {
      if (deleteTimer.current) clearTimeout(deleteTimer.current)
    }
  }, [])

  // Fetch registry on search/category/page/tab change
  useEffect(() => {
    if (!active) return
    if (tab !== 'mcp') return
    const requestId = ++regRequestSeq.current
    setRegLoading(true)
    setRegError(null)
    window.api.registry.search(effectiveRegistryQuery, regCurrentCursor)
      .then((data: RegistryResponse) => {
        if (requestId !== regRequestSeq.current) return
        if (!data || !Array.isArray(data.servers)) {
          throw new Error('The registry returned an unexpected response.')
        }
        const seen = new Set<string>()
        const unique = (data.servers ?? []).filter((r: RegistryResult) => {
          if (!r?.server) return false
          const key = registryServerName(r.server)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        setRegServers(unique)
        setRegNextCursor(data.metadata?.nextCursor ?? null)
      })
      .catch((err: any) => {
        if (requestId !== regRequestSeq.current) return
        setRegError(err?.message || 'Could not reach MCP Registry. Check your connection.')
        setRegServers([])
        setRegNextCursor(null)
      })
      .finally(() => {
        if (requestId === regRequestSeq.current) setRegLoading(false)
      })
  }, [effectiveRegistryQuery, regCurrentCursor, regCategory, tab, regRetryToken])

  async function saveServer() {
    if (!form) return
    const error = validateForm(form)
    if (error) {
      setForm({ ...form, error })
      return
    }
    const name = form.name.trim()
    try {
      if (form.originalName && form.originalName !== name) {
        const removeResult = await window.api.mcp.remove(form.originalName)
        if (!removeResult.success) {
          setForm({ ...form, error: `Failed to rename server: ${removeResult.error ?? 'unknown error'}` })
          addToast(`Failed to save ${name}`)
          return
        }
      }
      const addResult = await window.api.mcp.add(name, configFromForm(form))
      if (!addResult.success) {
        setForm({ ...form, error: `Failed to save server: ${addResult.error ?? 'unknown error'}` })
        addToast(`Failed to save ${name}`)
        return
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setForm({ ...form, error: `Failed to save server: ${message}` })
      addToast(`Failed to save ${name}`)
      return
    }
    setForm(null)
    await loadServers(false)
    await checkOne(name)
  }

  async function quickAdd(item: (typeof QUICK_ADDS)[number]) {
    const safeName = uniqueName(item.name.replace(/\s+/g, '-').toLowerCase())
    let config = item.config
    // Bundled servers ship with the app — resolve their real launch config from
    // main instead of inserting a placeholder into the live config.
    if (item.builtin) {
      try {
        config =
          item.builtinKind === 'browser'
            ? await window.api.mcp.getBrowserServerConfig()
            : await window.api.mcp.getKnowledgeServerConfig()
      } catch {
        addToast(`Could not resolve the ${item.name} config`)
        return
      }
    }
    try {
      const result = await window.api.mcp.add(safeName, config)
      if (!result.success) {
        addToast(`Failed to add ${item.name}: ${result.error ?? 'unknown error'}`)
        return
      }
    } catch (err) {
      addToast(`Failed to add ${item.name}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    await loadServers(false)
    setForm(formFromConfig(safeName, config))
    await checkOne(safeName)
  }

  function uniqueName(base: string): string {
    if (!serverNames.has(base)) return base
    let i = 2
    while (serverNames.has(`${base}-${i}`)) i++
    return `${base}-${i}`
  }

  async function toggleEnabled(server: McpServer, enabled: boolean) {
    const result = await window.api.mcp.setEnabled(server.name, enabled)
    if (!result.success) {
      addToast(`Failed to ${enabled ? 'enable' : 'disable'} ${server.name}: ${result.error ?? 'unknown error'}`)
      return
    }
    setServers((prev) => prev.map((s) => s.name === server.name ? { ...s, enabled } : s))
  }

  async function deleteServer(name: string) {
    if (pendingDelete !== name) {
      setPendingDelete(name)
      addToast(`Remove ${name}? Click again to confirm`)
      if (deleteTimer.current) clearTimeout(deleteTimer.current)
      deleteTimer.current = setTimeout(() => setPendingDelete(null), 3000)
      return
    }
    const result = await window.api.mcp.remove(name)
    if (!result.success) {
      addToast(`Failed to remove ${name}: ${result.error ?? 'unknown error'}`)
      return
    }
    setPendingDelete(null)
    setExpanded((cur) => cur === name ? null : cur)
    await loadServers(false)
    addToast(`${name} removed`)
  }

  function updateEnv(index: number, patch: Partial<EnvRow>) {
    if (!form) return
    setForm({
      ...form,
      env: form.env.map((row, i) => i === index ? { ...row, ...patch } : row),
      error: ''
    })
  }

  function removeEnv(index: number) {
    if (!form) return
    setForm({ ...form, env: form.env.filter((_, i) => i !== index), error: '' })
  }

  function selectCategory(idx: number) {
    setRegCategory(idx)
    setRegSearch('')
    setRegSearchEffective('')
    resetRegistryPaging()
  }

  function submitRegistrySearch(e?: FormEvent) {
    e?.preventDefault()
    const nextSearch = regSearch.trim()
    setRegCategory(0)
    setRegSearchEffective(nextSearch)
    resetRegistryPaging()
  }

  function clearSearch() {
    setRegCategory(0)
    setRegSearch('')
    setRegSearchEffective('')
    resetRegistryPaging()
  }

  function runRegistrySuggestion(query: string) {
    setRegCategory(0)
    setRegSearch(query)
    setRegSearchEffective(query)
    resetRegistryPaging()
  }

  function resetRegistryPaging() {
    setRegCursors([])
    setRegCurrentCursor('')
    setRegNextCursor(null)
    setRegExpanded(null)
    setRegSelected(null)
  }

  function goToNextRegistryPage() {
    if (!regNextCursor) return
    setRegCursors((prev) => [...prev, regCurrentCursor])
    setRegCurrentCursor(regNextCursor)
    setRegNextCursor(null)
  }

  function goToPreviousRegistryPage() {
    const previousCursor = regCursors[regCursors.length - 1]
    if (previousCursor === undefined) return
    setRegCursors((prev) => prev.slice(0, -1))
    setRegCurrentCursor(previousCursor)
    setRegNextCursor(null)
  }

  function prefillFromRegistry(result: RegistryResult) {
    const server = result.server
    const pkg = firstInstallableNpmPackage(server)
    if (!pkg?.name) {
      setRegSelected(result)
      addToast('No npm install metadata available for this registry entry')
      return
    }
    const base = safeRegistryConfigName(server)
    const name = uniqueName(base)
    setForm({ name, type: 'stdio', command: 'npx', argsText: `-y ${pkg.name}`, url: '', env: [], error: '' })
    setTimeout(() => {
      addFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
  }

  async function copyRegistryText(label: string, text: string | null) {
    if (!text) {
      addToast(`${label} is not available`)
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      addToast(`${label} copied`)
    } catch {
      addToast(`Could not copy ${label.toLowerCase()}`)
    }
  }

  const regHasResults = !regLoading && !regError && regServers.length > 0
  const regEmptyMsg = regSearchEffective
    ? `No servers found for "${regSearchEffective}"`
    : activeRegCategory.search
      ? `No servers found for "${activeRegCategory.label}"`
      : 'No servers found'

  return (
    <div className="extensions-panel">
      <div className="ext-tabs" role="tablist" aria-label="Extensions">
        <button
          role="tab"
          aria-selected={tab === 'mcp'}
          className={`ext-tab ${tab === 'mcp' ? 'active' : ''}`}
          onClick={() => setTab('mcp')}
        >
          MCP Servers
        </button>
        <button
          role="tab"
          aria-selected={tab === 'skills'}
          className={`ext-tab ${tab === 'skills' ? 'active' : ''}`}
          onClick={() => setTab('skills')}
        >
          Skills
        </button>
        <button
          role="tab"
          aria-selected={tab === 'agents'}
          className={`ext-tab ${tab === 'agents' ? 'active' : ''}`}
          onClick={() => setTab('agents')}
        >
          Agents
        </button>
      </div>

      {tab === 'mcp' && (
        <div className="ext-tab-panel">
          <div className="ext-mcp-head">
            <span>MCP SERVERS</span>
            <div className="ext-head-actions">
              <button className="ghost tiny" onClick={() => void runCheckAll()} disabled={servers.length === 0 || loading}>Check all</button>
              <button className="ghost tiny" onClick={() => setForm({ ...EMPTY_FORM })}>+ Add server</button>
            </div>
          </div>

          <div className="ext-enable-note muted small">
            Enable/disable applies to new agent sessions immediately. Claude Desktop reads this
            config on startup — restart it for changes to take effect there.
          </div>

          {errorCount > 0 && (
            <div className="ext-error-banner">
              {errorCount} {errorCount === 1 ? 'server has' : 'servers have'} connection errors
            </div>
          )}

          {servers.length === 0 ? (
            <div className="ext-empty">
              <h2>No MCP servers configured</h2>
              <p>MCP servers extend your AI agents with tools for web search, databases, file systems, APIs, and more.</p>
              <button className="primary tiny" onClick={() => setForm({ ...EMPTY_FORM })}>+ Add your first server</button>
            </div>
          ) : (
            <div className="ext-server-list">
              {servers.map((server) => (
                <div className={`ext-server-item ${server.enabled ? '' : 'muted'}`} key={server.name}>
                  <div
                    className="ext-server-row"
                    onClick={() => setExpanded((cur) => cur === server.name ? null : server.name)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setExpanded((cur) => cur === server.name ? null : server.name)
                      }
                    }}
                    aria-expanded={expanded === server.name}
                    role="button"
                    tabIndex={0}
                  >
                    <span className={`ext-status-dot ${server.status}`} title={statusLabel(server)} />
                    <span className="ext-server-name">{server.name}</span>
                    <span className="ext-transport-badge">{server.transport === 'stdio' ? 'STDIO' : 'HTTP'}</span>
                    <span className="ext-row-spacer" />
                    <span
                      role="switch"
                      aria-checked={server.enabled}
                      tabIndex={0}
                      className={`settings-toggle ${server.enabled ? 'on' : ''}`}
                      title={server.enabled ? 'Disable server' : 'Enable server'}
                      onClick={(e) => { e.stopPropagation(); void toggleEnabled(server, !server.enabled) }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          void toggleEnabled(server, !server.enabled)
                        }
                      }}
                    >
                      <span />
                    </span>
                    <button
                      className={`ghost tiny ext-check-btn ${server.status === 'checking' ? 'checking' : ''}`}
                      title="Check server"
                      onClick={(e) => { e.stopPropagation(); void checkOne(server.name) }}
                    >
                      ↻
                    </button>
                    <button
                      className={`ghost tiny ext-delete-btn ${pendingDelete === server.name ? 'confirm' : ''}`}
                      title={`Delete ${server.name}`}
                      onClick={(e) => { e.stopPropagation(); void deleteServer(server.name) }}
                    >
                      ×
                    </button>
                  </div>

                  {expanded === server.name && (
                    <div className="ext-server-detail">
                      {server.config.url ? (
                        <div><strong>URL</strong><code>{server.config.url}</code></div>
                      ) : (
                        <>
                          <div><strong>Command</strong><code>{server.config.command || '(missing)'}</code></div>
                          <div><strong>Arguments</strong><code>{(server.config.args ?? []).join(' ') || '(none)'}</code></div>
                        </>
                      )}
                      <div><strong>Env</strong><code>{formatEnv(server.config.env)}</code></div>
                      <div><strong>Last check</strong><span>{formatTime(server.lastChecked)}</span></div>
                      {server.statusMessage && <div><strong>Status</strong><span>{server.statusMessage}</span></div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Featured servers — collapsed by default */}
          <div className="ext-featured">
            <button className="ext-featured-toggle" onClick={() => setFeaturedOpen((v) => !v)}>
              <span>Featured servers</span>
              <span className="ext-featured-chevron">{featuredOpen ? '▲' : '▼'}</span>
            </button>
            {featuredOpen && (
              <div className="ext-featured-grid">
                <div className="ext-quick-add-grid">
                  {QUICK_ADDS.map((item) => {
                    // Bundled servers are auto-registered on app startup;
                    // don't offer a second copy when already configured.
                    const builtinConfigured = Boolean(
                      item.builtin && item.builtinServerName && serverNames.has(item.builtinServerName)
                    )
                    return (
                      <div className="ext-quick-add-card" key={item.name}>
                        <strong>{item.name}</strong>
                        <span>
                          {item.description}
                          {item.builtin && (
                            <span className="ext-transport-badge" style={{ marginLeft: 6, fontSize: 9, height: 14, verticalAlign: 'middle' }}>Built-in</span>
                          )}
                        </span>
                        <button
                          className="ghost tiny"
                          onClick={() => void quickAdd(item)}
                          disabled={builtinConfigured}
                          title={builtinConfigured ? 'Added automatically on startup' : undefined}
                        >
                          {builtinConfigured ? '✓ Configured' : '+ Add'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Registry browser */}
          <div className="ext-registry-section" data-testid="mcp-registry-browser">
            <div className="ext-registry-header">
              <div>
                <span className="ext-section-kicker">MCP Registry</span>
                <h2>Discover MCP servers</h2>
                <p>
                  Registry categories are approximate: the public registry currently supports name-based search,
                  so each category maps to a practical search term.
                </p>
              </div>
              <span className="ext-registry-status">Read-only discovery</span>
            </div>

            <div className="ext-registry-tabs" aria-label="Registry categories">
              {REG_CATEGORIES.map((cat, i) => (
                <button
                  key={cat.label}
                  className={`ext-registry-tab ${regCategory === i ? 'active' : ''}`}
                  onClick={() => selectCategory(i)}
                  aria-pressed={regCategory === i}
                  title={`${cat.description} ${cat.search ? `Uses registry search term "${cat.search}".` : 'No registry search term.'}`}
                >
                  <span>{cat.label}</span>
                  <code>{cat.search || 'all'}</code>
                </button>
              ))}
            </div>

            <form className="ext-registry-search" onSubmit={submitRegistrySearch}>
              <input
                value={regSearch}
                onChange={(e) => setRegSearch(e.target.value)}
                placeholder="Search server names, packages, or tools..."
                data-testid="mcp-registry-search"
                aria-label="Search MCP Registry"
              />
              {(regSearch || regSearchEffective) && (
                <button type="button" className="ext-registry-clear" onClick={clearSearch} title="Clear search">Clear</button>
              )}
              <button className="primary tiny" type="submit" disabled={regLoading}>Search</button>
            </form>

            <div className="ext-registry-query-note" data-testid="mcp-registry-query-note">
              <span>{registryQuerySource}</span>
              <code>{effectiveRegistryQuery || 'all'}</code>
              <span>Page {regCursors.length + 1}</span>
              {regSearchEffective && activeRegCategory.search && (
                <em>Manual search overrides the active category until cleared.</em>
              )}
            </div>

            <div className="ext-registry-list motion-list motion-list-tight">
              {regLoading && Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="ext-registry-row ext-registry-skeleton">
                  <div className="ext-reg-skel-name" />
                  <div className="ext-reg-skel-desc" />
                </div>
              ))}

              {!regLoading && regError && (
                <div className="ext-registry-state ext-registry-error" data-testid="mcp-registry-error">
                  <strong>Registry unavailable</strong>
                  <span>{regError}</span>
                  <button className="ghost tiny" onClick={() => setRegRetryToken((n) => n + 1)}>Retry</button>
                </div>
              )}

              {!regLoading && !regError && regServers.length === 0 && (
                <div className="ext-registry-state ext-registry-empty" data-testid="mcp-registry-empty">
                  <strong>{regEmptyMsg}</strong>
                  <span>Try a broader search such as github, postgres, filesystem, or search.</span>
                  <div className="ext-registry-suggestions">
                    {['github', 'postgres', 'filesystem', 'search', 'slack', 'notion'].map((query) => (
                      <button key={query} className="ghost tiny" onClick={() => runRegistrySuggestion(query)}>
                        {query}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {regHasResults && regServers.map((result, index) => {
                const srv = result.server
                const key = registryResultKey(result, index)
                const displayName = registryServerTitle(srv)
                const technicalName = registryServerName(srv)
                const npmSnippet = installSnippet(srv)
                const packageName = registryPrimaryPackageName(srv)
                const remoteLabel = registryRemoteLabel(srv)
                const updated = registryUpdatedDate(result)
                const created = formatRegistryDate(srv.created_at ?? srv.createdAt)
                const hasDistinctTitle = registryHasDistinctTitle(srv)
                return (
                <div
                  key={key}
                  className={`ext-registry-row ${regExpanded === key ? 'expanded' : ''}`}
                  data-testid="mcp-registry-result"
                >
                  <div
                    className="ext-registry-row-main"
                    role="button"
                    tabIndex={0}
                    onClick={() => setRegExpanded((cur) => cur === key ? null : key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setRegExpanded((cur) => cur === key ? null : key)
                      }
                    }}
                    aria-expanded={regExpanded === key}
                  >
                    <div className="ext-registry-row-info">
                      <span className="ext-reg-name">{displayName}</span>
                      {hasDistinctTitle && <code className="ext-reg-technical-name">{technicalName}</code>}
                      {srv.description ? (
                        <p className="ext-reg-desc">{srv.description}</p>
                      ) : (
                        <p className="ext-reg-desc muted">No description provided by the registry.</p>
                      )}
                      <div className="ext-registry-badges">
                        <span className="ext-transport-badge">Registry</span>
                        {srv.packages?.[0] && <span className="ext-transport-badge">{registryPackageLabel(srv.packages[0])}</span>}
                        {!srv.packages?.[0] && srv.version && <span className="ext-transport-badge">Version {srv.version}</span>}
                        {remoteLabel && <span className="ext-transport-badge">{remoteLabel}</span>}
                        {updated && <span className="ext-transport-badge">Updated {updated}</span>}
                        {!updated && created && <span className="ext-transport-badge">Created {created}</span>}
                      </div>
                    </div>
                    <button
                      className="ghost tiny"
                      onClick={(e) => { e.stopPropagation(); setRegSelected(result) }}
                    >
                      Details
                    </button>
                    <button
                      className="ghost tiny ext-reg-add-btn"
                      onClick={(e) => { e.stopPropagation(); prefillFromRegistry(result) }}
                      disabled={!npmSnippet}
                      title={npmSnippet ? 'Prefill the local MCP server form' : 'No npm install metadata available'}
                    >
                      Configure
                    </button>
                  </div>

                  {regExpanded === key && (
                    <div className="ext-registry-detail motion-detail">
                      <div className="ext-registry-detail-grid">
                        <span>Server name</span>
                        <code>{technicalName}</code>
                        <span>Publisher</span>
                        <span>{srv.publisher?.name || 'Not provided'}</span>
                        <span>Version</span>
                        <span>{srv.version || srv.packages?.[0]?.version || 'Not provided'}</span>
                        <span>Package</span>
                        <span>{packageName || 'No package metadata provided.'}</span>
                        <span>Remote</span>
                        <span>{registryRemoteUrl(srv) || 'No remote endpoint provided.'}</span>
                        <span>Install hint</span>
                        <span>{npmSnippet || 'No install command provided by the registry entry.'}</span>
                      </div>
                      {npmSnippet && (
                        <div className="ext-registry-install">
                          <code>{npmSnippet}</code>
                        </div>
                      )}
                      <div className="ext-registry-detail-actions">
                        <button className="ghost tiny" onClick={() => void copyRegistryText('Server name', technicalName)}>
                          Copy name
                        </button>
                        <button className="ghost tiny" onClick={() => void copyRegistryText('Registry details', JSON.stringify(result, null, 2))}>
                          Copy details
                        </button>
                        <button
                          className="ghost tiny"
                          disabled={!registryConfigSnippet(srv)}
                          onClick={() => void copyRegistryText('Config snippet', registryConfigSnippet(srv))}
                        >
                          Copy config
                        </button>
                        {srv.repository?.url && (
                          <button
                            className="ghost tiny"
                            onClick={() => void window.api.shell.openExternal(srv.repository!.url!)}
                          >
                            Repository
                          </button>
                        )}
                        <button
                          className="primary tiny"
                          disabled={!npmSnippet}
                          onClick={() => prefillFromRegistry(result)}
                        >
                          Configure manually
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                )
              })}
            </div>

            {!regLoading && !regError && (regCursors.length > 0 || regNextCursor) && (
              <div className="ext-registry-pagination">
                <button
                  className="ghost tiny"
                  disabled={regCursors.length === 0}
                  onClick={goToPreviousRegistryPage}
                >
                  Previous
                </button>
                <span>Page {regCursors.length + 1}</span>
                <button
                  className="ghost tiny"
                  disabled={!regNextCursor}
                  onClick={goToNextRegistryPage}
                >
                  Next
                </button>
              </div>
            )}

            {regSelected && (
              <div className="ext-registry-details-panel motion-detail" data-testid="mcp-registry-details">
                <div className="ext-registry-details-head">
                  <div>
                    <span className="ext-section-kicker">Registry details</span>
                    <h3>{registryServerTitle(regSelected.server)}</h3>
                    <code>{registryServerName(regSelected.server)}</code>
                  </div>
                  <button className="ghost tiny" onClick={() => setRegSelected(null)}>Close</button>
                </div>
                {regSelected.server.description && <p>{regSelected.server.description}</p>}
                <div className="ext-registry-detail-grid">
                  <span>Publisher</span>
                  <span>{regSelected.server.publisher?.name || 'Not provided'}</span>
                  <span>Version</span>
                  <span>{regSelected.server.version || regSelected.server.packages?.[0]?.version || 'Not provided'}</span>
                  <span>Package</span>
                  <span>{registryPrimaryPackageName(regSelected.server) || 'Not provided'}</span>
                  <span>Remote</span>
                  <span>{registryRemoteUrl(regSelected.server) || 'Not provided'}</span>
                  <span>Repository</span>
                  <span>{regSelected.server.repository?.url || 'Not provided'}</span>
                  <span>Homepage</span>
                  <span>{regSelected.server.homepage || 'Not provided'}</span>
                  <span>Install</span>
                  <span>{installSnippet(regSelected.server) || 'Install instructions are not available from this registry entry.'}</span>
                </div>
                <div className="ext-registry-detail-actions">
                  <button className="ghost tiny" onClick={() => void copyRegistryText('Server name', registryServerName(regSelected.server))}>Copy name</button>
                  <button className="ghost tiny" onClick={() => void copyRegistryText('Registry details', JSON.stringify(regSelected, null, 2))}>Copy details</button>
                  <button
                    className="ghost tiny"
                    disabled={!registryConfigSnippet(regSelected.server)}
                    onClick={() => void copyRegistryText('Config snippet', registryConfigSnippet(regSelected.server))}
                  >
                    Copy config
                  </button>
                  {regSelected.server.repository?.url && (
                    <button className="ghost tiny" onClick={() => void window.api.shell.openExternal(regSelected.server.repository!.url!)}>
                      Repository
                    </button>
                  )}
                  <button
                    className="primary tiny"
                    disabled={!installSnippet(regSelected.server)}
                    onClick={() => prefillFromRegistry(regSelected)}
                  >
                    Configure manually
                  </button>
                </div>
                <details className="ext-registry-json">
                  <summary>Raw registry metadata</summary>
                  <pre>{JSON.stringify(regSelected, null, 2)}</pre>
                </details>
              </div>
            )}
          </div>

          {form && (
            <div className="ext-add-form motion-detail" ref={addFormRef}>
              <div className="ext-form-row">
                <label>Server name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, error: '' })} placeholder="server-name" />
              </div>
              <div className="ext-form-row">
                <label>Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as FormType, error: '' })}>
                  <option value="stdio">stdio</option>
                  <option value="http">HTTP/SSE</option>
                </select>
              </div>

              {form.type === 'stdio' ? (
                <>
                  <div className="ext-form-row">
                    <label>Command</label>
                    <input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value, error: '' })} placeholder="npx" />
                  </div>
                  <div className="ext-form-row">
                    <label>Arguments</label>
                    <textarea value={form.argsText} onChange={(e) => setForm({ ...form, argsText: e.target.value, error: '' })} placeholder="-y @modelcontextprotocol/server-filesystem ." />
                  </div>
                </>
              ) : (
                <div className="ext-form-row">
                  <label>URL</label>
                  <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value, error: '' })} placeholder="http://localhost:3000" />
                </div>
              )}

              <div className="ext-env-block">
                <div className="ext-env-head">
                  <span>Environment variables</span>
                  <button className="ghost tiny" onClick={() => setForm({ ...form, env: [...form.env, { key: '', value: '' }] })}>+ Add variable</button>
                </div>
                {form.env.map((row, index) => (
                  <div className="ext-env-row" key={index}>
                    <input value={row.key} onChange={(e) => updateEnv(index, { key: e.target.value })} placeholder="KEY" />
                    <input value={row.value} onChange={(e) => updateEnv(index, { value: e.target.value })} placeholder="VALUE" />
                    <button className="ghost tiny" onClick={() => removeEnv(index)}>×</button>
                  </div>
                ))}
              </div>

              {form.error && <div className="ext-form-error">{form.error}</div>}
              <div className="ext-form-actions">
                <button className="ghost tiny" onClick={() => setForm(null)}>Cancel</button>
                <button className="primary tiny" onClick={() => void saveServer()}>Save server</button>
              </div>
            </div>
          )}

          <div className="ext-config-path">Config: {configPath || 'Claude Desktop config path not found yet'}</div>
        </div>
      )}

      {tab === 'skills' && <SkillsTab />}
      {tab === 'agents' && <Placeholder title="Agent extensions coming soon" body="Connect Cursor, Gemini CLI, and other AI agents." />}
    </div>
  )
}

// ── Skills tab ────────────────────────────────────────────────────────────────
// Hermes skills browser backed by the dashboard API (via IPC — the renderer
// CSP blocks direct fetches). The installed list can exceed 1,900 items, so it
// is search-first: never more than SKILLS_FILTER_LIMIT rows in the DOM.

const SKILLS_DEFAULT_LIMIT = 30
const SKILLS_FILTER_LIMIT = 50
const SKILLS_INSTALL_RECHECK_MS = 3000

function SkillsTab() {
  const { addToast } = useToast()
  const [skills, setSkills] = useState<SkillItem[] | null>(null)
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [hubOpen, setHubOpen] = useState(false)
  const [hubQuery, setHubQuery] = useState('')
  const [hubResults, setHubResults] = useState<HubSkillResult[]>([])
  const [hubLoading, setHubLoading] = useState(false)
  const [hubError, setHubError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const hubRequestSeq = useRef(0)

  async function loadSkills() {
    setSkillsLoading(true)
    setSkillsError(null)
    const res = await window.api.hermesSkills.list()
    setSkillsLoading(false)
    if (res.success && res.skills) {
      setSkills(res.skills)
      return res.skills
    }
    // Keep an already-loaded list on refresh failure; only show the error
    // state when there is nothing to display.
    if (skills === null) setSkillsError(res.error ?? 'Unknown error')
    else addToast('Could not refresh skills — Hermes unreachable')
    return null
  }

  useEffect(() => {
    void loadSkills()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    if (!skills) return { rows: [] as SkillItem[], matches: 0 }
    const q = search.trim().toLowerCase()
    if (!q) return { rows: skills.slice(0, SKILLS_DEFAULT_LIMIT), matches: skills.length }
    const matches = skills.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)
    )
    return { rows: matches.slice(0, SKILLS_FILTER_LIMIT), matches: matches.length }
  }, [skills, search])

  async function toggleSkill(skill: SkillItem) {
    const next = !skill.enabled
    setSkills((prev) => prev?.map((s) => (s.name === skill.name ? { ...s, enabled: next } : s)) ?? prev)
    const res = await window.api.hermesSkills.toggle(skill.name, next)
    if (!res.success) {
      setSkills((prev) => prev?.map((s) => (s.name === skill.name ? { ...s, enabled: skill.enabled } : s)) ?? prev)
      addToast(`Could not ${next ? 'enable' : 'disable'} ${skill.name}`)
    }
  }

  // Hub search — debounced 400ms; a request sequence guards against stale
  // responses overwriting newer ones (same pattern as the MCP registry).
  useEffect(() => {
    if (!hubOpen) return
    const q = hubQuery.trim()
    if (!q) {
      hubRequestSeq.current++
      setHubResults([])
      setHubError(null)
      setHubLoading(false)
      return
    }
    const requestId = ++hubRequestSeq.current
    setHubLoading(true)
    setHubError(null)
    const t = setTimeout(() => {
      window.api.hermesSkills.search(q).then((res) => {
        if (requestId !== hubRequestSeq.current) return
        setHubLoading(false)
        if (res.success && res.results) setHubResults(res.results)
        else {
          setHubResults([])
          setHubError(res.error ?? 'Hub search failed')
        }
      })
    }, 400)
    return () => clearTimeout(t)
  }, [hubQuery, hubOpen])

  async function installSkill(result: HubSkillResult) {
    setInstalling((prev) => new Set(prev).add(result.identifier))
    const res = await window.api.hermesSkills.install(result.identifier)
    if (!res.success) {
      setInstalling((prev) => {
        const next = new Set(prev)
        next.delete(result.identifier)
        return next
      })
      addToast(`Install failed: ${res.error ?? 'unknown error'}`)
      return
    }
    addToast(`Installing ${result.name}... this may take a moment`)
    // The install job is async server-side — re-fetch after a beat to see
    // whether the skill has landed yet.
    const installedName = res.name || result.name
    setTimeout(async () => {
      const refreshed = await loadSkills()
      setInstalling((prev) => {
        const next = new Set(prev)
        next.delete(result.identifier)
        return next
      })
      if (refreshed?.some((s) => s.name === installedName)) addToast(`✓ ${result.name} installed`)
      else addToast(`${result.name} install started — refresh to check`)
    }, SKILLS_INSTALL_RECHECK_MS)
  }

  const searchActive = search.trim().length > 0

  return (
    <div className="ext-tab-panel" data-testid="skills-tab">
      <div className="skills-installed-header">
        <span>
          INSTALLED SKILLS{skills ? ` (${skills.length.toLocaleString('en-US')})` : ''}
        </span>
        <div className="ext-head-actions">
          <button
            className="ghost tiny"
            onClick={() => void loadSkills()}
            disabled={skillsLoading}
            title="Reload the installed skills list"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      <input
        className="skills-search-input"
        placeholder="Search installed skills..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        disabled={!skills}
        data-testid="skills-search"
        aria-label="Search installed skills"
      />

      {skillsLoading && !skills && (
        <div className="skills-list">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="ext-registry-row ext-registry-skeleton">
              <div className="ext-reg-skel-name" />
              <div className="ext-reg-skel-desc" />
            </div>
          ))}
        </div>
      )}

      {!skillsLoading && skillsError && !skills && (
        <div className="ext-registry-state ext-registry-error" data-testid="skills-error">
          <strong>Could not connect to Hermes dashboard</strong>
          <span>Make sure Hermes is running and reachable, then try again.</span>
          <span className="muted small">{skillsError}</span>
          <button className="ghost tiny" onClick={() => void loadSkills()}>Retry</button>
        </div>
      )}

      {skills && (
        <>
          <div className="skills-list" data-testid="skills-list">
            {filtered.rows.map((skill) => (
              <div className="skill-row" key={skill.name} data-testid="skill-row">
                <span
                  role="switch"
                  aria-checked={skill.enabled}
                  tabIndex={0}
                  className={`settings-toggle ${skill.enabled ? 'on' : ''}`}
                  title={skill.enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`}
                  onClick={() => void toggleSkill(skill)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void toggleSkill(skill)
                    }
                  }}
                >
                  <span />
                </span>
                <span className="skill-name">{skill.name}</span>
                <span className={`skill-provenance-badge ${skill.provenance === 'hub' ? 'hub' : 'agent'}`}>
                  {skill.provenance === 'hub' ? 'HUB' : 'AGENT'}
                </span>
                <span className="skill-desc" title={skill.description}>{skill.description}</span>
                {skill.usage > 0 && <span className="skill-usage">used {skill.usage}x</span>}
              </div>
            ))}
          </div>

          {!searchActive && skills.length > SKILLS_DEFAULT_LIMIT && (
            <div className="skills-list-hint muted small">
              Type to search {skills.length.toLocaleString('en-US')} skills
            </div>
          )}
          {searchActive && filtered.matches === 0 && (
            <div className="skills-list-hint muted small">No skills match “{search.trim()}”</div>
          )}
          {searchActive && filtered.matches > SKILLS_FILTER_LIMIT && (
            <div className="skills-list-hint muted small">
              Showing {SKILLS_FILTER_LIMIT} of {filtered.matches.toLocaleString('en-US')} matches — refine your search
            </div>
          )}
        </>
      )}

      <div className="skills-hub-section">
        <button
          className="skills-hub-header"
          onClick={() => setHubOpen((v) => !v)}
          aria-expanded={hubOpen}
          data-testid="skills-hub-toggle"
        >
          <span>{hubOpen ? '▾' : '▸'}</span>
          <span>Skill Hub</span>
        </button>

        {hubOpen && (
          <div className="skills-hub-body">
            <input
              className="skills-search-input"
              placeholder="Search the skill hub..."
              value={hubQuery}
              onChange={(e) => setHubQuery(e.target.value)}
              data-testid="skills-hub-search"
              aria-label="Search the skill hub"
            />

            {hubLoading && (
              <div className="ext-registry-row ext-registry-skeleton">
                <div className="ext-reg-skel-name" />
                <div className="ext-reg-skel-desc" />
              </div>
            )}

            {!hubLoading && hubError && (
              <div className="ext-registry-state ext-registry-error">
                <strong>Hub search failed</strong>
                <span>{hubError}</span>
              </div>
            )}

            {!hubLoading && !hubError && hubQuery.trim() && hubResults.length === 0 && (
              <div className="ext-registry-state">
                <strong>No hub skills found for “{hubQuery.trim()}”</strong>
              </div>
            )}

            {!hubLoading && hubResults.map((result) => (
              <div className="hub-result-row" key={result.identifier} data-testid="skills-hub-result">
                <div className="hub-result-head">
                  <span className="skill-name">{result.name}</span>
                  <button
                    className="primary tiny"
                    onClick={() => void installSkill(result)}
                    disabled={installing.has(result.identifier)}
                  >
                    {installing.has(result.identifier) ? 'Installing…' : 'Install'}
                  </button>
                </div>
                <div className="hub-result-badges">
                  {result.source && <span className="hub-trust-badge">{result.source}</span>}
                  {result.trust_level && <span className="hub-trust-badge">{result.trust_level}</span>}
                </div>
                {result.description && <p className="hub-result-desc">{result.description}</p>}
                {result.repo && (
                  <button
                    className="ghost tiny"
                    onClick={() => void window.api.shell.openExternal(result.repo)}
                    title={result.repo}
                  >
                    Repository
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function formatEnv(env?: Record<string, string>): string {
  const keys = Object.keys(env ?? {})
  if (keys.length === 0) return '(none)'
  return keys.map((key) => `${key}=••••`).join(' ')
}

function Placeholder(props: { title: string; body: string }) {
  return (
    <div className="ext-placeholder">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3v4" />
        <path d="M12 17v4" />
        <path d="M3 12h4" />
        <path d="M17 12h4" />
        <path d="M5.6 5.6l2.8 2.8" />
        <path d="M15.6 15.6l2.8 2.8" />
        <path d="M18.4 5.6l-2.8 2.8" />
        <path d="M8.4 15.6l-2.8 2.8" />
      </svg>
      <h2>{props.title}</h2>
      <p>{props.body}</p>
    </div>
  )
}
