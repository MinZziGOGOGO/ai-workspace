import { BrowserWindow, WebContentsView, session } from 'electron'
import type { BrowserBounds, PanelDetachedChangedEvent, PreviewDevServerDetectedEvent, PreviewPanelState, ScreenPoint } from '../shared/ipcTypes'
import { isLocalPreviewUrl, normalizePreviewUrl } from './browserPreview'
import { createDetachedPanelWindow } from './detachedPanelWindow'

// ── Preview panel: a read-only, user-only live viewer ──────────────────────
//
// This is deliberately a second, isolated WebContentsView surface from the
// agent-controlled Browser panel (browserPanel.ts). Nothing here is reachable
// from MCP tools or the browser-control HTTP server — it exists purely so the
// human can watch their own dev server hot-reload while an agent edits files.
// A single view is created lazily and kept alive for the life of the app
// (never torn down when the panel is hidden/closed) so an open WebSocket
// (Vite/webpack HMR) is never interrupted by panel visibility changes.

const PARTITION = 'preview-panel'
const HIDDEN_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:'])
const BLANK_URL = 'about:blank'

let hostWindow: BrowserWindow | null = null
// See browserPanel.ts's identical split: `mainWindow` is the stable original
// app window; `hostWindow` is whichever window currently owns the view.
let mainWindow: BrowserWindow | null = null
let detachedWindow: BrowserWindow | null = null
let view: WebContentsView | null = null
let currentUrl = BLANK_URL
let currentTitle = ''
let isLoading = false
let navigationError: string | null = null
let currentBounds: BrowserBounds = HIDDEN_BOUNDS
let visibleBounds: BrowserBounds = HIDDEN_BOUNDS

function emit(channel: string, payload: unknown): void {
  if (hostWindow && !hostWindow.isDestroyed()) hostWindow.webContents.send(channel, payload)
}

