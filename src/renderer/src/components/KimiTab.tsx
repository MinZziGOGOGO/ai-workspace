import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, Session, Message, KimiCheck, KimiActivity, KimiConfigSelect, KimiEvent, KimiCommand, KimiPlanEntry, KimiPermissionMode, KimiPermissionRequestInfo, KimiAuthMethod, KimiAuthStatus, KimiLoginEvent, AgentModelInfo } from '../types'
import { AttachmentChips, resolveAttachments } from './ComposerAttachments'
import { useComposerAttachments } from '../hooks/useComposerAttachments'
import { useComposerDraft } from '../hooks/useComposerDraft'
import Markdown from './Markdown'
import RelativeTime from './RelativeTime'
import AiContextBar, { estimateTokensFromText } from './AiContextBar'
import { useToast } from './ToastContext'
import { useAgentTaskReporter } from '../AgentActivityContext'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { AgentErrorNotice, AgentSessionRail, AgentStatusStrip, ChatJumpToBottomButton, EditableUserMessage, OutputActions, SessionContextMenu, useAutoSessionSummary, useChatScrollFollow, useConfirmDestructive, useStatusPhrase } from './AgentPanelPrimitives'
import { WorkspaceNotice } from './WorkspacePrimitives'
import InstructionsEditor from './InstructionsEditor'
import { KimiModelPicker } from './ModelPicker'
import ContextMeter from './ContextMeter'
import ToolSyntaxBlock from './ToolSyntaxBlock'
import anime, { prefersReducedMotion, stopMotion, usePressMotion, type MotionHandle } from '../motion'
import { isLastAssistantMessage, useMessageActions } from '../messageActions'
import { useCompletionNotifier } from '../notify'

// Kimi Code (Moonshot AI) — ACP over local stdio. Modeled directly on
// HermesTab.tsx, minus the WSL2/SSH connection machinery (Kimi is a plain
// local PATH binary) and swapped for an auth section (OAuth login / API key)
// in place of Hermes's SSH connection settings. Intentionally does NOT wire
// into the Chat→agent handoff bus or LivePreviewAffordance/Preview panel —
// see the implementation report for why (handoff: out of scope for this
// pass; Preview panel: explicitly agent-inaccessible by design).

const KIMI_MODEL = 'kimi-for-coding'

// Static fallback so the picker never renders empty before the IPC catalog
// arrives; the authoritative list is parsed from ~/.kimi-code/config.toml.
const KIMI_DEFAULT_MODEL = 'kimi-code/kimi-for-coding'
const KIMI_FALLBACK_MODELS: AgentModelInfo[] = [
  { id: 'kimi-code/kimi-for-coding', label: 'K2.7 Coding', description: 'Default coding model', contextSize: 262144 },
  { id: 'kimi-code/kimi-for-coding-highspeed', label: 'K2.7 Coding Highspeed', description: 'Highspeed variant', contextSize: 262144 },
  { id: 'kimi-code/k3', label: 'K3', contextSize: 262144 }
]
const KIMI_MODEL_PREF_KEY = 'kimi-preferred-model'
function loadModelPref(): string {
  try { return localStorage.getItem(KIMI_MODEL_PREF_KEY) ?? KIMI_DEFAULT_MODEL } catch { return KIMI_DEFAULT_MODEL }
}
function saveModelPref(value: string) {
  try { localStorage.setItem(KIMI_MODEL_PREF_KEY, value) } catch { /* ignore */ }
}

// Chosen values for the ACP config selects (thinking effort etc.), keyed by
// config id. The available selects themselves always come from the server;
// only the user's picks are persisted.
const KIMI_CONFIG_PREF_KEY = 'kimi-config-values'
function loadConfigPrefs(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KIMI_CONFIG_PREF_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}
function saveConfigPrefs(values: Record<string, string>) {
  try { localStorage.setItem(KIMI_CONFIG_PREF_KEY, JSON.stringify(values)) } catch { /* ignore */ }
}

const KIMI_EMPTY_HEADINGS = [
  'What should Kimi work on?',
  'Ready for a coding task.',
  'Hand it to Kimi.',
]

const PERMISSION_MODES: Array<{ mode: KimiPermissionMode; label: string; description: string }> = [
  { mode: 1, label: 'Ask before everything', description: 'Every tool call requires your approval.' },
  { mode: 2, label: 'Read & create files', description: 'Reads and creates files freely — asks before modifying/deleting existing files or running commands.' },
  { mode: 3, label: 'Can edit files', description: 'Reads, writes, and edits files freely — asks before running terminal commands.' },
  { mode: 4, label: 'Can run commands', description: 'Full file access plus terminal commands — asks before destructive actions (delete, force push).' },
  { mode: 5, label: 'High autonomy', description: 'Minimal interruption — only asks for genuinely dangerous operations.' },
]
// Plan is a distinct entry in the same control: it drives Kimi's native ACP
// `mode: plan` (read-only planning, the server never executes a tool), which is
// strictly more restrictive than any tier and can't be reproduced client-side.
// The other native modes (auto/yolo) are intentionally not offered — verified
// against the real binary, they execute tools without sending a permission
// request, bypassing our approval matrix (see src/main/kimi.ts getKimiPlanMode).
const PLAN_MODE_VALUE = 'plan'
const PLAN_MODE_DESCRIPTION = 'Read-only planning — Kimi maps out an approach and never edits files or runs commands until you switch to an autonomy tier.'
const RENDER_LIMIT = 50
const PINNED_KEY = 'aiworkspace.kimi.pinned'
// Which session this tab was last looking at, per project — shared across the
// app's windows so a detached KimiTab remounts on the same session.
const SELECTED_SESSION_KEY_PREFIX = 'aiworkspace.kimi.selected-session.'
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

