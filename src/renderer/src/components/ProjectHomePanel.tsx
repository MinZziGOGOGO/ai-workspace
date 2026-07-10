import { useEffect, useMemo, useState } from 'react'
import type {
  FsEntry,
  MemoryItem,
  Project,
  Session,
  ToolDetection,
  WebCompanionStatus,
  McpServer,
} from '../types'
import { GLOBAL_PROJECT_ID, GLOBAL_PROJECT_SUBTITLE, isGlobalProjectId } from '../../../shared/globalWorkspace'
import { StatusBadge, WorkspaceEmptyState } from './WorkspacePrimitives'

type HomePanel =
  | 'navigator'
  | 'chat'
  | 'knowledge'
  | 'hermes'
  | 'claudecode'
  | 'codex'
  | 'editor'
  | 'terminal'
  | 'research'
  | 'activity'
  | 'extensions'

type Readiness = 'ready' | 'missing' | 'needs-setup' | 'unknown' | 'unavailable'

interface ToolRow {
  id: string
  label: string
  status: Readiness
  detail: string
  actionLabel: string
  action: () => void
}

interface FileSnapshot {
  loading: boolean
  entries: FsEntry[]
  readme: FsEntry | null
  packageJson: FsEntry | null
}

const STARTER_TASKS = [
  {
    title: 'Summarize this project',
    panel: 'chat' as const,
    prompt: 'Summarize this project. Focus on what it does, the main folders, the important entry points, and the next useful questions to ask.',
  },
  {
    title: 'Find TODOs',
    panel: 'codex' as const,
    prompt: 'Find TODO, FIXME, HACK, and similar markers in this project. Summarize the most important ones and suggest an order to tackle them.',
  },
  {
    title: 'Explain architecture',
    panel: 'chat' as const,
    prompt: 'Explain the architecture of this project from the available workspace context. Call out key modules, data flow, and likely extension points.',
  },
  {
    title: 'Review recent files',
    panel: 'codex' as const,
    prompt: 'Review the recently changed or most important files in this project and identify risks, bugs, or missing tests.',
  },
  {
    title: 'Generate project README',
    panel: 'codex' as const,
    prompt: 'Draft or improve a README for this project. Include purpose, setup, commands, architecture notes, and common workflows.',
  },
  {
    title: 'Find bugs',
    panel: 'claudecode' as const,
    prompt: 'Review this project for likely bugs and behavioral regressions. Prioritize concrete issues with file references and suggested fixes.',
  },
  {
    title: 'Create test plan',
    panel: 'chat' as const,
    prompt: 'Create a focused test plan for this project. Include smoke tests, unit/integration targets, risky flows, and what to automate next.',
  },
]

function formatDate(ts: number | null | undefined): string {
  if (!ts) return 'Not opened yet'
  return new Date(ts).toLocaleString()
}

function shortPath(path: string): string {
  if (!path) return 'No folder selected'
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 3) return path
  return `${parts[0]}\\...\\${parts.slice(-2).join('\\')}`
}

function statusTone(status: Readiness): 'neutral' | 'info' | 'success' | 'warning' | 'error' {
  if (status === 'ready') return 'success'
  if (status === 'missing') return 'error'
  if (status === 'needs-setup') return 'warning'
  if (status === 'unavailable') return 'neutral'
  return 'info'
}

function statusLabel(status: Readiness): string {
  switch (status) {
    case 'ready': return 'Ready'
    case 'missing': return 'Missing'
    case 'needs-setup': return 'Needs setup'
    case 'unavailable': return 'Unavailable'
    default: return 'Unknown'
  }
}

function itemSummary(item: MemoryItem): string {
  const content = item.content.trim()
  if (!content) return item.source
  return content.length > 130 ? `${content.slice(0, 130).trim()}...` : content
}

