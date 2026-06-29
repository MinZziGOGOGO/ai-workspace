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

export default function RelativeTime(props: { ts: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return (
    <time className="msg-time" dateTime={new Date(props.ts).toISOString()} title={new Date(props.ts).toLocaleString()}>
      {format(props.ts, now)}
    </time>
  )
}