// Detach state must always reach the main window, not whichever window
// currently owns the view (see browserPanel.ts's identical helper).
function emitToMain(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function emitUpdate(): void {
  emit('preview:updated', toState())
}

function toState(): PreviewPanelState {
  return { url: currentUrl, title: currentTitle, isLoading, navigationError }
}

function previewSession(): Electron.Session {
  const target = session.fromPartition(PARTITION)
  target.setPermissionCheckHandler(() => false)
  target.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  // A read-only viewer never needs to hand a page a filesystem destination.
  target.on('will-download', (event) => event.preventDefault())
  return target
}

function assertAllowedUrl(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol === 'about:' && parsed.href !== BLANK_URL) {
    throw new Error(`Blocked preview navigation to ${parsed.href}.`)
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Blocked preview navigation to unsupported scheme: ${parsed.protocol.replace(':', '')}`)
  }
  if (parsed.protocol !== 'about:' && !isLocalPreviewUrl(parsed.href)) {
    throw new Error('The Preview panel only loads local dev servers (localhost, 127.0.0.1, or [::1]).')
  }
}

function applyBounds(bounds: BrowserBounds): void {
  currentBounds = bounds
  if (!view) return
  try {
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    })
  } catch { /* view may be gone */ }
}

function sanitizeBounds(bounds: BrowserBounds): BrowserBounds {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every(Number.isFinite)) throw new Error('Invalid preview bounds')
  return {
    x: Math.max(-100000, Math.min(100000, Math.round(bounds.x))),
    y: Math.max(-100000, Math.min(100000, Math.round(bounds.y))),
    width: Math.max(0, Math.min(10000, Math.round(bounds.width))),
    height: Math.max(0, Math.min(10000, Math.round(bounds.height))),
  }
}

function ensureView(): WebContentsView {
  if (view) return view
  if (!hostWindow || hostWindow.isDestroyed()) throw new Error('No host window for Preview panel')
  const created = new WebContentsView({
    webPreferences: {
      session: previewSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  })
  view = created
  hostWindow.contentView.addChildView(created)
  applyBounds(HIDDEN_BOUNDS)

  const wc = created.webContents
  wc.on('did-start-loading', () => { isLoading = true; navigationError = null; emitUpdate() })
  wc.on('did-stop-loading', () => { isLoading = false; emitUpdate() })
  const onNavigate = (_e: unknown, url: string) => { currentUrl = url; navigationError = null; emitUpdate() }
  const guardNavigation = (event: Electron.Event, url: string) => {
    try {
      assertAllowedUrl(url)
    } catch (err) {
      event.preventDefault()
      navigationError = err instanceof Error ? err.message : String(err)
      isLoading = false
      emitUpdate()
    }
  }
  wc.on('will-navigate', guardNavigation)
  wc.on('will-redirect', guardNavigation)
  wc.on('did-navigate', onNavigate as never)
  wc.on('did-navigate-in-page', onNavigate as never)
  wc.on('page-title-updated', (_e, title) => { currentTitle = title; emitUpdate() })
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return
    isLoading = false
    navigationError = `${desc || 'Navigation failed'} (${code})${url ? `: ${url}` : ''}`
    emitUpdate()
  })
  // Popups have no place in a single-URL live viewer.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  return created
}

export function registerPreviewHostWindow(win: BrowserWindow): void {
  mainWindow = win
  hostWindow = win
}

export function isPreviewPanelDetached(): boolean {
  return detachedWindow !== null && !detachedWindow.isDestroyed()
}

function moveViewTo(win: BrowserWindow, from: BrowserWindow | null): void {
  ensureView()
  if (!view) return
  if (from && !from.isDestroyed()) {
    try { from.contentView.removeChildView(view) } catch { /* already detached */ }
  }
  try { win.contentView.addChildView(view) } catch { /* view may be gone */ }
  applyBounds(HIDDEN_BOUNDS)
}

// Idempotent — see browserPanel.ts's performReattach for why this guard matters.
function performReattach(win: BrowserWindow): void {
  if (detachedWindow !== win) return
  detachedWindow = null
  hostWindow = mainWindow
  if (mainWindow && !mainWindow.isDestroyed()) moveViewTo(mainWindow, win)
  emitToMain('preview:detachedChanged', { detached: false } satisfies PanelDetachedChangedEvent)
}

export async function detachPreviewPanel(projectId: string, dropPoint?: ScreenPoint): Promise<PanelDetachedChangedEvent> {
  if (isPreviewPanelDetached()) {
    detachedWindow!.focus()
    return { detached: true }
  }
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('No main window to detach the Preview panel from.')

  const win = await createDetachedPanelWindow('preview', projectId, 'Preview — AI Workspace', mainWindow, dropPoint)
  moveViewTo(win, mainWindow)
  detachedWindow = win
  hostWindow = win

  // See browserPanel.ts's identical comment: 'closed' (not 'close') is the
  // event guaranteed to fire regardless of how the window was closed.
  win.on('closed', () => performReattach(win))

  emitToMain('preview:detachedChanged', { detached: true } satisfies PanelDetachedChangedEvent)
  return { detached: true }
}

export function reattachPreviewPanel(): PanelDetachedChangedEvent {
  if (!isPreviewPanelDetached()) return { detached: false }
  const win = detachedWindow!
  performReattach(win)
  if (!win.isDestroyed()) {
    try { win.close() } catch { /* already closing */ }
  }
  return { detached: false }
}

export function navigatePreviewUrl(url: string): void {
  const target = normalizePreviewUrl(url)
  const created = ensureView()
  currentUrl = target
  navigationError = null
  created.webContents.loadURL(target).catch(() => { /* reported via did-fail-load */ })
}

export function reloadPreview(): void {
  view?.webContents.reload()
}

export function stopPreview(): void {
  view?.webContents.stop()
}

export function setPreviewBounds(bounds: BrowserBounds): void {
  const safeBounds = sanitizeBounds(bounds)
  visibleBounds = safeBounds
  ensureView()
  applyBounds(safeBounds)
}

export function hidePreviewView(): void {
  if (!view) return
  applyBounds(HIDDEN_BOUNDS)
}

export function parkPreviewForDrag(): void {
  if (!view) return
  applyBounds(HIDDEN_BOUNDS)
}

export function restorePreviewAfterDrag(): void {
  if (!view) return
  applyBounds(visibleBounds)
}

export function getPreviewState(): PreviewPanelState {
  return toState()
}

export function destroyPreviewPanel(): void {
  if (view && hostWindow && !hostWindow.isDestroyed()) {
    try { hostWindow.contentView.removeChildView(view) } catch { /* detached */ }
  }
  try { view?.webContents.close() } catch { /* best effort */ }
  view = null
  // Never leave the detached Preview window orphaned when the app quits.
  if (detachedWindow && !detachedWindow.isDestroyed()) {
    try { detachedWindow.close() } catch { /* already closing */ }
  }
  detachedWindow = null
}

// ── Dev-server output detection ──────────────────────────────────────────
//
// Scans terminal pty output for a handful of common dev-server startup lines
// (Vite, Next.js, webpack-dev-server, and this app's own renderer dev server)
// and offers the parsed URL to the renderer as a detected preview target.
// This is a best-effort suggestion, not a security boundary — the user still
// has to accept it before it loads in the Preview panel.

const DEV_SERVER_PATTERN =
  /(?:Local|Server running at|ready on|App running at|ready - started server on|Loopback|Available on)\s*[:\-]?\s*(?:url:\s*)?(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{2,5})?\/?)/i

const outputBuffers = new Map<string, string>()
const lastDetected = new Map<string, string>()
const MAX_BUFFER = 2000

export function noteTerminalOutput(projectPath: string, chunk: string): void {
  const key = projectPath || ''
  const buffer = ((outputBuffers.get(key) ?? '') + chunk).slice(-MAX_BUFFER)
  outputBuffers.set(key, buffer)
  const match = buffer.match(DEV_SERVER_PATTERN)
  if (!match) return
  const url = match[1]
  if (lastDetected.get(key) === url) return
  lastDetected.set(key, url)
  const payload: PreviewDevServerDetectedEvent = { projectPath: key, url }
  emit('preview:devServerDetected', payload)
}

export function getLastDetectedDevServerUrl(projectPath: string): string | null {
  return lastDetected.get(projectPath || '') ?? null
}
