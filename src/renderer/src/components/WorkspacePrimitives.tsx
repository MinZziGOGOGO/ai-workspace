import type { ReactNode } from 'react'

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

export function StatusBadge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: Tone
  title?: string
}) {
  return (
    <span className={`workspace-status-badge tone-${tone}`} title={title}>
      {children}
    </span>
  )
}

export function WorkspaceEmptyState({
  title,
  body,
  icon,
  actions,
  testId,
  compact = false,
}: {
  title: string
  body: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  testId?: string
  compact?: boolean
}) {
  return (
    <div className={`empty center workspace-empty-state motion-presence${compact ? ' compact' : ''}`} data-testid={testId}>
      {icon && <div className="empty-icon" aria-hidden>{icon}</div>}
      <h2>{title}</h2>
      <p className="muted">{body}</p>
      {actions && <div className="workspace-empty-actions">{actions}</div>}
    </div>
  )
}

export function WorkspaceNotice({
  title,
  children,
  tone = 'info',
  action,
  testId,
}: {
  title: string
  children?: ReactNode
  tone?: Tone
  action?: ReactNode
  testId?: string
}) {
  return (
    <div className={`workspace-notice tone-${tone} motion-notice`} data-testid={testId}>
      <div className="workspace-notice-main">
        <div className="workspace-notice-title">{title}</div>
        {children && <div className="workspace-notice-body">{children}</div>}
      </div>
      {action && <div className="workspace-notice-action">{action}</div>}
    </div>
  )
}
