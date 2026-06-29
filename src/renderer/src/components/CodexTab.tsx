import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import type { Project, Session, Message, CodexCheck, CodexActivityEntry, CodexEvent, CodexSandboxMode, ComposerAttachment } from '../types'
import { AttachmentChips, resolveAttachments } from './ComposerAttachments'
import Markdown from './Markdown'
import RelativeTime from './RelativeTime'
import AiContextBar, { estimateTokensFromText } from './AiContextBar'
import { useToast } from './ToastContext'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { fallbackTitleFromText, isGenericSessionTitle } from '../../../shared/sessionTitles'
import { AgentErrorNotice, AgentSessionRail, AgentStatusStrip, OutputActions } from './AgentPanelPrimitives'
import InstructionsEditor from './InstructionsEditor'

const CODEX_MODEL = 'Codex CLI'
const PINNED_KEY = 'aiworkspace.codex.pinned'
function loadPinned(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')) } catch { return new Set() }
}
function savePinned(s: Set<string>) { localStorage.setItem(PINNED_KEY, JSON.stringify([...s])) }

function ToolCard(props: { entry: CodexActivityEntry; live?: boolean }) {
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
      {hasBody && open && <div className="tool-card-body"><pre className="tool-output">{body}</pre></div>}
    </div>
  )
}

