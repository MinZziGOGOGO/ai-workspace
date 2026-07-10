import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useComposerAttachments } from '../hooks/useComposerAttachments'
import { diffLines } from 'diff'
import type { Project, Session, Message, CCActivityEntry, CCFileDiff, CCEvent, Checkpoint } from '../types'
import { AttachmentChips, resolveAttachments } from './ComposerAttachments'
import Markdown from './Markdown'
import RelativeTime from './RelativeTime'
import AiContextBar, { estimateTokensFromText } from './AiContextBar'
import VoiceInputButton from './VoiceInputButton'
import { useToast } from './ToastContext'
import { useAgentActivity } from '../AgentActivityContext'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { fallbackTitleFromText, isGenericSessionTitle } from '../../../shared/sessionTitles'
import { AgentErrorNotice, AgentSessionRail, AgentStatusStrip, EditableUserMessage, OutputActions, SessionContextMenu, useAutoSessionSummary, useConfirmDestructive, useStatusPhrase } from './AgentPanelPrimitives'
import InstructionsEditor from './InstructionsEditor'
import anime, { AnimatedScaleBar, animateScrollToBottom, prefersReducedMotion, stopMotion, usePressMotion, type MotionHandle } from '../motion'
import { setAgentAvailable, setAgentPanelOpen, setAgentSession, clearAgentCurrent, type HandoffSendDetail } from '../handoff'
import { isLastAssistantMessage, useMessageActions } from '../messageActions'
import { useCompletionNotifier } from '../notify'

type Check = { installed: boolean; version?: string; bin?: string; error?: string }
type SlashCommand = { name: string; desc: string }

const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
] as const
const DEFAULT_MODEL = 'claude-sonnet-4-6'
const RENDER_LIMIT = 50
const PINNED_KEY = 'aiworkspace.claudecode.pinned'
function loadPinned(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')) } catch { return new Set() }
}
function savePinned(s: Set<string>) { localStorage.setItem(PINNED_KEY, JSON.stringify([...s])) }

const CLAUDECODE_EMPTY_HEADINGS = [
  'Ready when you are.',
  'What should we build?',
  'Describe the task — Claude Code takes it from here.',
]

function labelForModel(model: string): string {
  return MODELS.find((m) => m.id === model)?.label ?? model
}

const EFFORTS = ['normal', 'high', 'max'] as const
type Effort = (typeof EFFORTS)[number]

const FALLBACK_COMMANDS: SlashCommand[] = [
  { name: '/bug', desc: 'Report a bug to Anthropic' },
  { name: '/checkpoint', desc: 'Save a checkpoint (git stash + note)' },
  { name: '/clear', desc: 'Start a fresh task (clears this view)' },
  { name: '/compact', desc: 'Compact the conversation context' },
  { name: '/context', desc: 'Show current context window usage' },
  { name: '/cost', desc: 'Show token usage and cost for this session' },
  { name: '/diff', desc: 'Show a diff of pending changes' },
  { name: '/doctor', desc: 'Diagnose configuration and connection issues' },
  { name: '/exit', desc: 'Exit the current Claude Code session' },
  { name: '/goal', desc: 'Set an explicit goal for this session' },
  { name: '/help', desc: 'Show available slash commands' },
  { name: '/init', desc: 'Initialize a CLAUDE.md in this project' },
  { name: '/loop', desc: 'Run a task repeatedly until done' },
  { name: '/memory', desc: 'Open the Knowledge panel' },
  { name: '/model', desc: 'Switch the model for this session' },
  { name: '/permissions', desc: 'Manage permission settings for this session' },
  { name: '/review', desc: 'Review current changes in the project' },
  { name: '/status', desc: 'Show current task and context status' },
  { name: '/summarize', desc: 'Summarize the conversation so far' },
  { name: '/think', desc: 'Engage extended thinking mode' },
  { name: '/undo', desc: 'Undo the last set of file changes' },
]

const LOCAL_COMMANDS = new Set(['/clear', '/memory', '/help'])

function parseHelpOutput(text: string): SlashCommand[] | null {
  const results: SlashCommand[] = []
  const re = /`?(\/[a-z][a-z-]*)`?\s*[-–:]+\s*([^\n`]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase(); const desc = m[2].trim().replace(/`/g, '')
    if (name.length >= 3 && desc.length >= 4) results.push({ name, desc })
  }
  return results.length >= 5 ? results : null
}

function mergeWithLocalCommands(fetched: SlashCommand[]): SlashCommand[] {
  const fetchedNames = new Set(fetched.map((c) => c.name))
  const localOnly = FALLBACK_COMMANDS.filter((c) => LOCAL_COMMANDS.has(c.name) && !fetchedNames.has(c.name))
  return [...localOnly, ...fetched].sort((a, b) => a.name.localeCompare(b.name))
}

function markLastPending(list: CCActivityEntry[], ok: boolean): CCActivityEntry[] {
  const next = [...list]
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].ok === undefined) { next[i] = { ...next[i], ok }; break }
  }
  return next
}

function attachDiff(list: CCActivityEntry[], toolCallId: string, diff: CCFileDiff): CCActivityEntry[] {
  return list.map((e) => (e.id === toolCallId ? { ...e, diff } : e))
}

function looksLikeDiff(text: string): boolean { return /\n/.test(text) && /^[+\-@]/m.test(text) }

// ---- file diff card ---------------------------------------------------------
// Lines beyond this (added + removed) are elided behind a "Show full diff" —
// full unified diffs on huge generated files can otherwise freeze the render.
const DIFF_TRUNCATE_AT = 2000

