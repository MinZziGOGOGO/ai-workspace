import { useEffect, useState } from 'react'
import type { AgentId, AgentTask } from '../AgentActivityContext'
import type { Session } from '../types'

// Unified cross-agent activity view. A popover anchored to the topbar "N active"
// badge rather than a docked panel, on purpose:
//   • It's a glance-and-go navigation surface, not a workspace you sit in — the
//     docked ActivityPanel already owns the full scrolling event log.
//   • Lower friction: one click from the badge that already told you something
//     is running, no dock slot spent, dismiss by clicking away.
//   • It grows the existing badge (last session's item 11) instead of adding a
//     competing surface, which is what the task asked for.
// It updates in real time because it renders straight from AgentActivityContext,
// which the agent tabs feed on task start/stop — no polling.

const AGENT_LABELS: Record<AgentId, string> = {
  chat: 'Chat',
  hermes: 'Hermes',
  claudecode: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi',
}

function elapsedLabel(from: number, to: number): string {
  const secs = Math.max(0, Math.round((to - from) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  if (mins < 60) return `${mins}m ${rem}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

function StatusDot(props: { status: AgentTask['status'] }) {
  // Colours track the app's existing status tones (success/danger, info accent).
  const cls =
    props.status === 'running' ? 'running' : props.status === 'error' ? 'error' : 'done'
  const glyph = props.status === 'running' ? '' : props.status === 'error' ? '✕' : '✓'
  return <span className={`activity-pop-dot ${cls}`} aria-hidden>{glyph}</span>
}

function TaskRow(props: { task: AgentTask; onJump: (agent: AgentId, session: Session) => void }) {
  const { task } = props
  // Live-tick elapsed time for running tasks only.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (task.status !== 'running') return
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [task.status])

  const elapsed = elapsedLabel(task.startedAt, task.status === 'running' ? now : task.endedAt ?? task.startedAt)
  const canJump = Boolean(task.session)
  const statusWord = task.status === 'running' ? 'Running' : task.status === 'error' ? 'Failed' : 'Done'

  return (
    <button
      type="button"
      className={`activity-pop-row status-${task.status}${canJump ? '' : ' no-jump'}`}
      data-testid="activity-pop-row"
      data-agent={task.agent}
      disabled={!canJump}
      title={canJump ? `Jump to ${AGENT_LABELS[task.agent]} · ${task.title}` : task.title}
      onClick={() => task.session && props.onJump(task.agent, task.session)}
    >
      <StatusDot status={task.status} />
      <span className="activity-pop-row-main">
        <span className="activity-pop-row-agent">{AGENT_LABELS[task.agent]}</span>
        <span className="activity-pop-row-title">{task.title}</span>
      </span>
      <span className="activity-pop-row-meta">
        <span className="activity-pop-row-status">{statusWord}</span>
        <span className="activity-pop-row-elapsed">{elapsed}</span>
      </span>
    </button>
  )
}

export default function AgentActivityPopover(props: {
  tasks: AgentTask[]
  onJump: (agent: AgentId, session: Session) => void
}) {
  const running = props.tasks.filter((t) => t.status === 'running')
  const finished = props.tasks.filter((t) => t.status !== 'running')

  return (
    <div className="activity-pop" data-testid="activity-popover">
      <div className="activity-pop-header">Agent activity</div>
      {props.tasks.length === 0 ? (
        <div className="activity-pop-empty muted small" data-testid="activity-pop-empty">
          Nothing running right now.
        </div>
      ) : (
        <>
          {running.length > 0 && (
            <div className="activity-pop-section" data-testid="activity-pop-running">
              <div className="activity-pop-section-label">Running · {running.length}</div>
              {running.map((t) => <TaskRow key={t.id} task={t} onJump={props.onJump} />)}
            </div>
          )}
          {finished.length > 0 && (
            <div className="activity-pop-section" data-testid="activity-pop-recent">
              <div className="activity-pop-section-label">Recently finished</div>
              {finished.map((t) => <TaskRow key={t.id} task={t} onJump={props.onJump} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
