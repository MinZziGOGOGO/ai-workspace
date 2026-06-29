import { useEffect, useRef, useState } from 'react'
import type { ActivityEntry } from '../types'
import { StatusBadge, WorkspaceEmptyState } from './WorkspacePrimitives'

const MAX_ENTRIES = 500

export default function ActivityPanel() {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const feedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!window.api.activity) return
    return window.api.activity.onLog((entry) => {
      setEntries(prev => {
        const next = [...prev, entry]
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
      })
    })
  }, [])

  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  function fmtTime(ts: number) {
    const d = new Date(ts)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  }

  return (
    <div className="activity-panel">
      <div className="activity-panel-head">
        <div>
          <h3>Workspace Activity</h3>
          <p className="muted small">Recent tool, memory, and agent events.</p>
        </div>
        <StatusBadge tone={entries.length > 0 ? 'success' : 'neutral'}>{entries.length} events</StatusBadge>
      </div>
      <div className="activity-feed motion-list motion-list-tight" ref={feedRef}>
        {entries.length === 0 && (
          <WorkspaceEmptyState
            compact
            title="No activity yet"
            body="Run a task, save memory, or start a tool to see events here."
          />
        )}
        {entries.map((e, i) => (
          <div key={i} className="activity-entry motion-feed-item">
            <span className="activity-entry-ts">[{fmtTime(e.timestamp)}]</span>
            <span className="activity-entry-source">[{e.source}]</span>
            <span className="activity-entry-msg">{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