interface DiffRow { type: 'add' | 'remove' | 'ctx'; text: string; oldNum?: number; newNum?: number }

function computeDiffRows(before: string, after: string): { rows: DiffRow[]; added: number; removed: number } {
  const parts = diffLines(before, after)
  const rows: DiffRow[] = []
  let oldNum = 1
  let newNum = 1
  let added = 0
  let removed = 0
  for (const part of parts) {
    const lines = part.value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    if (part.added) {
      for (const l of lines) { rows.push({ type: 'add', text: l, newNum: newNum++ }); added++ }
    } else if (part.removed) {
      for (const l of lines) { rows.push({ type: 'remove', text: l, oldNum: oldNum++ }); removed++ }
    } else {
      for (const l of lines) rows.push({ type: 'ctx', text: l, oldNum: oldNum++, newNum: newNum++ })
    }
  }
  return { rows, added, removed }
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function DiffRows(props: { rows: DiffRow[] }) {
  return (
    <>
      {props.rows.map((r, i) => (
        <div key={i} className={`diff-line-row ${r.type === 'add' ? 'diff-line-add' : r.type === 'remove' ? 'diff-line-remove' : ''}`}>
          <span className="diff-line-num">{r.oldNum ?? ''}</span>
          <span className="diff-line-num">{r.newNum ?? ''}</span>
          <span className="diff-line-text">{(r.type === 'add' ? '+ ' : r.type === 'remove' ? '- ' : '  ') + r.text}</span>
        </div>
      ))}
    </>
  )
}

function DiffCard(props: { diff: CCFileDiff }) {
  const { diff } = props
  const isNew = diff.before === null
  const [open, setOpen] = useState(false)
  const [showFull, setShowFull] = useState(false)

  const { rows, added, removed } = useMemo(
    () => computeDiffRows(diff.before ?? '', diff.after),
    [diff.before, diff.after]
  )
  const totalChanged = added + removed
  const truncated = !isNew && !showFull && totalChanged > DIFF_TRUNCATE_AT
  const visibleRows = truncated ? rows.slice(0, DIFF_TRUNCATE_AT) : rows

  const newFileLines = useMemo(() => diff.after.split('\n'), [diff.after])
  const newFileTruncated = isNew && !showFull && newFileLines.length > DIFF_TRUNCATE_AT
  const visibleNewFile = newFileTruncated ? newFileLines.slice(0, DIFF_TRUNCATE_AT).join('\n') : diff.after

  return (
    <div className="activity-line-item">
      <button className="activity-line" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="activity-line-name">{isNew ? 'Created' : 'Edited'}</span>
        <span className="activity-line-detail">{fileNameFromPath(diff.path)}</span>
        {isNew ? (
          <span className="stat-add">new file</span>
        ) : (
          <>
            <span className="stat-add">+{added}</span>
            <span className="stat-remove">-{removed}</span>
          </>
        )}
        <span className="chevron">{open ? '⌄' : '›'}</span>
      </button>
      {open && (
        <div className="activity-detail">
          {isNew ? (
            <>
              <div className="tool-output">{visibleNewFile}</div>
              {newFileTruncated && (
                <button className="ghost diff-show-full-btn" onClick={() => setShowFull(true)}>
                  Show full diff ({newFileLines.length} lines)
                </button>
              )}
            </>
          ) : (
            <>
              <div className="diff-line-list"><DiffRows rows={visibleRows} /></div>
              {truncated && (
                <button className="ghost diff-show-full-btn" onClick={() => setShowFull(true)}>
                  Show full diff ({totalChanged} lines changed)
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function DiffView(props: { text: string }) {
  return (
    <div className="diff" role="group" aria-label="diff">
      {props.text.split('\n').map((ln, i) => {
        let cls = 'diff-ctx'
        if (/^[+-]{3}/.test(ln)) cls = 'diff-meta'
        else if (/^@@/.test(ln)) cls = 'diff-hunk'
        else if (/^\+/.test(ln)) cls = 'diff-add'
        else if (/^-/.test(ln)) cls = 'diff-del'
        return <div key={i} className={`diff-line ${cls}`}>{ln || ' '}</div>
      })}
    </div>
  )
}

function ToolCard(props: { entry: CCActivityEntry; live?: boolean }) {
  const { entry, live } = props
  const status = entry.ok === false ? 'error' : entry.ok === true ? 'done' : live ? 'running' : 'pending'
  const lines = entry.summary.split('\n'); const detail = lines[0]; const body = lines.slice(1).join('\n')
  const hasBody = body.trim().length > 0
  const [open, setOpen] = useState(false)
  return (
    <div className={`activity-line-item status-${status}`}>
      <button className="activity-line" onClick={() => hasBody && setOpen((o) => !o)} disabled={!hasBody} aria-expanded={hasBody ? open : undefined} title={hasBody ? (open ? 'Collapse' : 'Expand') : detail}>
        <span className={`activity-line-name${status === 'error' ? ' err' : ''}`}>{entry.name}</span>
        <span className="activity-line-detail">{detail}</span>
        {status === 'running' && <span className="activity-line-spinner" aria-hidden>◌</span>}
        {hasBody && <span className="chevron">{open ? '⌄' : '›'}</span>}
      </button>
      {hasBody && open && <div className="activity-detail">{looksLikeDiff(body) ? <DiffView text={body} /> : <pre className="tool-output">{body}</pre>}</div>}
    </div>
  )
}

function ActivityLog(props: { entries: CCActivityEntry[]; live?: boolean }) {
  if (props.entries.length === 0) return null
  return (
    <div className="tool-activity">
      {props.entries.map((e, i) =>
        e.diff ? <DiffCard key={i} diff={e.diff} /> : <ToolCard key={i} entry={e} live={props.live && e.ok === undefined} />
      )}
    </div>
  )
}

// ---- checkpoint indicator ---------------------------------------------------
interface CheckpointInfo {
  success: boolean
  checkpointId?: string
  commitHash?: string
  reason?: 'not-git' | 'dirty' | 'error'
}

function CheckpointBadge(props: { info: CheckpointInfo; onRollback: () => Promise<void> }) {
  const { info } = props
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current) }, [])

  if (!info.success) {
    const label =
      info.reason === 'dirty' ? 'No checkpoint (uncommitted changes present)' :
      info.reason === 'not-git' ? 'No checkpoint (not a git repo)' :
      'No checkpoint (git error)'
    return <span className="cc-checkpoint-note muted small">{label}</span>
  }

  async function handleRollbackClick() {
    if (!confirming) {
      setConfirming(true)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirming(false), 4000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirming(false)
    setRollingBack(true)
    await props.onRollback()
    setRollingBack(false)
    setOpen(false)
  }

  return (
    <span className="cc-checkpoint" data-testid="claude-code-checkpoint">
      <button type="button" className="cc-checkpoint-btn" data-testid="claude-code-checkpoint-open" onClick={() => setOpen((o) => !o)}>🔖 Checkpoint</button>
      {open && (
        <div className="cc-checkpoint-panel" data-testid="claude-code-checkpoint-panel">
          <div className="muted small">Checkpoint created before this task</div>
          <button
            type="button"
            className={`danger cc-checkpoint-rollback${confirming ? ' pending-confirm' : ''}`}
            data-testid="claude-code-checkpoint-rollback"
            disabled={rollingBack}
            onClick={() => void handleRollbackClick()}
          >
            {rollingBack ? 'Rolling back…' : confirming ? 'This will discard changes after this point. Continue?' : 'Rollback to here'}
          </button>
        </div>
      )}
    </span>
  )
}

function SetupNotice(props: { check: Check; onRecheck: () => void }) {
  return (
    <div className="empty center cc-setup">
      <h2>{props.check.installed ? 'Claude Code needs setup' : "Claude Code isn't installed"}</h2>
      <p className="muted">This tab drives the Claude Code CLI headlessly under your Claude subscription login — it never uses API billing.</p>
      <ol className="cc-setup-steps">
        {!props.check.installed && <li>Install the CLI: <code>npm i -g @anthropic-ai/claude-code</code> (or the native installer).</li>}
        <li>Sign in once: run <code>claude login</code> in a terminal and authenticate with your Claude Pro/Max subscription (not an API key).</li>
        <li>Come back and click Re-check.</li>
      </ol>
      {props.check.error && <p className="muted small cc-setup-err">{props.check.error}</p>}
      <button className="primary" onClick={props.onRecheck}>Re-check</button>
    </div>
  )
}

interface CtxMenu { sessionId: string; x: number; y: number }

export default function ClaudeCodeTab(props: { project: Project; onOpenKnowledge: () => void; active?: boolean }) {
  const { addToast } = useToast()
  const { setActive: setAgentActive } = useAgentActivity()
  const [check, setCheck] = useState<Check | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [injectMemory, setInjectMemory] = useState(false)
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState('')
  const [activity, setActivity] = useState<CCActivityEntry[]>([])
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [loginRequired, setLoginRequired] = useState(false)
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(FALLBACK_COMMANDS)
  const [model, setModel] = useState<string>(DEFAULT_MODEL)
  const [effort, setEffort] = useState<Effort>('normal')
  const [thinking, setThinking] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => loadPinned())
  const confirmDestructive = useConfirmDestructive()
  const [tokPerSec, setTokPerSec] = useState(0)
  const [renderOffset, setRenderOffset] = useState(0)
  const { attachments, setAttachments, isDragOver, setIsDragOver, handlePaste, pickFile, handleDrop } = useComposerAttachments()
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [instructionsOpen, setInstructionsOpen] = useState<{ agentId: string; agentLabel: string } | null>(null)
  const [agentMdExists, setAgentMdExists] = useState(false)
  const [sharedMdExists, setSharedMdExists] = useState(false)
  const [checkpoints, setCheckpoints] = useState<Record<string, CheckpointInfo>>({})
  const [emptyHeading] = useState(() => CLAUDECODE_EMPTY_HEADINGS[Math.floor(Math.random() * CLAUDECODE_EMPTY_HEADINGS.length)])

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const scrollAnimRef = useRef<MotionHandle>(null)
  const sessionSwitchAnimRef = useRef<MotionHandle>(null)
  const sessionRef = useRef<Session | null>(null)
  const newSessionRef = useRef<() => void>(() => {})
  const handoffRef = useRef<(detail: HandoffSendDetail) => void>(() => {})
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendButtonMotion = usePressMotion<HTMLButtonElement>()
  const tokenTimestamps = useRef<number[]>([])
  const isGlobalWorkspace = isGlobalProjectId(props.project.id)
  const active = props.active ?? true
  const estimatedTokens = useMemo(
    () => estimateTokensFromText([...messages.map((m) => m.content), output, input].filter(Boolean).join('\n')),
    [messages, output, input]
  )
  const notifyCompletion = useCompletionNotifier(active)
  const pendingToolEntry = activity.find((e) => e.ok === undefined)
  const ccStatusPhrase = useStatusPhrase({
    active: running,
    hasStarted: output.length > 0 || activity.length > 0,
    toolName: pendingToolEntry?.name ?? null,
    progressKey: `${output.length}:${activity.length}:${activity.filter((e) => e.ok !== undefined).length}`
  })
  sessionRef.current = session

  useEffect(() => () => {
    stopMotion(scrollAnimRef.current)
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
    setAgentActive('claudecode', running)
    return () => setAgentActive('claudecode', false)
  }, [running, setAgentActive])

  async function loadSlashCommands() {
    try {
      const raw = await (window.api.claudeCode as any).commands?.()
      if (typeof raw === 'string' && raw.length > 0) { const parsed = parseHelpOutput(raw); if (parsed) { setSlashCommands(mergeWithLocalCommands(parsed)); return } }
      if (Array.isArray(raw) && raw.length >= 5) setSlashCommands(mergeWithLocalCommands(raw as SlashCommand[]))
    } catch { /* use fallback */ }
  }

  useEffect(() => { if (active) window.api.models.list().then(setOllamaModels) }, [active])

  useAutoSessionSummary(session, messages, ollamaModels[0], (sessionId, summary) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, summary } : s)))
    setSession((prev) => (prev && prev.id === sessionId ? { ...prev, summary } : prev))
  })

  useEffect(() => {
    function onFocusComposer(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'claudecode') textareaRef.current?.focus()
    }
    function onNewSession(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      // Call through the ref so the guard sees the current check/workspace
      // state instead of the values captured at listener registration.
      if (panel === 'claudecode') newSessionRef.current()
    }
    function onPrefillPrompt(event: Event) {
      const detail = (event as CustomEvent<{ panel?: string; prompt?: string }>).detail
      if (detail?.panel === 'claudecode' && typeof detail.prompt === 'string') {
        setInput(detail.prompt)
        textareaRef.current?.focus()
        setSlashDismissed(false)
      }
    }
    function onSelectSession(event: Event) {
      const detail = (event as CustomEvent<{ panel?: string; session?: Session }>).detail
      if (detail?.panel === 'claudecode' && detail.session) selectSession(detail.session)
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
    window.api.instructions.getPath('claudecode', p).then(fp => {
      if (fp) window.api.instructions.read(fp).then(r => setAgentMdExists(r.exists))
    })
    window.api.instructions.getPath('shared', p).then(fp => {
      if (fp) window.api.instructions.read(fp).then(r => setSharedMdExists(r.exists))
    })
  }, [props.project.path, isGlobalWorkspace, instructionsOpen])

  const recheck = () => window.api.claudeCode.check().then((c) => { setCheck(c); if (c.installed) void loadSlashCommands() })

  useEffect(() => { if (!isGlobalWorkspace && active) recheck() }, [isGlobalWorkspace, active])
  useEffect(() => {
    function handleTestCheck(event: Event) {
      const detail = (event as CustomEvent<{ check?: Check }>).detail
      const next = detail?.check ?? { installed: true, version: 'e2e', bin: 'fake-claude' }
      setCheck(next)
      setError('')
      setLoginRequired(false)
    }
    window.addEventListener('aiworkspace:test:set-claude-code-check', handleTestCheck)
    return () => window.removeEventListener('aiworkspace:test:set-claude-code-check', handleTestCheck)
  }, [])

  useEffect(() => {
    if (isGlobalWorkspace || !active) { setSessions([]); setArchivedSessions([]); return }
    window.api.sessions.list(props.project.id, 'claudecode').then(setSessions)
    window.api.sessions.listArchived(props.project.id, 'claudecode').then(setArchivedSessions)
  }, [props.project.id, isGlobalWorkspace, active])

  useEffect(() => {
    if (session) window.api.claudeCode.messages(session.id).then(setMessages)
    else setMessages([])
    setOutput(''); setActivity([]); setNote(''); setError('')
    setRenderOffset(0)
    tokenTimestamps.current = []; setTokPerSec(0)
    setCheckpoints({})
  }, [session])

  // Persisted checkpoints for this session (created before past tasks), keyed
  // by the user message they belong to so they can render inline.
  useEffect(() => {
    if (!session) return
    window.api.checkpoints.list(session.id).then((rows: Checkpoint[]) => {
      setCheckpoints((prev) => {
        const next = { ...prev }
        for (const row of rows) {
          if (row.message_id) next[row.message_id] = { success: true, checkpointId: row.id, commitHash: row.commit_hash }
        }
        return next
      })
    })
  }, [session])

  // Publish live state to the Chat→agent handoff bus so the Chat tab can resolve
  // where a handoff should land and whether this agent is reachable.
  useEffect(() => { setAgentPanelOpen('claudecode', active) }, [active])
  useEffect(() => { setAgentAvailable('claudecode', !isGlobalWorkspace && !!check?.installed) }, [check, isGlobalWorkspace])
  useEffect(() => {
    if (session) setAgentSession('claudecode', session.id, session.title)
    else clearAgentCurrent('claudecode')
  }, [session])

  // Receive a handoff sent programmatically from the Chat tab: select/create the
  // target session, then drive our own send path so tab state stays consistent.
  useEffect(() => {
    function onHandoff(event: Event) {
      const detail = (event as CustomEvent<HandoffSendDetail>).detail
      if (detail?.panel !== 'claudecode') return
      void handoffRef.current(detail)
    }
    window.addEventListener('panel:handoffSend', onHandoff)
    return () => window.removeEventListener('panel:handoffSend', onHandoff)
  }, [])

  useEffect(() => {
    const offEvent = window.api.claudeCode.onEvent((d) => {
      if (d.sessionId !== session?.id) return
      const e: CCEvent = d.event
      if (e.kind === 'text') { setOutput((o) => o + e.text); tokenTimestamps.current.push(Date.now()) }
      else if (e.kind === 'tool') setActivity((a) => [...a, { id: e.id, name: e.name, summary: e.summary }])
      else if (e.kind === 'tool-result') setActivity((a) => markLastPending(a, e.ok))
      else if (e.kind === 'file_diff') setActivity((a) => attachDiff(a, e.toolCallId, { path: e.path, before: e.before, after: e.after }))
      else if (e.kind === 'system') setNote(e.summary)
      else if (e.kind === 'error') setError(e.message)
    })
    const offDone = window.api.claudeCode.onDone(async (d) => {
      if (d.sessionId !== session?.id) return
      setRunning(false); setLoginRequired(d.loginRequired ?? false)
      setMessages(await window.api.claudeCode.messages(d.sessionId))
      setOutput(''); setActivity([]); setNote('')
      tokenTimestamps.current = []; setTokPerSec(0)
      notifyCompletion()
    })
    // Fires just before the task starts running, keyed to the real (server-side)
    // user message id. The composer had already pushed a temporary message with
    // a client-generated id, so reconcile it here to the real id the checkpoint
    // (and later the reloaded message list) is keyed to.
    const offCheckpoint = window.api.claudeCode.onCheckpoint((d) => {
      if (d.sessionId !== session?.id) return
      setCheckpoints((prev) => ({
        ...prev,
        [d.messageId]: { success: d.success, checkpointId: d.checkpointId, commitHash: d.commitHash, reason: d.reason }
      }))
      setMessages((prev) => {
        const idx = prev.map((m) => m.role === 'user' && m.id.startsWith('tmp-')).lastIndexOf(true)
        if (idx === -1 || prev[idx].id === d.messageId) return prev
        const next = [...prev]
        next[idx] = { ...next[idx], id: d.messageId }
        return next
      })
    })
    return () => { offEvent(); offDone(); offCheckpoint() }
  }, [session])

  // Compute tok/s every 500ms while running
  useEffect(() => {
    if (!running) { setTokPerSec(0); return }
    const iv = setInterval(() => {
      const now = Date.now()
      const recent = tokenTimestamps.current.filter(t => now - t < 5000)
      tokenTimestamps.current = recent
      setTokPerSec(recent.length / 5)
    }, 500)
    return () => clearInterval(iv)
  }, [running])

  useEffect(() => {
    clearTimeout(scrollTimeoutRef.current)
    scrollTimeoutRef.current = setTimeout(() => {
      const el = scrollRef.current
      if (!el) return
      stopMotion(scrollAnimRef.current)
      scrollAnimRef.current = animateScrollToBottom(el, running)
    }, running ? 100 : 0)
  }, [messages, output, activity, running])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    function handleDown() { setContextMenu(null) }
    document.addEventListener('pointerdown', handleDown)
    return () => document.removeEventListener('pointerdown', handleDown)
  }, [contextMenu])

  async function newSession() {
    const s = await window.api.sessions.create(props.project.id, 'claudecode', 'New task')
    setSessions((prev) => [s, ...prev]); setSession(s)
  }
  newSessionRef.current = () => { if (!isGlobalWorkspace && check?.installed) void newSession() }

  async function deleteSession(target: Session) {
    const result = await window.api.sessions.delete(target.id)
    if (!result.success) {
      addToast(`Failed to delete session: ${result.error ?? 'unknown error'}`)
      return
    }
    setSessions((prev) => prev.filter((s) => s.id !== target.id))
    setArchivedSessions((prev) => prev.filter((s) => s.id !== target.id))
    if (session?.id === target.id) { setSession(null); setMessages([]); setOutput(''); setActivity([]); setNote(''); setError(''); setLoginRequired(false) }
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
      if (session?.id === target.id) { setSession(null); setMessages([]); setOutput(''); setActivity([]); setNote(''); setError(''); setLoginRequired(false) }
    } else {
      setArchivedSessions(prev => prev.filter(x => x.id !== target.id))
      setSessions(prev => [{ ...target, archived: 0 }, ...prev])
    }
    addToast(archive ? 'Session archived' : 'Session unarchived')
  }

  const titleFrom = (text: string) => fallbackTitleFromText(text) ?? 'New task'

  async function sendPrompt(prompt: string) {
    if (!prompt.trim() || running || !check?.installed) return
    const firstTurn = !session || messages.length === 0
    let s = session
    if (!s) { s = await window.api.sessions.create(props.project.id, 'claudecode', titleFrom(prompt)); setSessions((prev) => [s!, ...prev]); setSession(s) }
    else if (firstTurn && isGenericSessionTitle(s.title)) { const title = titleFrom(prompt); setSessions((prev) => prev.map((x) => x.id === s!.id ? { ...x, title } : x)); setSession({ ...s, title }) }
    setError(''); setLoginRequired(false); setRunning(true); setOutput(''); setActivity([]); setNote('')
    setInput('')
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, session_id: s!.id, role: 'user', content: prompt, model: null, created_at: Date.now() }])
    window.api.claudeCode.send({ sessionId: s.id, projectId: props.project.id, prompt, injectMemory, model, effort, thinking })
    setInjectMemory(false)
  }

  async function handoffSend(detail: HandoffSendDetail) {
    if (isGlobalWorkspace || !check?.installed) return
    let s: Session | null = null
    if (!detail.newSession && detail.sessionId) s = sessions.find((x) => x.id === detail.sessionId) ?? null
    if (!s) {
      s = await window.api.sessions.create(props.project.id, 'claudecode', titleFrom(detail.prompt))
      setSessions((prev) => [s!, ...prev])
    }
    setSession(s)
    setError(''); setLoginRequired(false); setRunning(true); setOutput(''); setActivity([]); setNote('')
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, session_id: s!.id, role: 'user', content: detail.prompt, model: null, created_at: Date.now() }])
    window.api.claudeCode.send({ sessionId: s.id, projectId: props.project.id, prompt: detail.prompt, injectMemory: false, model, effort, thinking })
  }
  handoffRef.current = (detail) => { void handoffSend(detail) }

  async function deleteManySessions(ids: string[]) {
    const results = await Promise.all(ids.map(async (id) => ({ id, result: await window.api.sessions.delete(id) })))
    const failed = results.filter(({ result }) => !result.success)
    if (failed.length > 0) {
      addToast(`Failed to delete ${failed.length} session${failed.length === 1 ? '' : 's'}: ${failed[0].result.error ?? 'unknown error'}`)
    }
    const idSet = new Set(results.filter(({ result }) => result.success).map(({ id }) => id))
    if (idSet.size === 0) return
    setSessions((prev) => prev.filter((s) => !idSet.has(s.id)))
    setArchivedSessions((prev) => prev.filter((s) => !idSet.has(s.id)))
    if (session && idSet.has(session.id)) {
      setSession(null); setMessages([]); setOutput(''); setActivity([]); setNote(''); setError(''); setLoginRequired(false)
    }
    addToast(`${idSet.size} session${idSet.size === 1 ? '' : 's'} deleted`)
  }

  async function run() {
    if (running || !check?.installed) return
    const cmd = slashCommands.find((c) => c.name === input.trim())
    if (cmd) { executeSlash(cmd.name); return }
    if (!input.trim()) return
    if (attachments.length > 0) {
      const inlineAttachments = attachments.filter(a => a.file.type !== 'image')
      const imageAttachments = attachments.filter(a => a.file.type === 'image')
      const resolved = await resolveAttachments(inlineAttachments)
      if (resolved.error) { setError(resolved.error); return }
      const imageRefs: string[] = []
      for (const attachment of imageAttachments) {
        const sourcePath = attachment.file.filePath
        if (!sourcePath) {
          setError(`Image "${attachment.file.name}" does not have a readable file path.`)
          return
        }
        const copied = await window.api.files.copyToProject(sourcePath, props.project.path)
        if (!copied.success) {
          setError(`Failed to copy image "${attachment.file.name}" into the project: ${copied.error}`)
          addToast(`Failed to copy "${attachment.file.name}"`)
          return
        }
        imageRefs.push(`[Image file: ${copied.path}]`)
      }
      setAttachments([])
      const imageContent = imageRefs.join('\n\n')
      const prompt = imageContent ? `${resolved.content}${input}\n\n${imageContent}` : resolved.content + input
      void sendPrompt(prompt)
    } else {
      void sendPrompt(input)
    }
  }

  function stopRun() { if (session && running) window.api.claudeCode.abort(session.id) }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen && !e.ctrlKey) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (Math.min(i, slashMatches.length - 1) + 1) % slashMatches.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (Math.min(i, slashMatches.length - 1) - 1 + slashMatches.length) % slashMatches.length); return }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectSlash(slashMatches[slashIdx]); return }
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
      if (running) stopRun()
      else if (slashOpen) setSlashDismissed(true)
      else setInput('')
      return
    }
    if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      setInput('')
      setSlashIndex(0)
      setSlashDismissed(false)
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
        source: 'claudecode',
      })
      addToast('Saved to Knowledge')
      window.dispatchEvent(new CustomEvent('knowledge:pulse'))
    } catch (err) {
      addToast(`Failed to save to Knowledge: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  // Regenerate / edit-resend / reactions — shared logic lives in the hook,
  // this tab only supplies how to fetch messages and how to kick a fresh task.
  const ccResend = useCallback((content: string, regenerateMessageId: string) => {
    if (!session || running || !check?.installed) return
    setError(''); setLoginRequired(false); setRunning(true); setOutput(''); setActivity([]); setNote('')
    window.api.claudeCode.send({ sessionId: session.id, projectId: props.project.id, prompt: content, injectMemory: false, model, effort, thinking, regenerateMessageId })
  }, [session, running, check, model, effort, thinking, props.project.id])

  const fetchCcMessages = useCallback((sid: string) => window.api.claudeCode.messages(sid), [])

  const { regenerate, editAndResend, setReaction } = useMessageActions({
    sessionId: session?.id,
    messages,
    setMessages,
    busy: running,
    fetchMessages: fetchCcMessages,
    resend: ccResend,
    onError: addToast
  })

  async function rollbackToCheckpoint(checkpointId: string) {
    const result = await window.api.checkpoints.rollback(checkpointId)
    if (result.success) {
      addToast('Rolled back to checkpoint')
      if (session) {
        const content = 'Rolled back: file changes made after this checkpoint were discarded.'
        setMessages((m) => [...m, { id: `rollback-${Date.now()}`, session_id: session.id, role: 'assistant', content, model: null, created_at: Date.now() }])
      }
    } else {
      addToast(result.error || 'Rollback failed')
    }
  }

  function showHelp() {
    if (!session) return
    const content = ['Available slash commands:', ...slashCommands.map((c) => `${c.name} — ${c.desc}`)].join('\n')
    setMessages((m) => [...m, { id: `help-${Date.now()}`, session_id: session.id, role: 'assistant', content, model: null, created_at: Date.now() }])
  }

  function executeSlash(name: string) {
    setSlashDismissed(true); setSlashIndex(0); setInput('')
    if (name === '/clear') { void newSession(); return }
    if (name === '/help') { showHelp(); return }
    if (name === '/memory') { props.onOpenKnowledge(); return }
    void sendPrompt(name)
  }

  const renderMessage = (m: Message) => {
    if (m.role === 'tool') {
      let entries: CCActivityEntry[] = []
      try { entries = JSON.parse(m.content) } catch { /* */ }
      return <ActivityLog key={m.id} entries={entries} />
    }
    if (m.role === 'user') {
      const checkpoint = checkpoints[m.id]
      return (
        <EditableUserMessage
          key={m.id}
          content={m.content}
          timestamp={m.created_at}
          disabled={running}
          onSaveResend={(newContent) => void editAndResend(m.id, newContent)}
          onCopy={() => void copyOutput(m.content)}
          extraMeta={checkpoint && (
            <CheckpointBadge
              info={checkpoint}
              onRollback={() => (checkpoint.checkpointId ? rollbackToCheckpoint(checkpoint.checkpointId) : Promise.resolve())}
            />
          )}
        />
      )
    }
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

  const slashQuery = input.startsWith('/') && !input.includes(' ') ? input.slice(1).toLowerCase() : null
  const slashMatches = slashQuery !== null ? slashCommands.filter((c) => c.name.slice(1).startsWith(slashQuery)) : []
  const slashOpen = slashQuery !== null && !slashDismissed && slashMatches.length > 0
  const slashIdx = Math.min(slashIndex, Math.max(0, slashMatches.length - 1))

  function selectSlash(cmd: SlashCommand) { executeSlash(cmd.name); textareaRef.current?.focus() }
  function setVoiceInput(value: string) { setInput(value); setSlashIndex(0); setSlashDismissed(false) }

  const modelLabel = labelForModel(model)
  const contextStatus = running ? 'Running' : check?.installed ? 'Ready' : 'Checking'
  const contextMode = `Claude Code · ${effort}${thinking ? ' · thinking' : ''}`

  const ctxSession = contextMenu ? [...sessions, ...archivedSessions].find(s => s.id === contextMenu.sessionId) : null
  const visibleMessages = messages.slice(Math.max(0, messages.length - RENDER_LIMIT - renderOffset))

  // Context line + unified composer shell, shared between the empty state and
  // an active session — the empty state IS the composer, ready to type into.
  const composerBlock = (
    <>
      <AiContextBar
        testId="context-bar-claude-code"
        usedTokens={session ? estimatedTokens : undefined}
        tokensApproximate={session ? estimatedTokens !== undefined : undefined}
        model={modelLabel}
        mode={contextMode}
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
          activeModel={model}
          onRemove={id => setAttachments(prev => prev.filter(a => a.id !== id))}
          onVisionModelChange={(id, vm) => setAttachments(prev => prev.map(a => a.id === id ? { ...a, visionModel: vm } : a))}
        />
        {slashOpen && (
          <div className="slash-palette" role="listbox" aria-label="Slash commands">
            {slashMatches.map((c, i) => (
              <button key={c.name} type="button" role="option" aria-selected={i === slashIdx} className={`slash-item ${i === slashIdx ? 'active' : ''}`} onMouseEnter={() => setSlashIndex(i)} onClick={() => selectSlash(c)}>
                <span className="slash-name">{c.name}</span>
                <span className="slash-desc">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          data-composer="true"
          data-testid="claude-code-composer"
          placeholder="Describe a coding task…  (Enter to run · Shift+Enter for newline · / for commands)"
          value={input}
          onChange={(e) => { setInput(e.target.value); setSlashIndex(0); setSlashDismissed(false) }}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-bar">
          <div className="composer-bar-left">
            <button className="composer-icon-btn" onClick={() => void pickFile()} title="Attach file" aria-label="Attach file" disabled={running}>＋</button>
            <div className="mode-pill-toggle" role="group" aria-label="Effort" data-testid="claude-code-effort-pill">
              {EFFORTS.map((ef) => (
                <button key={ef} className={effort === ef ? 'active' : ''} onClick={() => setEffort(ef)} disabled={running} title={`Effort: ${ef}${ef === 'normal' ? ' (default turn budget)' : ''}`} style={{ textTransform: 'capitalize' }}>{ef}</button>
              ))}
            </div>
            <button className={`composer-text-toggle ${thinking ? 'on' : ''}`} onClick={() => setThinking((v) => !v)} disabled={running} title="Enable extended thinking for the next task">✦ Thinking{thinking ? ' on' : ''}</button>
          </div>
          <div className="composer-bar-right">
            {running && tokPerSec > 0 && (
              <div className="token-flow-wrap">
                <div className="token-flow-bar">
                  <AnimatedScaleBar className="token-flow-fill" value={Math.min(1, tokPerSec / 30)} />
                </div>
                <span className="token-flow-label">{Math.round(tokPerSec)} tok/s</span>
              </div>
            )}
            <div className="model-select model-picker-plain" title="Model passed to Claude Code (--model)">
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running}>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <span className="model-select-chevron">⌄</span>
            </div>
            <VoiceInputButton testId="voice-input-claude-code" value={input} onChange={setVoiceInput} disabled={running} label="Voice input for Claude Code" />
            {running
              ? <button ref={sendButtonMotion.ref} {...sendButtonMotion.pressHandlers} className="composer-send-btn stop" onClick={stopRun} title="Stop Claude Code">Stop</button>
              : <button ref={sendButtonMotion.ref} {...sendButtonMotion.pressHandlers} className="composer-send-btn" data-testid="claude-code-send" disabled={!check?.installed} onClick={() => void run()}>Run</button>}
          </div>
        </div>
      </div>
    </>
  )

  if (isGlobalWorkspace) return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
      <div className="chat-layout">
        <aside className="session-list">
          <div className="session-list-header">
            <button className="session-new-btn" disabled title="Claude Code needs a project folder">
              <span className="session-new-icon">＋</span> New task
            </button>
          </div>
          <div className="session-list-extra">
            <button className="instructions-md-btn exists" onClick={() => setInstructionsOpen({ agentId: 'app', agentLabel: 'App' })} title="Edit App CLAUDE.md">
              📋 App CLAUDE.md
            </button>
          </div>
        </aside>
        <section className="chat-main">
          <AiContextBar testId="context-bar-claude-code" model={labelForModel(DEFAULT_MODEL)} mode="Claude Code" status="Project required" disabledReason="Open a project folder" />
          <div className="empty center cc-setup" data-testid="claude-global-unavailable">
            <h2>Claude Code needs a project folder.</h2>
            <p className="muted">Claude Code needs a project folder. Open a project workspace to use it.</p>
            <VoiceInputButton testId="voice-input-claude-code" value="" onChange={() => undefined} disabled label="Voice input for Claude Code" />
          </div>
        </section>
      </div>
      {instructionsOpen && (
        <InstructionsEditor agentId={instructionsOpen.agentId} agentLabel={instructionsOpen.agentLabel} projectPath={props.project.path ?? null} onClose={() => setInstructionsOpen(null)} />
      )}
    </div>
  )

  if (check && !check.installed) {
    return (
      <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
        <div className="chat-layout">
          <aside className="session-list">
            <div className="session-list-header">
              <button className="session-new-btn" disabled title="Claude Code is unavailable">
                <span className="session-new-icon">＋</span> New task
              </button>
            </div>
            <div className="session-list-extra">
              <button className="instructions-md-btn exists" onClick={() => setInstructionsOpen({ agentId: 'app', agentLabel: 'App' })} title="Edit App CLAUDE.md">
                📋 App CLAUDE.md
              </button>
            </div>
          </aside>
          <section className="chat-main"><SetupNotice check={check} onRecheck={recheck} /></section>
        </div>
        {instructionsOpen && (
          <InstructionsEditor agentId={instructionsOpen.agentId} agentLabel={instructionsOpen.agentLabel} projectPath={props.project.path ?? null} onClose={() => setInstructionsOpen(null)} />
        )}
      </div>
    )
  }

  const instructionHeaderSlot = (
    <>
      <button
        className={`instructions-md-btn${agentMdExists ? ' exists' : ''}`}
        onClick={() => setInstructionsOpen({ agentId: 'claudecode', agentLabel: 'Claude Code' })}
        title="Edit CLAUDE.md"
      >
        📋 CLAUDE.md{!agentMdExists ? ' (create)' : ''}
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
        newTitle="Start a new Claude Code task"
        emptyLabel="No Claude Code tasks yet"
        headerSlot={instructionHeaderSlot}
        onNew={newSession}
        onSelect={selectSession}
        onOptions={openContextMenu}
        onRenameChange={(value) => renaming && setRenaming({ ...renaming, value })}
        onRenameCommit={(s) => void commitRename(s)}
        onRenameCancel={() => setRenaming(null)}
        onDeleteMany={deleteManySessions}
      />

      <section className="chat-main">
        {!session ? (
          <div className="empty-hero">
            <h2 className="empty-state-heading">
              <span className="empty-state-icon" style={{ color: 'var(--accent-claudecode)' }} aria-hidden>
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 17l6-5-6-5" /><path d="M12 19h8" />
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
              <button className={`ghost inject-btn ${injectMemory ? 'on' : ''}`} onClick={() => setInjectMemory((v) => !v)} title="Prepend get_project_context() (decisions, preferences, recent knowledge) to the next task">
                {injectMemory ? '✓ Memory will be injected' : '✦ Inject memory'}
              </button>
            </header>
            <AgentStatusStrip
              agent="Claude Code"
              status={running ? (ccStatusPhrase ?? 'Running') : check?.installed ? 'Ready' : 'Setup'}
              tone={running ? 'info' : check?.installed ? 'success' : 'warning'}
              running={running}
              detail={`${modelLabel} · ${effort}${thinking ? ' · thinking' : ''}`}
            />

            <div className="chat-scroll" ref={scrollRef}>
              {messages.length > RENDER_LIMIT + renderOffset && (
                <button className="ghost load-older-btn" onClick={() => setRenderOffset((o) => o + RENDER_LIMIT)}>
                  Load older messages
                </button>
              )}
              {visibleMessages.map(renderMessage)}
              {running && (
                <div className="cc-live">
                  {note && <div className="cc-note muted small">{note}</div>}
                  <ActivityLog entries={activity} live />
                  {output ? (
                    <div className="msg assistant"><div className="msg-body md-body"><Markdown>{output}</Markdown><span className="cursor">▋</span></div></div>
                  ) : (
                    activity.length === 0 && <div className="cc-note muted small">{ccStatusPhrase ?? 'Working…'}<span className="cursor">▋</span></div>
                  )}
                </div>
              )}
              {loginRequired && !running && <SetupNotice check={check ?? { installed: true }} onRecheck={recheck} />}
            </div>

            {error && <AgentErrorNotice title="Claude Code could not run">{error}</AgentErrorNotice>}

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
