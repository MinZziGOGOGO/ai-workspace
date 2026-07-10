import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import anime, {
  AnimatedScaleBar,
  animateScrollToBottom,
  cascadeItems,
  prefersReducedMotion,
  stopMotion,
  usePressMotion,
  type MotionHandle,
} from '../motion'
import type { Project, Session, Message, MemoryItem } from '../types'
import { AttachmentChips, resolveAttachments } from './ComposerAttachments'
import { useComposerAttachments } from '../hooks/useComposerAttachments'
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
import TipBanner from './TipBanner'
import AiContextBar, { estimateTokensFromText } from './AiContextBar'
import VoiceInputButton from './VoiceInputButton'
import { useToast } from './ToastContext'
import { useAgentActivity } from '../AgentActivityContext'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { cleanupGeneratedTitle, fallbackTitleFromText, firstExchange, isGenericSessionTitle } from '../../../shared/sessionTitles'
import { AgentSessionRail, AgentStatusStrip, EditableUserMessage, OutputActions, SessionContextMenu, useAutoSessionSummary, useConfirmDestructive, useStatusPhrase } from './AgentPanelPrimitives'
import { isLastAssistantMessage, useMessageActions } from '../messageActions'
import { useCompletionNotifier } from '../notify'
import {
  HANDOFF_AGENT_LABELS,
  HANDOFF_TRIGGER,
  isAgentAvailable,
  resolveHandoffTarget,
  type HandoffAgent
} from '../handoff'

const PINNED_KEY = 'aiworkspace.chat.pinned'
const RENDER_LIMIT = 50

type ChatMode = 'plan' | 'execute'

const PLAN_SYSTEM_PROMPT =
  'You are in planning mode. Focus on brainstorming, asking clarifying ' +
  'questions, exploring options and tradeoffs with the user. Do not ' +
  'write final, complete code or make final architectural decisions ' +
  'unilaterally — help the user think through the problem and arrive ' +
  'at a plan together. It\'s fine to sketch code snippets to illustrate ' +
  'ideas, but don\'t treat any output as final until the user confirms ' +
  'a direction.'

const EXECUTE_SYSTEM_PROMPT =
  'You are in execution mode. The user is ready to finalize a concrete, ' +
  'actionable plan. Be decisive and specific: name exact files, exact ' +
  'function names, exact steps. Help the user arrive at a plan detailed ' +
  'enough to hand off to a coding agent (Claude Code, Hermes, or Codex) ' +
  'as a ready-to-execute prompt. When the user indicates they\'re ready ' +
  'to send this plan to an agent, you may be asked to draft that ' +
  'handoff prompt.'

// The in-flight handoff preview card. Not a chat message — a distinct UI card
// rendered in the chat scroll while a handoff is being prepared/confirmed.
interface HandoffState {
  agent: HandoffAgent
  status: 'generating' | 'ready' | 'sending' | 'sent' | 'error'
  prompt: string
  newSession: boolean
  sessionTitle?: string
  editing: boolean
  error?: string
  confirmLabel?: string
}

function loadPinned(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')) } catch { return new Set() }
}
function savePinned(s: Set<string>) {
  localStorage.setItem(PINNED_KEY, JSON.stringify([...s]))
}

