import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import type { Project, Session, Message, CCActivityEntry, CCEvent, ComposerAttachment } from '../types'
import { AttachmentChips, resolveAttachments } from './ComposerAttachments'
import Markdown from './Markdown'
import RelativeTime from './RelativeTime'
import AiContextBar, { estimateTokensFromText } from './AiContextBar'
import VoiceInputButton from './VoiceInputButton'
import { useToast } from './ToastContext'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { fallbackTitleFromText, isGenericSessionTitle } from '../../../shared/sessionTitles'
import { AgentErrorNotice, AgentSessionRail, AgentStatusStrip, OutputActions } from './AgentPanelPrimitives'
import InstructionsEditor from './InstructionsEditor'

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
const PINNED_KEY = 'aiworkspace.claudecode.pinned'
function loadPinned(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')) } catch { return new Set() }
}
function savePinned(s: Set<string>) { localStorage.setItem(PINNED_KEY, JSON.stringify([...s])) }

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

function looksLikeDiff(text: string): boolean { return /\n/.test(text) && /^[+\-@]/m.test(text) }

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
  const icon = status === 'error' ? '✕' : status === 'done' ? '✓' : status === 'running' ? '◌' : '•'
  return (
    <div className={`tool-card status-${status}`}>
      <button className="tool-card-head" onClick={() => hasBody && setOpen((o) => !o)} disabled={!hasBody} aria-expanded={hasBody ? open : undefined} title={hasBody ? (open ? 'Collapse' : 'Expand') : detail}>
        <span className={`tool-card-status ${status === 'running' ? 'pending' : ''}`}>{icon}</span>
        <span className="tool-card-name">{entry.name}</span>
        <span className="tool-card-detail">{detail}</span>
        {hasBody && <span className="tool-card-chevron">{open ? '▾' : '▸'}</span>}
      </button>
      {hasBody && open && <div className="tool-card-body">{looksLikeDiff(body) ? <DiffView text={body} /> : <pre className="tool-output">{body}</pre>}</div>}
    </div>
  )
}

