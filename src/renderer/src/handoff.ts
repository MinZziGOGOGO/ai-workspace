// Cross-panel handoff bus (Chat → Claude Code / Hermes / Codex).
//
// A tiny module-level singleton — not React state — so the Chat tab can resolve
// *where* a handoff should land synchronously (which session, or a new one)
// without threading props through the whole WorkspaceShell. Each agent tab
// publishes its live session, availability and open state here as it changes;
// the Chat tab reads it when building the handoff preview and again on send.
//
// The actual delivery still flows through each tab's own send path (via the
// `panel:handoffSend` window event) so a tab's internal state stays correct.

export type HandoffAgent = 'claudecode' | 'hermes' | 'codex'

export const HANDOFF_AGENT_LABELS: Record<HandoffAgent, string> = {
  claudecode: 'Claude Code',
  hermes: 'Hermes',
  codex: 'Codex'
}

// Loose renderer-side triggers. Handoff detection only runs in Execute mode; a
// match here just gates the (cheap) classification call — it is intentionally
// permissive, and false positives are filtered out by classifyHandoff.
export const HANDOFF_TRIGGER =
  /\b(claude ?code|codex|hermes)\b.{0,40}\b(send|write|hand ?off|create|draft|prompt|session)\b|\b(send|write|hand ?off|create|draft)\b.{0,40}\b(claude ?code|codex|hermes|prompt|session)\b/i

export const NEW_SESSION_TRIGGER = /\b(new|fresh|start a new)\b.{0,20}\bsession\b/i

interface AgentTrack {
  currentId: string | null
  currentTitle: string | null
  lastActiveId: string | null
  lastActiveTitle: string | null
  available: boolean | undefined
  open: boolean
}

function blankTrack(): AgentTrack {
  return {
    currentId: null,
    currentTitle: null,
    lastActiveId: null,
    lastActiveTitle: null,
    available: undefined,
    open: false
  }
}

const tracks: Record<HandoffAgent, AgentTrack> = {
  claudecode: blankTrack(),
  hermes: blankTrack(),
  codex: blankTrack()
}

/** An agent tab selected/created a session — record it as current + last-active. */
export function setAgentSession(agent: HandoffAgent, sessionId: string, title: string | null): void {
  const t = tracks[agent]
  t.currentId = sessionId
  t.currentTitle = title
  t.lastActiveId = sessionId
  t.lastActiveTitle = title
}

/** An agent tab has no session selected right now (keeps last-active for later). */
export function clearAgentCurrent(agent: HandoffAgent): void {
  tracks[agent].currentId = null
  tracks[agent].currentTitle = null
}

export function setAgentAvailable(agent: HandoffAgent, available: boolean): void {
  tracks[agent].available = available
}

export function setAgentPanelOpen(agent: HandoffAgent, open: boolean): void {
  tracks[agent].open = open
}

/** Unknown availability is treated as available (optimistic) — only a known-false blocks. */
export function isAgentAvailable(agent: HandoffAgent): boolean {
  return tracks[agent].available !== false
}

export interface HandoffTarget {
  newSession: boolean
  sessionId?: string
  title?: string
}

// Session resolution priority (mirrors the spec):
//  1. forceNew            → always a new session
//  2. panel open + current → the session currently selected in that open tab
//  3. a recorded last-active session → reuse it (tab will be opened + switched)
//  4. otherwise            → new session
export function resolveHandoffTarget(agent: HandoffAgent, forceNew: boolean): HandoffTarget {
  const t = tracks[agent]
  if (forceNew) return { newSession: true }
  if (t.open && t.currentId) return { newSession: false, sessionId: t.currentId, title: t.currentTitle ?? undefined }
  if (t.lastActiveId) return { newSession: false, sessionId: t.lastActiveId, title: t.lastActiveTitle ?? undefined }
  return { newSession: true }
}

export interface HandoffSendDetail {
  panel: HandoffAgent
  prompt: string
  newSession: boolean
  sessionId?: string
}
