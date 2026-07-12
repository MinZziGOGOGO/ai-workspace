import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, Session, Message, HermesCheck, HermesActivity, HermesEvent, HermesCommand, HermesPlanEntry, HermesPermissionMode, HermesPermissionRequestInfo, RemoteHermesConfig } from '../types'
import { AttachmentChips, resolveAttachments } from './ComposerAttachments'
import { useComposerAttachments } from '../hooks/useComposerAttachments'
import Markdown from './Markdown'
import RelativeTime from './RelativeTime'
import AiContextBar, { estimateTokensFromText } from './AiContextBar'
import { useToast } from './ToastContext'
import { useAgentActivity } from '../AgentActivityContext'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { AgentErrorNotice, AgentSessionRail, AgentStatusStrip, ChatJumpToBottomButton, EditableUserMessage, OutputActions, SessionContextMenu, useAutoSessionSummary, useChatScrollFollow, useConfirmDestructive, useStatusPhrase } from './AgentPanelPrimitives'
import { WorkspaceNotice } from './WorkspacePrimitives'
import InstructionsEditor from './InstructionsEditor'
import ToolSyntaxBlock from './ToolSyntaxBlock'
import anime, { prefersReducedMotion, stopMotion, usePressMotion, type MotionHandle } from '../motion'
import { setAgentAvailable, setAgentPanelOpen, setAgentSession, clearAgentCurrent, type HandoffSendDetail } from '../handoff'
import { isLastAssistantMessage, useMessageActions } from '../messageActions'
import { useCompletionNotifier } from '../notify'

const HERMES_MODEL = 'gemma4-workspace:12b'

const HERMES_EMPTY_HEADINGS = [
  'What should Hermes work on?',
  'Ready for an autonomous task.',
  'Hand it to Hermes.',
]

const PERMISSION_MODES: Array<{ mode: HermesPermissionMode; label: string; description: string }> = [
  { mode: 1, label: 'Ask before everything', description: 'Every tool call requires your approval.' },
  { mode: 2, label: 'Read & create files', description: 'Reads and creates files freely — asks before modifying/deleting existing files or running commands.' },
  { mode: 3, label: 'Can edit files', description: 'Reads, writes, and edits files freely — asks before running terminal commands.' },
  { mode: 4, label: 'Can run commands', description: 'Full file access plus terminal commands — asks before destructive actions (delete, force push).' },
  { mode: 5, label: 'High autonomy', description: 'Minimal interruption — only asks for genuinely dangerous operations.' },
]
const RENDER_LIMIT = 50
const PINNED_KEY = 'aiworkspace.hermes.pinned'
function loadPinned(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')) } catch { return new Set() }
}
function savePinned(s: Set<string>) { localStorage.setItem(PINNED_KEY, JSON.stringify([...s])) }

function ThinkingBlock(props: { text: string; tokenCount: number; done: boolean }) {
  const [open, setOpen] = useState(false)
  if (!props.text) return null
  const label = props.done ? `Thought for ${props.tokenCount} token${props.tokenCount !== 1 ? 's' : ''}` : 'Thinking…'
  return (
    <div className={`thinking-block ${props.done ? 'done' : 'live'} ${open ? 'open' : ''}`}>
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="thinking-icon">{open ? '▾' : '▸'}</span>
        <span className="thinking-label">{label}</span>
        {!props.done && <span className="thinking-cursor">&#x2587;</span>}
      </button>
      {open && <pre className="thinking-body">{props.text}</pre>}
    </div>
  )
}

const KANBAN_COLUMNS: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: 'todo', label: 'To Do', statuses: ['pending'] },
  { key: 'in_progress', label: 'In Progress', statuses: ['in_progress', 'running'] },
  { key: 'done', label: 'Done', statuses: ['completed', 'done', 'error'] },
]

function columnForStatus(status: string): string {
  const match = KANBAN_COLUMNS.find((c) => c.statuses.includes(status))
  return match?.key ?? 'todo'
}

