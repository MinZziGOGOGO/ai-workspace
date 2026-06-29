import type { MouseEvent, ReactNode } from 'react'
import type { Session } from '../types'
import { StatusBadge, WorkspaceNotice } from './WorkspacePrimitives'

export function AgentSessionRail({
  sessions,
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
}: {
  sessions: Session[]
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
}) {
  const pinnedSessions = sessions.filter(s => pinnedIds.has(s.id))
  const unpinnedSessions = sessions.filter(s => !pinnedIds.has(s.id))

  function renderRow(s: Session) {
    const isActive = activeSessionId === s.id
    const isRenaming = renaming?.id === s.id
    return (
      <li key={s.id} className="session-row">
        <button className={`session-item${isActive ? ' active' : ''}`} onClick={() => { if (!isRenaming) onSelect(s) }}>
          {isRenaming ? (
            <input
              className="session-rename-input"
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
            <span className="session-item-title">{s.title || newLabel}</span>
          )}
        </button>
        <button
          className="session-dot-menu"
          title="Session options"
          aria-label={`Options for ${s.title || newLabel}`}
          onClick={e => onOptions(e, s)}
        >
          ...
        </button>
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
      <div className="session-list-body">
        {sessions.length === 0 ? (
          <div className="session-list-empty">{emptyLabel}</div>
        ) : (
          <ul className="motion-list motion-list-tight">
            {pinnedSessions.length > 0 && (
              <>{pinnedSessions.map(renderRow)}{unpinnedSessions.length > 0 && <div className="session-pin-divider" />}</>
            )}
            {unpinnedSessions.map(renderRow)}
          </ul>
        )}
      </div>
    </aside>
  )
}

export function AgentStatusStrip({
  agent,
  status,
  tone = 'neutral',
  detail,
  children,
}: {
  agent: string
  status: string
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error'
  detail?: ReactNode
  children?: ReactNode
}) {
  const isRunning = /running|streaming|checking|working/i.test(status)
  return (
    <div className={`agent-status-strip${isRunning ? ' is-running' : ''}`}>
      <div className="agent-status-main">
        <span className="agent-status-agent">{agent}</span>
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
}: {
  onCopy: () => void
  onSave?: () => void
  canSave?: boolean
  copyLabel?: string
  saveLabel?: string
}) {
  return (
    <span className="output-actions motion-actions">
      <button className="ghost tiny msg-action-btn output-copy-btn" data-testid="copy-response" onClick={onCopy} title="Copy full response">{copyLabel}</button>
      {onSave && (
        <button className="ghost tiny msg-action-btn" onClick={onSave} disabled={!canSave} title={saveLabel}>
          {saveLabel}
        </button>
      )}
    </span>
  )
}
