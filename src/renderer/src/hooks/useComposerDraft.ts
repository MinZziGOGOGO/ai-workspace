import { useEffect, useRef, useState } from 'react'

const DEBOUNCE_MS = 400

function loadDrafts(storageKey: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(storageKey) ?? '{}') } catch { return {} }
}

function saveDrafts(storageKey: string, drafts: Record<string, string>) {
  try { localStorage.setItem(storageKey, JSON.stringify(drafts)) } catch { /* storage full/unavailable */ }
}

function flush(storageKey: string, sessionId: string | null | undefined, value: string) {
  if (!sessionId) return
  const drafts = loadDrafts(storageKey)
  if (value) drafts[sessionId] = value
  else delete drafts[sessionId]
  saveDrafts(storageKey, drafts)
}

/**
 * Composer draft text keyed by session id, persisted to localStorage (same
 * pattern as ChatTab's PINNED_KEY/MODEL_CHOICE_KEY) so an unsent draft
 * survives a panel unmount/remount — e.g. fullscreening another panel today,
 * or moving a panel to its own detached window once that lands. Writes are
 * debounced while typing and flushed immediately on session switch/unmount.
 */
export function useComposerDraft(
  storageKey: string,
  sessionId: string | null | undefined
): readonly [string, (value: string) => void] {
  const [draft, setDraftState] = useState(() => (sessionId ? loadDrafts(storageKey)[sessionId] ?? '' : ''))
  const sessionIdRef = useRef(sessionId)
  const draftRef = useRef(draft)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const previousSessionId = sessionIdRef.current
    // Flush the outgoing session's pending draft before switching, so a fast
    // session change doesn't drop keystrokes still waiting on the debounce.
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    flush(storageKey, previousSessionId, draftRef.current)
    sessionIdRef.current = sessionId

    if (previousSessionId) {
      // A real session's composer is switching to a different session (or to
      // none) — load whatever that destination already has.
      const next = sessionId ? loadDrafts(storageKey)[sessionId] ?? '' : ''
      draftRef.current = next
      setDraftState(next)
    } else if (sessionId) {
      // No session → a session now exists under an in-progress draft (e.g. a
      // prefilled prompt typed before "New chat" created one). That draft wins
      // when non-empty. A freshly remounted panel also starts with no session,
      // so its blank initial value instead hydrates the stored session draft.
      const stored = loadDrafts(storageKey)[sessionId] ?? ''
      if (!draftRef.current && stored) {
        draftRef.current = stored
        setDraftState(stored)
      } else {
        flush(storageKey, sessionId, draftRef.current)
      }
    }
  }, [storageKey, sessionId])

  useEffect(() => {
    function flushNow() {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      flush(storageKey, sessionIdRef.current, draftRef.current)
    }
    window.addEventListener('composer:flushDrafts', flushNow)
    return () => {
      window.removeEventListener('composer:flushDrafts', flushNow)
      if (timerRef.current) clearTimeout(timerRef.current)
      flush(storageKey, sessionIdRef.current, draftRef.current)
    }
    // Flush-on-unmount only; storageKey/sessionId changes are handled by the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function setDraft(value: string) {
    setDraftState(value)
    draftRef.current = value
    const sid = sessionIdRef.current
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => flush(storageKey, sid, value), DEBOUNCE_MS)
  }

  return [draft, setDraft] as const
}
