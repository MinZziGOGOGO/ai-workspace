import { useEffect, useRef, useState } from 'react'
import type { CodexPlanUsage, CodexRateLimitWindow } from '../types'

// Compact context-window meter for the agent composer bars. The chip shows
// the fill percentage (— before the first run); the popover breaks down the
// real numbers plus, for Codex, the plan's rate-limit windows. All values
// come from real CLI data (result-event modelUsage / rollout token_count /
// Kimi usage events + config.toml max_context_size) — never estimates.

interface ContextMeterProps {
  testId: string
  used?: number | null
  total?: number | null
  plan?: CodexPlanUsage | null
}

function formatK(n: number): string {
  return `${(n / 1000).toFixed(1)}k`
}

function percentOf(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0
}

function titleCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// "Resets in 10 min" / "Resets in 3 h" / "Resets Sun 10:59 AM"
function resetText(resetsAt?: number): string | null {
  if (!resetsAt) return null
  const deltaMs = resetsAt * 1000 - Date.now()
  if (deltaMs <= 0) return 'Resets soon'
  const mins = Math.round(deltaMs / 60000)
  if (mins < 60) return `Resets in ${mins} min`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `Resets in ${hours} h`
  const d = new Date(resetsAt * 1000)
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM'
  const h = d.getHours() % 12 || 12
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `Resets ${WEEKDAYS[d.getDay()]} ${h}:${mm} ${ampm}`
}

function windowLabel(w: CodexRateLimitWindow): string {
  return w.kind === 'secondary' ? '5-hour limit' : 'Weekly'
}

function Bar(props: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, props.percent))
  return (
    <div className="context-meter-bar" aria-hidden>
      <div className={`context-meter-bar-fill${clamped >= 90 ? ' danger' : ''}`} style={{ width: `${clamped}%` }} />
    </div>
  )
}

export default function ContextMeter(props: ContextMeterProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const used = props.used ?? null
  const total = props.total ?? null
  const pct = used !== null && total ? percentOf(used, total) : null
  const planWindows = props.plan?.windows ?? []

  return (
    <div className="context-meter-wrap" ref={rootRef}>
      <button
        type="button"
        className="context-meter-chip"
        data-testid={props.testId}
        aria-expanded={open}
        title="Context window usage"
        onClick={() => setOpen((v) => !v)}
      >
        {pct !== null ? `${pct}%` : '—'}
      </button>
      {open && (
        <div className="context-meter-popover" data-testid={`${props.testId}-popover`}>
          <div className="context-meter-section">
            <div className="context-meter-row">
              <span className="context-meter-label">Context window</span>
              <span className="context-meter-value">
                {used !== null && total
                  ? `${formatK(used)} / ${formatK(total)} (${pct}%)`
                  : used !== null
                    ? `${formatK(used)} used`
                    : 'No usage data yet'}
              </span>
            </div>
            {total && pct !== null ? <Bar percent={pct} /> : null}
          </div>
          {planWindows.length > 0 && (
            <div className="context-meter-section">
              <div className="context-meter-plan-title">
                Plan usage limits{props.plan?.planType ? ` · ${titleCase(props.plan.planType)}` : ''}
              </div>
              {planWindows.map((w) => (
                <div key={w.kind} className="context-meter-plan-row" data-testid={`${props.testId}-plan-${w.kind}`}>
                  <div className="context-meter-row">
                    <span className="context-meter-label">{windowLabel(w)}</span>
                    <span className="context-meter-value">
                      {resetText(w.resetsAt) ? `${resetText(w.resetsAt)}  ` : ''}
                      {Math.round(w.usedPercent)}%
                    </span>
                  </div>
                  <Bar percent={w.usedPercent} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
