import { createPortal } from 'react-dom'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Project, Session, Message, MemoryItem, ComposerAttachment } from '../types'
import { AttachmentChips, resolveAttachments } from './ComposerAttachments'
import Markdown from './Markdown'
import ClarificationCard, {
  formatChoiceAnswer,
  formatClarificationAnswer,
  parseChoiceQuestionRequest,
  parseClarificationRequest,
  parseInlineChoiceQuestion
} from './ClarificationCard'
import ClarificationQuestionnaire, {
  formatQuestionnaireAnswer,
  parseMarkdownQuestionnaire,
  parseQuestionnaireRequest
} from './ClarificationQuestionnaire'
import RelativeTime from './RelativeTime'
import AiContextBar, { estimateTokensFromText } from './AiContextBar'
import VoiceInputButton from './VoiceInputButton'
import { useToast } from './ToastContext'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { cleanupGeneratedTitle, fallbackTitleFromText, firstExchange, isGenericSessionTitle } from '../../../shared/sessionTitles'
import { AgentStatusStrip, OutputActions } from './AgentPanelPrimitives'

const PINNED_KEY = 'aiworkspace.chat.pinned'
const RENDER_LIMIT = 50

function loadPinned(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')) } catch { return new Set() }
}
function savePinned(s: Set<string>) {
  localStorage.setItem(PINNED_KEY, JSON.stringify([...s]))
}

function parseSuggestions(text: string | null): string[] {
  if (!text) return []
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1))
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 3)
  } catch { /* */ }
  return []
}

const MessageItem = React.memo(function MessageItem({ message: m, answeredClarifications, onMarkAnswered, onCopy, onSave, onSubmitClarification, onSubmitChoice, onSubmitQuestionnaire }: {
  message: Message
  answeredClarifications: Set<string>
  onMarkAnswered: (key: string) => void
  onCopy: (text: string) => void
  onSave: (m: Message) => void
  onSubmitClarification: (msgId: string, reqId: string, answer: Parameters<typeof formatClarificationAnswer>[0]) => void
  onSubmitChoice: (msgId: string, reqId: string, answer: Parameters<typeof formatChoiceAnswer>[0]) => void
  onSubmitQuestionnaire: (msgId: string, reqId: string, answer: Parameters<typeof formatQuestionnaireAnswer>[0]) => void
}) {
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-body">{m.content}</div>
        <div className="msg-meta">
          <span className="msg-time"><RelativeTime ts={m.created_at} /></span>
        </div>
      </div>
    )
  }

  const clarification = parseClarificationRequest(m.content)
  const choiceQuestion = clarification.request ? { request: null, markdown: m.content } : parseChoiceQuestionRequest(m.content)
  const structuredQuestionnaire = clarification.request || choiceQuestion.request ? { request: null, markdown: m.content } : parseQuestionnaireRequest(m.content)
  const inlineChoiceQuestion = clarification.request || choiceQuestion.request || structuredQuestionnaire.request
    ? { request: null, markdown: m.content }
    : parseInlineChoiceQuestion(m.content)
  const fallbackQuestionnaire = clarification.request || choiceQuestion.request || structuredQuestionnaire.request || inlineChoiceQuestion.request
    ? { request: null, markdown: m.content }
    : parseMarkdownQuestionnaire(m.content)
  const questionnaire = structuredQuestionnaire.request ? structuredQuestionnaire : fallbackQuestionnaire
  const activeChoiceQuestion = choiceQuestion.request ? choiceQuestion : inlineChoiceQuestion
  const activeRequest = clarification.request ?? activeChoiceQuestion.request ?? questionnaire.request
  const answeredKey = activeRequest ? `${m.id}:${activeRequest.id}` : ''
  const isAnswered = answeredKey ? answeredClarifications.has(answeredKey) : false
  const markdown = clarification.request
    ? clarification.markdown
    : activeChoiceQuestion.request
      ? activeChoiceQuestion.markdown
    : questionnaire.request
      ? questionnaire.markdown
      : m.content

  return (
    <div className="msg assistant">
      <div className="msg-body md-body">
        <Markdown>{markdown}</Markdown>
        {clarification.request && !isAnswered && (
          <ClarificationCard
            request={clarification.request}
            onDismiss={() => onMarkAnswered(answeredKey)}
            onSubmit={(answer) => onSubmitClarification(m.id, clarification.request!.id, answer)}
          />
        )}
        {activeChoiceQuestion.request && !isAnswered && (
          <ClarificationCard
            request={activeChoiceQuestion.request}
            cardTestId="choice-card"
            optionTestId="choice-option"
            submitTestId="choice-submit"
            onDismiss={() => onMarkAnswered(answeredKey)}
            onSubmit={(answer) => onSubmitChoice(m.id, activeChoiceQuestion.request!.id, answer)}
          />
        )}
        {questionnaire.request && !isAnswered && (
          <ClarificationQuestionnaire
            request={questionnaire.request}
            onDismiss={() => onMarkAnswered(answeredKey)}
            onSubmit={(answer) => onSubmitQuestionnaire(m.id, questionnaire.request!.id, answer)}
          />
        )}
      </div>
      <div className="msg-meta">
        <span className="msg-time"><RelativeTime ts={m.created_at} /></span>
        <OutputActions
          onCopy={() => onCopy(m.content)}
          onSave={() => onSave(m)}
        />
      </div>
    </div>
  )
})

