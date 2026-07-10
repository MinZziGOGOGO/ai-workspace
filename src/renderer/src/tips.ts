import { useEffect, useState } from 'react'
import type { TipStats } from './types'

export interface Tip {
  id: string
  text: string
  cta: { label: string; action: string } | null
}

interface TipDef extends Tip {
  condition: (stats: TipStats) => boolean
}

const TIP_DEFS: TipDef[] = [
  {
    id: 'try_hermes',
    condition: (stats) => stats.chatSessions >= 10 && stats.hermesSessions === 0,
    text: 'Did you know Hermes can work on tasks autonomously while you do other things?',
    cta: { label: 'Try Hermes', action: 'open_panel:hermes' }
  },
  {
    id: 'try_handoff',
    condition: (stats) => stats.chatSessions >= 5 && !stats.usedHandoff,
    text: 'You can ask Chat to write a prompt and send it to Claude Code or Codex directly.',
    cta: null
  },
  {
    id: 'try_shortcuts',
    condition: (stats) => stats.totalSessions >= 15,
    text: 'Press Ctrl+/ anytime to see all keyboard shortcuts.',
    cta: null
  }
]

// Evaluated once per app session — module-level so remounting the hosting
// panel (tabs stay mounted, but this guards against future changes) never
// re-runs the check or picks a second tip for the same session.
let evaluated = false
let resolvedTip: Tip | null = null
let evalPromise: Promise<Tip | null> | null = null

function evaluateOnce(): Promise<Tip | null> {
  if (evaluated) return Promise.resolve(resolvedTip)
  if (evalPromise) return evalPromise
  evalPromise = (async () => {
    try {
      const [stats, shownIds] = await Promise.all([window.api.tips.stats(), window.api.tips.shownIds()])
      const shown = new Set(shownIds)
      const match = TIP_DEFS.find((t) => !shown.has(t.id) && t.condition(stats))
      if (match) {
        resolvedTip = { id: match.id, text: match.text, cta: match.cta }
        await window.api.tips.markShown(match.id)
      }
    } catch {
      resolvedTip = null
    }
    evaluated = true
    return resolvedTip
  })()
  return evalPromise
}

/** The single tip (if any) chosen for this app session — evaluated once, globally. */
export function useActiveTip(): Tip | null {
  const [tip, setTip] = useState<Tip | null>(resolvedTip)
  useEffect(() => {
    let cancelled = false
    evaluateOnce().then((t) => { if (!cancelled) setTip(t) })
    return () => { cancelled = true }
  }, [])
  return tip
}
