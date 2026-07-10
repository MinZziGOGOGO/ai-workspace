import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Message, Session } from '../types'
import { StatusBadge, WorkspaceNotice } from './WorkspacePrimitives'
import { BreathingDot, pressElement, stopMotion, type MotionHandle } from '../motion'
import RelativeTime from './RelativeTime'
import { exchangeCount } from '../sessionSummary'

// Fires window.api.sessions.generateSummary(...) after every 4 completed
// user/assistant exchanges, and once more when the session is switched away
// from or the tab unmounts (whichever comes first). Silent on failure — a
// missing summary is not an error state, it just doesn't render.
export function useAutoSessionSummary(
  session: Session | null,
  messages: Message[],
  model: string | undefined,
  onSummary: (sessionId: string, summary: string) => void
): void {
  // Per-session snapshot: updated on every render so the cleanup for a leaving
  // session can find its own latest messages rather than the new session's.
  // When the session changes, we SET the new session's (empty) entry but the
  // old session's entry remains with its last known messages — the cleanup
  // captures the old session.id and looks up by that key.
  const sessionSnapshotRef = useRef<Map<string, { messages: Message[]; model: string | undefined }>>(new Map())
  if (session) sessionSnapshotRef.current.set(session.id, { messages, model })

  const triggeredRef = useRef<Map<string, number>>(new Map())
  const onSummaryRef = useRef(onSummary)
  onSummaryRef.current = onSummary

  const generate = useCallback(async (sessionId: string, m: string | undefined) => {
    if (!m) return
    try {
      const summary = await window.api.sessions.generateSummary(sessionId, m)
      if (summary) onSummaryRef.current(sessionId, summary)
    } catch { /* silent — no summary this round */ }
  }, [])

  useEffect(() => {
    if (!session) return
    const count = exchangeCount(messages)
    const last = triggeredRef.current.get(session.id) ?? 0
    if (count > 0 && count % 4 === 0 && count > last) {
      triggeredRef.current.set(session.id, count)
      void generate(session.id, model)
    }
  }, [messages, session, model, generate])

  useEffect(() => {
    if (!session) return
    const sessionId = session.id
    return () => {
      const snap = sessionSnapshotRef.current.get(sessionId)
      if (snap && exchangeCount(snap.messages) > 0) void generate(sessionId, snap.model)
      sessionSnapshotRef.current.delete(sessionId)
    }
  }, [session?.id, generate])
}

// ---- contextual status phrases ---------------------------------------------
// Maps a tool name (e.g. "Read", "Bash", "write_file") to a friendly phrase.
// Classification is a best-effort substring match — agents don't share a tool
// naming scheme, so this only needs to be roughly right, not exhaustive.
type ToolPhase = 'read' | 'run' | 'write' | 'other'

const READ_RE = /read|cat|glob|grep|search|find|view|list|^ls\b/i
const RUN_RE = /bash|shell|exec|command|terminal|^run\b/i
const WRITE_RE = /write|edit|apply_patch|create|update|patch/i

function classifyToolName(name: string): ToolPhase {
  if (READ_RE.test(name)) return 'read'
  if (RUN_RE.test(name)) return 'run'
  if (WRITE_RE.test(name)) return 'write'
  return 'other'
}

const TOOL_PHASE_LABELS: Record<ToolPhase, string> = {
  read: 'Reading files…',
  run: 'Running command…',
  write: 'Writing code…',
  other: 'Working…',
}

function toolPhraseFor(name: string): string {
  return TOOL_PHASE_LABELS[classifyToolName(name)]
}