function KanbanBoard(props: { entries: KimiPlanEntry[] }) {
  if (props.entries.length === 0) {
    return (
      <div className="empty center kanban-empty">
        <p className="muted">No active task list. Kimi will show a board here when it&apos;s tracking multi-step work.</p>
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

function terminalCommandFromActivity(activity: KimiActivity): string | null {
  const candidates = [activity.toolName, activity.message, activity.result].filter((value): value is string => typeof value === 'string')
  for (const value of candidates) {
    const cleaned = cleanActivityMessage(value)
    const match = cleaned.match(/^terminal:\s*(.+)$/i)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return null
}

function commandTextFromActivity(activity: KimiActivity): string | null {
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

function hasOnlyGenericToolName(activity: KimiActivity): boolean {
  const name = activity.toolName?.trim().toLowerCase()
  return !name || name === 'tool'
}

function meaningfulActivityMessage(activity: KimiActivity): string {
  const message = cleanActivityMessage(activity.message)
  if (!message || /^tool$/i.test(message)) return ''
  return message
}

function activityLabel(activity: KimiActivity): string {
  if (activity.kind === 'plan') return 'Updated plan'
  if (activity.kind === 'error') return 'Tool error'
  if (terminalCommandFromActivity(activity)) return activity.status === 'done' ? 'Ran command' : 'Running command'
  if (hasOnlyGenericToolName(activity) && meaningfulActivityMessage(activity)) return activity.status === 'done' ? 'Completed update' : 'Kimi update'
  if (activity.status === 'done') return 'Finished tool'
  return 'Used tool'
}

function activityName(activity: KimiActivity): string {
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

function ToolActivityCard(props: { activity: KimiActivity; live?: boolean }) {
  const { activity } = props
  const [open, setOpen] = useState(false)
  const args = formatToolValue(activity.args)
  const result = formatToolValue(activity.result)
  const details = formatToolValue(activity.details)
  const commandText = commandTextFromActivity(activity)
  return (
    <div className={`hermes-tool-card${open ? ' open' : ''}${activity.kind === 'error' ? ' err' : ''}`} data-testid="kimi-tool-card">
      <button
        type="button"
        className="hermes-tool-summary"
        data-testid="kimi-tool-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="hermes-tool-chevron" aria-hidden>{open ? 'v' : '>'}</span>
        <span className="hermes-tool-label">{activityLabel(activity)}</span>
        <span className="hermes-tool-name">{activityName(activity)}</span>
        {props.live && <span className="hermes-tool-live-dot" aria-hidden />}
      </button>
      {open && (
        <div className="hermes-tool-details" data-testid="kimi-tool-details">
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
              <div className="hermes-tool-detail-heading">Raw payload</div>
              <ToolSyntaxBlock value={details} language="json" />
            </>
          )}
        </div>
      )}
    </div>
  )
}

type KimiLiveSegment =
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'activity'; activity: KimiActivity }

function boardEntryFromActivity(activity: KimiActivity): KimiPlanEntry {
  const name = activityName(activity)
  const detail = activity.message && activity.message !== name ? `: ${activity.message}` : ''
  return {
    content: `${activityLabel(activity)} ${name}${detail}`,
    status: activity.status === 'done' ? 'completed' : activity.status === 'error' ? 'error' : 'in_progress'
  }
}

function activitiesFromToolMessages(messages: Message[]): KimiActivity[] {
  const activities: KimiActivity[] = []
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

function ActivityLog(props: { entries: KimiActivity[]; live?: boolean }) {
  if (props.entries.length === 0) return null
  return (
    <div className="hermes-tool-stack">
      {props.entries.map((e, i) => (
        <ToolActivityCard key={i} activity={e} live={props.live && i === props.entries.length - 1} />
      ))}
    </div>
  )
}

function KimiAuthPanel(props: {
  status: KimiAuthStatus | null
  onSetMethod: (method: KimiAuthMethod) => Promise<void>
  onLogin: () => Promise<void>
  onSetApiKey: (key: string) => Promise<void>
  loginBusy: boolean
  loginProgress: KimiLoginEvent | null
}) {
  const [apiKey, setApiKey] = useState('')
  const method = props.status?.method ?? 'oauth'
  return (
    <div className="hermes-settings">
      <div className="hermes-settings-row">
        <span className="hermes-settings-label">Auth method</span>
        <div className="hermes-settings-radios">
          <label className="hermes-settings-radio">
            <input type="radio" name="kimi-auth" checked={method === 'oauth'} onChange={() => void props.onSetMethod('oauth')} />OAuth login
          </label>
          <label className="hermes-settings-radio">
            <input type="radio" name="kimi-auth" checked={method === 'apikey'} onChange={() => void props.onSetMethod('apikey')} />API key
          </label>
        </div>
      </div>
      {method === 'oauth' ? (
        <div className="hermes-settings-action-row">
          <button className="primary" data-testid="kimi-login-btn" onClick={() => void props.onLogin()} disabled={props.loginBusy}>
            {props.loginBusy ? 'Waiting for login…' : 'Log in with Kimi'}
          </button>
          {props.status?.configured && <span className="hermes-test-ok">✓ Authenticated</span>}
          {props.loginProgress?.kind === 'deviceCode' && (
            <span className="muted small" data-testid="kimi-login-device-code">
              Visit {props.loginProgress.url} and enter code <strong>{props.loginProgress.code}</strong>
            </span>
          )}
          {props.loginProgress?.kind === 'done' && !props.loginProgress.success && (
            <span className="hermes-test-err">✗ {props.loginProgress.error ?? 'Login failed'}</span>
          )}
        </div>
      ) : (
        <>
          <div className="hermes-settings-row">
            <label className="hermes-settings-label">API key</label>
            <input
              className="hermes-settings-input"
              type="password"
              data-testid="kimi-api-key-input"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={props.status?.configured ? '••••••••' : 'Paste your Moonshot API key'}
            />
          </div>
          <div className="hermes-settings-action-row">
            <button className="primary" data-testid="kimi-api-key-save" onClick={() => void props.onSetApiKey(apiKey)} disabled={!apiKey.trim()}>Save key</button>
            {props.status?.configured && <span className="hermes-test-ok">✓ Key saved</span>}
          </div>
        </>
      )}
    </div>
  )
}

function SetupNotice(props: {
  check: KimiCheck; authStatus: KimiAuthStatus | null; onRecheck: () => void; onConnect: () => void; connecting: boolean
}) {
  const { installed } = props.check
  const heading = !installed ? "Kimi Code CLI isn't installed" : !props.authStatus?.configured ? 'Kimi needs authentication' : "Kimi isn't connected"
  return (
    <div className="empty center cc-setup">
      <h2>{heading}</h2>
      <p className="muted">
        Kimi Code is Moonshot AI&apos;s coding agent, integrated here over ACP (Agent Client Protocol) — a local
        stdio JSON-RPC connection, same style as Hermes. It shares this workspace&apos;s knowledge through the MCP server.
      </p>
      <ol className="cc-setup-steps">
        {!installed && <li>Install: <code>npm install -g @moonshot-ai/kimi-code</code> (Node 22.19+), or the official install script. Restart AI Workspace afterward.</li>}
        {installed && !props.authStatus?.configured && <li>Authenticate below (OAuth login or API key), then click Connect.</li>}
        {installed && props.authStatus?.configured && <li>Click <strong>Connect</strong> to start the Kimi ACP process.</li>}
        <li>Then click Re-check.</li>
      </ol>
      {props.check.error && <p className="muted small cc-setup-err">{props.check.error}</p>}
      <div className="hermes-setup-actions">
        {installed && <button className="primary" onClick={props.onConnect} disabled={props.connecting}>{props.connecting ? 'Connecting…' : 'Connect'}</button>}
        <button className={installed ? 'ghost' : 'primary'} onClick={props.onRecheck}>Re-check</button>
      </div>
    </div>
  )
}

interface CtxMenu { sessionId: string; x: number; y: number }

export default function KimiTab(props: { project: Project; active?: boolean }) {
  const { addToast } = useToast()
  const [check, setCheck] = useState<KimiCheck | null>(null)
  const [authStatus, setAuthStatus] = useState<KimiAuthStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useComposerDraft('aiworkspace.kimi.draft', session?.id)
  const [injectMemory, setInjectMemory] = useState(false)
  const [running, setRunning] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [thoughtText, setThoughtText] = useState('')
  const [activity, setActivity] = useState<KimiActivity[]>([])
  const [liveSegments, setLiveSegments] = useState<KimiLiveSegment[]>([])
  const [planEntries, setPlanEntries] = useState<KimiPlanEntry[]>([])
  const [view, setView] = useState<'chat' | 'board'>('chat')
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [kimiModel, setKimiModel] = useState<string | undefined>(undefined)
  const [kimiUsage, setKimiUsage] = useState<{ used: number; max: number } | null>(null)
  const [commands, setCommands] = useState<KimiCommand[]>([])
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
  const [permissionMode, setPermissionMode] = useState<KimiPermissionMode>(3)
  const [planMode, setPlanMode] = useState<boolean>(false)
  const [models, setModels] = useState<AgentModelInfo[]>(KIMI_FALLBACK_MODELS)
  const [model, setModel] = useState<string>(() => loadModelPref())
  const [configSelects, setConfigSelects] = useState<KimiConfigSelect[]>([])
  const [configValues, setConfigValues] = useState<Record<string, string>>(() => loadConfigPrefs())
  const [pendingPermission, setPendingPermission] = useState<KimiPermissionRequestInfo | null>(null)
  const [respondingPermission, setRespondingPermission] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginProgress, setLoginProgress] = useState<KimiLoginEvent | null>(null)
  const [emptyHeading] = useState(() => KIMI_EMPTY_HEADINGS[Math.floor(Math.random() * KIMI_EMPTY_HEADINGS.length)])

  const scrollRef = useRef<HTMLDivElement>(null)
  const sessionSwitchAnimRef = useRef<MotionHandle>(null)
  const sessionRef = useRef<Session | null>(null)
  const newSessionRef = useRef<() => void>(() => {})
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendButtonMotion = usePressMotion<HTMLButtonElement>()
  const checkRef = useRef<KimiCheck | null>(null)
  const pendingPermissionsRef = useRef<Map<string, KimiPermissionRequestInfo>>(new Map())
  // Replaying the live log must not re-fire an OS notification for a request the
  // previous owner already announced.
  const notifiedPermissionsRef = useRef<Set<string>>(new Set())
  // Highest replay sequence already applied, so a detach handover can overlap
  // the replayed log with the live stream without double-applying an event.
  const lastLiveSequenceRef = useRef(0)
  checkRef.current = check

  const isGlobalWorkspace = isGlobalProjectId(props.project.id)
  const active = props.active ?? true
  const activeRef = useRef(active)
  activeRef.current = active
  const estimatedTokens = useMemo(
    () => estimateTokensFromText([...messages.map((m) => m.content), streamText, thoughtText, input].filter(Boolean).join('\n')),
    [messages, streamText, thoughtText, input]
  )
  const contextStatus = running ? 'Running' : connected ? 'Ready' : 'Disconnected'
  const notifyCompletion = useCompletionNotifier(active)
  const lastActivity = activity[activity.length - 1]
  const activeToolName = running && lastActivity?.kind === 'tool' && !lastActivity.message.startsWith('✓') ? lastActivity.message : null
  const kimiHasStarted = streamText.length > 0 || thoughtText.length > 0 || activity.length > 0
  const statusPhrase = useStatusPhrase({
    active: running,
    hasStarted: kimiHasStarted,
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
      if (last?.kind === 'text') return [...prev.slice(0, -1), { ...last, text: last.text + text }]
      return [...prev, { id: `text-${Date.now()}-${prev.length}`, kind: 'text', text }]
    })
  }

  function appendLiveActivity(nextActivity: KimiActivity) {
    setLiveSegments((prev) => [...prev, { id: `activity-${nextActivity.ts}-${prev.length}`, kind: 'activity', activity: nextActivity }])
  }

  useEffect(() => () => { stopMotion(sessionSwitchAnimRef.current) }, [])

  function selectSession(next: Session | null) {
    if (next?.id === sessionRef.current?.id) return
    const el = scrollRef.current
    stopMotion(sessionSwitchAnimRef.current)
    if (!el || prefersReducedMotion()) { setSession(next); return }
    const out = anime(el, { opacity: [1, 0], translateY: [0, -4], duration: 100, ease: 'outQuad' })
    sessionSwitchAnimRef.current = out
    if (!out) { setSession(next); return }
    void out.then(() => {
      setSession(next)
      window.requestAnimationFrame(() => {
        const nextEl = scrollRef.current
        if (!nextEl) return
        sessionSwitchAnimRef.current = anime(nextEl, { opacity: [0, 1], translateY: [6, 0], duration: 150, ease: 'outExpo' })
      })
    })
  }

  useAgentTaskReporter('kimi', { running, session, title: session?.summary || session?.title, failed: Boolean(error) })

  const recheck = () => window.api.kimi.check().then(setCheck)
  const recheckAuth = () => window.api.kimi.getAuthStatus().then(setAuthStatus)

  async function doConnect() {
    setConnecting(true)
    const r = await window.api.kimi.connect()
    if (r.connected) { setConnected(true); const c = await window.api.kimi.check(); setCheck(c) }
    else { setError(r.error ?? 'Failed to connect'); await recheck() }
    setConnecting(false)
  }

  async function setAuthMethod(method: 'oauth' | 'apikey') {
    await window.api.kimi.setAuthMethod(method)
    await recheckAuth()
  }

  async function doLogin() {
    setLoginBusy(true); setLoginProgress(null)
    const r = await window.api.kimi.login()
    setLoginBusy(false)
    if (!r.success) addToast(`Kimi login failed: ${r.error ?? 'unknown error'}`)
    await recheckAuth()
  }

  async function doSetApiKey(key: string) {
    await window.api.kimi.setApiKey(key)
    addToast('Kimi API key saved')
    await recheckAuth()
  }

  useEffect(() => window.api.kimi.onLoginEvent(setLoginProgress), [])

  useEffect(() => { if (active) window.api.models.list().then(setOllamaModels) }, [active])

  // Real model catalog from the main process (~/.kimi-code/config.toml).
  useEffect(() => {
    if (!active) return
    let cancelled = false
    window.api.kimi.listModels()
      .then((list) => { if (!cancelled && Array.isArray(list) && list.length > 0) setModels(list) })
      .catch(() => { /* keep fallback */ })
    return () => { cancelled = true }
  }, [active])

  // A restored preference absent from the fetched catalog is still shown
  // (appended as a plain option) so restoration never lies.
  useEffect(() => {
    setModels((prev) => (model && !prev.some((m) => m.id === model) ? [...prev, { id: model, label: model }] : prev))
  }, [model])

  function selectModel(id: string) { setModel(id); saveModelPref(id) }

  function selectConfigValue(configId: string, value: string) {
    setConfigValues((prev) => {
      const next = { ...prev, [configId]: value }
      saveConfigPrefs(next)
      return next
    })
  }

  useAutoSessionSummary(session, messages, ollamaModels[0], (sessionId, summary) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, summary } : s)))
    setSession((prev) => (prev && prev.id === sessionId ? { ...prev, summary } : prev))
  })

  useEffect(() => {
    function onFocusComposer(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'kimi') textareaRef.current?.focus()
    }
    function onNewSession(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'kimi') newSessionRef.current()
    }
    function onPrefillPrompt(event: Event) {
      const detail = (event as CustomEvent<{ panel?: string; prompt?: string }>).detail
      if (detail?.panel === 'kimi' && typeof detail.prompt === 'string') {
        setInput(detail.prompt)
        textareaRef.current?.focus()
        setSlashIdx(-1)
      }
    }
    function onSelectSession(event: Event) {
      const detail = (event as CustomEvent<{ panel?: string; session?: Session }>).detail
      if (detail?.panel === 'kimi' && detail.session) selectSession(detail.session)
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
    window.api.instructions.getPath('kimi', p).then(fp => {
      if (fp) window.api.instructions.read(fp).then(r => setAgentMdExists(r.exists))
    })
    window.api.instructions.getPath('shared', p).then(fp => {
      if (fp) window.api.instructions.read(fp).then(r => setSharedMdExists(r.exists))
    })
  }, [props.project.path, isGlobalWorkspace, instructionsOpen])
  useEffect(() => {
    if (isGlobalWorkspace || !active) return
    recheck(); recheckAuth()
    window.api.kimi.health().then((h) => setConnected(h.ok))
  }, [isGlobalWorkspace, active])
  useEffect(() => {
    if (isGlobalWorkspace || !active) { setSessions([]); setArchivedSessions([]); return }
    let disposed = false
    void Promise.all([
      window.api.sessions.list(props.project.id, 'kimi'),
      window.api.sessions.listArchived(props.project.id, 'kimi'),
      window.api.kimi.liveState(props.project.id),
    ]).then(([nextSessions, nextArchived, live]) => {
      if (disposed) return
      setSessions(nextSessions)
      setArchivedSessions(nextArchived)
      let storedId: string | null = null
      try { storedId = localStorage.getItem(`${SELECTED_SESSION_KEY_PREFIX}${props.project.id}`) } catch { /* storage unavailable */ }
      const desiredId = live?.sessionId ?? storedId
      const next = desiredId ? [...nextSessions, ...nextArchived].find((candidate) => candidate.id === desiredId) ?? null : null
      if (next?.id !== sessionRef.current?.id) setSession(next)
    })
    return () => { disposed = true }
  }, [props.project.id, isGlobalWorkspace, active])

  useEffect(() => {
    if (!session?.id) return
    try { localStorage.setItem(`${SELECTED_SESSION_KEY_PREFIX}${props.project.id}`, session.id) } catch { /* storage unavailable */ }
  }, [props.project.id, session?.id])
  useEffect(() => {
    if (isGlobalWorkspace || !active) return
    window.api.kimi.getPermissionMode().then(setPermissionMode)
    window.api.kimi.getPlanMode().then(setPlanMode)
  }, [isGlobalWorkspace, active])

  async function changePermissionMode(mode: KimiPermissionMode) {
    const previous = permissionMode
    setPermissionMode(mode)
    const result = await window.api.kimi.setPermissionMode(mode)
    if (!result.success) {
      setPermissionMode(previous)
      addToast(`Failed to change Kimi permission mode: ${result.error ?? 'unknown error'}`)
    }
  }

  async function changePlanMode(on: boolean) {
    const previous = planMode
    setPlanMode(on)
    const result = await window.api.kimi.setPlanMode(on)
    if (!result.success) {
      setPlanMode(previous)
      addToast(`Failed to change Kimi plan mode: ${result.error ?? 'unknown error'}`)
    }
  }

  // The permission control is a single dropdown whose value is either the
  // read-only Plan mode or one of the five autonomy tiers. Plan drives Kimi's
  // native ACP mode; the tiers drive our client-side approval matrix. Picking a
  // tier while Plan is on turns Plan off first.
  async function changePermissionSelection(value: string) {
    if (value === PLAN_MODE_VALUE) {
      await changePlanMode(true)
      return
    }
    if (planMode) await changePlanMode(false)
    await changePermissionMode(Number(value) as KimiPermissionMode)
  }

  async function respondPermission(approved: boolean, alwaysAllowSession = false) {
    if (!pendingPermission || !session || respondingPermission) return
    setRespondingPermission(true)
    try {
      const result = await window.api.kimi.respondPermission({
        sessionId: session.id,
        requestId: pendingPermission.requestId,
        approved,
        actionKind: pendingPermission.action,
        alwaysAllowSession
      })
      if (!result.success) {
        addToast(`Failed to respond to Kimi permission request: ${result.error ?? 'request is no longer active'}`)
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
      const h = await window.api.kimi.health(); if (!alive) return
      if (h.ok !== connected) setConnected(h.ok)
    }
    const id = setInterval(tick, 4000)
    return () => { alive = false; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGlobalWorkspace, active])

  useEffect(() => {
    if (session) window.api.kimi.messages(session.id).then(setMessages)
    else setMessages([])
    resetLiveRunState(); setPlanEntries([]); setError('')
    setPendingPermission(session ? pendingPermissionsRef.current.get(session.id) ?? null : null)
    setRenderOffset(0)
  }, [session])

  // Applies one live event. Shared by the subscription and the replay log so a
  // window taking ownership mid-run rebuilds the same view — including an
  // unanswered ACP permissionRequest, which only main can resolve and would
  // otherwise be left pending with no UI able to answer it.
  const applyKimiEvent = useCallback((sessionId: string, e: KimiEvent) => {
    const isCurrentSession = sessionId === (sessionRef.current?.id ?? null)
    if (!isCurrentSession && e.kind !== 'permissionRequest') return
    if (e.kind === 'text') { setStreamText((t) => t + e.text); appendLiveText(e.text) }
    else if (e.kind === 'thought') setThoughtText((t) => t + e.text)
    else if (e.kind === 'activity') { setActivity((a) => [...a, e.activity]); appendLiveActivity(e.activity) }
    else if (e.kind === 'error') setError(e.message)
    else if (e.kind === 'model') setKimiModel(e.name)
    else if (e.kind === 'configOptions') setConfigSelects(e.options)
    else if (e.kind === 'commands') setCommands(e.commands)
    else if (e.kind === 'plan') setPlanEntries(e.entries)
    else if (e.kind === 'permissionRequest') {
      pendingPermissionsRef.current.set(sessionId, e.request)
      if (isCurrentSession) setPendingPermission(e.request)
      if (!notifiedPermissionsRef.current.has(e.request.requestId)) {
        notifiedPermissionsRef.current.add(e.request.requestId)
        void window.api.window.notifyApproval({ source: 'kimi', summary: e.request.title, panelActive: activeRef.current })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let disposed = false
    let hydrated = false
    let finished = false
    const queuedEvents: Array<{ sessionId: string; event: KimiEvent; sequence?: number }> = []
    lastLiveSequenceRef.current = 0
    const acceptEvent = (sessionId: string, event: KimiEvent, sequence?: number) => {
      if (sequence !== undefined) {
        // Main restarts the counter at 1 for every turn, so a fresh run resets the
        // watermark — otherwise the second turn of a session would be discarded as
        // 'already seen'.
        if (sequence === 1) lastLiveSequenceRef.current = 0
        if (sequence <= lastLiveSequenceRef.current) return
        lastLiveSequenceRef.current = sequence
      }
      applyKimiEvent(sessionId, event)
    }
    const offEvent = window.api.kimi.onEvent((d) => {
      if (!hydrated) {
        queuedEvents.push({ sessionId: d.sessionId, event: d.event, sequence: d.sequence })
        return
      }
      acceptEvent(d.sessionId, d.event, d.sequence)
    })
    const offDone = window.api.kimi.onDone(async (d) => {
      pendingPermissionsRef.current.delete(d.sessionId)
      finished = true
      setRunning(false)
      if (d.sessionId !== sessionRef.current?.id) return
      setPendingPermission(null)
      resetLiveRunState()
      setMessages(await window.api.kimi.messages(d.sessionId))
      notifyCompletion()
    })
    const flushQueue = () => {
      hydrated = true
      for (const item of queuedEvents) acceptEvent(item.sessionId, item.event, item.sequence)
      queuedEvents.length = 0
    }
    if (session) {
      void window.api.kimi.liveState(props.project.id).then((live) => {
        if (disposed) return
        if (live?.sessionId === session.id) {
          if (!finished) setRunning(true)
          for (const item of live.events) acceptEvent(live.sessionId, item.event, item.sequence)
        }
        flushQueue()
      }).catch(() => { if (!disposed) flushQueue() })
    } else {
      hydrated = true
    }
    return () => { disposed = true; offEvent(); offDone() }
  }, [session?.id, props.project.id, applyKimiEvent])

  useEffect(() => window.api.kimi.onUsage((d) => setKimiUsage(d)), [])

  useEffect(() => {
    if (!contextMenu) return
    function handleDown() { setContextMenu(null) }
    document.addEventListener('pointerdown', handleDown)
    return () => document.removeEventListener('pointerdown', handleDown)
  }, [contextMenu])

  async function newSession() {
    const s = await window.api.sessions.create(props.project.id, 'kimi', 'New task')
    setSessions((prev) => [s, ...prev]); setSession(s)
  }
  newSessionRef.current = () => { if (!isGlobalWorkspace && connected) void newSession() }

  async function deleteSession(target: Session) {
    const result = await window.api.sessions.delete(target.id)
    if (!result.success) { addToast(`Failed to delete session: ${result.error ?? 'unknown error'}`); return }
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
    if (!result.success) { addToast(`Failed to rename session: ${result.error ?? 'unknown error'}`); return }
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
    if (!result.success) { addToast(`Failed to ${archive ? 'archive' : 'unarchive'} session: ${result.error ?? 'unknown error'}`); return }
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
    if (!s) { s = await window.api.sessions.create(props.project.id, 'kimi', titleFrom(prompt)); setSessions((prev) => [s!, ...prev]); setSession(s) }
    else if (firstTurn) { const title = titleFrom(prompt); setSessions((prev) => prev.map((x) => x.id === s!.id ? { ...x, title } : x)); setSession({ ...s, title }) }

    setError(''); setRunning(true); resetLiveRunState(); setPlanEntries([]); setInput(''); setKimiUsage(null)
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, session_id: s!.id, role: 'user', content: prompt, model: null, created_at: Date.now() }])
    window.api.kimi.send({ sessionId: s.id, projectId: props.project.id, prompt, injectMemory, model, configValues })
    setInjectMemory(false)
  }

  async function run() {
    if (running || !input.trim()) return
    if (input.startsWith('/') || attachments.length === 0) { sendTask(input); return }
    const resolved = await resolveAttachments(attachments)
    if (resolved.error) { setError(resolved.error); return }
    setAttachments([])
    sendTask(resolved.content + input)
  }
  function cancelRun() { if (session) window.api.kimi.abort(session.id) }

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

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); void run(); return }
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); void run(); return }
    if (e.key === 'Enter' && e.shiftKey) return
    if (e.key === 'Escape') {
      e.preventDefault()
      if (running) cancelRun()
      else { setInput(''); setSlashIdx(-1) }
      return
    }
    if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setInput(''); setSlashIdx(-1) }
  }

  async function copyOutput(text: string) {
    try { await navigator.clipboard.writeText(text); addToast('Copied output') } catch { addToast('Copy failed') }
  }

  async function saveOutputToKnowledge(m: Message) {
    try {
      await window.api.memory.save({ projectId: props.project.id, type: 'note', title: m.content.slice(0, 60), content: m.content, source: 'kimi' })
      addToast('Saved to Knowledge')
      window.dispatchEvent(new CustomEvent('knowledge:pulse'))
    } catch (err) {
      addToast(`Failed to save to Knowledge: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const kimiResend = useCallback((content: string, regenerateMessageId: string) => {
    if (!session || running) return
    setError(''); setRunning(true); resetLiveRunState(); setPlanEntries([]); setKimiUsage(null)
    window.api.kimi.send({ sessionId: session.id, projectId: props.project.id, prompt: content, injectMemory: false, model, configValues, regenerateMessageId })
  }, [session, running, props.project.id, model, configValues])

  const fetchKimiMessages = useCallback((sid: string) => window.api.kimi.messages(sid), [])

  const { regenerate, editAndResend, setReaction } = useMessageActions({
    sessionId: session?.id,
    messages,
    setMessages,
    busy: running,
    fetchMessages: fetchKimiMessages,
    resend: kimiResend,
    onError: addToast
  })

  const renderLiveSegment = (segment: KimiLiveSegment, index: number) => {
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
      let entries: KimiActivity[] = []
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
  const visibleMessages = messages.slice(Math.max(0, messages.length - RENDER_LIMIT - renderOffset))
  const boardEntries = useMemo(() => {
    if (planEntries.length > 0) return planEntries
    const sourceActivities = activity.length > 0 ? activity : activitiesFromToolMessages(messages)
    if (sourceActivities.length > 0) return sourceActivities.slice(-18).map(boardEntryFromActivity)
    if (running && session?.title) return [{ content: session.title, status: 'in_progress' }]
    return []
  }, [activity, messages, planEntries, running, session?.title])

  const composerBlock = (
    <>
      <AiContextBar
        testId="context-bar-kimi"
        usedTokens={session ? (kimiUsage?.used ?? estimatedTokens) : undefined}
        maxTokens={session ? kimiUsage?.max : undefined}
        tokensApproximate={session ? (kimiUsage === null && estimatedTokens !== undefined) : undefined}
        model={kimiModel ?? (models.find((m) => m.id === model)?.label ?? KIMI_MODEL)}
        mode="Kimi"
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
          data-testid="kimi-composer"
          placeholder="Describe a task for Kimi…  (Enter to send · Shift+Enter for newline)"
          value={input}
          onChange={(e) => { setInput(e.target.value); setSlashIdx(-1) }}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-bar">
          <div className="composer-bar-left">
            <button className="composer-icon-btn" onClick={() => void pickFile()} title="Attach file" aria-label="Attach file" disabled={running}>＋</button>
            <div
              className={`model-select composer-control-boxed kimi-mode-control${planMode ? ' plan-active' : ''}`}
              data-testid="kimi-mode-control"
              title={planMode ? PLAN_MODE_DESCRIPTION : PERMISSION_MODES.find((m) => m.mode === permissionMode)?.description}
            >
              <select
                data-testid="kimi-permission-mode"
                value={planMode ? PLAN_MODE_VALUE : permissionMode}
                onChange={(e) => void changePermissionSelection(e.target.value)}
              >
                <option value={PLAN_MODE_VALUE}>Plan (read-only)</option>
                {PERMISSION_MODES.map((m) => <option key={m.mode} value={m.mode}>{m.label}</option>)}
              </select>
              <span className="model-select-chevron">⌄</span>
            </div>
            <KimiModelPicker
              testId="kimi-model"
              model={model}
              onModelChange={selectModel}
              models={models}
              configSelects={configSelects}
              configValues={configValues}
              onConfigChange={selectConfigValue}
              disabled={running}
            />
          </div>
          <div className="composer-bar-right">
            {(commands.length === 0 || commands.some((c) => c.name === 'compact')) && (
              <button
                className="composer-text-toggle kimi-compact-btn"
                data-testid="kimi-compact"
                disabled={!connected || running || !session}
                title="Compact the conversation to free up context (runs /compact)"
                onClick={() => void sendTask('/compact')}
              >
                Compact
              </button>
            )}
            <ContextMeter
              testId="context-meter-kimi"
              used={kimiUsage?.used ?? null}
              total={models.find((m) => m.id === model)?.contextSize ?? kimiUsage?.max ?? null}
            />
            {running
              ? <button ref={sendButtonMotion.ref} {...sendButtonMotion.pressHandlers} className="composer-send-btn stop" onClick={cancelRun} title="Stop Kimi">Stop</button>
              : <button ref={sendButtonMotion.ref} {...sendButtonMotion.pressHandlers} className="composer-send-btn" data-testid="kimi-send" disabled={!connected} onClick={() => void run()}>Send</button>}
          </div>
        </div>
      </div>
    </>
  )

  const kimiGlobalHeaderSlot = (
    <button className="instructions-md-btn exists" onClick={() => setInstructionsOpen({ agentId: 'app', agentLabel: 'App' })} title="Edit App CLAUDE.md">
      📋 App CLAUDE.md
    </button>
  )

  const kimiHeaderSlot = (
    <>
      <button
        className={`instructions-md-btn${agentMdExists ? ' exists' : ''}`}
        onClick={() => setInstructionsOpen({ agentId: 'kimi', agentLabel: 'Kimi' })}
        title="Edit KIMI.md"
      >
        📋 KIMI.md{!agentMdExists ? ' (create)' : ''}
      </button>
      <button className="instructions-md-btn exists" onClick={() => setInstructionsOpen({ agentId: 'app', agentLabel: 'App' })} title="Edit App CLAUDE.md">
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
          disabledTitle="Kimi needs a project folder"
          emptyLabel="No Kimi tasks yet"
          headerSlot={kimiGlobalHeaderSlot}
          onSelect={() => {}}
          onOptions={() => {}}
          onRenameChange={() => {}}
          onRenameCommit={() => {}}
          onRenameCancel={() => {}}
        />
        <section className="chat-main">
          <AiContextBar testId="context-bar-kimi" model={KIMI_MODEL} mode="Kimi" status="Project required" disabledReason="Open a project folder" />
          <div className="empty center cc-setup" data-testid="kimi-global-unavailable">
            <h2>Kimi needs a project folder.</h2>
            <p className="muted">Open a project workspace to use Kimi. Global Workspace is available for general chat and shared memory, but this Kimi integration should not run without a real project path.</p>
          </div>
        </section>
      </div>
      {instructionsOpen && (
        <InstructionsEditor agentId={instructionsOpen.agentId} agentLabel={instructionsOpen.agentLabel} projectPath={props.project.path ?? null} onClose={() => setInstructionsOpen(null)} />
      )}
    </div>
  )

  if (check && (!check.installed || !connected) && !running) {
    return (
      <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
        <div className="chat-layout">
          <AgentSessionRail
            sessions={[]}
            pinnedIds={new Set()}
            renaming={null}
            newLabel="New task"
            disabled
            disabledTitle="Kimi is not connected"
            emptyLabel="No Kimi tasks yet"
            headerSlot={kimiHeaderSlot}
            onSelect={() => {}}
            onOptions={() => {}}
            onRenameChange={() => {}}
            onRenameCommit={() => {}}
            onRenameCancel={() => {}}
          />
          <section className="chat-main">
            <header className="chat-header">
              <span className="chat-header-title">Kimi Connection</span>
              <button className={`ghost icon-btn ${settingsOpen ? 'on' : ''}`} onClick={() => setSettingsOpen((v) => !v)} title="Auth settings" aria-label="Toggle auth settings">⚙</button>
            </header>
            {settingsOpen && (
              <KimiAuthPanel
                status={authStatus}
                onSetMethod={setAuthMethod}
                onLogin={doLogin}
                onSetApiKey={doSetApiKey}
                loginBusy={loginBusy}
                loginProgress={loginProgress}
              />
            )}
            <SetupNotice check={check} authStatus={authStatus} onRecheck={recheck} onConnect={doConnect} connecting={connecting} />
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
        newTitle="Start a new Kimi task"
        emptyLabel="No Kimi tasks yet"
        headerSlot={kimiHeaderSlot}
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
              <span className="empty-state-icon" style={{ color: 'var(--accent-kimi)' }} aria-hidden>
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19V5" /><path d="M4 12l9 -7" /><path d="M4 12l9 7" /><path d="M13 5l7 7l-7 7" />
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
                <span className={`hermes-conn ${connected ? 'ok' : 'bad'}`} title={connected ? 'Kimi ACP connected' : 'Kimi disconnected'}>
                  <span className="status-dot" />
                  {connected ? `Connected${check?.version ? ` · ${check.version}` : ''}` : 'Disconnected'}
                </span>
                <button className={`ghost inject-btn ${injectMemory ? 'on' : ''}`} onClick={() => setInjectMemory((v) => !v)} title="Prepend get_project_context() to the next task via MCP">
                  {injectMemory ? '✓ Memory will be injected' : '✦ Inject memory'}
                </button>
              </div>
            </header>
            <AgentStatusStrip
              agent="Kimi"
              status={running ? (statusPhrase ?? 'Running') : connected ? 'Ready' : 'Disconnected'}
              tone={running ? 'info' : connected ? 'success' : 'warning'}
              running={running}
              detail="Local ACP"
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
                    {!streamText && !thoughtText && activity.length === 0 && <div className="cc-note muted small">{statusPhrase ?? 'Connecting to Kimi…'}<span className="cursor">&#x2587;</span></div>}
                  </div>
                )}
              </div>
              <ChatJumpToBottomButton visible={showJumpToBottom} onClick={jumpToBottom} />
              </div>
            )}

            {error && <AgentErrorNotice title="Kimi could not run">{error}</AgentErrorNotice>}

            {pendingPermission && (
              <div className="agent-error-wrap hermes-permission-wrap" data-testid="kimi-permission-card">
                <WorkspaceNotice
                  title={`⚠ Kimi wants to: ${pendingPermission.title}`}
                  tone="warning"
                  action={
                    <div className="hermes-permission-actions">
                      <button className="ghost" data-testid="kimi-permission-deny" disabled={respondingPermission} onClick={() => void respondPermission(false)}>Deny</button>
                      <button className="primary" data-testid="kimi-permission-allow-once" disabled={respondingPermission} onClick={() => void respondPermission(true)}>Allow once</button>
                      <button className="ghost" data-testid="kimi-permission-allow-session" disabled={respondingPermission} onClick={() => void respondPermission(true, true)}>Allow for session</button>
                    </div>
                  }
                />
              </div>
            )}

            {composerBlock}
          </>
        )}
      </section>

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