// Time-aware greeting for the empty state, with a couple of variants per
// period so repeated visits don't always read identically.
function chatEmptyHeadings(): string[] {
  const h = new Date().getHours()
  if (h < 5) return ['Hello, night owl', 'Still at it?']
  if (h < 12) return ['Good morning', 'Hello, early bird']
  if (h < 18) return ['Good afternoon', 'What are we thinking through?']
  if (h < 22) return ['Good evening', 'What are we planning tonight?']
  return ['Hello, night owl', 'One more idea before bed?']
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

const MessageItem = React.memo(function MessageItem({ message: m, answeredClarifications, onMarkAnswered, onCopy, onSave, onSubmitClarification, onSubmitChoice, onSubmitQuestionnaire, onEditResend, editDisabled, isLastAssistant, onRegenerate, onReaction }: {
  message: Message
  answeredClarifications: Set<string>
  onMarkAnswered: (key: string) => void
  onCopy: (text: string) => void
  onSave: (m: Message) => void
  onSubmitClarification: (msgId: string, reqId: string, answer: Parameters<typeof formatClarificationAnswer>[0]) => void
  onSubmitChoice: (msgId: string, reqId: string, answer: Parameters<typeof formatChoiceAnswer>[0]) => void
  onSubmitQuestionnaire: (msgId: string, reqId: string, answer: Parameters<typeof formatQuestionnaireAnswer>[0]) => void
  onEditResend: (id: string, content: string) => void
  editDisabled: boolean
  isLastAssistant: boolean
  onRegenerate: () => void
  onReaction: (id: string, reaction: 'up' | 'down') => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const msgAnimRef = useRef<MotionHandle>(null)
  const codeAnimRef = useRef<MotionHandle>(null)
  useEffect(() => {
    const el = wrapRef.current
    if (!el || prefersReducedMotion()) return
    stopMotion(msgAnimRef.current)
    msgAnimRef.current = anime(el, m.role === 'user'
      ? { translateX: [14, 0], translateY: [8, 0], opacity: [0, 1], scale: [0.975, 1], duration: 300, ease: 'cubic-bezier(0.19, 1, 0.22, 1)' }
      : { translateX: [-12, 0], translateY: [10, 0], opacity: [0, 1], scale: [0.985, 1], duration: 460, ease: 'cubic-bezier(0.19, 1, 0.22, 1)' }
    )
    if (m.role !== 'user') {
      const codeBlocks = el.querySelectorAll('.md-body pre, .prompt-output-card')
      if (codeBlocks.length > 0) {
        codeAnimRef.current = cascadeItems(codeBlocks, { y: 6, duration: 360, delay: 44 })
      }
    }
    return () => {
      stopMotion(msgAnimRef.current)
      stopMotion(codeAnimRef.current)
    }
  }, [])

  if (m.role === 'user') {
    return (
      <div ref={wrapRef}>
        <EditableUserMessage
          content={m.content}
          timestamp={m.created_at}
          disabled={editDisabled}
          onSaveResend={(newContent) => onEditResend(m.id, newContent)}
          onCopy={() => onCopy(m.content)}
        />
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
    <div className="msg assistant" ref={wrapRef}>
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
        <span className="msg-timestamp"><RelativeTime ts={m.created_at} /></span>
        <OutputActions
          onCopy={() => onCopy(m.content)}
          onSave={() => onSave(m)}
          isLast={isLastAssistant}
          onRegenerate={onRegenerate}
          reaction={m.reaction ?? null}
          onReaction={(r) => onReaction(m.id, r)}
        />
      </div>
    </div>
  )
})

interface CtxMenu { sessionId: string; x: number; y: number }

export default function ChatTab(props: { project: Project; active?: boolean }) {
  const { addToast } = useToast()
  const { setActive: setAgentActive } = useAgentActivity()
  const [sessions, setSessions] = useState<Session[]>([])
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([])
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
  const [cloudModelsError, setCloudModelsError] = useState('')
  const [cloudKeyConfigured, setCloudKeyConfigured] = useState(false)
  const [cloudKeyMasked, setCloudKeyMasked] = useState<string | null>(null)
  const [cloudKeyInput, setCloudKeyInput] = useState('')
  const [showCloudSetup, setShowCloudSetup] = useState(false)
  const [contextMenu, setContextMenu] = useState<CtxMenu | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => loadPinned())
  const [tokPerSec, setTokPerSec] = useState(0)
  const [answeredClarifications, setAnsweredClarifications] = useState<Set<string>>(() => new Set())
  const { attachments, setAttachments, isDragOver, setIsDragOver, handlePaste, pickFile, handleDrop } = useComposerAttachments()
  const [renderOffset, setRenderOffset] = useState(0)
  const confirmDestructive = useConfirmDestructive()
  // Plan/Execute mode is per-session. New sessions default to Plan. Kept in an
  // in-memory map (doesn't need to survive restart) plus a state mirror.
  const [mode, setMode] = useState<ChatMode>('plan')
  const modeMapRef = useRef<Map<string, ChatMode>>(new Map())
  const [handoff, setHandoff] = useState<HandoffState | null>(null)
  const [handoffDraft, setHandoffDraft] = useState('')
  const [checkingHandoff, setCheckingHandoff] = useState(false)
  const [emptyHeading] = useState(() => {
    const list = chatEmptyHeadings()
    return list[Math.floor(Math.random() * list.length)]
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const scrollAnimRef = useRef<MotionHandle>(null)
  const sessionSwitchAnimRef = useRef<MotionHandle>(null)
  const sessionRef = useRef<Session | null>(null)
  const sendRef = useRef<typeof send | null>(null)
  const newSessionRef = useRef<() => void>(() => {})
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sendButtonMotion = usePressMotion<HTMLButtonElement>()
  const modelRef = useRef(model)
  modelRef.current = model
  const suggestToken = useRef(0)
  const tokenTimestamps = useRef<number[]>([])
  const streamingBufferRef = useRef('')
  const streamingFrameRef = useRef<number | null>(null)
  const skipNextSessionLoad = useRef(false)
  const isGlobalWorkspace = isGlobalProjectId(props.project.id)
  const memoryProjectId = isGlobalWorkspace ? null : props.project.id
  const active = props.active ?? true
  const notifyCompletion = useCompletionNotifier(active)
  const statusPhrase = useStatusPhrase({ active: busy, hasStarted: streaming.length > 0, toolName: null, progressKey: streaming.length })
  sessionRef.current = session

  // Publish start/stop only (not per streamed token) so the topbar activity
  // badge doesn't re-render on every chunk.
  useEffect(() => {
    setAgentActive('chat', busy)
    return () => setAgentActive('chat', false)
  }, [busy, setAgentActive])

  useEffect(() => () => {
    stopMotion(scrollAnimRef.current)
    stopMotion(sessionSwitchAnimRef.current)
    if (streamingFrameRef.current !== null) cancelAnimationFrame(streamingFrameRef.current)
  }, [])

  useEffect(() => {
    window.api.sessions.list(props.project.id, 'chat').then(setSessions)
    window.api.sessions.listArchived(props.project.id, 'chat').then(setArchivedSessions)
  }, [props.project.id])

  useEffect(() => {
    function onFocusComposer(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel === 'chat') textareaRef.current?.focus()
    }
    function onNewSession(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      // Call through the ref so the handler always sees the current project,
      // not the one captured when this listener was registered.
      if (panel === 'chat') newSessionRef.current()
    }
    function onPrefillPrompt(event: Event) {
      const detail = (event as CustomEvent<{ panel?: string; prompt?: string }>).detail
      if (detail?.panel === 'chat' && typeof detail.prompt === 'string') {
        setInput(detail.prompt)
        textareaRef.current?.focus()
      }
    }
    function onSelectSession(event: Event) {
      const detail = (event as CustomEvent<{ panel?: string; session?: Session }>).detail
      if (detail?.panel === 'chat' && detail.session) selectSession(detail.session)
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

  // Poll for local models only while the panel is actually open — closed
  // panels stay mounted for state preservation, and without this gate the
  // 3-second poll would run forever whenever Ollama is down.
  useEffect(() => {
    if (!active) return
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
  }, [active])

  useAutoSessionSummary(session, messages, models[0], (sessionId, summary) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, summary } : s)))
    setSession((prev) => (prev && prev.id === sessionId ? { ...prev, summary } : prev))
  })

  async function loadCloudModels(showFailureToast = false) {
    const result = await window.api.models.listCloud()
    if (!result.success) {
      setCloudModels([])
      setCloudModelsError(result.error)
      if (showFailureToast) addToast(`Could not reach Ollama Cloud: ${result.error}`)
      return
    }
    setCloudModels(result.models)
    setCloudModelsError('')
  }

  useEffect(() => {
    window.api.settings.summary().then((summary) => {
      const status = summary.secrets.ollama_cloud_key
      setCloudKeyConfigured(Boolean(status?.configured))
      setCloudKeyMasked(status?.masked ?? null)
      if (status?.configured) void loadCloudModels()
    })
  }, [])

  // Only accept usage updates for the session currently on screen, so a
  // stream finishing after a session switch can't stamp its token count
  // onto the wrong session's context bar.
  useEffect(() => window.api.chat.onUsage((d) => {
    if (d.sessionId === session?.id) setChatUsage({ used: d.used, max: d.max })
  }), [session])

  useEffect(() => {
    if (streamingFrameRef.current !== null) {
      cancelAnimationFrame(streamingFrameRef.current)
      streamingFrameRef.current = null
    }
    streamingBufferRef.current = ''
    setMode(modeMapRef.current.get(session?.id ?? '') ?? 'plan')
    setHandoff(null); setHandoffDraft(''); setCheckingHandoff(false)
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
        streamingBufferRef.current += d.token
        if (streamingFrameRef.current === null) {
          streamingFrameRef.current = requestAnimationFrame(() => {
            streamingFrameRef.current = null
            const next = streamingBufferRef.current
            streamingBufferRef.current = ''
            if (next) setStreaming((s) => s + next)
          })
        }
        tokenTimestamps.current.push(Date.now())
      }
    })
    const offDone = window.api.chat.onDone(async (d) => {
      if (!session || d.sessionId !== session.id) return
      if (streamingFrameRef.current !== null) {
        cancelAnimationFrame(streamingFrameRef.current)
        streamingFrameRef.current = null
      }
      streamingBufferRef.current = ''
      setStreaming(''); setBusy(false); tokenTimestamps.current = []; setTokPerSec(0)
      const msgs = await window.api.chat.messages(d.sessionId)
      setMessages(msgs)
      if (msgs.some((m) => m.role === 'assistant')) void loadSuggestions(msgs)
      if (isGenericSessionTitle(session.title)) void updateSessionTitle(d.sessionId, session.title, msgs)
      notifyCompletion()
    })
    const offError = window.api.chat.onError((d) => {
      if (d.sessionId === session?.id) {
        if (streamingFrameRef.current !== null) {
          cancelAnimationFrame(streamingFrameRef.current)
          streamingFrameRef.current = null
        }
        streamingBufferRef.current = ''
        setBusy(false); setStreaming(''); setError(d.error); setTokPerSec(0)
      }
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
      const el = scrollRef.current
      if (!el) return
      stopMotion(scrollAnimRef.current)
      scrollAnimRef.current = animateScrollToBottom(el, Boolean(streaming))
    }, streaming ? 100 : 0)
  }, [messages, streaming])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    function handleDown() { setContextMenu(null) }
    document.addEventListener('pointerdown', handleDown)
    return () => document.removeEventListener('pointerdown', handleDown)
  }, [contextMenu])

  async function newSession() {
    const s = await window.api.sessions.create(props.project.id, 'chat', 'New chat')
    setSessions((prev) => [s, ...prev]); setSession(s)
  }

  async function deleteSession(target: Session) {
    const result = await window.api.sessions.delete(target.id)
    if (!result.success) {
      addToast(`Failed to delete session: ${result.error ?? 'unknown error'}`)
      return
    }
    setSessions((prev) => prev.filter((s) => s.id !== target.id))
    setArchivedSessions((prev) => prev.filter((s) => s.id !== target.id))
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
    setPinnedIds(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId)
      savePinned(next)
      return next
    })
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
      if (session?.id === target.id) {
        setSession(null); setMessages([]); setStreaming(''); setSuggestions([])
        setExtracted(null); setExtractError(''); setError('')
      }
    } else {
      setArchivedSessions(prev => prev.filter(x => x.id !== target.id))
      setSessions(prev => [{ ...target, archived: 0 }, ...prev])
    }
    addToast(archive ? 'Session archived' : 'Session unarchived')
  }

  async function saveCloudKey() {
    const key = cloudKeyInput.trim()
    await window.api.settings.set('ollama_cloud_key', key)
    setCloudKeyInput('')
    setCloudKeyConfigured(Boolean(key))
    setCloudKeyMasked(key ? `•••• ${key.slice(-4)}` : null)
    setShowCloudSetup(false)
    if (key) void loadCloudModels(true)
    else { setCloudModels([]); setCloudModelsError('') }
  }

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
      setSession(null); setMessages([]); setStreaming(''); setSuggestions([])
      setExtracted(null); setExtractError(''); setError('')
    }
    addToast(`${idSet.size} session${idSet.size === 1 ? '' : 's'} deleted`)
  }

  async function send(text?: string) {
    const rawContent = (text ?? input).trim()
    if (!rawContent || busy) return
    if (!model) { setError('No model available. Is Ollama running? Try: ollama pull <model>'); return }

    // Handoff detection runs ONLY in Execute mode, and only for messages the user
    // actually typed (text === undefined). A loose regex gates the classifier; if
    // it decides this is a real handoff, the message becomes the handoff request
    // instead of a normal chat turn. Anything else falls through to normal chat.
    if (text === undefined && mode === 'execute' && HANDOFF_TRIGGER.test(rawContent)) {
      const handled = await tryHandoff(rawContent)
      if (handled) return
    }

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
    const systemPrefix = mode === 'execute' ? EXECUTE_SYSTEM_PROMPT : PLAN_SYSTEM_PROMPT
    window.api.chat.send({ sessionId: s.id, projectId: props.project.id, model, content, images: nativeImageBase64s, systemPrefix })
  }
  // Always point to the latest send so stable useCallback closures stay current
  sendRef.current = send
  newSessionRef.current = () => void newSession()

  function changeMode(next: ChatMode) {
    setMode(next)
    if (session) modeMapRef.current.set(session.id, next)
  }

  // Classify a typed Execute-mode message that matched the loose regex, then (if
  // it's a real handoff) generate the prompt and surface the preview card.
  // Returns true when the message was consumed as a handoff request.
  async function tryHandoff(userMessage: string): Promise<boolean> {
    setCheckingHandoff(true)
    const convo = messages.slice(-10).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')
    let cls: { handoff: boolean; agent: string | null; newSession: boolean } | null = null
    try {
      cls = await window.api.chat.classifyHandoff({ model, conversationContext: convo, userMessage })
    } catch {
      cls = null
    } finally {
      setCheckingHandoff(false)
    }
    // Classification failed or said "not a handoff" → fall back to normal chat.
    if (!cls || !cls.handoff || !cls.agent) return false
    const agent = cls.agent as HandoffAgent

    setInput('')
    const target = resolveHandoffTarget(agent, cls.newSession)
    setHandoff({ agent, status: 'generating', prompt: '', newSession: target.newSession, sessionTitle: target.title, editing: false })

    const history = [
      ...messages.slice(-20).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`),
      `User: ${userMessage}`
    ].join('\n')
    try {
      const gen = await window.api.chat.generateHandoffPrompt({ model, agent, conversationHistory: history })
      if (!gen || !gen.trim()) {
        setHandoff((h) => (h ? { ...h, status: 'error', error: 'Could not generate a handoff prompt. Try again.' } : h))
      } else {
        setHandoff((h) => (h ? { ...h, prompt: gen.trim(), status: 'ready' } : h))
      }
    } catch {
      setHandoff((h) => (h ? { ...h, status: 'error', error: 'Could not generate a handoff prompt. Try again.' } : h))
    }
    return true
  }

  function startEditHandoff() {
    setHandoffDraft(handoff?.prompt ?? '')
    setHandoff((h) => (h ? { ...h, editing: true } : h))
  }
  function saveEditHandoff() {
    setHandoff((h) => (h ? { ...h, prompt: handoffDraft, editing: false } : h))
  }
  function cancelEditHandoff() {
    setHandoff((h) => (h ? { ...h, editing: false } : h))
  }
  function dismissHandoff() {
    setHandoff(null)
    setHandoffDraft('')
  }

  async function performHandoffSend() {
    if (!handoff || handoff.status !== 'ready') return
    const agent = handoff.agent
    if (!isAgentAvailable(agent)) {
      setHandoff((h) => (h ? { ...h, status: 'error', error: `Couldn't send — ${HANDOFF_AGENT_LABELS[agent]} isn't available.` } : h))
      return
    }
    const target = resolveHandoffTarget(agent, handoff.newSession)
    setHandoff((h) => (h ? { ...h, status: 'sending' } : h))
    // Open the target panel (if closed) and deliver via its own send path.
    window.dispatchEvent(new CustomEvent('workspace:openPanel', { detail: { panel: agent } }))
    window.dispatchEvent(new CustomEvent('panel:handoffSend', {
      detail: { panel: agent, prompt: handoff.prompt, newSession: target.newSession, sessionId: target.sessionId }
    }))
    const confirmLabel = target.newSession ? 'New session created' : `Continuing: '${target.title ?? 'session'}'`
    setHandoff((h) => (h ? { ...h, status: 'sent', confirmLabel } : h))
    addToast(`Prompt sent to ${HANDOFF_AGENT_LABELS[agent]}`)
    void window.api.tips.markHandoffUsed()
  }

  async function copyHandoffPrompt() {
    if (!handoff) return
    try {
      await navigator.clipboard.writeText(handoff.prompt)
      addToast('Copied prompt')
    } catch {
      addToast('Copy failed')
    }
  }

  function viewHandoffPanel() {
    if (!handoff) return
    window.dispatchEvent(new CustomEvent('workspace:openPanel', { detail: { panel: handoff.agent } }))
  }

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
    const result = await window.api.sessions.rename(sessionId, title)
    if (!result.success) {
      addToast(`Failed to rename session: ${result.error ?? 'unknown error'}`)
      return
    }
    setSession((s) => s && s.id === sessionId && isGenericSessionTitle(s.title) ? { ...s, title } : s)
    setSessions((prev) => prev.map((s) => s.id === sessionId && isGenericSessionTitle(s.title) ? { ...s, title } : s))
  }

  const saveToMemory = useCallback(async (m: Message) => {
    try {
      await window.api.memory.save({ projectId: memoryProjectId, type: 'note', title: m.content.slice(0, 60), content: m.content, source: 'chat' })
      addToast('Saved to Knowledge')
      window.dispatchEvent(new CustomEvent('knowledge:pulse'))
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Memory was skipped')
    }
  }, [memoryProjectId, addToast])

  const copyOutput = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      addToast('Copied output')
    } catch {
      addToast('Copy failed')
    }
  }, [addToast])

  // Regenerate / edit-resend / reactions — shared logic lives in the hook,
  // this tab only supplies how to fetch messages and how to kick a fresh turn.
  const chatResend = useCallback((content: string, regenerateMessageId: string) => {
    if (!session || busy) return
    if (!model) { setError('No model available. Is Ollama running? Try: ollama pull <model>'); return }
    setError(''); setBusy(true)
    const systemPrefix = mode === 'execute' ? EXECUTE_SYSTEM_PROMPT : PLAN_SYSTEM_PROMPT
    window.api.chat.send({ sessionId: session.id, projectId: props.project.id, model, content, systemPrefix, regenerateMessageId })
  }, [session, busy, model, mode, props.project.id])

  const fetchChatMessages = useCallback((sid: string) => window.api.chat.messages(sid), [])

  const { regenerate, editAndResend, setReaction } = useMessageActions({
    sessionId: session?.id,
    messages,
    setMessages,
    busy,
    fetchMessages: fetchChatMessages,
    resend: chatResend,
    onError: addToast
  })

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
  const estimatedTokens = useMemo(
    () => estimateTokensFromText([...messages.map((m) => m.content), streaming, input].filter(Boolean).join('\n')),
    [messages, streaming, input]
  )
  const contextStatus = busy ? 'Streaming' : session ? 'Ready' : 'No active chat'

  const visibleMessages = messages.slice(Math.max(0, messages.length - RENDER_LIMIT - renderOffset))

  // Context line + unified composer shell, shared between the empty state and
  // an active session — the empty state IS the composer, ready to type into.
  const composerBlock = (
    <>
      <AiContextBar
        testId="context-bar-chat"
        usedTokens={session ? (chatUsage?.used ?? estimatedTokens) : undefined}
        tokensApproximate={true}
        model={(model.startsWith('cloud:') ? model.slice(6) : model) || undefined}
        mode="Chat"
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
          models={models}
          activeModel={model}
          onRemove={id => setAttachments(prev => prev.filter(a => a.id !== id))}
          onVisionModelChange={(id, vm) => setAttachments(prev => prev.map(a => a.id === id ? { ...a, visionModel: vm } : a))}
        />
        <textarea
          ref={textareaRef}
          data-composer="true"
          data-testid="chat-composer"
          placeholder="Plan, ask, research…  (Enter to send · Shift+Enter for newline)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        <div className="composer-bar">
          <div className="composer-bar-left">
            <button className="composer-icon-btn" onClick={() => void pickFile()} title="Attach file" aria-label="Attach file" disabled={busy}>＋</button>
            <div className="mode-pill-toggle" role="group" aria-label="Plan or execute mode" data-testid="chat-mode-pill">
              <button
                className={mode === 'plan' ? 'active' : ''}
                data-testid="chat-mode-plan"
                onClick={() => changeMode('plan')}
                title="Planning mode — brainstorm and explore options"
              >Plan</button>
              <button
                className={mode === 'execute' ? 'active' : ''}
                data-testid="chat-mode-execute"
                onClick={() => changeMode('execute')}
                title="Execution mode — finalize a concrete, handoff-ready plan"
              >Execute</button>
            </div>
          </div>
          <div className="composer-bar-right">
            {busy && tokPerSec > 0 && (
              <div className="token-flow-wrap">
                <div className="token-flow-bar">
                  <AnimatedScaleBar className="token-flow-fill" value={Math.min(1, tokPerSec / 30)} />
                </div>
                <span className="token-flow-label">{Math.round(tokPerSec)} tok/s</span>
              </div>
            )}
            <div className="model-picker-wrap">
              <div className="model-select model-picker-plain">
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
                  {cloudModels.length === 0 && cloudKeyConfigured && cloudModelsError && (
                    <optgroup label="OLLAMA CLOUD"><option value="" disabled>Could not reach Ollama Cloud - check your API key</option></optgroup>
                  )}
                  {cloudModels.length === 0 && !cloudKeyConfigured && (
                    <optgroup label="OLLAMA CLOUD"><option value="" disabled>Add API key to use cloud models</option></optgroup>
                  )}
                </select>
                <span className="model-select-chevron">⌄</span>
              </div>
              <button className={`composer-icon-btn cloud-cfg-btn ${showCloudSetup ? 'on' : ''}`} onClick={() => setShowCloudSetup((v) => !v)} title="Configure Ollama Cloud API key">⚙</button>
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
            <VoiceInputButton testId="voice-input-chat" value={input} onChange={setInput} disabled={busy} label="Voice input for Chat" />
            {busy
              ? <button ref={sendButtonMotion.ref} {...sendButtonMotion.pressHandlers} className="composer-send-btn stop" onClick={stop} title="Stop generating">Stop</button>
              : <button ref={sendButtonMotion.ref} {...sendButtonMotion.pressHandlers} className="composer-send-btn" data-testid="chat-send" onClick={() => void send()}>Send</button>
            }
          </div>
        </div>
      </div>
    </>
  )

  const ctxSession = contextMenu ? [...sessions, ...archivedSessions].find(s => s.id === contextMenu.sessionId) : null

  return (
    <div className="chat-layout">
      {/* ── Session sidebar ── */}
      <AgentSessionRail
        sessions={sessions}
        archivedSessions={archivedSessions}
        activeSessionId={session?.id}
        pinnedIds={pinnedIds}
        renaming={renaming}
        newLabel="New chat"
        newTitle="Start a new chat"
        emptyLabel="No chats yet"
        onNew={newSession}
        onSelect={selectSession}
        onOptions={openContextMenu}
        onRenameChange={(value) => renaming && setRenaming({ ...renaming, value })}
        onRenameCommit={(s) => void commitRename(s)}
        onRenameCancel={() => setRenaming(null)}
        onDeleteMany={deleteManySessions}
      />

      {/* ── Main area ── */}
      <section className="chat-main">
        <TipBanner />
        {!session ? (
          <div className="empty-hero">
            <h2 className="empty-state-heading">
              <span className="empty-state-icon" style={{ color: 'var(--accent-chat)' }} aria-hidden>
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-9 8.36 8.5 8.5 0 0 1-3.4-.71L3 20l1.07-4.28A8.5 8.5 0 1 1 21 11.5z" />
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
              <button className="ghost extract-btn" data-testid="chat-extract-memories" disabled={!canExtractMemories || extracting} onClick={extractMemories} title={canExtractMemories ? 'Review this conversation and save key decisions, preferences, and findings' : 'Extraction is available after a user and assistant exchange'}>
                {extracting ? 'Extracting...' : 'Extract memories'}
              </button>
            </header>
            <AgentStatusStrip
              agent="Chat"
              status={busy ? (statusPhrase ?? 'Streaming') : 'Ready'}
              tone={busy ? 'info' : 'success'}
              running={busy}
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
                  onEditResend={editAndResend}
                  editDisabled={busy}
                  isLastAssistant={isLastAssistantMessage(messages, m.id) && !busy}
                  onRegenerate={regenerate}
                  onReaction={setReaction}
                />
              ))}
              {streaming && (
                <div className="msg assistant">
                  <div className="msg-body md-body"><Markdown>{streaming}</Markdown><span className="cursor">▋</span></div>
                </div>
              )}
              {checkingHandoff && (
                <div className="handoff-checking" data-testid="handoff-checking">
                  <span className="cursor">▋</span> Checking for handoff…
                </div>
              )}
              {handoff && (
                <div className="handoff-card" data-testid="handoff-card">
                  <div className="handoff-card-header">
                    <span className="handoff-card-title">
                      📤 {handoff.status === 'sent' ? 'Sent to' : 'Ready to send to'} {HANDOFF_AGENT_LABELS[handoff.agent]}
                    </span>
                    <button className="handoff-card-close" title="Cancel" aria-label="Cancel handoff" onClick={dismissHandoff}>✕</button>
                  </div>
                  {handoff.status !== 'sent' && (
                    <div className="handoff-card-session">
                      {handoff.newSession ? 'Session: New session' : `Session: Continuing "${handoff.sessionTitle ?? 'session'}"`}
                    </div>
                  )}
                  {handoff.status === 'generating' && (
                    <div className="handoff-card-body">
                      <div className="handoff-card-skeleton"><span className="cursor">▋</span> Generating handoff prompt…</div>
                    </div>
                  )}
                  {handoff.status === 'error' && <div className="handoff-card-error">{handoff.error}</div>}
                  {(handoff.status === 'ready' || handoff.status === 'sending' || handoff.status === 'sent') && (
                    handoff.editing ? (
                      <div className="handoff-card-body">
                        <textarea
                          value={handoffDraft}
                          onChange={(e) => setHandoffDraft(e.target.value)}
                          aria-label="Edit handoff prompt"
                          data-testid="handoff-edit"
                        />
                      </div>
                    ) : (
                      <div className="handoff-card-body"><Markdown>{handoff.prompt}</Markdown></div>
                    )
                  )}
                  {handoff.status === 'sent' ? (
                    <div className="handoff-card-confirm" data-testid="handoff-confirm">
                      <span>✓ Sent to {HANDOFF_AGENT_LABELS[handoff.agent]} — {handoff.confirmLabel}</span>
                      <button onClick={viewHandoffPanel}>View</button>
                    </div>
                  ) : handoff.editing ? (
                    <div className="handoff-card-actions">
                      <button onClick={cancelEditHandoff}>Cancel</button>
                      <button className="primary" onClick={saveEditHandoff}>Save</button>
                    </div>
                  ) : (
                    <div className="handoff-card-actions">
                      <button onClick={dismissHandoff}>Cancel</button>
                      {handoff.status === 'error' && handoff.prompt ? (
                        <button onClick={() => void copyHandoffPrompt()}>Copy prompt instead</button>
                      ) : (
                        <>
                          <button onClick={startEditHandoff} disabled={handoff.status !== 'ready'}>Edit</button>
                          <button className="primary" data-testid="handoff-send" onClick={() => void performHandoffSend()} disabled={handoff.status !== 'ready'}>Send →</button>
                        </>
                      )}
                    </div>
                  )}
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
  )

}