function ActivityLog(props: { entries: CCActivityEntry[]; live?: boolean }) {
  if (props.entries.length === 0) return null
  return (
    <div className="tool-activity">
      <div className="activity-head">Activity</div>
      <div className="tool-card-list">
        {props.entries.map((e, i) => <ToolCard key={i} entry={e} live={props.live && e.ok === undefined} />)}
      </div>
    </div>
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

function ProjectRequiredNotice() {
  return (
    <div className="chat-layout">
      <aside className="session-list">
        <div className="session-list-header">
          <button className="session-new-btn" disabled title="Claude Code needs a project folder">
            <span className="session-new-icon">＋</span> New task
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
  )
}

interface CtxMenu { sessionId: string; x: number; y: number }

export default function ClaudeCodeTab(props: { project: Project; onOpenKnowledge: () => void; active?: boolean }) {
  const { addToast } = useToast()
  const [check, setCheck] = useState<Check | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
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
  const [tokPerSec, setTokPerSec] = useState(0)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [instructionsOpen, setInstructionsOpen] = useState<{ agentId: string; agentLabel: string } | null>(null)
  const [agentMdExists, setAgentMdExists] = useState(false)
  const [sharedMdExists, setSharedMdExists] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const tokenTimestamps = useRef<number[]>([])
  const isGlobalWorkspace = isGlobalProjectId(props.project.id)
  const active = props.active ?? true
  const contextText = [...messages.map((m) => m.content), output, input].filter(Boolean).join('\n')
  const estimatedTokens = estimateTokensFromText(contextText)

  async function loadSlashCommands() {
    try {
      const raw = await (window.api.claudeCode as any).commands?.()
      if (typeof raw === 'string' && raw.length > 0) { const parsed = parseHelpOutput(raw); if (parsed) { setSlashCommands(mergeWithLocalCommands(parsed)); return } }
      if (Array.isArray(raw) && raw.length >= 5) setSlashCommands(mergeWithLocalCommands(raw as SlashCommand[]))
    } catch { /* use fallback */ }
  }

  useEffect(() => { window.api.models.list().then(setOllamaModels) }, [])

  useEffect(() => {
    function onFocusComposer(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'claudecode') textareaRef.current?.focus()
    }
    function onNewSession(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'claudecode' && !isGlobalWorkspace && check?.installed) void newSession()
    }
    window.addEventListener('panel:focusComposer', onFocusComposer)
    window.addEventListener('panel:newSession', onNewSession)
    return () => {
      window.removeEventListener('panel:focusComposer', onFocusComposer)
      window.removeEventListener('panel:newSession', onNewSession)
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
  useEffect(() => { if (isGlobalWorkspace || !active) { setSessions([]); return } window.api.sessions.list(props.project.id, 'claudecode').then(setSessions) }, [props.project.id, isGlobalWorkspace, active])

  useEffect(() => {
    if (session) window.api.claudeCode.messages(session.id).then(setMessages)
    else setMessages([])
    setOutput(''); setActivity([]); setNote(''); setError('')
    tokenTimestamps.current = []; setTokPerSec(0)
  }, [session])

  useEffect(() => {
    const offEvent = window.api.claudeCode.onEvent((d) => {
      if (d.sessionId !== session?.id) return
      const e: CCEvent = d.event
      if (e.kind === 'text') { setOutput((o) => o + e.text); tokenTimestamps.current.push(Date.now()) }
      else if (e.kind === 'tool') setActivity((a) => [...a, { name: e.name, summary: e.summary }])
      else if (e.kind === 'tool-result') setActivity((a) => markLastPending(a, e.ok))
      else if (e.kind === 'system') setNote(e.summary)
      else if (e.kind === 'error') setError(e.message)
    })
    const offDone = window.api.claudeCode.onDone(async (d) => {
      if (d.sessionId !== session?.id) return
      setRunning(false); setLoginRequired(d.loginRequired ?? false)
      setMessages(await window.api.claudeCode.messages(d.sessionId))
      setOutput(''); setActivity([]); setNote('')
      tokenTimestamps.current = []; setTokPerSec(0)
    })
    return () => { offEvent(); offDone() }
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
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: running ? 'auto' : 'smooth' })
    }, running ? 100 : 0)
  }, [messages, output, activity, running])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    function handleDown() { setContextMenu(null) }
    document.addEventListener('pointerdown', handleDown, true)
    return () => document.removeEventListener('pointerdown', handleDown, true)
  }, [contextMenu])

  async function newSession() {
    const s = await window.api.sessions.create(props.project.id, 'claudecode', 'New task')
    setSessions((prev) => [s, ...prev]); setSession(s)
  }

  async function deleteSession(target: Session) {
    await window.api.sessions.delete(target.id)
    setSessions((prev) => prev.filter((s) => s.id !== target.id))
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
    await window.api.sessions.rename(s.id, title)
    setSessions(prev => prev.map(x => x.id === s.id ? { ...x, title } : x))
    if (session?.id === s.id) setSession(prev => prev ? { ...prev, title } : prev)
  }

  function togglePin(sessionId: string) {
    setContextMenu(null)
    setPinnedIds(prev => { const next = new Set(prev); if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId); savePinned(next); return next })
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

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData('text/plain')
    if (text.length > 1500) {
      e.preventDefault()
      const att: ComposerAttachment = {
        id: crypto.randomUUID(),
        file: { type: 'text', name: 'Pasted text', size: text.length, content: text, ext: '.txt' }
      }
      setAttachments(prev => [...prev, att])
    }
  }

  async function pickFile() {
    try {
      const path = await window.api.files.pick()
      if (!path) return
      const file = await window.api.files.read(path)
      const att: ComposerAttachment = { id: crypto.randomUUID(), file }
      setAttachments(prev => [...prev, att])
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to read file')
    }
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
        try {
          const destPath = await window.api.files.copyToProject(sourcePath, props.project.path)
          imageRefs.push(`[Image file: ${destPath}]`)
        } catch (err) {
          setError(err instanceof Error ? err.message : `Failed to copy image "${attachment.file.name}" into the project.`)
          return
        }
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
    await window.api.memory.save({
      projectId: props.project.id,
      type: 'note',
      title: m.content.slice(0, 60),
      content: m.content,
      source: 'claudecode',
    })
    addToast('Saved to Knowledge')
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
    if (m.role === 'user') return (
      <div key={m.id} className="msg user">
        <div className="msg-body">{m.content}</div>
        <div className="msg-meta"><span className="msg-time"><RelativeTime ts={m.created_at} /></span></div>
      </div>
    )
    return (
      <div key={m.id} className="msg assistant">
        <div className="msg-body md-body"><Markdown>{m.content}</Markdown></div>
        <div className="msg-meta">
          <span className="msg-time"><RelativeTime ts={m.created_at} /></span>
          <OutputActions
            onCopy={() => void copyOutput(m.content)}
            onSave={() => void saveOutputToKnowledge(m)}
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

  const ctxSession = contextMenu ? sessions.find(s => s.id === contextMenu.sessionId) : null
  const pinnedSessions = sessions.filter(s => pinnedIds.has(s.id))
  const unpinnedSessions = sessions.filter(s => !pinnedIds.has(s.id))

  function renderSessionRow(s: Session) {
    const isActive = session?.id === s.id
    const isRenaming = renaming?.id === s.id
    return (
      <li key={s.id} className="session-row">
        <button className={`session-item${isActive ? ' active' : ''}`} onClick={() => { if (!isRenaming) setSession(s) }}>
          {isRenaming ? (
            <input className="session-rename-input" value={renaming.value} onChange={e => setRenaming({ id: s.id, value: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void commitRename(s) } if (e.key === 'Escape') setRenaming(null) }} onBlur={() => void commitRename(s)} autoFocus onClick={e => e.stopPropagation()} />
          ) : (
            <span className="session-item-title">{s.title || 'New task'}</span>
          )}
        </button>
        <button className="session-dot-menu" title="Session options" aria-label={`Options for ${s.title}`} onClick={e => openContextMenu(e, s)}>⋯</button>
      </li>
    )
  }

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
        activeSessionId={session?.id}
        pinnedIds={pinnedIds}
        renaming={renaming}
        newLabel="New task"
        newTitle="Start a new Claude Code task"
        emptyLabel="No Claude Code tasks yet"
        headerSlot={instructionHeaderSlot}
        onNew={newSession}
        onSelect={setSession}
        onOptions={openContextMenu}
        onRenameChange={(value) => renaming && setRenaming({ ...renaming, value })}
        onRenameCommit={(s) => void commitRename(s)}
        onRenameCancel={() => setRenaming(null)}
      />

      <section className="chat-main">
        {!session ? (
          <>
            <div className="empty center">
              <div className="empty-icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 17l6-5-6-5" /><path d="M12 19h8" />
                </svg>
              </div>
              <h2>Hand off to Claude Code.</h2>
              <p className="muted">Describe a coding task and Claude Code runs it headlessly in this project under your subscription login — streaming its output and tool calls here. Inject project memory so it starts with everything the workspace already knows.</p>
              <button className="primary" onClick={newSession}>Start a task</button>
            </div>
            <AiContextBar testId="context-bar-claude-code" model={modelLabel} mode={contextMode} status={contextStatus} />
          </>
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
              status={running ? 'Running' : check?.installed ? 'Ready' : 'Setup'}
              tone={running ? 'info' : check?.installed ? 'success' : 'warning'}
              detail={`${modelLabel} · ${effort}${thinking ? ' · thinking' : ''}`}
            />

            <div className="chat-scroll" ref={scrollRef}>
              {messages.map(renderMessage)}
              {running && (
                <div className="cc-live">
                  {note && <div className="cc-note muted small">{note}</div>}
                  <ActivityLog entries={activity} live />
                  {output ? (
                    <div className="msg assistant"><div className="msg-body md-body"><Markdown>{output}</Markdown><span className="cursor">▋</span></div></div>
                  ) : (
                    activity.length === 0 && <div className="cc-note muted small">Working…<span className="cursor">▋</span></div>
                  )}
                </div>
              )}
              {loginRequired && !running && <SetupNotice check={check ?? { installed: true }} onRecheck={recheck} />}
            </div>

            {error && <AgentErrorNotice title="Claude Code could not run">{error}</AgentErrorNotice>}

            <div className="cc-toolbar">
              <div className="model-select" title="Model passed to Claude Code (--model)">
                <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running}>
                  {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <span className="model-select-chevron">▾</span>
              </div>
              <div className="cc-seg" role="group" aria-label="Effort">
                {EFFORTS.map((ef) => (
                  <button key={ef} className={`cc-seg-btn ${effort === ef ? 'active' : ''}`} onClick={() => setEffort(ef)} disabled={running} title={`Effort: ${ef}${ef === 'normal' ? ' (default turn budget)' : ''}`}>{ef}</button>
                ))}
              </div>
              <button className={`cc-think ${thinking ? 'on' : ''}`} onClick={() => setThinking((v) => !v)} disabled={running} title="Enable extended thinking for the next task">✦ Thinking{thinking ? ' on' : ''}</button>
            </div>

            <AiContextBar testId="context-bar-claude-code" usedTokens={estimatedTokens} tokensApproximate={estimatedTokens !== undefined} model={modelLabel} mode={contextMode} status={contextStatus} />

            <div className="composer">
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
                placeholder="Describe a coding task…  (Enter to run · Shift+Enter for newline · / for commands)"
                value={input}
                onChange={(e) => { setInput(e.target.value); setSlashIndex(0); setSlashDismissed(false) }}
                onPaste={handlePaste}
                onKeyDown={handleKeyDown}
              />
              <div className="composer-bar">
                <span className="cc-hint muted small">{check?.installed ? `${modelLabel} · Claude Code ${check.version ?? ''} · subscription login` : 'Checking Claude Code…'}</span>
                <div className="composer-actions">
                  {running && tokPerSec > 0 && (
                    <div className="token-flow-wrap">
                      <div className="token-flow-bar">
                        <div className="token-flow-fill" style={{ width: `${Math.min(100, (tokPerSec / 30) * 100)}%` }} />
                      </div>
                      <span className="token-flow-label">{Math.round(tokPerSec)} tok/s</span>
                    </div>
                  )}
                  <button className="composer-attach-btn" onClick={() => void pickFile()} title="Attach file" aria-label="Attach file" disabled={running}>📎</button>
                  <VoiceInputButton testId="voice-input-claude-code" value={input} onChange={setVoiceInput} disabled={running} label="Voice input for Claude Code" />
                  {running ? <button className="danger send-btn stop-btn" onClick={stopRun} title="Stop Claude Code">■ Stop</button> : <button className="send-btn" disabled={!check?.installed} onClick={() => void run()}>Run</button>}
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── Context menu portal ── */}
      {contextMenu && ctxSession && createPortal(
        <div className="session-context-menu" style={{ top: contextMenu.y, left: contextMenu.x }} onPointerDown={e => e.stopPropagation()}>
          <button className="session-context-item" onClick={() => togglePin(contextMenu.sessionId)}>{pinnedIds.has(contextMenu.sessionId) ? 'Unpin' : 'Pin'}</button>
          <button className="session-context-item" onClick={() => startRename(ctxSession)}>Rename</button>
          <div className="session-context-divider" />
          <button className="session-context-item danger" onClick={() => { setContextMenu(null); void deleteSession(ctxSession) }}>Delete</button>
        </div>,
        document.body
      )}
    </div>
      {instructionsOpen && (
        <InstructionsEditor agentId={instructionsOpen.agentId} agentLabel={instructionsOpen.agentLabel} projectPath={props.project.path ?? null} onClose={() => setInstructionsOpen(null)} />
      )}
    </div>
  )
}
