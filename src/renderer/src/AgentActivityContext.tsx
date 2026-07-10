// Cross-panel activity bus: lets the topbar show "N active" without each agent
// tab reaching into WorkspaceShell. Agent tabs call setActive on start/stop of
// a response only (not per streamed token), so consumers re-render at most
// once per run rather than once per chunk.

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

export type AgentId = 'chat' | 'hermes' | 'claudecode' | 'codex'

export interface AgentActivityContextValue {
  active: Record<AgentId, boolean>
  setActive: (agent: AgentId, isActive: boolean) => void
}

const AgentActivityContext = createContext<AgentActivityContextValue | null>(null)

const BLANK_ACTIVE: Record<AgentId, boolean> = {
  chat: false,
  hermes: false,
  claudecode: false,
  codex: false,
}

export function AgentActivityProvider({ children }: { children: ReactNode }) {
  const [active, setActiveState] = useState<Record<AgentId, boolean>>(BLANK_ACTIVE)

  const value = useMemo<AgentActivityContextValue>(() => ({
    active,
    setActive: (agent, isActive) => {
      setActiveState((prev) => (prev[agent] === isActive ? prev : { ...prev, [agent]: isActive }))
    },
  }), [active])

  return <AgentActivityContext.Provider value={value}>{children}</AgentActivityContext.Provider>
}

export function useAgentActivity(): AgentActivityContextValue {
  const value = useContext(AgentActivityContext)
  if (!value) throw new Error('useAgentActivity must be used inside AgentActivityProvider')
  return value
}