export default function ProjectHomePanel(props: {
  project: Project
  projects: Project[]
  onOpenPanel: (panel: HomePanel) => void
  onOpenSettings: () => void
  onOpenSetupWizard: () => void
  onRefreshProjects: () => void
}) {
  const isGlobal = isGlobalProjectId(props.project.id)
  const memoryProjectId = isGlobal ? GLOBAL_PROJECT_ID : props.project.id

  const [tools, setTools] = useState<ToolDetection | null>(null)
  const [webStatus, setWebStatus] = useState<WebCompanionStatus | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServer[] | null>(null)
  const [toolError, setToolError] = useState('')
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [files, setFiles] = useState<FileSnapshot>({ loading: false, entries: [], readme: null, packageJson: null })

  useEffect(() => {
    let cancelled = false
    setToolError('')
    void Promise.allSettled([
      window.api.setup.detectTools(),
      window.api.webCompanion.status(),
      window.api.mcp.list(),
    ]).then(([toolResult, webResult, mcpResult]) => {
      if (cancelled) return
      if (toolResult.status === 'fulfilled') setTools(toolResult.value)
      else setToolError('Tool readiness could not be checked.')
      if (webResult.status === 'fulfilled') setWebStatus(webResult.value)
      if (mcpResult.status === 'fulfilled') setMcpServers(mcpResult.value)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setMemories([])
    window.api.memory.list(memoryProjectId)
      .then((items) => { if (!cancelled) setMemories(items.slice(0, 8)) })
      .catch(() => { if (!cancelled) setMemories([]) })
    return () => { cancelled = true }
  }, [memoryProjectId])

  useEffect(() => {
    let cancelled = false
    const modes = ['chat', 'codex', 'claudecode', 'hermes']
    Promise.all(modes.map((mode) => window.api.sessions.list(props.project.id, mode).catch(() => [] as Session[])))
      .then((groups) => {
        if (cancelled) return
        setSessions(groups.flat().sort((a, b) => b.created_at - a.created_at).slice(0, 6))
      })
    return () => { cancelled = true }
  }, [props.project.id])

  useEffect(() => {
    let cancelled = false
    if (isGlobal || !props.project.path) {
      setFiles({ loading: false, entries: [], readme: null, packageJson: null })
      return () => { cancelled = true }
    }
    setFiles({ loading: true, entries: [], readme: null, packageJson: null })
    window.api.fs.readDir(props.project.path)
      .then((entries) => {
        if (cancelled) return
        const readme = entries.find((entry) => !entry.isDir && /^readme(\.|$)/i.test(entry.name)) ?? null
        const packageJson = entries.find((entry) => !entry.isDir && entry.name.toLowerCase() === 'package.json') ?? null
        setFiles({ loading: false, entries: entries.slice(0, 12), readme, packageJson })
      })
      .catch(() => {
        if (!cancelled) setFiles({ loading: false, entries: [], readme: null, packageJson: null })
      })
    return () => { cancelled = true }
  }, [isGlobal, props.project.path])

  const quickActions = useMemo(() => {
    if (isGlobal) {
      return [
        { label: 'Open or import project', detail: 'Use Navigator to switch folders.', panel: 'navigator' as const },
        { label: 'Start chat', detail: 'Think, plan, and capture useful knowledge.', panel: 'chat' as const, prompt: 'Help me plan what to work on next in this global workspace.' },
        { label: 'Open Knowledge', detail: 'Search shared workspace memory.', panel: 'knowledge' as const },
        { label: 'Open Settings', detail: 'Configure models, tools, and workspace options.', settings: true },
        { label: 'Open Setup Wizard', detail: 'Run the guided tool setup flow again.', setup: true },
      ]
    }
    return [
      { label: 'Ask Chat about this project', detail: 'Use local context and shared memory.', panel: 'chat' as const, prompt: `Help me understand the ${props.project.name} project.` },
      { label: 'Run Codex task', detail: 'Hand off a coding task to Codex.', panel: 'codex' as const, prompt: 'Inspect this project and suggest a small, safe next improvement.' },
      { label: 'Run Claude Code task', detail: 'Use Claude Code inside this folder.', panel: 'claudecode' as const, prompt: 'Review this project and identify the highest-impact next engineering task.' },
      { label: 'Run Hermes task', detail: 'Start an autonomous Hermes task.', panel: 'hermes' as const, prompt: 'Explore this project and propose a short action plan.' },
      { label: 'Open Terminal', detail: 'Use a shell in the project folder.', panel: 'terminal' as const },
      { label: 'Open Editor', detail: 'Inspect a selected file.', panel: 'editor' as const },
      { label: 'Search Knowledge', detail: 'Find project decisions and notes.', panel: 'knowledge' as const },
      { label: 'Start Research', detail: 'Create a saved research brief.', panel: 'research' as const },
      { label: 'Open Navigator', detail: 'Browse files and switch workspaces.', panel: 'navigator' as const },
      { label: 'Open Settings', detail: 'Configure this workspace.', settings: true },
    ]
  }, [isGlobal, props.project.name])

  const toolRows = useMemo<ToolRow[]>(() => {
    const detectStatus = (key: keyof ToolDetection): Readiness => {
      if (isGlobal && (key === 'codex' || key === 'claudeCode' || key === 'hermes')) return 'unavailable'
      if (!tools) return 'unknown'
      return tools[key].installed ? 'ready' : 'missing'
    }
    const version = (key: keyof ToolDetection) => tools?.[key].version ? `Version ${tools[key].version}` : tools?.[key].installed ? 'Installed' : 'Not found'
    const mcpEnabled = mcpServers?.filter((server) => server.enabled).length ?? 0
    return [
      {
        id: 'ollama',
        label: 'Ollama',
        status: tools ? (tools.ollama.installed ? 'ready' : 'missing') : 'unknown',
        detail: tools ? version('ollama') : 'Checking local model runtime...',
        actionLabel: 'Settings',
        action: props.onOpenSettings,
      },
      {
        id: 'codex',
        label: 'Codex',
        status: detectStatus('codex'),
        detail: isGlobal ? 'Project folder required' : tools ? version('codex') : 'Checking CLI...',
        actionLabel: isGlobal ? 'Open project' : 'Open Codex',
        action: () => props.onOpenPanel(isGlobal ? 'navigator' : 'codex'),
      },
      {
        id: 'claudecode',
        label: 'Claude Code',
        status: detectStatus('claudeCode'),
        detail: isGlobal ? 'Project folder required' : tools ? version('claudeCode') : 'Checking CLI...',
        actionLabel: isGlobal ? 'Open project' : 'Open Claude Code',
        action: () => props.onOpenPanel(isGlobal ? 'navigator' : 'claudecode'),
      },
      {
        id: 'hermes',
        label: 'Hermes',
        status: detectStatus('hermes'),
        detail: isGlobal ? 'Project folder required' : tools ? version('hermes') : 'Checking agent...',
        actionLabel: isGlobal ? 'Open project' : 'Open Hermes',
        action: () => props.onOpenPanel(isGlobal ? 'navigator' : 'hermes'),
      },
      {
        id: 'web',
        label: 'Web Companion',
        status: webStatus ? (webStatus.enabled ? (webStatus.running ? 'ready' : 'needs-setup') : 'needs-setup') : 'unknown',
        detail: webStatus ? (webStatus.enabled ? (webStatus.running ? `Running on port ${webStatus.port}` : 'Enabled but not running') : 'Disabled by default') : 'Checking local companion...',
        actionLabel: 'Settings',
        action: props.onOpenSettings,
      },
      {
        id: 'mcp',
        label: 'MCP / Extensions',
        status: mcpServers ? (mcpEnabled > 0 ? 'ready' : 'needs-setup') : 'unknown',
        detail: mcpServers ? `${mcpEnabled} enabled server${mcpEnabled === 1 ? '' : 's'}` : 'Checking extension registry...',
        actionLabel: 'Extensions',
        action: () => props.onOpenPanel('extensions'),
      },
    ]
  }, [isGlobal, mcpServers, props, tools, webStatus])

  function openAction(action: { panel?: HomePanel; prompt?: string; settings?: boolean; setup?: boolean }) {
    if (action.settings) {
      props.onOpenSettings()
      return
    }
    if (action.setup) {
      props.onOpenSetupWizard()
      return
    }
    if (!action.panel) return
    props.onOpenPanel(action.panel)
    window.setTimeout(() => {
      if (action.prompt) {
        window.dispatchEvent(new CustomEvent('panel:newSession', { detail: { panel: action.panel } }))
      }
      window.dispatchEvent(new CustomEvent('panel:focusComposer', { detail: { panel: action.panel } }))
      if (action.prompt) {
        window.dispatchEvent(new CustomEvent('panel:prefillPrompt', { detail: { panel: action.panel, prompt: action.prompt } }))
      }
    }, 60)
  }

  return (
    <div className="project-home" data-testid="project-home">
      <section className="project-home-hero">
        <div className="project-home-title-block">
          <span className="project-home-kicker">{isGlobal ? 'Global Workspace' : 'Project Home'}</span>
          <h1>{isGlobal ? 'Welcome to Global Workspace' : props.project.name}</h1>
          <p className="muted">
            {isGlobal
              ? 'Use Global Workspace for general chat, shared knowledge, setup, and planning before choosing a project folder.'
              : shortPath(props.project.path)}
          </p>
        </div>
        <div className="project-home-summary" data-testid="project-home-summary">
          <div><span>Mode</span>{isGlobal ? 'Global' : 'Project'}</div>
          <div><span>Last opened</span>{formatDate(props.project.last_opened_at)}</div>
          <div><span>Memory</span>{memories.length === 0 ? 'No recent items' : `${memories.length} recent item${memories.length === 1 ? '' : 's'}`}</div>
          {!isGlobal && <div title={props.project.path}><span>Folder</span>{shortPath(props.project.path)}</div>}
          {isGlobal && <div><span>Scope</span>{GLOBAL_PROJECT_SUBTITLE}</div>}
        </div>
      </section>

      <section className="project-home-section">
        <div className="project-home-section-head">
          <h2>Quick Actions</h2>
          <span className="muted small">Open the tool you need next.</span>
        </div>
        <div className="project-home-action-grid">
          {quickActions.map((action) => (
            <button
              key={action.label}
              className="project-home-action"
              data-testid={`project-home-action-${action.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              onClick={() => openAction(action)}
            >
              <span>{action.label}</span>
              <small>{action.detail}</small>
            </button>
          ))}
        </div>
      </section>

      {!isGlobal && (
        <section className="project-home-section">
          <div className="project-home-section-head">
            <h2>Suggested Starter Tasks</h2>
            <span className="muted small">Open a panel with a ready prompt.</span>
          </div>
          <div className="project-home-task-grid">
            {STARTER_TASKS.map((task) => (
              <button
                key={task.title}
                className="project-home-task"
                data-testid={`project-home-starter-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                onClick={() => openAction(task)}
              >
                <span>{task.title}</span>
                <small>{task.panel === 'claudecode' ? 'Claude Code' : task.panel === 'codex' ? 'Codex' : 'Chat'}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="project-home-columns">
        <section className="project-home-card" data-testid="project-home-tool-readiness">
          <div className="project-home-card-head">
            <h2>Tool Readiness</h2>
            {toolError && <StatusBadge tone="warning">Partial</StatusBadge>}
          </div>
          <div className="project-home-tool-list">
            {toolRows.map((row) => (
              <div key={row.id} className="project-home-tool-row">
                <div>
                  <strong>{row.label}</strong>
                  <span>{row.detail}</span>
                </div>
                <StatusBadge tone={statusTone(row.status)}>{statusLabel(row.status)}</StatusBadge>
                <button className="ghost tiny" onClick={row.action}>{row.actionLabel}</button>
              </div>
            ))}
          </div>
        </section>

        <section className="project-home-card" data-testid="project-home-activity">
          <div className="project-home-card-head">
            <h2>Recent Activity</h2>
            <button className="ghost tiny" onClick={() => props.onOpenPanel('activity')}>Open Activity</button>
          </div>
          {sessions.length === 0 ? (
            <WorkspaceEmptyState compact title="No recent sessions" body="Start a chat or agent task and it will appear here." />
          ) : (
            <ul className="project-home-list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <span>{session.title || 'Untitled session'}</span>
                  <small>{session.mode} - {formatDate(session.created_at)}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="project-home-columns">
        <section className="project-home-card" data-testid="project-home-knowledge">
          <div className="project-home-card-head">
            <h2>Knowledge Snapshot</h2>
            <button className="ghost tiny" onClick={() => props.onOpenPanel('knowledge')}>Open Knowledge</button>
          </div>
          <div className="project-home-search-row">
            <input
              aria-label="Knowledge search prompt"
              placeholder="Search Knowledge..."
              onKeyDown={(event) => {
                if (event.key === 'Enter') props.onOpenPanel('knowledge')
              }}
            />
            <button className="ghost tiny" onClick={() => props.onOpenPanel('knowledge')}>Search</button>
          </div>
          {memories.length === 0 ? (
            <WorkspaceEmptyState compact title="No knowledge yet" body="Saved answers, project decisions, research, and indexed files show up here." />
          ) : (
            <ul className="project-home-list">
              {memories.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <span><span className={`pill pill-${item.type}`}>{item.type}</span> {item.title}</span>
                  <small>{itemSummary(item)}</small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="project-home-card" data-testid="project-home-files">
          <div className="project-home-card-head">
            <h2>Project Files</h2>
            <button className="ghost tiny" onClick={() => props.onOpenPanel('navigator')}>Open Navigator</button>
          </div>
          {isGlobal ? (
            <WorkspaceEmptyState compact title="No project folder" body="Open or import a project to see file hints." />
          ) : (
            <>
              <div className="project-home-file-hints">
                <StatusBadge tone={files.readme ? 'success' : 'warning'}>{files.readme ? 'README found' : 'README missing'}</StatusBadge>
                <StatusBadge tone={files.packageJson ? 'success' : 'neutral'}>{files.packageJson ? 'package.json found' : 'No package.json'}</StatusBadge>
              </div>
              {files.loading ? (
                <div className="empty small">Loading top-level files...</div>
              ) : files.entries.length === 0 ? (
                <WorkspaceEmptyState compact title="No top-level files" body="Navigator can still browse this folder when files appear." />
              ) : (
                <ul className="project-home-file-list">
                  {files.entries.map((entry) => (
                    <li key={entry.path} title={entry.path}>
                      <span className={entry.isDir ? 'project-home-file-kind dir' : 'project-home-file-kind file'}>
                        {entry.isDir ? 'DIR' : 'FILE'}
                      </span>
                      <span>{entry.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
