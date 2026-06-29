import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import type { Project, Session, Message, HermesCheck, HermesActivity, HermesEvent, HermesCommand, RemoteHermesConfig, ComposerAttachment } from '../types'
import { AttachmentChips, resolveAttachments } from './ComposerAttachments'
import Markdown from './Markdown'
import RelativeTime from './RelativeTime'
import AiContextBar, { estimateTokensFromText } from './AiContextBar'
import { useToast } from './ToastContext'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { AgentErrorNotice, AgentSessionRail, AgentStatusStrip, OutputActions } from './AgentPanelPrimitives'
import InstructionsEditor from './InstructionsEditor'

const HERMES_MODEL = 'gemma4-workspace:12b'
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

function ActivityLog(props: { entries: HermesActivity[]; live?: boolean }) {
  if (props.entries.length === 0) return null
  return (
    <div className="activity-log">
      <div className="activity-head">Activity</div>
      <ul>
        {props.entries.map((e, i) => (
          <li key={i} className={`activity-item ${e.kind === 'error' ? 'err' : ''}`}>
            <span className={`activity-status ${props.live && i === props.entries.length - 1 ? 'pending' : ''}`}>
              {e.kind === 'error' ? '✕' : e.kind === 'tool' ? '▸' : e.kind === 'plan' ? '☐' : '•'}
            </span>
            <span className="activity-tool">{e.kind}</span>
            <span className="activity-summary">{e.message}</span>
          </li>
        ))}
      </ul>
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

function ProjectRequiredNotice() {
  return (
    <div className="chat-layout">
      <aside className="session-list">
        <div className="session-list-header">
          <button className="session-new-btn" disabled title="Hermes needs a project folder">
            <span className="session-new-icon">＋</span> New task
          </button>
        </div>
      </aside>
      <section className="chat-main">
        <AiContextBar testId="context-bar-hermes" model={HERMES_MODEL} mode="Hermes" status="Project required" disabledReason="Open a project folder" />
        <div className="empty center cc-setup" data-testid="hermes-global-unavailable">
          <h2>Hermes needs a project folder.</h2>
          <p className="muted">Open a project workspace to use Hermes. Global Workspace is available for general chat and shared memory, but this Hermes integration should not run without a real project path.</p>
        </div>
      </section>
    </div>
  )
}

interface CtxMenu { sessionId: string; x: number; y: number }

export default function HermesTab(props: { project: Project; active?: boolean }) {
  const { addToast } = useToast()
  const [check, setCheck] = useState<HermesCheck | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [injectMemory, setInjectMemory] = useState(false)
  const [pendingContextBlock, setPendingContextBlock] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [thoughtText, setThoughtText] = useState('')
  const [activity, setActivity] = useState<HermesActivity[]>([])
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
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [instructionsOpen, setInstructionsOpen] = useState<{ agentId: string; agentLabel: string } | null>(null)
  const [agentMdExists, setAgentMdExists] = useState(false)
  const [sharedMdExists, setSharedMdExists] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const checkRef = useRef<HermesCheck | null>(null)
  checkRef.current = check

  const isGlobalWorkspace = isGlobalProjectId(props.project.id)
  const active = props.active ?? true
  const connected = check?.connected ?? false
  const contextText = [...messages.map((m) => m.content), streamText, thoughtText, input].filter(Boolean).join('\n')
  const estimatedTokens = estimateTokensFromText(contextText)
  const contextStatus = running ? 'Running' : connected ? 'Ready' : 'Disconnected'

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

  useEffect(() => { window.api.models.list().then(setOllamaModels) }, [])
  useEffect(() => {
    function onFocusComposer(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'hermes') textareaRef.current?.focus()
    }
    function onNewSession(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'hermes' && !isGlobalWorkspace && connected) void newSession()
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
    window.api.instructions.getPath('hermes', p).then(fp => {
      if (fp) window.api.instructions.read(fp).then(r => setAgentMdExists(r.exists))
    })
    window.api.instructions.getPath('shared', p).then(fp => {
      if (fp) window.api.instructions.read(fp).then(r => setSharedMdExists(r.exists))
    })
  }, [props.project.path, isGlobalWorkspace, instructionsOpen])
  useEffect(() => { if (!isGlobalWorkspace && active) recheck() }, [isGlobalWorkspace, active])
  useEffect(() => {
    if (isGlobalWorkspace || !active) { setSessions([]); return }
    window.api.sessions.list(props.project.id, 'hermes').then(setSessions)
  }, [props.project.id, isGlobalWorkspace, active])
  useEffect(() => { if (!isGlobalWorkspace && active) window.api.hermes.getConfig().then(setConfig) }, [isGlobalWorkspace, active])

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
    setStreamText(''); setThoughtText(''); setActivity([]); setError('')
  }, [session])

  useEffect(() => {
    const offEvent = window.api.hermes.onEvent((d) => {
      if (d.sessionId !== session?.id) return
      const e: HermesEvent = d.event
      if (e.kind === 'text') setStreamText((t) => t + e.text)
      else if (e.kind === 'thought') setThoughtText((t) => t + e.text)
      else if (e.kind === 'activity') setActivity((a) => [...a, e.activity])
      else if (e.kind === 'error') setError(e.message)
      else if (e.kind === 'model') setHermesModel(e.name)
      else if (e.kind === 'commands') setCommands(e.commands)
    })
    const offDone = window.api.hermes.onDone(async (d) => {
      if (d.sessionId !== session?.id) return
      setRunning(false); setStreamText(''); setThoughtText('')
      setMessages(await window.api.hermes.messages(d.sessionId)); setActivity([])
    })
    return () => { offEvent(); offDone() }
  }, [session])

  useEffect(() => { return window.api.hermes.onUsage((d) => setHermesUsage(d)) }, [])

  useEffect(() => {
    clearTimeout(scrollTimeoutRef.current)
    scrollTimeoutRef.current = setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: running ? 'auto' : 'smooth' })
    }, running ? 100 : 0)
  }, [messages, activity, streamText, thoughtText, running])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    function handleDown() { setContextMenu(null) }
    document.addEventListener('pointerdown', handleDown, true)
    return () => document.removeEventListener('pointerdown', handleDown, true)
  }, [contextMenu])

  async function newSession() {
    const s = await window.api.sessions.create(props.project.id, 'hermes', 'New task')
    setSessions((prev) => [s, ...prev]); setSession(s)
  }

  async function deleteSession(target: Session) {
    await window.api.sessions.delete(target.id)
    setSessions((prev) => prev.filter((s) => s.id !== target.id))
    if (session?.id === target.id) { setSession(null); setMessages([]); setStreamText(''); setThoughtText(''); setActivity([]); setError('') }
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

    setError(''); setRunning(true); setStreamText(''); setThoughtText(''); setActivity([]); setInput(''); setHermesUsage(null)
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, session_id: s!.id, role: 'user', content: prompt, model: null, created_at: Date.now() }])
    window.api.hermes.send({ sessionId: s.id, projectId: props.project.id, prompt: finalPrompt, injectMemory })
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
    await window.api.memory.save({
      projectId: props.project.id,
      type: 'note',
      title: m.content.slice(0, 60),
      content: m.content,
      source: 'hermes',
    })
    addToast('Saved to Knowledge')
  }

  const renderMessage = (m: Message) => {
    if (m.role === 'tool') {
      let entries: HermesActivity[] = []
      try { entries = JSON.parse(m.content) } catch { /* legacy */ }
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
  const isRemote = config?.mode === 'remote'
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
            <button className="session-new-btn" disabled title="Hermes needs a project folder">
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
          <aside className="session-list">
            <div className="session-list-header">
              <button className="session-new-btn" disabled title="Hermes is not connected">
                <span className="session-new-icon">＋</span> New task
              </button>
            </div>
            <div className="session-list-extra">
              <button
                className={`instructions-md-btn${agentMdExists ? ' exists' : ''}`}
                onClick={() => setInstructionsOpen({ agentId: 'hermes', agentLabel: 'Hermes' })}
                title="Edit HERMES.md"
              >
                📋 HERMES.md{!agentMdExists ? ' (create)' : ''}
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

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0 }}>
    <div className="chat-layout">
      <AgentSessionRail
        sessions={sessions}
        activeSessionId={session?.id}
        pinnedIds={pinnedIds}
        renaming={renaming}
        newLabel="New task"
        newTitle="Start a new Hermes task"
        emptyLabel="No Hermes tasks yet"
        headerSlot={hermesHeaderSlot}
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
                  <circle cx="12" cy="5" r="2.4" /><circle cx="5" cy="18" r="2.4" /><circle cx="19" cy="18" r="2.4" />
                  <path d="M12 7.4v4.2M12 11.6 6.6 16.2M12 11.6l5.4 4.6" />
                </svg>
              </div>
              <h2>Hand off to Hermes.</h2>
              <p className="muted">{isRemote ? 'Hermes runs autonomously on a remote host via SSH + ACP. Give it a task and it works through it, streaming its activity here.' : "Hermes runs autonomously in WSL2 via ACP. Give it a task and it works through it, streaming its activity here. It shares this workspace's memory through the knowledge MCP server."}</p>
              <button className="primary" onClick={newSession}>Start a task</button>
            </div>
            <AiContextBar testId="context-bar-hermes" model={HERMES_MODEL} mode="Hermes" status={contextStatus} />
          </>
        ) : (
          <>
            <header className="chat-header">
              <span className="chat-header-title">{session.title}</span>
              <div className="hermes-header-right">
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
              status={running ? 'Running' : connected ? 'Ready' : 'Disconnected'}
              tone={running ? 'info' : connected ? 'success' : 'warning'}
              detail={isRemote ? 'Remote SSH' : 'WSL2 ACP'}
            />

            <div className="chat-scroll" ref={scrollRef}>
              {messages.map(renderMessage)}
              {running && (
                <div className="cc-live">
                  {thoughtText && <ThinkingBlock text={thoughtText} tokenCount={thoughtText.split(/\s+/).filter(Boolean).length} done={streamText.length > 0} />}
                  {streamText && <div className="msg assistant"><div className="msg-body md-body"><Markdown>{streamText}</Markdown><span className="cursor">&#x2587;</span></div></div>}
                  <ActivityLog entries={activity} live />
                  {!streamText && !thoughtText && activity.length === 0 && <div className="cc-note muted small">Connecting to Hermes…<span className="cursor">&#x2587;</span></div>}
                </div>
              )}
            </div>

            {error && <AgentErrorNotice title="Hermes could not run">{error}</AgentErrorNotice>}

            <AiContextBar testId="context-bar-hermes" usedTokens={hermesUsage?.used ?? estimatedTokens} maxTokens={hermesUsage?.max} tokensApproximate={hermesUsage === null && estimatedTokens !== undefined} model={hermesModel ?? HERMES_MODEL} mode="Hermes" status={contextStatus} />

            <div className="composer">
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
                placeholder="Describe a task for Hermes…  (Enter to send · Shift+Enter for newline)"
                value={input}
                onChange={(e) => { setInput(e.target.value); setSlashIdx(-1) }}
                onPaste={handlePaste}
                onKeyDown={handleKeyDown}
              />
              <div className="composer-bar">
                <span className="cc-hint muted small">{connected ? (isRemote ? 'Hermes · remote SSH · subscription-free local agent' : 'Hermes · WSL2 ACP · subscription-free local agent') : 'Hermes disconnected'}</span>
                <div className="composer-actions">
                  <button className="composer-attach-btn" onClick={() => void pickFile()} title="Attach file" aria-label="Attach file" disabled={running}>📎</button>
                  {running ? <button className="danger send-btn stop-btn" onClick={cancelRun} title="Stop Hermes">■ Stop</button> : <button className="send-btn" disabled={!connected} onClick={() => void run()}>Send</button>}
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
