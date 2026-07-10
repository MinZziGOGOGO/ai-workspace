import { useCallback } from 'react'
import type { Message } from './types'

// True only for the single most-recent assistant-role message in the list —
// older assistant turns (and any 'tool' log entries after them) don't count.
export function isLastAssistantMessage(messages: Message[], id: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].id === id
  }
  return false
}

function findPrecedingUserMessage(messages: Message[], beforeId: string): Message | null {
  const idx = messages.findIndex((m) => m.id === beforeId)
  if (idx === -1) return null
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i]
  }
  return null
}

export function countMessagesAfter(messages: Message[], id: string): number {
  const idx = messages.findIndex((m) => m.id === id)
  if (idx === -1) return 0
  return messages.length - idx - 1
}

export interface MessageActionsDeps {
  sessionId: string | undefined
  messages: Message[]
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  busy: boolean
  /** Re-fetch the persisted message list for a session (each tab's own IPC call). */
  fetchMessages: (sessionId: string) => Promise<Message[]>
  /** Kick off a fresh model/agent turn reusing an existing user message. */
  resend: (content: string, regenerateMessageId: string) => void
  onError?: (message: string) => void
}

// Shared regenerate / edit-resend / reaction logic for all four agent tabs.
// Each tab supplies its own fetchMessages/resend since the underlying send
// IPC and running-state fields differ, but the message-graph surgery
// (delete-after, then resend without duplicating the user turn) is identical.
export function useMessageActions(deps: MessageActionsDeps) {
  const { sessionId, messages, setMessages, busy, fetchMessages, resend, onError } = deps

  const regenerate = useCallback(async () => {
    if (!sessionId || busy) return
    let lastAssistant: Message | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') { lastAssistant = messages[i]; break }
    }
    if (!lastAssistant) return
    const precedingUser = findPrecedingUserMessage(messages, lastAssistant.id)
    if (!precedingUser) return
    const result = await window.api.messages.deleteAfter(sessionId, precedingUser.id)
    if (!result.success) {
      onError?.(`Failed to regenerate response: ${result.error ?? 'unknown error'}`)
      return
    }
    const fresh = await fetchMessages(sessionId)
    setMessages(() => fresh)
    resend(precedingUser.content, precedingUser.id)
  }, [sessionId, messages, busy, fetchMessages, resend, setMessages, onError])

  const editAndResend = useCallback(async (messageId: string, newContent: string) => {
    if (!sessionId || busy) return
    const after = countMessagesAfter(messages, messageId)
    if (after > 2) {
      const ok = window.confirm(`This will remove ${after} messages after this point. Continue?`)
      if (!ok) return
    }
    const updateResult = await window.api.messages.update(messageId, newContent)
    if (!updateResult.success) {
      onError?.(`Failed to update message: ${updateResult.error ?? 'unknown error'}`)
      return
    }
    const deleteResult = await window.api.messages.deleteAfter(sessionId, messageId)
    if (!deleteResult.success) {
      onError?.(`Failed to prepare edited resend: ${deleteResult.error ?? 'unknown error'}`)
      return
    }
    const fresh = await fetchMessages(sessionId)
    setMessages(() => fresh)
    resend(newContent, messageId)
  }, [sessionId, messages, busy, fetchMessages, resend, setMessages, onError])

  const setReaction = useCallback(async (messageId: string, reaction: 'up' | 'down') => {
    const current = messages.find((m) => m.id === messageId)
    const next: 'up' | 'down' | null = current?.reaction === reaction ? null : reaction
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reaction: next } : m)))
    const result = await window.api.messages.setReaction(messageId, next)
    if (!result.success) {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reaction: current?.reaction ?? null } : m)))
      onError?.(`Failed to save reaction: ${result.error ?? 'unknown error'}`)
    }
  }, [messages, setMessages, onError])

  return { regenerate, editAndResend, setReaction }
}
