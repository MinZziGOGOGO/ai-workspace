import type { BrowserWindow } from 'electron'
import type { AgentPanelDetachedChangedEvent, AgentPanelId, PanelDetachedChangedEvent, ScreenPoint } from '../shared/ipcTypes'
import { browserApprovals } from './browserApproval'
import { createDetachedPanelWindow } from './detachedPanelWindow'

// Step 4 of WINDOW_DETACH_DESIGN.md: the same ownership-transfer mechanism the
// Claude Code pilot proved (claudeCodePanel.ts), generalized over the four
// remaining agent tabs. Claude Code deliberately keeps its own module and its
// own `claudecode:*` channels — this file does not touch it.

export type DetachableAgentPanel = AgentPanelId

const TITLES: Record<DetachableAgentPanel, string> = {
  hermes: 'Hermes',
  codex: 'Codex',
  kimi: 'Kimi',
  chat: 'Chat',
}

/**
 * The `agentId` each panel's agent presents to the Browser control server (see
 * bundledMcpServers/resolveHermesMcpServers in ipc.ts). A detached window is
 * registered as an approval host so it can display — and decide — the Browser
 * approval cards raised by *its own* agent; ApprovalCenter filters the shared
 * queue on exactly this id.
 *
 * Chat maps to null on purpose: it is a direct model conversation with no MCP
 * client and no tool access, so it can never originate a Browser approval and
 * must not be registered as a host for anyone else's.
 */
const BROWSER_AGENT_IDS: Record<DetachableAgentPanel, string | null> = {
  hermes: 'hermes',
  codex: 'codex',
  kimi: 'kimi',
  chat: null,
}

export function browserAgentIdForPanel(panel: DetachableAgentPanel): string | null {
  return BROWSER_AGENT_IDS[panel]
}

let mainWindow: BrowserWindow | null = null
const detachedWindows = new Map<DetachableAgentPanel, BrowserWindow>()
const removeApprovalHosts = new Map<DetachableAgentPanel, () => void>()

export function registerAgentPanelMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

export function isAgentPanelDetached(panel: DetachableAgentPanel): boolean {
  const win = detachedWindows.get(panel)
  return Boolean(win && !win.isDestroyed())
}

export function listDetachedAgentPanels(): DetachableAgentPanel[] {
  return [...detachedWindows.keys()].filter(isAgentPanelDetached)
}

/**
 * Where this panel's streamed events must land right now. Same contract as
 * claudeCodePanelHostWindow: a run started in the main window keeps streaming
 * into whichever window currently owns the panel, so detaching mid-turn does
 * not strand the output in a window that no longer shows the tab.
 */
export function agentPanelHostWindow(
  panel: DetachableAgentPanel,
  fallback?: BrowserWindow | null,
): BrowserWindow | null {
  const detached = detachedWindows.get(panel)
  if (detached && !detached.isDestroyed()) return detached
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return fallback && !fallback.isDestroyed() ? fallback : null
}

function emitToMain(panel: DetachableAgentPanel, detached: boolean): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const payload: AgentPanelDetachedChangedEvent = { panel, detached }
    mainWindow.webContents.send('agentPanel:detachedChanged', payload)
  }
}

function performReattach(panel: DetachableAgentPanel, win: BrowserWindow): void {
  if (detachedWindows.get(panel) !== win) return
  detachedWindows.delete(panel)
  removeApprovalHosts.get(panel)?.()
  removeApprovalHosts.delete(panel)
  emitToMain(panel, false)
}

export async function detachAgentPanel(
  panel: DetachableAgentPanel,
  projectId: string,
  projectName: string,
  dropPoint?: ScreenPoint,
): Promise<PanelDetachedChangedEvent> {
  const current = detachedWindows.get(panel)
  if (current && !current.isDestroyed()) {
    current.focus()
    return { detached: true }
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(`No main window to detach ${TITLES[panel]} from.`)
  }

  const win = await createDetachedPanelWindow(
    panel,
    projectId,
    `${TITLES[panel]} — ${projectName}`,
    mainWindow,
    dropPoint,
  )
  detachedWindows.set(panel, win)
  // Hermes/Codex/Kimi can originate Browser MCP requests. The detached renderer
  // owns those Browser approval cards while its panel is detached; each agent's
  // *native* permission card (Hermes/Kimi ACP) already lives inside the tab
  // itself and therefore travels with it. Chat has neither.
  if (BROWSER_AGENT_IDS[panel]) removeApprovalHosts.set(panel, browserApprovals.addHostWindow(win))
  win.on('closed', () => performReattach(panel, win))
  emitToMain(panel, true)
  return { detached: true }
}

export function reattachAgentPanel(panel: DetachableAgentPanel): PanelDetachedChangedEvent {
  const win = detachedWindows.get(panel)
  if (!win || win.isDestroyed()) return { detached: false }
  performReattach(panel, win)
  try { win.close() } catch { /* already closing */ }
  return { detached: false }
}

export function reattachAllAgentPanels(): void {
  for (const panel of [...detachedWindows.keys()]) reattachAgentPanel(panel)
}