// Drives the personality-driven status text shown next to the breathing dot:
// "Thinking…" before the first token/tool arrives, the matching tool phrase
// while one is in flight, and "Still working…" after a >10s stall mid-stream.
// Returns null when none of those apply, so the caller falls back to its own
// default status text (e.g. "Streaming", "Running").
export function useStatusPhrase(opts: {
  active: boolean
  hasStarted: boolean
  toolName?: string | null
  progressKey: number | string
}): string | null {
  const [stale, setStale] = useState(false)
  const lastProgressRef = useRef(Date.now())

  useEffect(() => {
    lastProgressRef.current = Date.now()
    setStale(false)
  }, [opts.progressKey])

  useEffect(() => {
    if (!opts.active) return
    lastProgressRef.current = Date.now()
    setStale(false)
    const iv = setInterval(() => {
      setStale(Date.now() - lastProgressRef.current > 10000)
    }, 1000)
    return () => clearInterval(iv)
  }, [opts.active])

  if (!opts.active) return null
  if (opts.toolName) return toolPhraseFor(opts.toolName)
  if (!opts.hasStarted) return 'Thinking…'
  if (stale) return 'Still working…'
  return null
}

export function useConfirmDestructive(): boolean {
  const [confirmDestructive, setConfirmDestructive] = useState(true)
  useEffect(() => {
    window.api.settings.get('workspace_confirm_destructive').then(v => setConfirmDestructive(v !== 'false'))
  }, [])
  return confirmDestructive
}

