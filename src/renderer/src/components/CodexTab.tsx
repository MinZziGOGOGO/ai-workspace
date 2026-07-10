import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, Session, Message, CodexCheck, CodexActivityEntry, CodexEvent, CodexSandboxMode } from '../types'
import { AttachmentChips, resolveAttachments } from './ComposerAttachments'
import { useComposerAttachments } from '../hooks/useComposerAttachments'
import Markdown from './Markdown'
import RelativeTime from './RelativeTime'
import AiContextBar, { estimateTokensFromText } from './AiContextBar'
import { useToast } from './ToastContext'
import { useAgentActivity } from '../AgentActivityContext'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { fallbackTitleFromText, isGenericSessionTitle } from '../../../shared/sessionTitles'
import { AgentErrorNotice, AgentSessionRail, AgentStatusStrip, EditableUserMessage, OutputActions, SessionContextMenu, useAutoSessionSummary, useConfirmDestructive, useStatusPhrase } from './AgentPanelPrimitives'
import InstructionsEditor from './InstructionsEditor'
import anime, { animateScrollToBottom, prefersReducedMotion, stopMotion, usePressMotion, type MotionHandle } from '../motion'
import { setAgentAvailable, setAgentPanelOpen, setAgentSession, clearAgentCurrent, type HandoffSendDetail } from '../handoff'
import { isLastAssistantMessage, useMessageActions } from '../messageActions'
import { useCompletionNotifier } from '../notify'

const CODEX_MODEL = 'Codex CLI'

const CODEX_EMPTY_HEADINGS = [
  'What are we building?',
  'Ready when you are.',
  'Describe a task for Codex.',
]
const RENDER_LIMIT = 50
const PINNED_KEY = 'aiworkspace.codex.pinned'
function loadPinned(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')) } catch { return new Set() }
}
function savePinned(s: Set<string>) { localStorage.setItem(PINNED_KEY, JSON.stringify([...s])) }

const KNOWN_MODELS = ['gpt-5.5', 'o3', 'o4-mini', 'o3-mini']
const CUSTOM_MODELS_KEY = 'aiworkspace.codex.customModels'
const CUSTOM_MODEL_SENTINEL = '__custom__'
function loadCustomModels(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(CUSTOM_MODELS_KEY) ?? '[]')
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
  } catch { return [] }
}
function saveCustomModels(list: string[]) {
  localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(list.slice(0, 5)))
}
function rememberCustomModel(value: string, prev: string[]): string[] {
  const next = [value, ...prev.filter((m) => m !== value)].slice(0, 5)
  saveCustomModels(next)
  return next
}

const SANDBOX_META: Record<CodexSandboxMode, { label: string; icon: string; tone: 'neutral' | 'warning' | 'error' }> = {
  'read-only': { label: 'Read-only', icon: '◎', tone: 'neutral' },
  'workspace-write': { label: 'Workspace write', icon: '✎', tone: 'warning' },
  'danger-full-access': { label: 'Full access', icon: '⚠', tone: 'error' },
}

function ToolCard(props: { entry: CodexActivityEntry; live?: boolean }) {
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
      {hasBody && open && <div className="activity-detail"><pre className="tool-output">{body}</pre></div>}
    </div>
  )
}

function ActivityLog(props: { entries: CodexActivityEntry[]; live?: boolean }) {
  if (props.entries.length === 0) return null
  return (
    <div className="tool-activity motion-list motion-list-tight">
      {props.entries.map((e, i) => <ToolCard key={i} entry={e} live={props.live && e.ok === undefined} />)}
    </div>
  )
}