function ActivityLog(props: { entries: CodexActivityEntry[]; live?: boolean }) {
  if (props.entries.length === 0) return null
  return (
    <div className="tool-activity">
      <div className="activity-head">Activity</div>
      <div className="tool-card-list motion-list motion-list-tight">
        {props.entries.map((e, i) => <ToolCard key={i} entry={e} live={props.live && e.ok === undefined} />)}
      </div>
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

function ProjectRequiredNotice() {
  return (
    <div className="chat-layout">
      <aside className="session-list">
        <div className="session-list-header">
          <button className="session-new-btn" disabled title="Codex needs a project folder">
            <span className="session-new-icon">＋</span> New task
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
  )
}

interface CtxMenu { sessionId: string; x: number; y: number }

export default function CodexTab(props: { project: Project; active?: boolean }) {
  const { addToast } = useToast()
  const [check, setCheck] = useState<CodexCheck | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
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
  const [usageTokens, setUsageTokens] = useState<number | undefined>(undefined)
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => loadPinned())
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [instructionsOpen, setInstructionsOpen] = useState<{ agentId: string; agentLabel: string } | null>(null)
  const [agentMdExists, setAgentMdExists] = useState(false)
  const [sharedMdExists, setSharedMdExists] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastPromptRef = useRef('')
  const isGlobalWorkspace = isGlobalProjectId(props.project.id)
  const active = props.active ?? true
  const contextText = [...messages.map((m) => m.content), output, input].filter(Boolean).join('\n')
  const estimatedTokens = estimateTokensFromText(contextText)

  useEffect(() => { window.api.models.list().then(setOllamaModels) }, [])

  useEffect(() => {
    function onFocusComposer(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'codex') textareaRef.current?.focus()
    }
    function onNewSession(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'codex' && !isGlobalWorkspace && check?.installed) void newSession()
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
    if (isGlobalWorkspace || !active) { setSessions([]); return }
    window.api.sessions.list(props.project.id, 'codex').then(setSessions)
  }, [props.project.id, isGlobalWorkspace, active])

  useEffect(() => {
    if (session) window.api.codex.messages(session.id).then(setMessages)
    else setMessages([])
    setOutput(''); setActivity([]); setNote(''); setError(''); setUsageTokens(undefined)
  }, [session])

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
    })
    return () => { offEvent(); offDone() }
  }, [session])

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
    const s = await window.api.sessions.create(props.project.id, 'codex', 'New task')
    setSessions((prev) => [s, ...prev]); setSession(s)
  }

  async function deleteSession(target: Session) {
    await window.api.sessions.delete(target.id)
    setSessions((prev) => prev.filter((s) => s.id !== target.id))
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
    await window.api.sessions.rename(s.id, title)
    setSessions(prev => prev.map(x => x.id === s.id ? { ...x, title } : x))
    if (session?.id === s.id) setSession(prev => prev ? { ...prev, title } : prev)
  }

  function togglePin(sessionId: string) {
    setContextMenu(null)
    setPinnedIds(prev => { const next = new Set(prev); if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId); savePinned(next); return next })
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
        try {
          imagePaths.push(await window.api.files.copyToProject(sourcePath, props.project.path))
        } catch (err) {
          setError(err instanceof Error ? err.message : `Failed to copy image "${attachment.file.name}" into the project.`)
          return
        }
      }
      setAttachments([])
      void sendPrompt(resolved.content + input, imagePaths)
    } else {
      void sendPrompt(input)
    }
  }

  function stopRun() { if (session && running) window.api.codex.abort(session.id) }

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
    await window.api.memory.save({
      projectId: props.project.id,
      type: 'note',
      title: m.content.slice(0, 60),
      content: m.content,
      source: 'codex',
    })
    addToast('Saved to Knowledge')
  }

  const renderMessage = (m: Message) => {
    if (m.role === 'tool') {
      let entries: CodexActivityEntry[] = []
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

  const ctxSession = contextMenu ? sessions.find(s => s.id === contextMenu.sessionId) : null
  const pinnedSessions = sessions.filter(s => pinnedIds.has(s.id))
  const unpinnedSessions = sessions.filter(s => !pinnedIds.has(s.id))
  const contextStatus = running ? 'Running' : check?.installed ? 'Ready' : 'Checking'

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

  const SafetyControls = (
    <div className="codex-toolbar" role="group" aria-label="Codex safety controls">
      <div className="model-select" title="Codex model (-m)">
        <select data-testid="codex-model" value={model} disabled={running} onChange={(e) => { setModel(e.target.value); localStorage.setItem('codex-preferred-model', e.target.value) }}>
          <option value="gpt-5.5">gpt-5.5</option>
          <option value="o3">o3</option>
          <option value="o4-mini">o4-mini</option>
          <option value="o3-mini">o3-mini</option>
        </select>
        <span className="model-select-chevron">▾</span>
      </div>
      <div className="model-select" title="Codex sandbox (-s)">
        <select data-testid="codex-sandbox" value={sandbox} disabled={running} onChange={(e) => setSandbox(e.target.value as CodexSandboxMode)}>
          <option value="read-only">Read-only</option>
          <option value="workspace-write">Workspace write</option>
        </select>
        <span className="model-select-chevron">▾</span>
      </div>
      <label className={`codex-trust-chip ${skipGitRepoCheck ? 'on' : ''}`} title="Only enable for folders you trust — Codex may read and modify files in this project.">
        <input data-testid="codex-allow-untrusted" type="checkbox" checked={skipGitRepoCheck} disabled={running} onChange={(e) => setSkipGitRepoCheck(e.target.checked)} />
        <span>Allow in untrusted folder</span>
      </label>
    </div>
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
        activeSessionId={session?.id}
        pinnedIds={pinnedIds}
        renaming={renaming}
        newLabel="New task"
        newTitle="Start a new Codex task"
        emptyLabel="No Codex tasks yet"
        headerSlot={codexHeaderSlot}
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
                  <path d="M8 9l-4 3 4 3" /><path d="M16 9l4 3-4 3" /><path d="M13 7l-2 10" />
                </svg>
              </div>
              <h2>Hand off to Codex.</h2>
              <p className="muted">Describe a coding task and Codex runs it using your ChatGPT Plus subscription, streaming its output and tool calls here.</p>
              <button className="primary" data-testid="codex-start-task" onClick={newSession}>Start a task</button>
            </div>
            <AiContextBar testId="context-bar-codex" model={model} mode="Codex" status="subscription login" />
          </>
        ) : (
          <>
            <header className="chat-header">
              <span className="chat-header-title">{session.title}</span>
            </header>
            <AgentStatusStrip
              agent="Codex"
              status={running ? 'Running' : 'Ready'}
              tone={running ? 'info' : 'success'}
              detail={`${model} · ${sandbox}${skipGitRepoCheck ? ' · untrusted allowed' : ''}`}
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
            </div>

            {error && <AgentErrorNotice title="Codex could not run" testId="codex-error">{error}</AgentErrorNotice>}

            {SafetyControls}

            <AiContextBar testId="context-bar-codex" usedTokens={usageTokens ?? estimatedTokens} tokensApproximate={usageTokens == null} model={model} mode="Codex" status="subscription login" />

            <div className="composer">
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
                <span className="cc-hint muted small">Codex CLI · subscription login</span>
                <div className="composer-actions">
                  <button className="composer-attach-btn" onClick={() => void pickFile()} title="Attach file" aria-label="Attach file" disabled={running}>📎</button>
                  {running
                    ? <button className="danger send-btn stop-btn" onClick={stopRun} title="Stop Codex">■ Stop</button>
                    : <button className="send-btn" data-testid="codex-send" disabled={!input.trim()} onClick={() => void run()}>Run</button>}
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