export function SessionContextMenu({
  x,
  y,
  pinned,
  archived = false,
  confirmDestructive,
  onTogglePin,
  onRename,
  onToggleArchive,
  onDelete,
  onClose,
}: {
  x: number
  y: number
  pinned: boolean
  archived?: boolean
  confirmDestructive: boolean
  onTogglePin: () => void
  onRename: () => void
  onToggleArchive?: () => void
  onDelete: () => void
  onClose?: () => void
}) {
  const [pendingDelete, setPendingDelete] = useState(false)
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => { if (deleteTimer.current) clearTimeout(deleteTimer.current) }, [])

  useEffect(() => {
    menuRef.current?.querySelector('button')?.focus()
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose?.()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function handleDeleteClick() {
    if (confirmDestructive && !pendingDelete) {
      setPendingDelete(true)
      if (deleteTimer.current) clearTimeout(deleteTimer.current)
      deleteTimer.current = setTimeout(() => setPendingDelete(false), 3000)
      return
    }
    if (deleteTimer.current) clearTimeout(deleteTimer.current)
    onDelete()
  }

  return createPortal(
    <div ref={menuRef} className="session-context-menu" style={{ top: y, left: x }} role="menu" onPointerDown={e => e.stopPropagation()}>
      <button className="session-context-item" role="menuitem" data-testid="session-menu-pin" onClick={onTogglePin}>{pinned ? 'Unpin' : 'Pin'}</button>
      <button className="session-context-item" role="menuitem" data-testid="session-menu-rename" onClick={onRename}>Rename</button>
      {onToggleArchive && (
        <button className="session-context-item" role="menuitem" data-testid="session-menu-archive" onClick={onToggleArchive}>{archived ? 'Unarchive' : 'Archive'}</button>
      )}
      <div className="session-context-divider" />
      <button
        className={`session-context-item danger session-menu-delete${pendingDelete ? ' pending-confirm' : ''}`}
        role="menuitem"
        data-testid="session-menu-delete"
        onClick={handleDeleteClick}
      >
        {pendingDelete ? 'Click again to confirm' : 'Delete'}
      </button>
    </div>,
    document.body
  )
}

export function AgentSessionRail({
  sessions,
  archivedSessions = [],
  activeSessionId,
  pinnedIds,
  renaming,
  newLabel,
  newTitle,
  disabled = false,
  disabledTitle,
  emptyLabel = 'No sessions yet',
  headerSlot,
  onNew,
  onSelect,
  onOptions,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDeleteMany,
}: {
  sessions: Session[]
  archivedSessions?: Session[]
  activeSessionId?: string | null
  pinnedIds: Set<string>
  renaming: { id: string; value: string } | null
  newLabel: string
  newTitle?: string
  disabled?: boolean
  disabledTitle?: string
  emptyLabel?: string
  headerSlot?: ReactNode
  onNew?: () => void
  onSelect: (session: Session) => void
  onOptions: (event: MouseEvent, session: Session) => void
  onRenameChange: (value: string) => void
  onRenameCommit: (session: Session) => void
  onRenameCancel: () => void
  /** Enables the select-mode toggle + bulk delete bar when provided. */
  onDeleteMany?: (ids: string[]) => void
}) {
  const [filter, setFilter] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false)
  const bulkDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const query = filter.trim().toLowerCase()
  const filteredSessions = query
    ? sessions.filter(s => (s.title || newLabel).toLowerCase().includes(query))
    : sessions
  const pinnedSessions = filteredSessions.filter(s => pinnedIds.has(s.id))
  const unpinnedSessions = filteredSessions.filter(s => !pinnedIds.has(s.id))
  const sessionMotionRef = useRef<MotionHandle[]>([])

  useEffect(() => () => {
    sessionMotionRef.current.forEach(stopMotion)
    sessionMotionRef.current = []
  }, [])

  useEffect(() => () => { if (bulkDeleteTimer.current) clearTimeout(bulkDeleteTimer.current) }, [])

  function toggleSelectMode() {
    setSelectMode(v => !v)
    setSelectedIds(new Set())
    setPendingBulkDelete(false)
    if (bulkDeleteTimer.current) clearTimeout(bulkDeleteTimer.current)
  }

  function toggleSelected(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function handleBulkDeleteClick() {
    if (selectedIds.size === 0) return
    if (!pendingBulkDelete) {
      setPendingBulkDelete(true)
      if (bulkDeleteTimer.current) clearTimeout(bulkDeleteTimer.current)
      bulkDeleteTimer.current = setTimeout(() => setPendingBulkDelete(false), 3000)
      return
    }
    if (bulkDeleteTimer.current) clearTimeout(bulkDeleteTimer.current)
    setPendingBulkDelete(false)
    const ids = [...selectedIds]
    setSelectedIds(new Set())
    setSelectMode(false)
    onDeleteMany?.(ids)
  }

  function renderRow(s: Session) {
    const isActive = activeSessionId === s.id
    const isRenaming = renaming?.id === s.id
    const isChecked = selectedIds.has(s.id)
    return (
      <li key={s.id} className="session-row">
        {selectMode && (
          <input
            type="checkbox"
            className="session-row-checkbox"
            checked={isChecked}
            onChange={() => toggleSelected(s.id)}
            onClick={e => e.stopPropagation()}
            aria-label={`Select ${s.title || newLabel}`}
          />
        )}
        <button
          className={`session-item${isActive ? ' active' : ''}`}
          data-testid="session-item"
          onPointerDown={(e) => pressElement(e, sessionMotionRef.current)}
          onClick={() => { if (selectMode) { toggleSelected(s.id); return } if (!isRenaming) onSelect(s) }}
        >
          {isRenaming ? (
            <input
              className="session-rename-input"
              data-testid="session-rename-input"
              value={renaming.value}
              onChange={e => onRenameChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); onRenameCommit(s) }
                if (e.key === 'Escape') onRenameCancel()
              }}
              onBlur={() => onRenameCommit(s)}
              autoFocus
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span className="session-item-body">
              <span className="session-item-row1">
                <span className="session-item-title">{s.title || newLabel}</span>
                {typeof s.updated_at === 'number' && <RelativeTime ts={s.updated_at} compact />}
              </span>
              {s.summary && <span className="session-item-summary">{s.summary}</span>}
            </span>
          )}
        </button>
        {!selectMode && (
          <button
            className="session-dot-menu"
            data-testid="session-options"
            title="Session options"
            aria-label={`Options for ${s.title || newLabel}`}
            onClick={e => onOptions(e, s)}
          >
            ...
          </button>
        )}
      </li>
    )
  }

  return (
    <aside className="session-list">
      <div className="session-list-header">
        <button className="session-new-btn" onClick={onNew} disabled={disabled} title={disabledTitle ?? newTitle}>
          <span className="session-new-icon">+</span>
          {newLabel}
        </button>
      </div>
      {headerSlot && <div className="session-list-extra">{headerSlot}</div>}
      {onDeleteMany && sessions.length > 0 && (
        <div className="session-search">
          {sessions.length > 8 && (
            <input
              placeholder="Search sessions..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Search sessions"
            />
          )}
          <button
            className={`session-select-toggle${selectMode ? ' on' : ''}`}
            onClick={toggleSelectMode}
            title={selectMode ? 'Exit select mode' : 'Select multiple sessions'}
            aria-label="Toggle select mode"
            aria-pressed={selectMode}
          >
            ☑
          </button>
        </div>
      )}
      {!onDeleteMany && sessions.length > 8 && (
        <div className="session-search">
          <input
            placeholder="Search sessions..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Search sessions"
          />
        </div>
      )}
      <div className="session-list-body">
        {sessions.length === 0 ? (
          <div className="session-list-empty">{emptyLabel}</div>
        ) : query && filteredSessions.length === 0 ? (
          <div className="session-list-empty">No sessions match "{filter.trim()}"</div>
        ) : (
          <ul className="motion-list motion-list-tight">
            {pinnedSessions.length > 0 && (
              <>{pinnedSessions.map(renderRow)}{unpinnedSessions.length > 0 && <div className="session-pin-divider" />}</>
            )}
            {unpinnedSessions.map(renderRow)}
          </ul>
        )}
        {archivedSessions.length > 0 && (
          <>
            <button className="session-archived-toggle" onClick={() => setShowArchived(v => !v)}>
              {showArchived ? 'Hide archived' : `${archivedSessions.length} archived session${archivedSessions.length !== 1 ? 's' : ''}`}
            </button>
            {showArchived && (
              <ul className="motion-list motion-list-tight session-archived-list">
                {archivedSessions.map(renderRow)}
              </ul>
            )}
          </>
        )}
      </div>
      {selectMode && selectedIds.size > 0 && (
        <div className="session-bulk-bar">
          <span>{selectedIds.size} selected</span>
          <div className="session-bulk-bar-actions">
            <button className="ghost tiny" onClick={toggleSelectMode}>Cancel</button>
            <button className={`danger tiny${pendingBulkDelete ? ' pending-confirm' : ''}`} onClick={handleBulkDeleteClick}>
              {pendingBulkDelete ? `Click again to delete ${selectedIds.size} session${selectedIds.size === 1 ? '' : 's'}` : 'Delete selected'}
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}

export function AgentStatusStrip({
  agent,
  status,
  tone = 'neutral',
  detail,
  running,
  children,
}: {
  agent: string
  status: string
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error'
  detail?: ReactNode
  running?: boolean
  children?: ReactNode
}) {
  const isRunning = running ?? /running|streaming|checking|working/i.test(status)
  return (
    <div className={`agent-status-strip${isRunning ? ' is-running' : ''}`}>
      <div className="agent-status-main">
        <span className="agent-status-agent">{agent}</span>
        {isRunning && <BreathingDot />}
        <StatusBadge tone={tone}>{status}</StatusBadge>
        {detail && <span className="agent-status-detail">{detail}</span>}
      </div>
      {children && <div className="agent-status-actions">{children}</div>}
    </div>
  )
}

export function AgentErrorNotice({
  title = 'Run failed',
  children,
  testId,
}: {
  title?: string
  children: ReactNode
  testId?: string
}) {
  return (
    <div className="agent-error-wrap motion-presence-soft" data-testid={testId}>
      <WorkspaceNotice title={title} tone="error">
        {children}
      </WorkspaceNotice>
    </div>
  )
}

export function OutputActions({
  onCopy,
  onSave,
  canSave = true,
  copyLabel = 'Copy response',
  saveLabel = 'Save to Knowledge',
  isLast = false,
  onRegenerate,
  reaction = null,
  onReaction,
}: {
  onCopy: () => void
  onSave?: () => void
  canSave?: boolean
  copyLabel?: string
  saveLabel?: string
  /** True only for the single most-recent assistant message in the session. */
  isLast?: boolean
  onRegenerate?: () => void
  reaction?: 'up' | 'down' | null
  onReaction?: (reaction: 'up' | 'down') => void
}) {
  return (
    <span className="output-actions msg-actions motion-actions">
      <button className="ghost tiny msg-action-btn output-copy-btn" data-testid="copy-response" onClick={onCopy} title="Copy full response">{copyLabel}</button>
      {onSave && (
        <button className="ghost tiny msg-action-btn" onClick={onSave} disabled={!canSave} title={saveLabel}>
          {saveLabel}
        </button>
      )}
      {isLast && onRegenerate && (
        <button className="ghost tiny msg-action-btn" data-testid="regenerate-response" onClick={onRegenerate} title="Regenerate response">
          ↻ Regenerate
        </button>
      )}
      {onReaction && (
        <>
          <button
            className={`ghost tiny msg-action-btn${reaction === 'up' ? ' reaction-active' : ''}`}
            data-testid="reaction-up"
            aria-pressed={reaction === 'up'}
            onClick={() => onReaction('up')}
            title="Good response"
          >
            👍
          </button>
          <button
            className={`ghost tiny msg-action-btn${reaction === 'down' ? ' reaction-active' : ''}`}
            data-testid="reaction-down"
            aria-pressed={reaction === 'down'}
            onClick={() => onReaction('down')}
            title="Bad response"
          >
            👎
          </button>
        </>
      )}
    </span>
  )
}

// Shared user-message bubble: click the bubble (or the hover-only pencil icon)
// to turn it into an inline textarea. Saving forks the conversation from here —
// the caller (useMessageActions) owns the delete-after-and-resend logic; this
// component only owns the click-to-edit UI state.
export function EditableUserMessage({
  content,
  timestamp,
  disabled = false,
  onSaveResend,
  onCopy,
  extraMeta,
}: {
  content: string
  timestamp: number
  disabled?: boolean
  onSaveResend: (newContent: string) => void
  onCopy?: () => void
  /** Extra content rendered in the message's meta row (e.g. a checkpoint badge). */
  extraMeta?: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)

  function startEdit() {
    if (disabled) return
    setDraft(content)
    setEditing(true)
  }
  function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== content) onSaveResend(trimmed)
  }
  function cancel() {
    setEditing(false)
    setDraft(content)
  }

  if (editing) {
    return (
      <div className="msg user editing">
        <div className="msg-edit-wrap">
          <textarea
            className="msg-edit-textarea"
            data-testid="edit-message-textarea"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); cancel() }
              if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); commit() }
            }}
          />
          <div className="msg-edit-actions">
            <button className="ghost tiny" onClick={cancel}>Cancel</button>
            <button className="primary tiny" data-testid="edit-message-save" onClick={commit}>Save & resend</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="msg user">
      <div className="msg-body" onClick={startEdit} title={disabled ? undefined : 'Click to edit'}>{content}</div>
      <div className="msg-meta">
        <span className="msg-timestamp"><RelativeTime ts={timestamp} /></span>
        <span className="msg-actions">
          {onCopy && (
            <button className="ghost tiny msg-action-btn output-copy-btn" data-testid="copy-response" onClick={(e) => { e.stopPropagation(); onCopy() }} title="Copy message">Copy</button>
          )}
          {!disabled && (
            <button className="ghost tiny msg-action-btn" data-testid="edit-message-btn" onClick={(e) => { e.stopPropagation(); startEdit() }} title="Edit and resend" aria-label="Edit message">
              ✎
            </button>
          )}
        </span>
        {extraMeta}
      </div>
    </div>
  )
}