function SetupNotice(props: { check: CodexCheck; onRecheck: () => void }) {
  return (
    <div className="empty center cc-setup" data-testid="codex-setup">
      <h2>{props.check.installed ? 'Codex needs setup' : "Codex isn't installed"}</h2>
      <p className="muted">This tab drives the Codex CLI headlessly under your ChatGPT subscription login — it never uses API billing.</p>
      <ol className="cc-setup-steps">
        {!props.check.installed && <li>Install the CLI: <code>npm install -g @openai/codex</code>.</li>}
        <li>Sign in once: run <code>codex login</code> in a terminal and authenticate with your ChatGPT subscription (not an API key).</li>
        <li>Come back and click Re-check.</li>
      </ol>
      {props.check.error && <p className="muted small cc-setup-err" data-testid="codex-setup-error">{props.check.error}</p>}
      <button className="primary" data-testid="codex-recheck" onClick={props.onRecheck}>Re-check</button>
    </div>
  )
}

interface CtxMenu { sessionId: string; x: number; y: number }

export default function CodexTab(props: { project: Project; active?: boolean }) {
  const { addToast } = useToast()
  const { setActive: setAgentActive } = useAgentActivity()
  const [check, setCheck] = useState<CodexCheck | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState('')
  const [activity, setActivity] = useState<CodexActivityEntry[]>([])
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [sandbox, setSandbox] = useState<CodexSandboxMode>('read-only')
  const [skipGitRepoCheck, setSkipGitRepoCheck] = useState(false)
  const [model, setModel] = useState<string>(() => {
    try { return localStorage.getItem('codex-preferred-model') ?? 'gpt-5.5' } catch { return 'gpt-5.5' }
  })
  const [customModels, setCustomModels] = useState<string[]>(() => loadCustomModels())
  const [customEditing, setCustomEditing] = useState(false)
  const [customDraft, setCustomDraft] = useState('')
  const [dangerConfirmOpen, setDangerConfirmOpen] = useState(false)
  const [usageTokens, setUsageTokens] = useState<number | undefined>(undefined)
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
  const [emptyHeading] = useState(() => CODEX_EMPTY_HEADINGS[Math.floor(Math.random() * CODEX_EMPTY_HEADINGS.length)])

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const scrollAnimRef = useRef<MotionHandle>(null)
  const sessionSwitchAnimRef = useRef<MotionHandle>(null)
  const sessionRef = useRef<Session | null>(null)
  const newSessionRef = useRef<() => void>(() => {})
  const handoffRef = useRef<(detail: HandoffSendDetail) => void>(() => {})
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendButtonMotion = usePressMotion<HTMLButtonElement>()
  const lastPromptRef = useRef('')
  const isGlobalWorkspace = isGlobalProjectId(props.project.id)
  const active = props.active ?? true
  const estimatedTokens = useMemo(
    () => estimateTokensFromText([...messages.map((m) => m.content), output, input].filter(Boolean).join('\n')),
    [messages, output, input]
  )
  const notifyCompletion = useCompletionNotifier(active)
  const lastCodexActivity = activity[activity.length - 1]
  const codexStatusPhrase = useStatusPhrase({
    active: running,
    hasStarted: output.length > 0 || activity.length > 0,
    toolName: !output && lastCodexActivity ? lastCodexActivity.name : null,
    progressKey: `${output.length}:${activity.length}`
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
    setAgentActive('codex', running)
    return () => setAgentActive('codex', false)
  }, [running, setAgentActive])

  useEffect(() => { if (active) window.api.models.list().then(setOllamaModels) }, [active])

  useAutoSessionSummary(session, messages, ollamaModels[0], (sessionId, summary) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, summary } : s)))
    setSession((prev) => (prev && prev.id === sessionId ? { ...prev, summary } : prev))
  })

  useEffect(() => {
    function onFocusComposer(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'codex') textareaRef.current?.focus()
    }
    function onNewSession(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      // Call through the ref so the guard sees the current check/workspace
      // state instead of the values captured at listener registration.
      if (panel === 'codex') newSessionRef.current()
    }
    function onPrefillPrompt(event: Event) {
      const detail = (event as CustomEvent<{ panel?: string; prompt?: string }>).detail
      if (detail?.panel === 'codex' && typeof detail.prompt === 'string') {
        setInput(detail.prompt)
        textareaRef.current?.focus()
      }
    }
    function onSelectSession(event: Event) {
      const detail = (event as CustomEvent<{ panel?: string; session?: Session }>).detail
      if (detail?.panel === 'codex' && detail.session) selectSession(detail.session)
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
    window.api.instructions.getPath('codex', p).then(fp => {
      if (fp) window.api.instructions.read(fp).then(r => setAgentMdExists(r.exists))
    })
    window.api.instructions.getPath('shared', p).then(fp => {
      if (fp) window.api.instructions.read(fp).then(r => setSharedMdExists(r.exists))
    })
  }, [props.project.path, isGlobalWorkspace, instructionsOpen])

  const recheck = () => window.api.codex.check().then(setCheck)

  useEffect(() => { if (!isGlobalWorkspace && active) recheck() }, [isGlobalWorkspace, active])
  useEffect(() => {
    if (isGlobalWorkspace || !active) { setSessions([]); setArchivedSessions([]); return }
    window.api.sessions.list(props.project.id, 'codex').then(setSessions)
    window.api.sessions.listArchived(props.project.id, 'codex').then(setArchivedSessions)
  }, [props.project.id, isGlobalWorkspace, active])

  useEffect(() => {
    if (session) window.api.codex.messages(session.id).then(setMessages)
    else setMessages([])
    setOutput(''); setActivity([]); setNote(''); setError(''); setUsageTokens(undefined)
    setRenderOffset(0)
  }, [session])

  // Publish live state to the Chat→agent handoff bus.
  useEffect(() => { setAgentPanelOpen('codex', active) }, [active])
  useEffect(() => { setAgentAvailable('codex', !isGlobalWorkspace && !!check?.installed) }, [check, isGlobalWorkspace])
  useEffect(() => {
    if (session) setAgentSession('codex', session.id, session.title)
    else clearAgentCurrent('codex')
  }, [session])

  // Receive a handoff sent programmatically from the Chat tab.
  useEffect(() => {
    function onHandoff(event: Event) {
      const detail = (event as CustomEvent<HandoffSendDetail>).detail
      if (detail?.panel !== 'codex') return
      void handoffRef.current(detail)
    }
    window.addEventListener('panel:handoffSend', onHandoff)
    return () => window.removeEventListener('panel:handoffSend', onHandoff)
  }, [])

  useEffect(() => {
    const offEvent = window.api.codex.onEvent((d) => {
      if (d.sessionId !== session?.id) return
      const e: CodexEvent = d.event
      if (e.kind === 'text') setOutput((o) => o + (o ? '\n' : '') + e.text)
      else if (e.kind === 'tool') setActivity((a) => [...a, { name: e.name, summary: e.summary, ok: true }])
      else if (e.kind === 'system') setNote(e.summary)
      else if (e.kind === 'usage') setUsageTokens(e.used)
      else if (e.kind === 'error') setError(e.message)
    })
    const offDone = window.api.codex.onDone(async (d) => {
      if (d.sessionId !== session?.id) return
      setRunning(false)
      if (d.trustRequired) {
        setError('Codex refused to run because this folder is not trusted or is not a Git repository. Enable “Allow Codex in this folder” below and resend.')
        setInput(lastPromptRef.current)
      } else if (d.loginRequired) {
        setError('Codex is installed but not logged in. Run `codex login` in a terminal, then resend.')
      }
      setMessages(await window.api.codex.messages(d.sessionId))
      setOutput(''); setActivity([]); setNote('')
      notifyCompletion()
    })
    return () => { offEvent(); offDone() }
  }, [session])

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
    const s = await window.api.sessions.create(props.project.id, 'codex', 'New task')
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
    if (session?.id === target.id) { setSession(null); setMessages([]); setOutput(''); setActivity([]); setNote(''); setError('') }
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
      if (session?.id === target.id) { setSession(null); setMessages([]); setOutput(''); setActivity([]); setNote(''); setError('') }
    } else {
      setArchivedSessions(prev => prev.filter(x => x.id !== target.id))
      setSessions(prev => [{ ...target, archived: 0 }, ...prev])
    }
    addToast(archive ? 'Session archived' : 'Session unarchived')
  }

  const titleFrom = (text: string) => fallbackTitleFromText(text) ?? 'New task'

  async function sendPrompt(prompt: string, imagePaths?: string[]) {
    if (!prompt.trim() || running || !check?.installed) return
    const firstTurn = !session || messages.length === 0
    let s = session
    if (!s) { s = await window.api.sessions.create(props.project.id, 'codex', titleFrom(prompt)); setSessions((prev) => [s!, ...prev]); setSession(s) }
    else if (firstTurn && isGenericSessionTitle(s.title)) { const title = titleFrom(prompt); setSessions((prev) => prev.map((x) => x.id === s!.id ? { ...x, title } : x)); setSession({ ...s, title }) }
    lastPromptRef.current = prompt
    setError(''); setRunning(true); setOutput(''); setActivity([]); setNote('')
    setInput('')
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, session_id: s!.id, role: 'user', content: prompt, model: null, created_at: Date.now() }])
    window.api.codex.send({ sessionId: s.id, projectId: props.project.id, prompt, sandbox, skipGitRepoCheck, model, imagePaths: imagePaths?.length ? imagePaths : undefined })
  }

  async function handoffSend(detail: HandoffSendDetail) {
    if (isGlobalWorkspace || !check?.installed) return
    let s: Session | null = null
    if (!detail.newSession && detail.sessionId) s = sessions.find((x) => x.id === detail.sessionId) ?? null
    if (!s) {
      s = await window.api.sessions.create(props.project.id, 'codex', titleFrom(detail.prompt))
      setSessions((prev) => [s!, ...prev])
    }
    setSession(s)
    lastPromptRef.current = detail.prompt
    setError(''); setRunning(true); setOutput(''); setActivity([]); setNote('')
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, session_id: s!.id, role: 'user', content: detail.prompt, model: null, created_at: Date.now() }])
    window.api.codex.send({ sessionId: s.id, projectId: props.project.id, prompt: detail.prompt, sandbox, skipGitRepoCheck, model })
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
      setSession(null); setMessages([]); setOutput(''); setActivity([]); setNote(''); setError('')
    }
    addToast(`${idSet.size} session${idSet.size === 1 ? '' : 's'} deleted`)
  }

  async function run() {
    if (running || !check?.installed) return
    if (!input.trim()) return
    if (attachments.length > 0) {
      const inlineAttachments = attachments.filter(a => a.file.type !== 'image')
      const imageAttachments = attachments.filter(a => a.file.type === 'image')
      const resolved = await resolveAttachments(inlineAttachments)
      if (resolved.error) { setError(resolved.error); return }
      const imagePaths: string[] = []
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
        imagePaths.push(copied.path)
      }
      setAttachments([])
      void sendPrompt(resolved.content + input, imagePaths)
    } else {
      void sendPrompt(input)
    }
  }

  function stopRun() { if (session && running) window.api.codex.abort(session.id) }

  function selectModel(value: string) {
    if (value === CUSTOM_MODEL_SENTINEL) {
      setCustomDraft('')
      setCustomEditing(true)
      return
    }
    setModel(value)
    try { localStorage.setItem('codex-preferred-model', value) } catch { /* ignore */ }
  }

  function commitCustomModel() {
    const value = customDraft.trim()
    setCustomEditing(false)
    if (!value) return
    setModel(value)
    try { localStorage.setItem('codex-preferred-model', value) } catch { /* ignore */ }
    setCustomModels((prev) => rememberCustomModel(value, prev))
  }

  function selectSandbox(value: CodexSandboxMode) {
    if (value === 'danger-full-access' && sandbox !== 'danger-full-access') {
      setDangerConfirmOpen(true)
      return
    }
    setSandbox(value)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
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
      else setInput('')
      return
    }
    if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      setInput('')
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
        source: 'codex',
      })
      addToast('Saved to Knowledge')
      window.dispatchEvent(new CustomEvent('knowledge:pulse'))
    } catch (err) {
      addToast(`Failed to save to Knowledge: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  // Regenerate / edit-resend / reactions — shared logic lives in the hook,
  // this tab only supplies how to fetch messages and how to kick a fresh run.
  const codexResend = useCallback((content: string, regenerateMessageId: string) => {
    if (!session || running || !check?.installed) return
    lastPromptRef.current = content
    setError(''); setRunning(true); setOutput(''); setActivity([]); setNote('')
    window.api.codex.send({ sessionId: session.id, projectId: props.project.id, prompt: content, sandbox, skipGitRepoCheck, model, regenerateMessageId })
  }, [session, running, check, sandbox, skipGitRepoCheck, model, props.project.id])

  const fetchCodexMessages = useCallback((sid: string) => window.api.codex.messages(sid), [])

  const { regenerate, editAndResend, setReaction } = useMessageActions({
    sessionId: session?.id,
    messages,
    setMessages,
    busy: running,
    fetchMessages: fetchCodexMessages,
    resend: codexResend,
    onError: addToast
  })

  const renderMessage = (m: Message) => {
    if (m.role === 'tool') {
      let entries: CodexActivityEntry[] = []
      try { entries = JSON.parse(m.content) } catch { /* */ }
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
  const contextStatus = running ? 'Running' : check?.installed ? 'Ready' : 'Checking'

  const modelOptions = [...KNOWN_MODELS, ...customModels.filter((m) => !KNOWN_MODELS.includes(m))]
  const modelSelectValue = modelOptions.includes(model) ? model : CUSTOM_MODEL_SENTINEL

  // Context line + unified composer shell, shared between the empty state and
  // an active session — the empty state IS the composer, ready to type into.
  const composerBlock = (
    <>
      <AiContextBar
        testId="context-bar-codex"
        usedTokens={session ? (usageTokens ?? estimatedTokens) : undefined}
        tokensApproximate={session ? usageTokens == null : undefined}
        model={model}
        mode={`Codex · ${SANDBOX_META[sandbox].label}`}
        status="subscription login"
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
        <textarea
          ref={textareaRef}
          data-composer="true"
          data-testid="codex-composer"
          placeholder="Describe a coding task…  (Enter to run · Shift+Enter for newline)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-bar">
          <div className="composer-bar-left">
            <button className="composer-icon-btn" onClick={() => void pickFile()} title="Attach file" aria-label="Attach file" disabled={running}>＋</button>
            <div className="mode-pill-toggle" role="group" aria-label="Codex sandbox mode" data-testid="codex-sandbox" title="Codex sandbox (-s)">
              {(Object.keys(SANDBOX_META) as CodexSandboxMode[]).map((m) => (
                <button
                  key={m}
                  className={sandbox === m ? 'active' : ''}
                  data-testid={`codex-sandbox-${m}`}
                  disabled={running}
                  onClick={() => selectSandbox(m)}
                  title={`Codex sandbox: ${SANDBOX_META[m].label}`}
                >{SANDBOX_META[m].label}</button>
              ))}
            </div>
            <label className={`codex-trust-chip ${skipGitRepoCheck ? 'on' : ''}`} title="Only enable for folders you trust — Codex may read and modify files in this project.">
              <input data-testid="codex-allow-untrusted" type="checkbox" checked={skipGitRepoCheck} disabled={running} onChange={(e) => setSkipGitRepoCheck(e.target.checked)} />
              <span>Allow untrusted</span>
            </label>
          </div>
          <div className="composer-bar-right">
            {customEditing ? (
              <div className="model-select codex-custom-model" title="Custom Codex model (-m)">
                <input
                  data-testid="codex-model-custom-input"
                  autoFocus
                  placeholder="Custom model string…"
                  value={customDraft}
                  disabled={running}
                  onChange={(e) => setCustomDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitCustomModel() }
                    if (e.key === 'Escape') { e.preventDefault(); setCustomEditing(false) }
                  }}
                  onBlur={commitCustomModel}
                />
              </div>
            ) : (
              <div className="model-select model-picker-plain" title="Codex model (-m)">
                <select data-testid="codex-model" value={modelSelectValue} disabled={running} onChange={(e) => selectModel(e.target.value)}>
                  {KNOWN_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                  {customModels.filter((m) => !KNOWN_MODELS.includes(m)).length > 0 && (
                    <optgroup label="Recently used">
                      {customModels.filter((m) => !KNOWN_MODELS.includes(m)).map((m) => <option key={m} value={m}>{m}</option>)}
                    </optgroup>
                  )}
                  <option value={CUSTOM_MODEL_SENTINEL}>Custom…</option>
                </select>
                <span className="model-select-chevron">⌄</span>
              </div>
            )}
            {running
              ? <button ref={sendButtonMotion.ref} {...sendButtonMotion.pressHandlers} className="composer-send-btn stop" onClick={stopRun} title="Stop Codex">Stop</button>
              : <button ref={sendButtonMotion.ref} {...sendButtonMotion.pressHandlers} className="composer-send-btn" data-testid="codex-send" disabled={!input.trim()} onClick={() => void run()}>Run</button>}
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
            <button className="session-new-btn" disabled title="Codex needs a project folder">
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
          <AiContextBar testId="context-bar-codex" model={CODEX_MODEL} mode="Codex" status="Project required" disabledReason="Open a project folder" />
          <div className="empty center cc-setup" data-testid="codex-project-required">
            <h2>Open a project to use Codex.</h2>
            <p className="muted">Codex runs against a selected project folder. Open a project workspace to use it — Global Workspace has no folder for it to work in.</p>
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
              <button className="session-new-btn" disabled title="Codex is unavailable">
                <span className="session-new-icon">＋</span> New task
              </button>
            </div>
            <div className="session-list-extra">
              <button
                className={`instructions-md-btn${agentMdExists ? ' exists' : ''}`}
                onClick={() => setInstructionsOpen({ agentId: 'codex', agentLabel: 'Codex' })}
                title="Edit CODEX.md"
              >
                📋 CODEX.md{!agentMdExists ? ' (create)' : ''}
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

  const codexHeaderSlot = (
    <>
      <button
        className={`instructions-md-btn${agentMdExists ? ' exists' : ''}`}
        onClick={() => setInstructionsOpen({ agentId: 'codex', agentLabel: 'Codex' })}
        title="Edit CODEX.md"
      >
        📋 CODEX.md{!agentMdExists ? ' (create)' : ''}
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
        newTitle="Start a new Codex task"
        emptyLabel="No Codex tasks yet"
        headerSlot={codexHeaderSlot}
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
              <span className="empty-state-icon" style={{ color: 'var(--accent-codex)' }} aria-hidden>
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 9l-4 3 4 3" /><path d="M16 9l4 3-4 3" /><path d="M13 7l-2 10" />
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
            </header>
            <AgentStatusStrip
              agent="Codex"
              status={running ? (codexStatusPhrase ?? 'Running') : 'Ready'}
              tone={running ? 'info' : 'success'}
              running={running}
              detail={`${model} · ${sandbox}${skipGitRepoCheck ? ' · untrusted allowed' : ''}`}
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
                    activity.length === 0 && <div className="cc-note muted small">{codexStatusPhrase ?? 'Working…'}<span className="cursor">▋</span></div>
                  )}
                </div>
              )}
            </div>

            {error && <AgentErrorNotice title="Codex could not run" testId="codex-error">{error}</AgentErrorNotice>}

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
      {dangerConfirmOpen && (
        <div className="codex-confirm-overlay" onPointerDown={() => setDangerConfirmOpen(false)}>
          <div className="codex-confirm-dialog" role="alertdialog" aria-label="Confirm full access sandbox" onPointerDown={(e) => e.stopPropagation()}>
            <h3>⚠ Enable full access?</h3>
            <p className="muted">This allows Codex to modify files outside the project folder and run any command. Continue?</p>
            <div className="codex-confirm-actions">
              <button className="ghost" data-testid="codex-danger-cancel" onClick={() => setDangerConfirmOpen(false)}>Cancel</button>
              <button className="danger" data-testid="codex-danger-enable" onClick={() => { setSandbox('danger-full-access'); setDangerConfirmOpen(false) }}>Enable</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
