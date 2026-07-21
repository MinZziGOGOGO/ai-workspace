// Cross-panel activity bus: lets the topbar show "N active" — and, since the
// unified activity view, *what* is active — without each agent tab reaching
// into WorkspaceShell. Agent tabs report start/stop of a response only (not per
// streamed token), so consumers re-render at most once per run rather than once
// per chunk.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session } from './types'

export type AgentId = 'chat' | 'hermes' | 'claudecode' | 'codex' | 'kimi'

export type AgentTaskStatus = 'running' | 'done' | 'error'

export interface AgentTask {
  /** Stable per agent+session, so a re-run of the same session replaces its row. */
  id: string
  agent: AgentId
  status: AgentTaskStatus
  /** Session name/summary at the time the task started. */
  title: string
  /** Carried whole so "jump to session" can reuse the existing panel:selectSession
      contract (same payload CommandPalette sends) rather than a second lookup path. */
  session: Session | null
  startedAt: number
  endedAt: number | null
}

/** How many finished tasks to keep. This is a status surface, not a history browser. */
const RECENT_LIMIT = 6

export interface AgentTaskMeta {
  session?: Session | null
  title?: string
  /** Only read when a task ends: did the turn fail? */
  failed?: boolean
}

export interface AgentActivityContextValue {
  active: Record<AgentId, boolean>
  setActive: (agent: AgentId, isActive: boolean, meta?: AgentTaskMeta) => void
  /** Running tasks first (newest first), then recently finished ones. */
  tasks: AgentTask[]
}

const AgentActivityContext = createContext<AgentActivityContextValue | null>(null)

const BLANK_ACTIVE: Record<AgentId, boolean> = {
  chat: false,
  hermes: false,
  claudecode: false,
  codex: false,
  kimi: false,
}

export function AgentActivityProvider({ children }: { children: ReactNode }) {
  const [active, setActiveState] = useState<Record<AgentId, boolean>>(BLANK_ACTIVE)
  const [tasks, setTasks] = useState<AgentTask[]>([])

  // Stable identity: agent tabs depend on setActive in effects whose cleanup
  // also calls it. If this callback were recreated per activity change (the
  // old useMemo([active]) shape), every flip would re-run those effects and
  // flip the state back — an infinite setState loop while any agent runs.
  const setActive = useCallback((agent: AgentId, isActive: boolean, meta?: AgentTaskMeta) => {
    setActiveState((prev) => (prev[agent] === isActive ? prev : { ...prev, [agent]: isActive }))
    setTasks((prev) => {
      const runningIdx = prev.findIndex((t) => t.agent === agent && t.status === 'running')

      if (isActive) {
        // Idempotent: an effect re-running mustn't restart the clock on a task
        // that is already tracked.
        if (runningIdx !== -1) return prev
        const session = meta?.session ?? null
        const task: AgentTask = {
          id: `${agent}:${session?.id ?? 'adhoc'}:${Date.now()}`,
          agent,
          status: 'running',
          title: meta?.title || session?.summary || session?.title || 'Untitled task',
          session,
          startedAt: Date.now(),
          endedAt: null,
        }
        return trim([task, ...prev])
      }

      // Nothing running for this agent — a stop with no start is a no-op, not
      // a phantom "finished" row.
      if (runningIdx === -1) return prev
      const next = [...prev]
      next[runningIdx] = {
        ...next[runningIdx],
        status: meta?.failed ? 'error' : 'done',
        endedAt: Date.now(),
      }
      return trim(next)
    })
  }, [])

  const value = useMemo<AgentActivityContextValue>(() => ({ active, setActive, tasks }), [active, setActive, tasks])

  return <AgentActivityContext.Provider value={value}>{children}</AgentActivityContext.Provider>
}

/** Keep every running task; cap only the finished tail. */
function trim(list: AgentTask[]): AgentTask[] {
  const running = list.filter((t) => t.status === 'running')
  const finished = list
    .filter((t) => t.status !== 'running')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, RECENT_LIMIT)
  return [...running, ...finished]
}

export function useAgentActivity(): AgentActivityContextValue {
  const value = useContext(AgentActivityContext)
  if (!value) throw new Error('useAgentActivity must be used inside AgentActivityProvider')
  return value
}

/**
 * The one way an agent tab reports its task. Replaces the bare
 * `useEffect(() => setActive(id, running), [running, setActive])` each tab used
 * to hand-roll.
 *
 * `session`/`failed` are read through a ref *inside* the effect rather than
 * declared as dependencies. That's load-bearing: adding them to the dep array
 * would re-run the effect (and its cleanup) whenever the user merely switched
 * session, ending a task that is still running — and it would reintroduce the
 * churn that caused the render loop this context was fixed for.
 */
export function useAgentTaskReporter(
  agent: AgentId,
  opts: { running: boolean; session: Session | null; title?: string; failed?: boolean }
): void {
  const { setActive } = useAgentActivity()
  const metaRef = useRef(opts)
  metaRef.current = opts

  useEffect(() => {
    const meta = metaRef.current
    if (opts.running) setActive(agent, true, { session: meta.session, title: meta.title })
    else setActive(agent, false, { failed: meta.failed })
    // Ending on unmount is intentional: a closed panel has no running turn to
    // show, and finishing is idempotent if the effect simply re-ran.
    return () => setActive(agent, false, { failed: metaRef.current.failed })
  }, [agent, opts.running, setActive])
}
