import type { BrowserWindow } from 'electron'
import type { DockPanel, PanelDetachedChangedEvent, ScreenPoint } from '../shared/ipcTypes'
import { browserApprovals } from './browserApproval'
import { createDetachedPanelWindow } from './detachedPanelWindow'

let mainWindow: BrowserWindow | null = null
let detachedWindow: BrowserWindow | null = null
let removeApprovalHost: (() => void) | null = null

export function registerClaudeCodeMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

export function isClaudeCodePanelDetached(): boolean {
  return detachedWindow !== null && !detachedWindow.isDestroyed()
}

export function claudeCodePanelHostWindow(fallback?: BrowserWindow | null): BrowserWindow | null {
  if (isClaudeCodePanelDetached()) return detachedWindow
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return fallback && !fallback.isDestroyed() ? fallback : null
}

function emitToMain(channel: string, payload: PanelDetachedChangedEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function performReattach(win: BrowserWindow): void {
  if (detachedWindow !== win) return
  detachedWindow = null
  removeApprovalHost?.()
  removeApprovalHost = null
  emitToMain('claudecode:detachedChanged', { detached: false })
}

export async function detachClaudeCodePanel(
  projectId: string,
  projectName: string,
  dropPoint?: ScreenPoint,
): Promise<PanelDetachedChangedEvent> {
  if (isClaudeCodePanelDetached()) {
    detachedWindow!.focus()
    return { detached: true }
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('No main window to detach Claude Code from.')
  }

  const win = await createDetachedPanelWindow(
    'claudecode',
    projectId,
    `Claude Code — ${projectName}`,
    mainWindow,
    dropPoint,
  )
  detachedWindow = win
  removeApprovalHost = browserApprovals.addHostWindow(win)
  win.on('closed', () => performReattach(win))
  emitToMain('claudecode:detachedChanged', { detached: true })
  return { detached: true }
}

export function reattachClaudeCodePanel(): PanelDetachedChangedEvent {
  if (!isClaudeCodePanelDetached()) return { detached: false }
  const win = detachedWindow!
  performReattach(win)
  if (!win.isDestroyed()) {
    try { win.close() } catch { /* already closing */ }
  }
  return { detached: false }
}

export function openPanelInMain(panel: DockPanel): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('workspace:openPanelRequested', panel)
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}