interface CtxMenu { sessionId: string; x: number; y: number }

export default function ChatTab(props: { project: Project }) {
  const { addToast } = useToast()
  const [sessions, setSessions] = useState<Session[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [extracted, setExtracted] = useState<MemoryItem[] | null>(null)
  const [extractError, setExtractError] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [chatUsage, setChatUsage] = useState<{ used: number; max: number | null } | null>(null)
  const [cloudModels, setCloudModels] = useState<{ id: string; name: string }[]>([])
  const [cloudKeyConfigured, setCloudKeyConfigured] = useState(false)
  const [cloudKeyMasked, setCloudKeyMasked] = useState<string | null>(null)
  const [cloudKeyInput, setCloudKeyInput] = useState('')
  const [showCloudSetup, setShowCloudSetup] = useState(false)
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => loadPinned())
  const [tokPerSec, setTokPerSec] = useState(0)
  const [answeredClarifications, setAnsweredClarifications] = useState<Set<string>>(() => new Set())
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [renderOffset, setRenderOffset] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const sendRef = useRef<typeof send | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modelRef = useRef(model)
  modelRef.current = model
  const suggestToken = useRef(0)
  const tokenTimestamps = useRef<number[]>([])
  const skipNextSessionLoad = useRef(false)
  const isGlobalWorkspace = isGlobalProjectId(props.project.id)
  const memoryProjectId = isGlobalWorkspace ? null : props.project.id

  useEffect(() => {
    window.api.sessions.list(props.project.id, 'chat').then(setSessions)
  }, [props.project.id])

  useEffect(() => {
    function onFocusComposer(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'chat') textareaRef.current?.focus()
    }
    function onNewSession(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'chat') void newSession()
    }
    window.addEventListener('panel:focusComposer', onFocusComposer)
    window.addEventListener('panel:newSession', onNewSession)
    return () => {
      window.removeEventListener('panel:focusComposer', onFocusComposer)
      window.removeEventListener('panel:newSession', onNewSession)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined
    const load = async () => {
      const m = await window.api.models.list()
      if (cancelled) return
      setModels(m)
      if (m.length > 0) { setModel((cur) => cur || m[0]); if (timer) clearInterval(timer) }
    }
    load()
    timer = setInterval(load, 3000)
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [])

  useEffect(() => {
    window.api.settings.summary().then((summary) => {
      const status = summary.secrets.ollama_cloud_key
      setCloudKeyConfigured(Boolean(status?.configured))
      setCloudKeyMasked(status?.masked ?? null)
      if (status?.configured) void window.api.models.listCloud().then(setCloudModels)
    })
  }, [])

  useEffect(() => window.api.chat.onUsage((d) => setChatUsage(d)), [])

  useEffect(() => {
    if (skipNextSessionLoad.current) {
      skipNextSessionLoad.current = false
      return
    }
    if (session) window.api.chat.messages(session.id).then(setMessages)
    else setMessages([])
    setExtracted(null); setExtractError(''); setSuggestions([]); setChatUsage(null)
    setAnsweredClarifications(new Set())
    setRenderOffset(0)
    suggestToken.current++
    tokenTimestamps.current = []
    setTokPerSec(0)
  }, [session])

  useEffect(() => {
    function handleTestState(event: Event) {
      const detail = (event as CustomEvent).detail as {
        session?: Session
        messages?: Message[]
        model?: string
      }
      if (!Array.isArray(detail?.messages)) return
      const nextSession = detail.session ?? { id: 'test-chat-session', project_id: props.project.id, mode: 'chat', title: 'Test chat', created_at: Date.now() }
      skipNextSessionLoad.current = true
      setSession(nextSession)
      setMessages(detail.messages)
      setAnsweredClarifications(new Set())
      setBusy(false)
      setStreaming('')
      setError('')
      if (typeof detail.model === 'string') setModel(detail.model)
    }
    window.addEventListener('aiworkspace:test:set-chat-state', handleTestState)
    return () => window.removeEventListener('aiworkspace:test:set-chat-state', handleTestState)
  }, [props.project.id])

  useEffect(() => {
    const offToken = window.api.chat.onToken((d) => {
      if (d.sessionId === session?.id) {
        setStreaming((s) => s + d.token)
        tokenTimestamps.current.push(Date.now())
      }
    })
    const offDone = window.api.chat.onDone(async (d) => {
      if (!session || d.sessionId !== session.id) return
      setStreaming(''); setBusy(false); tokenTimestamps.current = []; setTokPerSec(0)
      const msgs = await window.api.chat.messages(d.sessionId)
      setMessages(msgs)
      if (msgs.some((m) => m.role === 'assistant')) void loadSuggestions(msgs)
      if (isGenericSessionTitle(session.title)) void updateSessionTitle(d.sessionId, session.title, msgs)
    })
    const offError = window.api.chat.onError((d) => {
      if (d.sessionId === session?.id) { setBusy(false); setStreaming(''); setError(d.error); setTokPerSec(0) }
    })
    return () => { offToken(); offDone(); offError() }
  }, [session])

  // Compute tok/s every 500ms while streaming
  useEffect(() => {
    if (!busy) { setTokPerSec(0); return }
    const iv = setInterval(() => {
      const now = Date.now()
      const recent = tokenTimestamps.current.filter(t => now - t < 5000)
      tokenTimestamps.current = recent
      setTokPerSec(recent.length / 5)
    }, 500)
    return () => clearInterval(iv)
  }, [busy])

  // Debounced scroll: 100ms during streaming, immediate on message settle
  useEffect(() => {
    clearTimeout(scrollTimeoutRef.current)
    scrollTimeoutRef.current = setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: streaming ? 'auto' : 'smooth' })
    }, streaming ? 100 : 0)
  }, [messages, streaming])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    function handleDown() { setContextMenu(null) }
    document.addEventListener('pointerdown', handleDown, true)
    return () => document.removeEventListener('pointerdown', handleDown, true)
  }, [contextMenu])

  async function newSession() {
    const s = await window.api.sessions.create(props.project.id, 'chat', 'New chat')
    setSessions((prev) => [s, ...prev]); setSession(s)
  }

  async function deleteSession(target: Session) {
    await window.api.sessions.delete(target.id)
    setSessions((prev) => prev.filter((s) => s.id !== target.id))
    if (session?.id === target.id) {
      setSession(null); setMessages([]); setStreaming(''); setSuggestions([])
      setExtracted(null); setExtractError(''); setError('')
    }
    addToast('Session deleted')
  }

  function openContextMenu(e: React.MouseEvent, s: Session) {
    e.preventDefault(); e.stopPropagation()
    setContextMenu({ sessionId: s.id, x: e.clientX, y: e.clientY })
    setRenaming(null)
  }

  function startRename(s: Session) {
    setContextMenu(null)
    setRenaming({ id: s.id, value: s.title })
  }

  async function commitRename(s: Session) {
    const title = renaming?.value.trim() || s.title
    setRenaming(null)
    if (title === s.title) return
    await window.api.sessions.rename(s.id, title)
    setSessions(prev => prev.map(x => x.id === s.id ? { ...x, title } : x))
    if (session?.id === s.id) setSession(prev => prev ? { ...prev, title } : prev)
  }

  function togglePin(sessionId: string) {
    setContextMenu(null)
    setPinnedIds(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId)
      savePinned(next)
      return next
    })
  }

  async function saveCloudKey() {
    const key = cloudKeyInput.trim()
    await window.api.settings.set('ollama_cloud_key', key)
    setCloudKeyInput('')
    setCloudKeyConfigured(Boolean(key))
    setCloudKeyMasked(key ? `•••• ${key.slice(-4)}` : null)
    setShowCloudSetup(false)
    if (key) { const m = await window.api.models.listCloud(); setCloudModels(m) } else setCloudModels([])
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

  async function send(text?: string) {
    const rawContent = (text ?? input).trim()
    if (!rawContent || busy) return
    if (!model) { setError('No model available. Is Ollama running? Try: ollama pull <model>'); return }

    let content = rawContent
    let nativeImageBase64s: string[] | undefined
    if (text === undefined && attachments.length > 0) {
      const resolved = await resolveAttachments(attachments, { activeModel: model })
      if (resolved.error) { setError(resolved.error); return }
      content = resolved.content + rawContent
      if (resolved.nativeImages && resolved.nativeImages.length > 0) {
        nativeImageBase64s = resolved.nativeImages.map(i => i.base64)
      }
      setAttachments([])
    }

    suggestToken.current++; setSuggestions([])
    let s = session
    if (!s) {
      s = await window.api.sessions.create(props.project.id, 'chat', 'New chat')
      setSessions((prev) => [s!, ...prev]); setSession(s)
    }
    setError(''); setBusy(true)
    if (text === undefined) setInput('')
    setMessages((m) => [...m, { id: 'tmp', session_id: s!.id, role: 'user', content, model: null, created_at: Date.now() }])
    window.api.chat.send({ sessionId: s.id, projectId: props.project.id, model, content, images: nativeImageBase64s })
  }
  // Always point to the latest send so stable useCallback closures stay current
  sendRef.current = send

  const onMarkAnswered = useCallback((key: string) => {
    setAnsweredClarifications((prev) => new Set(prev).add(key))
  }, [])

  const submitClarification = useCallback((messageId: string, requestId: string, answer: Parameters<typeof formatClarificationAnswer>[0]) => {
    setAnsweredClarifications((prev) => new Set(prev).add(`${messageId}:${requestId}`))
    void sendRef.current?.(formatClarificationAnswer(answer))
  }, [])

  const submitChoiceQuestion = useCallback((messageId: string, requestId: string, answer: Parameters<typeof formatChoiceAnswer>[0]) => {
    setAnsweredClarifications((prev) => new Set(prev).add(`${messageId}:${requestId}`))
    void sendRef.current?.(formatChoiceAnswer(answer))
  }, [])

  const submitQuestionnaire = useCallback((messageId: string, requestId: string, answer: Parameters<typeof formatQuestionnaireAnswer>[0]) => {
    setAnsweredClarifications((prev) => new Set(prev).add(`${messageId}:${requestId}`))
    void sendRef.current?.(formatQuestionnaireAnswer(answer))
  }, [])

  function stop() { if (session) window.api.chat.abort(session.id) }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault()
      void send()
      return
    }
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      void send()
      return
    }
    if (e.key === 'Enter' && e.shiftKey) return
    if (e.key === 'Escape') {
      e.preventDefault()
      if (busy) stop()
      else setInput('')
      return
    }
    if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      setInput('')
    }
  }

  async function loadSuggestions(msgs: Message[]) {
    const m = modelRef.current; if (!m) return
    const myToken = ++suggestToken.current
    const convo = msgs.slice(-6).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')
    try {
      const res = await window.api.ollama.complete(m, [{ role: 'user', content: 'Given this conversation, suggest 3 short follow-up questions the user might want to ask. Return only a JSON array of strings, nothing else.\n\nConversation:\n' + convo }], 20000)
      if (myToken !== suggestToken.current) return
      setSuggestions(parseSuggestions(res))
    } catch { /* leave empty */ }
  }

  async function updateSessionTitle(sessionId: string, currentTitle: string, msgs: Message[]) {
    if (!isGenericSessionTitle(currentTitle)) return
    const exchange = firstExchange(msgs); if (!exchange) return
    const m = modelRef.current
    let title: string | null = null
    if (m) {
      try {
        const raw = await window.api.ollama.complete(m, [{ role: 'user', content: 'Write a concise 3 to 5 word title for this chat. Return only the title, no quotes, no punctuation.\n\n' + `User: ${exchange.user.content}\n\nAssistant: ${exchange.assistant.content.slice(0, 1200)}` }], 10000)
        title = cleanupGeneratedTitle(raw)
      } catch { title = null }
    }
    title = title ?? fallbackTitleFromText(exchange.user.content)
    if (!title || !isGenericSessionTitle(currentTitle)) return
    await window.api.sessions.rename(sessionId, title)
    setSession((s) => s && s.id === sessionId && isGenericSessionTitle(s.title) ? { ...s, title } : s)
    setSessions((prev) => prev.map((s) => s.id === sessionId && isGenericSessionTitle(s.title) ? { ...s, title } : s))
  }

  const saveToMemory = useCallback(async (m: Message) => {
    await window.api.memory.save({ projectId: memoryProjectId, type: 'note', title: m.content.slice(0, 60), content: m.content, source: 'chat' })
    addToast('Saved to Knowledge')
  }, [memoryProjectId, addToast])

  const copyOutput = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      addToast('Copied output')
    } catch {
      addToast('Copy failed')
    }
  }, [addToast])

  async function extractMemories() {
    if (!session || extracting) return
    setExtracting(true); setExtracted(null); setExtractError('')
    try { setExtracted(await window.api.memory.extract(memoryProjectId, session.id)) }
    catch (err) { setExtractError(err instanceof Error ? err.message : 'Memory extraction failed. Check the local model and try again.') }
    finally { setExtracting(false) }
  }

  const canExtractMemories =
    messages.some((m) => m.role === 'user' && m.content.trim().length > 0) &&
    messages.some((m) => m.role === 'assistant' && m.content.trim().length > 0)
  const contextText = [...messages.map((m) => m.content), streaming, input].filter(Boolean).join('\n')
  const estimatedTokens = estimateTokensFromText(contextText)
  const contextStatus = busy ? 'Streaming' : session ? 'Ready' : 'No active chat'

  const visibleMessages = messages.slice(Math.max(0, messages.length - RENDER_LIMIT - renderOffset))
  const pinnedSessions = sessions.filter(s => pinnedIds.has(s.id))
  const unpinnedSessions = sessions.filter(s => !pinnedIds.has(s.id))
  const ctxSession = contextMenu ? sessions.find(s => s.id === contextMenu.sessionId) : null

  return (
    <div className="chat-layout">
      {/* ── Session sidebar ── */}
      <aside className="session-list">
        <div className="session-list-header">
          <button className="session-new-btn" onClick={newSession}>
            <span className="session-new-icon">＋</span>
            New chat
          </button>
        </div>
        <div className="session-list-body">
              <ul className="motion-list motion-list-tight">
            {pinnedSessions.length > 0 && (
              <>
                {pinnedSessions.map(s => renderSessionRow(s))}
                {unpinnedSessions.length > 0 && <div className="session-pin-divider" />}
              </>
            )}
            {unpinnedSessions.map(s => renderSessionRow(s))}
          </ul>
        </div>
      </aside>

      {/* ── Main area ── */}
      <section className="chat-main">
        {!session ? (
          <>
            <div className="empty center">
              <div className="empty-icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-9 8.36 8.5 8.5 0 0 1-3.4-.71L3 20l1.07-4.28A8.5 8.5 0 1 1 21 11.5z" />
                </svg>
              </div>
              <h2>Plan here, build elsewhere.</h2>
              <p className="muted">Chat is for thinking: planning, research, architecture. What matters gets saved to the knowledge base, where Hermes and Claude Code will find it.</p>
              <button className="primary" onClick={newSession}>Start a chat</button>
            </div>
            <AiContextBar testId="context-bar-chat" model={model || undefined} mode="Chat" status={contextStatus} disabledReason="Start a chat" />
          </>
        ) : (
          <>
            <header className="chat-header">
              <span className="chat-header-title">{session.title}</span>
              <button className="ghost extract-btn" data-testid="chat-extract-memories" disabled={!canExtractMemories || extracting} onClick={extractMemories} title={canExtractMemories ? 'Review this conversation and save key decisions, preferences, and findings' : 'Extraction is available after a user and assistant exchange'}>
                {extracting ? 'Extracting...' : 'Extract memories'}
              </button>
            </header>
            <AgentStatusStrip
              agent="Chat"
              status={busy ? 'Streaming' : 'Ready'}
              tone={busy ? 'info' : 'success'}
              detail={model ? `Model: ${model.startsWith('cloud:') ? model.slice(6) : model}` : 'No model selected'}
            />

            <div className="chat-scroll" ref={scrollRef}>
              {messages.length > RENDER_LIMIT + renderOffset && (
                <button className="ghost load-older-btn" onClick={() => setRenderOffset((o) => o + RENDER_LIMIT)}>
                  Load older messages
                </button>
              )}
              {visibleMessages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  answeredClarifications={answeredClarifications}
                  onMarkAnswered={onMarkAnswered}
                  onCopy={copyOutput}
                  onSave={saveToMemory}
                  onSubmitClarification={submitClarification}
                  onSubmitChoice={submitChoiceQuestion}
                  onSubmitQuestionnaire={submitQuestionnaire}
                />
              ))}
              {streaming && (
                <div className="msg assistant">
                  <div className="msg-body md-body"><Markdown>{streaming}</Markdown><span className="cursor">▋</span></div>
                </div>
              )}
            </div>

            {(extracted || extractError) && (
              <div className={`extract-results ${extractError ? 'error' : ''}`} data-testid="chat-extract-results">
                <div className="extract-results-head">
                  <span className="extract-results-title">
                    {extractError ? extractError : extracted && extracted.length > 0 ? `✦ Saved ${extracted.length} ${extracted.length === 1 ? 'memory' : 'memories'} to the knowledge base` : 'No new memories found in this conversation'}
                  </span>
                  <button className="ghost tiny" onClick={() => setExtracted(null)} title="Dismiss">✕</button>
                </div>
                {extracted && extracted.length > 0 && (
                  <ul className="extract-list motion-list motion-list-tight">
                    {extracted.map((it) => (
                      <li key={it.id}><span className={`pill pill-${it.type}`}>{it.type}</span><span className="extract-item-title">{it.title}</span></li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {suggestions.length > 0 && !busy && (
              <div className="suggestions" role="group" aria-label="Suggested follow-ups">
                {suggestions.map((q, i) => <button key={i} className="suggestion-pill" onClick={() => send(q)} title={q}>{q}</button>)}
              </div>
            )}

            {error && <div className="error-bar">{error}</div>}

            <AiContextBar
              testId="context-bar-chat"
              usedTokens={chatUsage?.used ?? estimatedTokens}
              tokensApproximate={true}
              model={(model.startsWith('cloud:') ? model.slice(6) : model) || undefined}
              mode="Chat"
              status={contextStatus}
            />

            <div className="composer">
              <AttachmentChips
                attachments={attachments}
                models={models}
                activeModel={model}
                onRemove={id => setAttachments(prev => prev.filter(a => a.id !== id))}
                onVisionModelChange={(id, vm) => setAttachments(prev => prev.map(a => a.id === id ? { ...a, visionModel: vm } : a))}
              />
              <textarea
                ref={textareaRef}
                data-composer="true"
                placeholder="Plan, ask, research…  (Enter to send · Shift+Enter for newline)"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
              />
              <div className="composer-bar">
                <div className="model-picker-wrap">
                  <div className="model-select">
                    <select value={model} onChange={(e) => setModel(e.target.value)} title="Model">
                      <optgroup label="LOCAL MODELS">
                        {models.length === 0 && <option value="">No local models found</option>}
                        {models.map((m) => <option key={m} value={m} disabled={m.includes('embed')}>{m}</option>)}
                      </optgroup>
                      {cloudModels.length > 0 && (
                        <optgroup label="OLLAMA CLOUD">
                          {cloudModels.map((m) => <option key={m.id} value={`cloud:${m.id}`}>{m.name}</option>)}
                        </optgroup>
                      )}
                      {cloudModels.length === 0 && !cloudKeyConfigured && (
                        <optgroup label="OLLAMA CLOUD"><option value="" disabled>Add API key to use cloud models</option></optgroup>
                      )}
                    </select>
                    <span className="model-select-chevron">⌄</span>
                  </div>
                  <button className={`ghost icon-btn cloud-cfg-btn ${showCloudSetup ? 'on' : ''}`} onClick={() => setShowCloudSetup((v) => !v)} title="Configure Ollama Cloud API key">⚙</button>
                  {showCloudSetup && (
                    <div className="cloud-key-popover">
                      <div className="cloud-key-label">Ollama Cloud API key</div>
                      <div className="cloud-key-row">
                        <input type="password" className="cloud-key-input" placeholder={cloudKeyConfigured ? 'Enter a new key to replace existing' : 'ollama_...'} value={cloudKeyInput} onChange={(e) => setCloudKeyInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveCloudKey() }} autoFocus />
                        <button className="primary" onClick={() => void saveCloudKey()}>Save</button>
                      </div>
                      <div className="cloud-key-hint muted small">
                        {cloudKeyConfigured ? `Configured: ${cloudKeyMasked ?? 'saved'}` : 'Get your key at ollama.com/settings'}
                      </div>
                    </div>
                  )}
                </div>
                <div className="composer-actions">
                  {busy && tokPerSec > 0 && (
                    <div className="token-flow-wrap">
                      <div className="token-flow-bar">
                        <div className="token-flow-fill" style={{ width: `${Math.min(100, (tokPerSec / 30) * 100)}%` }} />
                      </div>
                      <span className="token-flow-label">{Math.round(tokPerSec)} tok/s</span>
                    </div>
                  )}
                  <button className="composer-attach-btn" onClick={() => void pickFile()} title="Attach file" aria-label="Attach file" disabled={busy}>📎</button>
                  <VoiceInputButton testId="voice-input-chat" value={input} onChange={setInput} disabled={busy} label="Voice input for Chat" />
                  {busy
                    ? <button className="danger send-btn stop-btn" onClick={stop} title="Stop generating">■ Stop</button>
                    : <button className="send-btn" onClick={() => void send()}>Send</button>
                  }
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── Context menu portal ── */}
      {contextMenu && ctxSession && createPortal(
        <div
          className="session-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onPointerDown={e => e.stopPropagation()}
        >
          <button className="session-context-item" onClick={() => togglePin(contextMenu.sessionId)}>
            {pinnedIds.has(contextMenu.sessionId) ? 'Unpin' : 'Pin'}
          </button>
          <button className="session-context-item" onClick={() => startRename(ctxSession)}>Rename</button>
          <div className="session-context-divider" />
          <button className="session-context-item danger" onClick={() => { setContextMenu(null); void deleteSession(ctxSession) }}>Delete</button>
        </div>,
        document.body
      )}
    </div>
  )

  function renderSessionRow(s: Session) {
    const isActive = session?.id === s.id
    const isRenaming = renaming?.id === s.id
    return (
      <li key={s.id} className="session-row">
        <button
          className={`session-item${isActive ? ' active' : ''}`}
          onClick={() => { if (!isRenaming) setSession(s) }}
        >
          {isRenaming ? (
            <input
              className="session-rename-input"
              value={renaming.value}
              onChange={e => setRenaming({ id: s.id, value: e.target.value })}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); void commitRename(s) }
                if (e.key === 'Escape') setRenaming(null)
              }}
              onBlur={() => void commitRename(s)}
              autoFocus
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span className="session-item-title">{s.title}</span>
          )}
        </button>
        <button
          className="session-dot-menu"
          title="Session options"
          aria-label={`Options for ${s.title}`}
          onClick={e => openContextMenu(e, s)}
        >
          ⋯
        </button>
      </li>
    )
  }
}
