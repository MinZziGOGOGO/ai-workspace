import { useEffect, useState } from 'react'

// Self-updating relative timestamp ("just now", "2 min ago", "3 h ago").
// Each instance ticks on its own light interval so the label stays fresh
// without the parent tab having to thread a clock through every message.
function format(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} d ago`
  return new Date(ts).toLocaleDateString()
}

// Compact variant for session-list activity badges: "Active now" inside a
// 2-minute window, then terse units ("5m ago", "2h ago", "3d ago", "2w ago").
// Always relative — the full date lives in the title tooltip.
function formatCompact(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 120) return 'Active now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

export default function RelativeTime(props: { ts: number; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return (
    <time
      className={props.compact ? 'session-activity-time' : 'msg-time'}
      dateTime={new Date(props.ts).toISOString()}
      title={new Date(props.ts).toLocaleString()}
    >
      {props.compact ? formatCompact(props.ts, now) : format(props.ts, now)}
    </time>
  )
}