function KanbanBoard(props: { entries: HermesPlanEntry[] }) {
  if (props.entries.length === 0) {
    return (
      <div className="empty center kanban-empty">
        <p className="muted">No active task list. Hermes will show a board here when it&apos;s tracking multi-step work.</p>
      </div>
    )
  }
  return (
    <div className="kanban-board">
      {KANBAN_COLUMNS.map((col) => {
        const cards = props.entries.filter((e) => columnForStatus(e.status) === col.key)
        return (
          <div key={col.key} className="kanban-column">
            <div className="kanban-column-header">{col.label} · {cards.length}</div>
            <div className="kanban-column-body">
              {cards.map((c, i) => (
                <div key={i} className="kanban-card">{c.content}</div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function cleanActivityMessage(message: string): string {
  return message.replace(/^✓\s*/, '').replace(/^âœ“\s*/, '').trim()
}

function terminalCommandFromActivity(activity: HermesActivity): string | null {
  const candidates = [activity.toolName, activity.message, activity.result].filter((value): value is string => typeof value === 'string')
  for (const value of candidates) {
    const cleaned = cleanActivityMessage(value)
    const match = cleaned.match(/^terminal:\s*(.+)$/i)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return null
}

function commandTextFromActivity(activity: HermesActivity): string | null {
  const terminal = terminalCommandFromActivity(activity)
  if (terminal) return terminal
  if (activity.args && typeof activity.args === 'object' && 'command' in activity.args) {
    const command = (activity.args as { command?: unknown }).command
    if (typeof command === 'string' && command.trim()) return command.trim()
  }
  const candidates = [activity.toolName, activity.message].filter((value): value is string => typeof value === 'string')
  for (const value of candidates) {
    const cleaned = cleanActivityMessage(value)
    if (/^(?:npm|pnpm|yarn|node|git|rg|grep|python|pip|wsl|powershell|cmd|date|whoami|uname)\b/i.test(cleaned)) return cleaned
  }
  return null
}

function hasOnlyGenericToolName(activity: HermesActivity): boolean {
  const name = activity.toolName?.trim().toLowerCase()
  return !name || name === 'tool' || name === 'remote tool'
}

function meaningfulActivityMessage(activity: HermesActivity): string {
  const message = cleanActivityMessage(activity.message)
  if (!message || /^remote tool$/i.test(message) || /^tool$/i.test(message)) return ''
  return message
}

function activityLabel(activity: HermesActivity): string {
  if (activity.kind === 'plan') return 'Updated plan'
  if (activity.kind === 'error') return 'Tool error'
  if (terminalCommandFromActivity(activity)) return activity.status === 'done' ? 'Ran command' : 'Running command'
  if (hasOnlyGenericToolName(activity) && meaningfulActivityMessage(activity)) return activity.status === 'done' ? 'Completed update' : 'Hermes update'
  if (activity.status === 'done') return 'Finished tool'
  return 'Used tool'
}

function activityName(activity: HermesActivity): string {
  const command = terminalCommandFromActivity(activity)
  if (command) return command
  if (hasOnlyGenericToolName(activity)) {
    const message = meaningfulActivityMessage(activity)
    if (message) return message
  }
  return activity.toolName || activity.message.replace(/^✓\s*/, '').split(':')[0].split('(')[0].trim() || activity.kind
}

function formatToolValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function ToolActivityCard(props: { activity: HermesActivity; live?: boolean }) {
  const { activity } = props
  const [open, setOpen] = useState(false)
  const args = formatToolValue(activity.args)
  const result = formatToolValue(activity.result)
  const details = formatToolValue(activity.details)
  const commandText = commandTextFromActivity(activity)
  return (
    <div className={`hermes-tool-card${open ? ' open' : ''}${activity.kind === 'error' ? ' err' : ''}`} data-testid="hermes-tool-card">
      <button
        type="button"
        className="hermes-tool-summary"
        data-testid="hermes-tool-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="hermes-tool-chevron" aria-hidden>{open ? 'v' : '>'}</span>
        <span className="hermes-tool-label">{activityLabel(activity)}</span>
        <span className="hermes-tool-name">{activityName(activity)}</span>
        {props.live && <span className="hermes-tool-live-dot" aria-hidden />}
      </button>
      {open && (
        <div className="hermes-tool-details" data-testid="hermes-tool-details">
          <div className="hermes-tool-detail-row">
            <span>Tool</span>
            <strong>{activityName(activity)}</strong>
          </div>
          {activity.status && (
            <div className="hermes-tool-detail-row">
              <span>Status</span>
              <strong>{activity.status}</strong>
            </div>
          )}
          <ToolSyntaxBlock value={commandText ?? activity.message} language={commandText ? 'shell' : 'text'} />
          {args && (
            <>
              <div className="hermes-tool-detail-heading">Input</div>
              <ToolSyntaxBlock value={args} language="json" />
            </>
          )}
          {result && (
            <>
              <div className="hermes-tool-detail-heading">Result</div>
              <ToolSyntaxBlock value={result} language={commandText ? 'shell' : 'auto'} />
            </>
          )}
          {details && !args && !result && (
            <>
              <div className="hermes-tool-detail-heading">Remote payload</div>
              <ToolSyntaxBlock value={details} language="json" />
            </>
          )}
        </div>
      )}
    </div>
  )
}

type HermesLiveSegment =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'activity'; activity: HermesActivity }

function boardEntryFromActivity(activity: HermesActivity): HermesPlanEntry {
  const name = activityName(activity)
  const detail = activity.message && activity.message !== name ? `: ${activity.message}` : ''
  return {
    content: `${activityLabel(activity)} ${name}${detail}`,
    status: activity.status === 'done' ? 'completed' : activity.status === 'error' ? 'error' : 'in_progress'
  }
}

function activitiesFromToolMessages(messages: Message[]): HermesActivity[] {
  const activities: HermesActivity[] = []
  for (const message of messages) {
    if (message.role !== 'tool') continue
    try {
      const parsed = JSON.parse(message.content)
      if (Array.isArray(parsed)) activities.push(...parsed)
    } catch {
      // Ignore legacy tool blobs that were not JSON arrays.
    }
  }
  return activities
}

function ActivityLog(props: { entries: HermesActivity[]; live?: boolean }) {
  if (props.entries.length === 0) return null
  return (
    <div className="hermes-tool-stack">
      {props.entries.map((e, i) => (
        <ToolActivityCard key={i} activity={e} live={props.live && i === props.entries.length - 1} />
      ))}
    </div>
  )
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'error'

function HermesSettings(props: {
  config: RemoteHermesConfig
  onSave: (config: RemoteHermesConfig) => Promise<void>
  onTest: (config: RemoteHermesConfig) => Promise<{ success: boolean; error?: string }>
}) {
  const [mode, setMode] = useState<'local' | 'remote'>(props.config.mode)
  const [sshHost, setSshHost] = useState(props.config.sshHost)
  const [sshUser, setSshUser] = useState(props.config.sshUser)
  const [sshKey, setSshKey] = useState(props.config.sshKeyPath)
  const [hermesPath, setHermesPath] = useState(props.config.hermesPath)
  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testError, setTestError] = useState('')
  const [saving, setSaving] = useState(false)

  async function runTest() {
    setTestStatus('testing'); setTestError('')
    const r = await props.onTest({ mode, sshHost, sshUser, sshKeyPath: sshKey, hermesPath })
    setTestStatus(r.success ? 'ok' : 'error')
    if (!r.success) setTestError(r.error ?? 'Cannot reach remote Hermes')
  }

  async function save() { setSaving(true); await props.onSave({ mode, sshHost, sshUser, sshKeyPath: sshKey, hermesPath }); setSaving(false) }

  return (
    <div className="hermes-settings">
      <div className="hermes-settings-row">
        <span className="hermes-settings-label">Mode</span>
        <div className="hermes-settings-radios">
          <label className="hermes-settings-radio"><input type="radio" name="hermes-mode" checked={mode === 'local'} onChange={() => setMode('local')} />Local (WSL2)</label>
          <label className="hermes-settings-radio"><input type="radio" name="hermes-mode" checked={mode === 'remote'} onChange={() => setMode('remote')} />Remote (SSH)</label>
        </div>
      </div>
      {mode === 'remote' && (
        <>
          <div className="hermes-settings-row"><label className="hermes-settings-label">SSH Host</label><input className="hermes-settings-input" value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="10.0.0.246" /></div>
          <div className="hermes-settings-row"><label className="hermes-settings-label">SSH User</label><input className="hermes-settings-input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="martin" /></div>
          <div className="hermes-settings-row"><label className="hermes-settings-label">SSH Key</label><input className="hermes-settings-input" value={sshKey} onChange={(e) => setSshKey(e.target.value)} placeholder="C:\Users\marti\.ssh\id_ed25519" /></div>
          <div className="hermes-settings-row"><label className="hermes-settings-label">Hermes Path</label><input className="hermes-settings-input" value={hermesPath} onChange={(e) => setHermesPath(e.target.value)} placeholder="/home/martin/.local/bin/hermes" /></div>
          <div className="hermes-settings-action-row">
            <button className="ghost" onClick={runTest} disabled={testStatus === 'testing' || !sshHost}>{testStatus === 'testing' ? 'Testing…' : 'Test Connection'}</button>
            {testStatus === 'ok' && <span className="hermes-test-ok">✓ Connected</span>}
            {testStatus === 'error' && <span className="hermes-test-err">✗ {testError}</span>}
          </div>
        </>
      )}
      <div className="hermes-settings-action-row">
        <button className="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Settings'}</button>
      </div>
    </div>
  )
}

function SetupNotice(props: {
  check: HermesCheck; mode: 'local' | 'remote'; onRecheck: () => void; onConnect: () => void; connecting: boolean; connectProgress?: string
}) {
  const { wsl2, installed, connected } = props.check
  if (props.mode === 'remote') {
    return (
      <div className="empty center cc-setup">
        <h2>{!installed ? 'Cannot reach remote Hermes' : "Hermes isn't connected"}</h2>
        <p className="muted">{!installed ? 'Could not connect to the remote Hermes instance via SSH. Check SSH settings above.' : 'Remote Hermes is reachable. Click Connect to start the ACP session over SSH.'}</p>
        {props.check.error && <p className="muted small cc-setup-err">{props.check.error}</p>}
        <div className="hermes-setup-actions">
          {installed && <button className="primary" onClick={props.onConnect} disabled={props.connecting}>{props.connecting ? 'Connecting…' : 'Connect'}</button>}
          <button className={installed ? 'ghost' : 'primary'} onClick={props.onRecheck}>Re-check</button>
        </div>
        {props.connecting && props.connectProgress && <p className="muted small hermes-connect-progress">{props.connectProgress}</p>}
      </div>
    )
  }
  const heading = !wsl2 ? 'WSL2 is required for Hermes' : !installed ? "Hermes isn't installed yet" : !connected ? "Hermes isn't connected" : 'Hermes needs setup'
  return (
    <div className="empty center cc-setup">
      <h2>{heading}</h2>
      <p className="muted">Hermes is an autonomous agent (Nous Research) running in WSL2 via ACP — a stdio JSON-RPC integration. It shares this workspace&apos;s knowledge through the MCP server and uses Windows-host Ollama as its model provider.</p>
      <ol className="cc-setup-steps">
        {!wsl2 && <li>Enable WSL2: open PowerShell as admin and run <code>wsl --install</code>, then reboot.</li>}
        {wsl2 && !installed && <li>Install Hermes once: <code>powershell -ExecutionPolicy Bypass -File scripts/setup-hermes.ps1</code>. It installs Ubuntu (if needed), Python 3.11+, uv, Hermes Agent, and configures it to use Windows-host Ollama.</li>}
        {wsl2 && installed && !connected && <li>Click <strong>Connect</strong> to start the Hermes ACP process.</li>}
        <li>Then click Re-check.</li>
      </ol>
      {props.check.error && <p className="muted small cc-setup-err">{props.check.error}</p>}
      <div className="hermes-setup-actions">
        {wsl2 && installed && !connected && <button className="primary" onClick={props.onConnect} disabled={props.connecting}>{props.connecting ? 'Connecting…' : 'Connect'}</button>}
        <button className={wsl2 && installed && !connected ? 'ghost' : 'primary'} onClick={props.onRecheck}>Re-check</button>
      </div>
    </div>
  )
}

interface CtxMenu { sessionId: string; x: number; y: number }

export default function HermesTab(props: { project: Project; active?: boolean }) {
  const { addToast } = useToast()
  const { setActive: setAgentActive } = useAgentActivity()
  const [check, setCheck] = useState<HermesCheck | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [injectMemory, setInjectMemory] = useState(false)
  const [pendingContextBlock, setPendingContextBlock] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [thoughtText, setThoughtText] = useState('')
  const [activity, setActivity] = useState<HermesActivity[]>([])
  const [liveSegments, setLiveSegments] = useState<HermesLiveSegment[]>([])
  const [planEntries, setPlanEntries] = useState<HermesPlanEntry[]>([])
  const [view, setView] = useState<'chat' | 'board'>('chat')
  const [error, setError] = useState('')
  const [config, setConfig] = useState<RemoteHermesConfig | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [connectProgress, setConnectProgress] = useState('')
  const [hermesModel, setHermesModel] = useState<string | undefined>(undefined)
  const [hermesUsage, setHermesUsage] = useState<{ used: number; max: number } | null>(null)
  const [commands, setCommands] = useState<HermesCommand[]>([])
  const [slashIdx, setSlashIdx] = useState(-1)
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => loadPinned())
  const confirmDestructive = useConfirmDestructive()
  const [renderOffset, setRenderOffset] = useState(0)
  const { attachments, setAttachments, isDragOver, setIsDragOver, handlePaste, pickFile, handleDrop } = useComposerAttachments()
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [instructionsOpen, setInstructionsOpen] = useState<{ agentId: string; agentLabel: string } | null>(null)
  const [agentMdExists, setAgentMdExists] = useState(false)
  const [sharedMdExists, setSharedMdExists] = useState(false)
  const [permissionMode, setPermissionMode] = useState<HermesPermissionMode>(3)
  const [pendingPermission, setPendingPermission] = useState<HermesPermissionRequestInfo | null>(null)
  const [respondingPermission, setRespondingPermission] = useState(false)
  const [emptyHeading] = useState(() => HERMES_EMPTY_HEADINGS[Math.floor(Math.random() * HERMES_EMPTY_HEADINGS.length)])

  const scrollRef = useRef<HTMLDivElement>(null)
  const sessionSwitchAnimRef = useRef<MotionHandle>(null)
  const sessionRef = useRef<Session | null>(null)
  const newSessionRef = useRef<() => void>(() => {})
  const handoffRef = useRef<(detail: HandoffSendDetail) => void>(() => {})
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendButtonMotion = usePressMotion<HTMLButtonElement>()
  const checkRef = useRef<HermesCheck | null>(null)
  const pendingPermissionsRef = useRef<Map<string, HermesPermissionRequestInfo>>(new Map())
  checkRef.current = check

  const isGlobalWorkspace = isGlobalProjectId(props.project.id)
  const active = props.active ?? true
  const connected = check?.connected ?? false
  const estimatedTokens = useMemo(
    () => estimateTokensFromText([...messages.map((m) => m.content), streamText, thoughtText, input].filter(Boolean).join('\n')),
    [messages, streamText, thoughtText, input]
  )
  const contextStatus = running ? 'Running' : connected ? 'Ready' : 'Disconnected'
  const notifyCompletion = useCompletionNotifier(active)
  const lastActivity = activity[activity.length - 1]
  const activeToolName = running && lastActivity?.kind === 'tool' && !lastActivity.message.startsWith('✓') ? lastActivity.message : null
  const hermesHasStarted = streamText.length > 0 || thoughtText.length > 0 || activity.length > 0
  const statusPhrase = useStatusPhrase({
    active: running,
    hasStarted: hermesHasStarted,
    toolName: activeToolName,
    progressKey: `${streamText.length}:${thoughtText.length}:${activity.length}:${lastActivity?.message.length ?? 0}`
  })
  const { showJumpToBottom, jumpToBottom } = useChatScrollFollow(
    scrollRef,
    [messages.length, liveSegments.length, streamText.length, thoughtText.length, activity.length, running],
    { resetKey: session?.id, immediate: running, activeDelay: running ? 100 : 0 }
  )
  sessionRef.current = session

  function resetLiveRunState() {
    setStreamText('')
    setThoughtText('')
    setActivity([])
    setLiveSegments([])
  }

  function appendLiveText(text: string) {
    setLiveSegments((prev) => {
      const last = prev[prev.length - 1]
      if (last?.kind === 'text') {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }]
      }
      return [...prev, { id: `text-${Date.now()}-${prev.length}`, kind: 'text', text }]
    })
  }

  function appendLiveActivity(nextActivity: HermesActivity) {
    setLiveSegments((prev) => [
      ...prev,
      { id: `activity-${nextActivity.ts}-${prev.length}`, kind: 'activity', activity: nextActivity }
    ])
  }

  useEffect(() => () => {
    stopMotion(sessionSwitchAnimRef.current)
  }, [])

  function selectSession(next: Session | null) {
    if (next?.id === sessionRef.current?.id) return
    const el = scrollRef.current
    stopMotion(sessionSwitchAnimRef.current)
    if (!el || prefersReducedMotion()) {
      setSession(next)
      return
    }
    const out = anime(el, { opacity: [1, 0], translateY: [0, -4], duration: 100, ease: 'outQuad' })
    sessionSwitchAnimRef.current = out
    if (!out) {
      setSession(next)
      return
    }
    void out.then(() => {
      setSession(next)
      window.requestAnimationFrame(() => {
        const nextEl = scrollRef.current
        if (!nextEl) return
        sessionSwitchAnimRef.current = anime(nextEl, { opacity: [0, 1], translateY: [6, 0], duration: 150, ease: 'outExpo' })
      })
    })
  }

  // Publish start/stop only (not per event) so the topbar activity badge
  // doesn't re-render on every streamed chunk.
  useEffect(() => {
    setAgentActive('hermes', running)
    return () => setAgentActive('hermes', false)
  }, [running, setAgentActive])

  const recheck = () => window.api.hermes.check().then(setCheck)

  async function doConnect() {
    setConnecting(true); setConnectProgress('')
    const progressTimer = config?.mode === 'remote' ? setTimeout(() => setConnectProgress('Still connecting… (remote Hermes may take up to 60s to initialize MCP tools)'), 10_000) : null
    const r = await window.api.hermes.connect(check?.distro)
    if (progressTimer) clearTimeout(progressTimer)
    setConnectProgress('')
    if (r.connected) { const c = await window.api.hermes.check(); setCheck(c) }
    else { setError(r.error ?? 'Failed to connect'); await recheck() }
    setConnecting(false)
  }

  async function saveConfig(newConfig: RemoteHermesConfig) {
    await window.api.hermes.setConfig(newConfig); setConfig(newConfig); setSettingsOpen(false); await recheck()
  }

  async function testConnection(cfg: RemoteHermesConfig) { return window.api.hermes.testConnection(cfg) }

  async function handleInjectMemory() {
    const isRemote = config?.mode === 'remote'
    if (isRemote) {
      // Remote mode: fetch memory client-side and prepend as context to next message
      try {
        const items = await window.api.memory.list(props.project.id)
        if (items.length === 0) {
          addToast('No memories found for this project')
          return
        }
        const contextLines = items.map((i) => `[${i.type}] ${i.title}: ${i.content}`)
        const block = `PROJECT KNOWLEDGE:\n${contextLines.join('\n')}`
        setPendingContextBlock(block)
        addToast('Knowledge injected — send your next message')
      } catch (e) {
        addToast('Failed to fetch memories')
      }
    } else {
      // Local mode: toggle MCP injection flag (existing behavior)
      setInjectMemory((v) => !v)
    }
  }

  useEffect(() => { if (active) window.api.models.list().then(setOllamaModels) }, [active])

  useAutoSessionSummary(session, messages, ollamaModels[0], (sessionId, summary) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, summary } : s)))
    setSession((prev) => (prev && prev.id === sessionId ? { ...prev, summary } : prev))
  })

  useEffect(() => {
    function handleTestCheck(event: Event) {
      const detail = (event as CustomEvent<{ check?: HermesCheck }>).detail
      const next = detail?.check ?? { wsl2: true, installed: true, connected: true, version: 'e2e' }
      setCheck(next)
      checkRef.current = next
      setConnecting(false)
      setError('')
    }
    window.addEventListener('aiworkspace:test:set-hermes-check', handleTestCheck)
    return () => window.removeEventListener('aiworkspace:test:set-hermes-check', handleTestCheck)
  }, [])

  useEffect(() => {
    function onFocusComposer(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'hermes') textareaRef.current?.focus()
    }
    function onNewSession(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      // Call through the ref so the guard sees the current connection state
      // instead of the values captured at listener registration.
      if (panel === 'hermes') newSessionRef.current()
    }
    function onPrefillPrompt(event: Event) {
      const detail = (event as CustomEvent<{ panel?: string; prompt?: string }>).detail
      if (detail?.panel === 'hermes' && typeof detail.prompt === 'string') {
        setInput(detail.prompt)
        textareaRef.current?.focus()
        setSlashIdx(-1)
      }
    }
    function onSelectSession(event: Event) {
      const detail = (event as CustomEvent<{ panel?: string; session?: Session }>).detail
      if (detail?.panel === 'hermes' && detail.session) selectSession(detail.session)
    }
    window.addEventListener('panel:focusComposer', onFocusComposer)
    window.addEventListener('panel:newSession', onNewSession)
    window.addEventListener('panel:prefillPrompt', onPrefillPrompt)
    window.addEventListener('panel:selectSession', onSelectSession)
    return () => {
      window.removeEventListener('panel:focusComposer', onFocusComposer)
      window.removeEventListener('panel:newSession', onNewSession)
      window.removeEventListener('panel:prefillPrompt', onPrefillPrompt)
      window.removeEventListener('panel:selectSession', onSelectSession)
    }
  }, [])

  useEffect(() => {
    if (isGlobalWorkspace || !props.project.path) return
    const p = props.project.path
    window.api.instructions.getPath('hermes', p).then(fp => {
      if (fp) window.api.instructions.read(fp).then(r => setAgentMdExists(r.exists))
    })
    window.api.instructions.getPath('shared', p).then(fp => {
      if (fp) window.api.instructions.read(fp).then(r => setSharedMdExists(r.exists))
    })
  }, [props.project.path, isGlobalWorkspace, instructionsOpen])
  useEffect(() => { if (!isGlobalWorkspace && active) recheck() }, [isGlobalWorkspace, active])
  useEffect(() => {
    if (isGlobalWorkspace || !active) { setSessions([]); setArchivedSessions([]); return }
    window.api.sessions.list(props.project.id, 'hermes').then(setSessions)
    window.api.sessions.listArchived(props.project.id, 'hermes').then(setArchivedSessions)
  }, [props.project.id, isGlobalWorkspace, active])
  useEffect(() => { if (!isGlobalWorkspace && active) window.api.hermes.getConfig().then(setConfig) }, [isGlobalWorkspace, active])
  useEffect(() => { if (!isGlobalWorkspace && active) window.api.hermes.getPermissionMode().then(setPermissionMode) }, [isGlobalWorkspace, active])

  async function changePermissionMode(mode: HermesPermissionMode) {
    const previous = permissionMode
    setPermissionMode(mode)
    const result = await window.api.hermes.setPermissionMode(mode)
    if (!result.success) {
      setPermissionMode(previous)
      addToast(`Failed to change Hermes permission mode: ${result.error ?? 'unknown error'}`)
    }
  }

  async function respondPermission(approved: boolean, alwaysAllowSession = false) {
    if (!pendingPermission || !session || respondingPermission) return
    setRespondingPermission(true)
    try {
      const result = await window.api.hermes.respondPermission({
        sessionId: session.id,
        requestId: pendingPermission.requestId,
        approved,
        actionKind: pendingPermission.action,
        alwaysAllowSession
      })
      if (!result.success) {
        addToast(`Failed to respond to Hermes permission request: ${result.error ?? 'request is no longer active'}`)
        return
      }
      pendingPermissionsRef.current.delete(session.id)
      setPendingPermission(null)
    } finally {
      setRespondingPermission(false)
    }
  }

  useEffect(() => {
    if (isGlobalWorkspace || !active) return
    let alive = true
    const tick = async () => {
      const h = await window.api.hermes.health(); if (!alive) return
      const was = checkRef.current?.connected ?? false
      if (h.ok !== was) { const c = await window.api.hermes.check(); if (alive) setCheck(c) }
    }
    const id = setInterval(tick, 4000)
    return () => { alive = false; clearInterval(id) }
  }, [isGlobalWorkspace, active])

  useEffect(() => {
    if (session) window.api.hermes.messages(session.id).then(setMessages)
    else setMessages([])
    resetLiveRunState(); setPlanEntries([]); setError('')
    setPendingPermission(session ? pendingPermissionsRef.current.get(session.id) ?? null : null)
    setRenderOffset(0)
  }, [session])

  // Publish live state to the Chat→agent handoff bus.
  useEffect(() => { setAgentPanelOpen('hermes', active) }, [active])
  useEffect(() => { setAgentAvailable('hermes', !isGlobalWorkspace && connected) }, [connected, isGlobalWorkspace])
  useEffect(() => {
    if (session) setAgentSession('hermes', session.id, session.title)
    else clearAgentCurrent('hermes')
  }, [session])

  // Receive a handoff sent programmatically from the Chat tab.
  useEffect(() => {
    function onHandoff(event: Event) {
      const detail = (event as CustomEvent<HandoffSendDetail>).detail
      if (detail?.panel !== 'hermes') return
      void handoffRef.current(detail)
    }
    window.addEventListener('panel:handoffSend', onHandoff)
    return () => window.removeEventListener('panel:handoffSend', onHandoff)
  }, [])

  useEffect(() => {
    const offEvent = window.api.hermes.onEvent((d) => {
      const e: HermesEvent = d.event
      const isCurrentSession = d.sessionId === sessionRef.current?.id
      if (!isCurrentSession && e.kind !== 'permissionRequest') return
      if (e.kind === 'text') {
        setStreamText((t) => t + e.text)
        appendLiveText(e.text)
      }
      else if (e.kind === 'thought') setThoughtText((t) => t + e.text)
      else if (e.kind === 'activity') {
        setActivity((a) => [...a, e.activity])
        appendLiveActivity(e.activity)
      }
      else if (e.kind === 'error') setError(e.message)
      else if (e.kind === 'model') setHermesModel(e.name)
      else if (e.kind === 'commands') setCommands(e.commands)
      else if (e.kind === 'plan') setPlanEntries(e.entries)
      else if (e.kind === 'permissionRequest') {
        pendingPermissionsRef.current.set(d.sessionId, e.request)
        if (isCurrentSession) setPendingPermission(e.request)
      }
    })
    const offDone = window.api.hermes.onDone(async (d) => {
      pendingPermissionsRef.current.delete(d.sessionId)
      setRunning(false)
      if (d.sessionId !== sessionRef.current?.id) return
      setPendingPermission(null)
      resetLiveRunState()
      setMessages(await window.api.hermes.messages(d.sessionId))
      notifyCompletion()
    })
    return () => { offEvent(); offDone() }
  }, [session])

  useEffect(() => { return window.api.hermes.onUsage((d) => setHermesUsage(d)) }, [])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    function handleDown() { setContextMenu(null) }
    document.addEventListener('pointerdown', handleDown)
    return () => document.removeEventListener('pointerdown', handleDown)
  }, [contextMenu])

  async function newSession() {
    const s = await window.api.sessions.create(props.project.id, 'hermes', 'New task')
    setSessions((prev) => [s, ...prev]); setSession(s)
  }
  newSessionRef.current = () => { if (!isGlobalWorkspace && connected) void newSession() }

  async function deleteSession(target: Session) {
    const result = await window.api.sessions.delete(target.id)
    if (!result.success) {
      addToast(`Failed to delete session: ${result.error ?? 'unknown error'}`)
      return
    }
    setSessions((prev) => prev.filter((s) => s.id !== target.id))
    setArchivedSessions((prev) => prev.filter((s) => s.id !== target.id))
    pendingPermissionsRef.current.delete(target.id)
    if (session?.id === target.id) { setSession(null); setMessages([]); resetLiveRunState(); setError('') }
    addToast('Session deleted')
  }

  function openContextMenu(e: React.MouseEvent, s: Session) {
    e.preventDefault(); e.stopPropagation()
    setContextMenu({ sessionId: s.id, x: e.clientX, y: e.clientY }); setRenaming(null)
  }

  function startRename(s: Session) { setContextMenu(null); setRenaming({ id: s.id, value: s.title }) }

  async function commitRename(s: Session) {
    const title = renaming?.value.trim() || s.title; setRenaming(null)
    if (title === s.title) return
    const result = await window.api.sessions.rename(s.id, title)
    if (!result.success) {
      addToast(`Failed to rename session: ${result.error ?? 'unknown error'}`)
      return
    }
    setSessions(prev => prev.map(x => x.id === s.id ? { ...x, title } : x))
    setArchivedSessions(prev => prev.map(x => x.id === s.id ? { ...x, title } : x))
    if (session?.id === s.id) setSession(prev => prev ? { ...prev, title } : prev)
  }

  function togglePin(sessionId: string) {
    setContextMenu(null)
    setPinnedIds(prev => { const next = new Set(prev); if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId); savePinned(next); return next })
  }

  async function toggleArchive(target: Session) {
    setContextMenu(null)
    const archive = !target.archived
    const result = await window.api.sessions.archive(target.id, archive)
    if (!result.success) {
      addToast(`Failed to ${archive ? 'archive' : 'unarchive'} session: ${result.error ?? 'unknown error'}`)
      return
    }
    if (archive) {
      setSessions(prev => prev.filter(x => x.id !== target.id))
      setArchivedSessions(prev => [{ ...target, archived: 1 }, ...prev])
      if (session?.id === target.id) { setSession(null); setMessages([]); resetLiveRunState(); setError('') }
    } else {
      setArchivedSessions(prev => prev.filter(x => x.id !== target.id))
      setSessions(prev => [{ ...target, archived: 0 }, ...prev])
    }
    addToast(archive ? 'Session archived' : 'Session unarchived')
  }

  const titleFrom = (text: string) => text.trim().replace(/\s+/g, ' ').slice(0, 50) || 'New task'

  async function sendTask(prompt: string) {
    if (!prompt.trim() || running) return
    const firstTurn = !session || messages.length === 0
    let s = session
    if (!s) { s = await window.api.sessions.create(props.project.id, 'hermes', titleFrom(prompt)); setSessions((prev) => [s!, ...prev]); setSession(s) }
    else if (firstTurn) { const title = titleFrom(prompt); setSessions((prev) => prev.map((x) => x.id === s!.id ? { ...x, title } : x)); setSession({ ...s, title }) }

    // Remote mode: prepend pending context block to the prompt
    let finalPrompt = prompt
    if (pendingContextBlock) {
      finalPrompt = `${pendingContextBlock}\n\n---\n\n${prompt}`
      setPendingContextBlock(null)
    }

    setError(''); setRunning(true); resetLiveRunState(); setPlanEntries([]); setInput(''); setHermesUsage(null)
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, session_id: s!.id, role: 'user', content: prompt, model: null, created_at: Date.now() }])
    window.api.hermes.send({ sessionId: s.id, projectId: props.project.id, prompt: finalPrompt, injectMemory })
    setInjectMemory(false)
  }

  async function handoffSend(detail: HandoffSendDetail) {
    if (isGlobalWorkspace || !connected) return
    let s: Session | null = null
    if (!detail.newSession && detail.sessionId) s = sessions.find((x) => x.id === detail.sessionId) ?? null
    if (!s) {
      s = await window.api.sessions.create(props.project.id, 'hermes', titleFrom(detail.prompt))
      setSessions((prev) => [s!, ...prev])
    }
    setSession(s)
    setError(''); setRunning(true); resetLiveRunState(); setPlanEntries([]); setHermesUsage(null)
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, session_id: s!.id, role: 'user', content: detail.prompt, model: null, created_at: Date.now() }])
    window.api.hermes.send({ sessionId: s.id, projectId: props.project.id, prompt: detail.prompt, injectMemory: false })
  }
  handoffRef.current = (detail) => { void handoffSend(detail) }

  async function run() {
    if (running || !input.trim()) return
    if (input.startsWith('/') || attachments.length === 0) {
      sendTask(input)
      return
    }
    const resolved = await resolveAttachments(attachments)
    if (resolved.error) { setError(resolved.error); return }
    setAttachments([])
    sendTask(resolved.content + input)
  }
  function cancelRun() { if (session) window.api.hermes.abort(session.id) }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const showSlash = input.startsWith('/') && !input.includes(' ') && commands.length > 0
    const slashFilter = showSlash ? input.slice(1).toLowerCase() : ''
    const filteredCmds = showSlash ? commands.filter((c) => c.name.toLowerCase().startsWith(slashFilter)) : []

    if (filteredCmds.length > 0 && !e.ctrlKey) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => Math.min(i + 1, filteredCmds.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => Math.max(i - 1, -1)); return }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const cmd = slashIdx >= 0 ? filteredCmds[slashIdx] : filteredCmds[0]
        if (cmd) { sendTask(`/${cmd.name}`); setSlashIdx(-1) }
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault()
      void run()
      return
    }
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      void run()
      return
    }
    if (e.key === 'Enter' && e.shiftKey) return
    if (e.key === 'Escape') {
      e.preventDefault()
      if (running) cancelRun()
      else { setInput(''); setSlashIdx(-1) }
      return
    }
    if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      setInput('')
      setSlashIdx(-1)
    }
  }

  async function copyOutput(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      addToast('Copied output')
    } catch {
      addToast('Copy failed')
    }
  }

  async function saveOutputToKnowledge(m: Message) {
    try {
      await window.api.memory.save({
        projectId: props.project.id,
        type: 'note',
        title: m.content.slice(0, 60),
        content: m.content,
        source: 'hermes',
      })
      addToast('Saved to Knowledge')
      window.dispatchEvent(new CustomEvent('knowledge:pulse'))
    } catch (err) {
      addToast(`Failed to save to Knowledge: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  // Regenerate / edit-resend / reactions — shared logic lives in the hook,
  // this tab only supplies how to fetch messages and how to kick a fresh task.
  const hermesResend = useCallback((content: string, regenerateMessageId: string) => {
    if (!session || running) return
    setError(''); setRunning(true); resetLiveRunState(); setPlanEntries([]); setHermesUsage(null)
    window.api.hermes.send({ sessionId: session.id, projectId: props.project.id, prompt: content, injectMemory: false, regenerateMessageId })
  }, [session, running, props.project.id])

  const fetchHermesMessages = useCallback((sid: string) => window.api.hermes.messages(sid), [])

  const { regenerate, editAndResend, setReaction } = useMessageActions({
    sessionId: session?.id,
    messages,
    setMessages,
    busy: running,
    fetchMessages: fetchHermesMessages,
    resend: hermesResend,
    onError: addToast
  })

  const renderLiveSegment = (segment: HermesLiveSegment, index: number) => {
    const isLast = index === liveSegments.length - 1
    if (segment.kind === 'activity') return <ActivityLog key={segment.id} entries={[segment.activity]} live={running && isLast} />
    return (
      <div key={segment.id} className="msg assistant hermes-live-segment">
        <div className="msg-body md-body">
          <Markdown>{segment.text}</Markdown>
          {running && isLast && <span className="cursor">&#x2587;</span>}
        </div>
      </div>
    )
  }

  const renderMessage = (m: Message) => {
    if (m.role === 'tool') {
      let entries: HermesActivity[] = []
      try { entries = JSON.parse(m.content) } catch { /* legacy */ }
      return <ActivityLog key={m.id} entries={entries} />
    }
    if (m.role === 'user') return (
      <EditableUserMessage
        key={m.id}
        content={m.content}
        timestamp={m.created_at}
        disabled={running}
        onSaveResend={(newContent) => void editAndResend(m.id, newContent)}
        onCopy={() => void copyOutput(m.content)}
      />
    )
    return (
      <div key={m.id} className="msg assistant">
        <div className="msg-body md-body"><Markdown>{m.content}</Markdown></div>
        <div className="msg-meta">
          <span className="msg-timestamp"><RelativeTime ts={m.created_at} /></span>
          <OutputActions
            onCopy={() => void copyOutput(m.content)}
            onSave={() => void saveOutputToKnowledge(m)}
            isLast={!running && isLastAssistantMessage(messages, m.id)}
            onRegenerate={() => void regenerate()}
            reaction={m.reaction ?? null}
            onReaction={(r) => void setReaction(m.id, r)}
          />
        </div>
      </div>
    )
  }

  const ctxSession = contextMenu ? [...sessions, ...archivedSessions].find(s => s.id === contextMenu.sessionId) : null
  const isRemote = config?.mode === 'remote'
  const visibleMessages = messages.slice(Math.max(0, messages.length - RENDER_LIMIT - renderOffset))
  const boardEntries = useMemo(() => {
    if (planEntries.length > 0) return planEntries
    const sourceActivities = activity.length > 0 ? activity : activitiesFromToolMessages(messages)
    if (sourceActivities.length > 0) return sourceActivities.slice(-18).map(boardEntryFromActivity)
    if (running && session?.title) return [{ content: session.title, status: 'in_progress' }]
    return []
  }, [activity, messages, planEntries, running, session?.title])

  // Context line + unified composer shell, shared between the empty state and
  // an active session — the empty state IS the composer, ready to type into.
  const composerBlock = (
    <>
      <AiContextBar
        testId="context-bar-hermes"
        usedTokens={session ? (hermesUsage?.used ?? estimatedTokens) : undefined}
        maxTokens={session ? hermesUsage?.max : undefined}
        tokensApproximate={session ? (hermesUsage === null && estimatedTokens !== undefined) : undefined}
        model={hermesModel ?? HERMES_MODEL}
        mode="Hermes"
        status={contextStatus}
      />
      <div
        className={`composer composer-shell${isDragOver ? ' composer-dropzone-active' : ''}`}
        onDragOver={e => { e.preventDefault(); setIsDragOver(true) }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={e => void handleDrop(e)}
      >
        {isDragOver && <div className="composer-drop-overlay">Drop files to attach</div>}
        <AttachmentChips
          attachments={attachments}
          models={ollamaModels}
          onRemove={id => setAttachments(prev => prev.filter(a => a.id !== id))}
          onVisionModelChange={(id, vm) => setAttachments(prev => prev.map(a => a.id === id ? { ...a, visionModel: vm } : a))}
        />
        {(() => {
          const showSlash = input.startsWith('/') && !input.includes(' ') && commands.length > 0
          const slashFilter = showSlash ? input.slice(1).toLowerCase() : ''
          const filteredCmds = showSlash ? commands.filter((c) => c.name.toLowerCase().startsWith(slashFilter)) : []
          return filteredCmds.length > 0 ? (
            <div className="slash-palette">
              {filteredCmds.map((cmd, i) => (
                <button key={cmd.name} className={`slash-item ${i === slashIdx ? 'active' : ''}`} onMouseEnter={() => setSlashIdx(i)} onClick={() => { setInput(`/${cmd.name}`); setSlashIdx(-1) }}>
                  <span className="slash-name">/{cmd.name}</span>
                  <span className="slash-desc">{cmd.description}</span>
                </button>
              ))}
            </div>
          ) : null
        })()}
        <textarea
          ref={textareaRef}
          data-composer="true"
          data-testid="hermes-composer"
          placeholder="Describe a task for Hermes…  (Enter to send · Shift+Enter for newline)"
          value={input}
          onChange={(e) => { setInput(e.target.value); setSlashIdx(-1) }}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-bar">
          <div className="composer-bar-left">
            <button className="composer-icon-btn" onClick={() => void pickFile()} title="Attach file" aria-label="Attach file" disabled={running}>＋</button>
            <div className="model-select model-picker-plain" data-testid="hermes-mode-control" title={PERMISSION_MODES.find((m) => m.mode === permissionMode)?.description}>
              <select
                data-testid="hermes-permission-mode"
                value={permissionMode}
                onChange={(e) => void changePermissionMode(Number(e.target.value) as HermesPermissionMode)}
              >
                {PERMISSION_MODES.map((m) => <option key={m.mode} value={m.mode}>{m.label}</option>)}
              </select>
              <span className="model-select-chevron">⌄</span>
            </div>
          </div>
          <div className="composer-bar-right">
            {running
              ? <button ref={sendButtonMotion.ref} {...sendButtonMotion.pressHandlers} className="composer-send-btn stop" onClick={cancelRun} title="Stop Hermes">Stop</button>
              : <button ref={sendButtonMotion.ref} {...sendButtonMotion.pressHandlers} className="composer-send-btn" data-testid="hermes-send" disabled={!connected} onClick={() => void run()}>Send</button>}
          </div>
        </div>
      </div>
    </>
  )

  const hermesGlobalHeaderSlot = (
    <button className="instructions-md-btn exists" onClick={() => setInstructionsOpen({ agentId: 'app', agentLabel: 'App' })} title="Edit App CLAUDE.md">
      📋 App CLAUDE.md
    </button>
  )

  const hermesHeaderSlot = (
    <>
      <button
        className={`instructions-md-btn${agentMdExists ? ' exists' : ''}`}
        onClick={() => setInstructionsOpen({ agentId: 'hermes', agentLabel: 'Hermes' })}
        title="Edit HERMES.md"
      >
        📋 HERMES.md{!agentMdExists ? ' (create)' : ''}
      </button>
      <button
        className="instructions-md-btn exists"
        onClick={() => setInstructionsOpen({ agentId: 'app', agentLabel: 'App' })}
        title="Edit App CLAUDE.md"
      >
        📋 App CLAUDE.md
      </button>
      <button
        className={`instructions-md-btn${sharedMdExists ? ' exists' : ''}`}
        onClick={() => setInstructionsOpen({ agentId: 'shared', agentLabel: 'Shared' })}
        title="Edit AI.md (shared instructions for all agents)"
      >
        📋 AI.md{!sharedMdExists ? ' (create)' : ''}
      </button>
    </>
  )

  if (isGlobalWorkspace) return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
      <div className="chat-layout">
        <AgentSessionRail
          sessions={[]}
          pinnedIds={new Set()}
          renaming={null}
          newLabel="New task"
          disabled
          disabledTitle="Hermes needs a project folder"
          emptyLabel="No Hermes tasks yet"
          headerSlot={hermesGlobalHeaderSlot}
          onSelect={() => {}}
          onOptions={() => {}}
          onRenameChange={() => {}}
          onRenameCommit={() => {}}
          onRenameCancel={() => {}}
        />
        <section className="chat-main">
          <AiContextBar testId="context-bar-hermes" model={HERMES_MODEL} mode="Hermes" status="Project required" disabledReason="Open a project folder" />
          <div className="empty center cc-setup" data-testid="hermes-global-unavailable">
            <h2>Hermes needs a project folder.</h2>
            <p className="muted">Open a project workspace to use Hermes. Global Workspace is available for general chat and shared memory, but this Hermes integration should not run without a real project path.</p>
          </div>
        </section>
      </div>
      {instructionsOpen && (
        <InstructionsEditor agentId={instructionsOpen.agentId} agentLabel={instructionsOpen.agentLabel} projectPath={props.project.path ?? null} onClose={() => setInstructionsOpen(null)} />
      )}
    </div>
  )

  if (check && !check.connected && !running) {
    const currentMode = config?.mode ?? 'local'
    return (
      <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
        <div className="chat-layout">
          <AgentSessionRail
            sessions={[]}
            pinnedIds={new Set()}
            renaming={null}
            newLabel="New task"
            disabled
            disabledTitle="Hermes is not connected"
            emptyLabel="No Hermes tasks yet"
            headerSlot={hermesHeaderSlot}
            onSelect={() => {}}
            onOptions={() => {}}
            onRenameChange={() => {}}
            onRenameCommit={() => {}}
            onRenameCancel={() => {}}
          />
          <section className="chat-main">
            <header className="chat-header">
              <span className="chat-header-title">Hermes Connection</span>
              <button className={`ghost icon-btn ${settingsOpen ? 'on' : ''}`} onClick={() => setSettingsOpen((v) => !v)} title="Connection settings" aria-label="Toggle connection settings">⚙</button>
            </header>
            {settingsOpen && config && <HermesSettings config={config} onSave={saveConfig} onTest={testConnection} />}
            <SetupNotice check={check} mode={currentMode} onRecheck={recheck} onConnect={doConnect} connecting={connecting} connectProgress={connectProgress} />
          </section>
        </div>
        {instructionsOpen && (
          <InstructionsEditor agentId={instructionsOpen.agentId} agentLabel={instructionsOpen.agentLabel} projectPath={props.project.path ?? null} onClose={() => setInstructionsOpen(null)} />
        )}
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
    <div className="chat-layout">
      <AgentSessionRail
        sessions={sessions}
        archivedSessions={archivedSessions}
        activeSessionId={session?.id}
        pinnedIds={pinnedIds}
        renaming={renaming}
        newLabel="New task"
        newTitle="Start a new Hermes task"
        emptyLabel="No Hermes tasks yet"
        headerSlot={hermesHeaderSlot}
        openMenuSessionId={contextMenu?.sessionId ?? null}
        onNew={newSession}
        onSelect={selectSession}
        onOptions={openContextMenu}
        onRenameChange={(value) => renaming && setRenaming({ ...renaming, value })}
        onRenameCommit={(s) => void commitRename(s)}
        onRenameCancel={() => setRenaming(null)}
      />

      <section className="chat-main">
        {!session ? (
          <div className="empty-hero">
            <h2 className="empty-state-heading">
              <span className="empty-state-icon" style={{ color: 'var(--accent-hermes)' }} aria-hidden>
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="5" r="2.4" /><circle cx="5" cy="18" r="2.4" /><circle cx="19" cy="18" r="2.4" />
                  <path d="M12 7.4v4.2M12 11.6 6.6 16.2M12 11.6l5.4 4.6" />
                </svg>
              </span>
              {emptyHeading}
            </h2>
            {composerBlock}
          </div>
        ) : (
          <>
            <header className="chat-header">
              <span className="chat-header-title">{session.title}</span>
              <div className="hermes-header-right">
                <div className="hermes-view-toggle" role="group" aria-label="View">
                  <button className={`hermes-view-btn ${view === 'chat' ? 'on' : ''}`} onClick={() => setView('chat')}>Chat</button>
                  <button className={`hermes-view-btn ${view === 'board' ? 'on' : ''}`} onClick={() => setView('board')}>Board</button>
                </div>
                <span className={`hermes-conn ${connected ? 'ok' : 'bad'}`} title={connected ? 'Hermes ACP connected' : 'Hermes disconnected'}>
                  <span className="status-dot" />
                  {connected ? (isRemote ? `Connected · remote${check?.version ? ` · ${check.version}` : ''}` : `Connected${check?.version ? ` · ${check.version}` : ''}`) : 'Disconnected'}
                </span>
                {isRemote && (
                  <span className="hermes-remote-indicator" title="Remote mode: knowledge injected as context, not via MCP">
                    Remote
                  </span>
                )}
                <button className={`ghost inject-btn ${isRemote ? (pendingContextBlock ? 'on' : '') : (injectMemory ? 'on' : '')}`} onClick={handleInjectMemory} title={isRemote ? 'Prepend project knowledge to the next task' : 'Prepend get_project_context() to the next task via MCP'}>
                  {isRemote ? (pendingContextBlock ? '✓ Knowledge ready' : '✦ Inject memory') : (injectMemory ? '✓ Memory will be injected' : '✦ Inject memory')}
                </button>
              </div>
            </header>
            <AgentStatusStrip
              agent="Hermes"
              status={running ? (statusPhrase ?? 'Running') : connected ? 'Ready' : 'Disconnected'}
              tone={running ? 'info' : connected ? 'success' : 'warning'}
              running={running}
              detail={isRemote ? 'Remote SSH' : 'WSL2 ACP'}
            />

            {view === 'board' ? (
              <div className="chat-scroll kanban-scroll">
                <KanbanBoard entries={boardEntries} />
              </div>
            ) : (
              <div className="chat-scroll-shell">
              <div className="chat-scroll" ref={scrollRef}>
                {messages.length > RENDER_LIMIT + renderOffset && (
                  <button className="ghost load-older-btn" onClick={() => setRenderOffset((o) => o + RENDER_LIMIT)}>
                    Load older messages
                  </button>
                )}
                {visibleMessages.map(renderMessage)}
                {running && (
                  <div className="cc-live">
                    {thoughtText && <ThinkingBlock text={thoughtText} tokenCount={thoughtText.split(/\s+/).filter(Boolean).length} done={streamText.length > 0} />}
                    {liveSegments.map(renderLiveSegment)}
                    {!streamText && !thoughtText && activity.length === 0 && <div className="cc-note muted small">{statusPhrase ?? 'Connecting to Hermes…'}<span className="cursor">&#x2587;</span></div>}
                  </div>
                )}
              </div>
              <ChatJumpToBottomButton visible={showJumpToBottom} onClick={jumpToBottom} />
              </div>
            )}

            {error && <AgentErrorNotice title="Hermes could not run">{error}</AgentErrorNotice>}

            {pendingPermission && (
              <div className="agent-error-wrap hermes-permission-wrap" data-testid="hermes-permission-card">
                <WorkspaceNotice
                  title={`⚠ Hermes wants to: ${pendingPermission.title}`}
                  tone="warning"
                  action={
                    <div className="hermes-permission-actions">
                      <button className="ghost" data-testid="hermes-permission-deny" disabled={respondingPermission} onClick={() => void respondPermission(false)}>Deny</button>
                      <button className="primary" data-testid="hermes-permission-allow-once" disabled={respondingPermission} onClick={() => void respondPermission(true)}>Allow once</button>
                      <button className="ghost" data-testid="hermes-permission-allow-session" disabled={respondingPermission} onClick={() => void respondPermission(true, true)}>Allow for session</button>
                    </div>
                  }
                />
              </div>
            )}

            {composerBlock}
          </>
        )}
      </section>

      {/* ── Context menu portal ── */}
      {contextMenu && ctxSession && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          pinned={pinnedIds.has(contextMenu.sessionId)}
          archived={!!ctxSession.archived}
          confirmDestructive={confirmDestructive}
          onTogglePin={() => togglePin(contextMenu.sessionId)}
          onRename={() => startRename(ctxSession)}
          onToggleArchive={() => void toggleArchive(ctxSession)}
          onDelete={() => { setContextMenu(null); void deleteSession(ctxSession) }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
      {instructionsOpen && (
        <InstructionsEditor agentId={instructionsOpen.agentId} agentLabel={instructionsOpen.agentLabel} projectPath={props.project.path ?? null} onClose={() => setInstructionsOpen(null)} />
      )}
    </div>
  )
}
