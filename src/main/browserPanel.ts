import { app, BrowserWindow, WebContentsView, dialog, session, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, statSync } from 'fs'
import path from 'path'
import { getDb } from './db'
import type { BrowserBounds, BrowserPreviewInspection, BrowserTabState, PanelDetachedChangedEvent, ScreenPoint } from '../shared/ipcTypes'
import { clickScript, contentScript, scrollScript, snapshotScript, typeScript } from './browserAgentScript'
import { browserApprovals } from './browserApproval'
import type { BrowserAgentIdentity } from './browserApproval'
import { getHermesPermissionMode } from './hermes'
import { browserUploadHandles, classifyDownloadRisks, sanitizeDownloadFilename } from './browserTransfers'
import { isLocalPreviewUrl, normalizePreviewUrl } from './browserPreview'
import { createDetachedPanelWindow } from './detachedPanelWindow'

// ── WebContentsView-backed manual browser (Phase 1: no agent control) ─────────
//
// Each Browser panel tab is a real Chromium page rendered NATIVELY above the
// renderer DOM via WebContentsView. The React component (BrowserPanel.tsx) draws
// the chrome (tab bar / URL bar) as normal DOM and streams the placeholder's
// on-screen rect here through browser:setBounds so the native view stays exactly
// overlaid on that placeholder. When the panel is closed, hidden, or another
// panel is fullscreened over it, the renderer calls hideAll()/setBounds(0) so the
// native view (which paints above the DOM) never bleeds over other panels.

interface BrowserTab {
  id: string
  view: WebContentsView
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  navigationError: string | null
  previewMode: boolean
  snapshotId: string | null
  snapshotUrl: string | null
  navigationGeneration: number
  snapshotGeneration: number | null
  snapshotElements: AgentSnapshotElement[]
  bounds: BrowserBounds
  // Last on-screen rect the renderer pushed for this tab while it was the active
  // one. `bounds` is whatever is currently applied to the native view (HIDDEN
  // while parked); `visibleBounds` remembers where the tab *should* sit so that
  // re-activating it can reposition immediately, without waiting for the
  // renderer's diff-checked rAF loop to notice a change.
  visibleBounds: BrowserBounds
}

const HIDDEN_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
const NEW_TAB_URL = 'about:blank'
const PERSIST_PARTITION = 'persist:browser-panel'
const EPHEMERAL_PARTITION = 'browser-panel'
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'about:'])

const tabs = new Map<string, BrowserTab>()
let activeTabId: string | null = null
let hostWindow: BrowserWindow | null = null
// `mainWindow` is the stable original app window (set once at startup);
// `hostWindow` is whichever window currently owns the WebContentsViews and
// receives their tabUpdated/tabCreated/etc. events — main by default, or the
// detached window once detachBrowserPanel() reparents the views. See
// WINDOW_DETACH_DESIGN.md §2.1.
let mainWindow: BrowserWindow | null = null
let detachedWindow: BrowserWindow | null = null

export interface BrowserDownloadRecord {
  downloadId: string; filename: string; origin: string; state: 'pending' | 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number; totalBytes: number; startedAt: number; completedAt?: number; cancelled: boolean; failureReason?: string; destinationType: 'managed'
  displayLocation: string; tabId: string; agentId: string
}
const downloads = new Map<string, BrowserDownloadRecord & { destinationPath?: string; item?: any }>()
const expectedDownloads = new Map<string, { downloadId: string; url: string; expiresAt: number }>()

function safeOrigin(url: string): string { try { return new URL(url).origin } catch { return 'unknown origin' } }
function downloadsRoot(): string {
  const root = path.join(app.getPath('userData'), 'Browser Downloads')
  mkdirSync(root, { recursive: true })
  return root
}
function managedDestination(filename: string): string {
  const root = downloadsRoot(); const safe = sanitizeDownloadFilename(filename)
  const parsed = path.parse(safe)
  for (let n = 0; n < 10_000; n++) {
    const name = n ? `${parsed.name} (${n})${parsed.ext}` : safe
    const candidate = path.resolve(root, name)
    if (!candidate.startsWith(`${path.resolve(root)}${path.sep}`) || existsSync(candidate)) continue
    return candidate
  }
  throw new Error('Could not allocate a download destination')
}
function publicDownload(record: BrowserDownloadRecord): Omit<BrowserDownloadRecord, 'tabId' | 'agentId'> & { tabId: string } {
  return {
    downloadId: record.downloadId, filename: record.filename, origin: record.origin, state: record.state,
    receivedBytes: record.receivedBytes, totalBytes: record.totalBytes, startedAt: record.startedAt,
    completedAt: record.completedAt, cancelled: record.cancelled, failureReason: record.failureReason,
    destinationType: record.destinationType, displayLocation: record.displayLocation, tabId: record.tabId,
  }
}

// ── Session persistence setting ───────────────────────────────────────────────
// OFF (default): an in-memory partition that is discarded when the app exits, so
// cookies/logins never survive a restart. ON: a persist: partition that does.
function sessionPersistEnabled(): boolean {
  try {
    const row = getDb()
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get('browser_persist_session') as { value: string } | undefined
    return row?.value === 'true'
  } catch {
    return false
  }
}

function browserSession(): Electron.Session {
  const persist = sessionPersistEnabled()
  const target = session.fromPartition(persist ? PERSIST_PARTITION : EPHEMERAL_PARTITION, { cache: persist })
  configureBrowserSession(target)
  return target
}

const configuredSessions = new WeakSet<Electron.Session>()
function configureBrowserSession(target: Electron.Session): void {
  if (configuredSessions.has(target)) return
  configuredSessions.add(target)
  // Chromium permission prompts must never escape the application approval
  // model. Downloads are intercepted and routed to the owning tab's approval
  // path; pages never receive an unrestricted filesystem destination.
  target.setPermissionCheckHandler(() => false)
  target.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  target.on('will-download', (event, item, webContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.view.webContents.id === webContents.id)
    if (!tab) { event.preventDefault(); return }
    handleWillDownload(tab, event, item)
  })
}

function handleWillDownload(tab: BrowserTab, event: any, item: any): void {
  const url = String(item.getURL?.() ?? tab.view.webContents.getURL())
  const expected = expectedDownloads.get(tab.id)
  if (expected && expected.expiresAt > Date.now() && expected.url === url) {
    expectedDownloads.delete(tab.id)
    const record = downloads.get(expected.downloadId)
    if (record) attachDownload(record, item, url)
    else event.preventDefault()
    return
  }
  // Chromium has already begun an unrequested download. Cancel this attempt and
  // only reissue it after a strict application approval has completed.
  event.preventDefault()
  const filename = sanitizeDownloadFilename(String(item.getFilename?.() ?? 'download'))
  const identity: BrowserAgentIdentity = { agentId: 'manual-browser', agentName: 'You', identityVerified: true, transport: 'manual-browser' }
  void browserApprovals.submit(identity, getHermesPermissionMode(), {
    ...getBrowserCommandContext(tab.id), category: 'browser.download', toolName: 'browser_download', tabId: tab.id,
    targetUrl: url, targetOrigin: safeOrigin(url), leavesLocalhost: !/^https?:\/\/(localhost|127\.|\[::1\])/i.test(url), elementName: filename,
    actionSummary: `Download ${filename}`, sensitive: false, riskFlags: [...classifyDownloadRisks(filename), 'Webpage initiated this download'], mutation: true,
  }, async () => beginDownload(tab.id, url, identity.agentId, filename))
}

function attachDownload(record: BrowserDownloadRecord & { destinationPath?: string; item?: any }, item: any, url: string): void {
  try { item.setSavePath(record.destinationPath) } catch { try { item.cancel() } catch { /* noop */ }; record.state = 'cancelled'; record.cancelled = true; record.failureReason = 'destination_failure'; return }
  record.item = item; record.state = 'progressing'; record.totalBytes = Number(item.getTotalBytes?.() ?? 0)
  item.on('updated', (_event: unknown, state: string) => { record.receivedBytes = Number(item.getReceivedBytes?.() ?? 0); if (state === 'interrupted') record.state = 'interrupted' })
  item.once('done', (_event: unknown, state: string) => { record.receivedBytes = Number(item.getReceivedBytes?.() ?? record.receivedBytes); record.completedAt = Date.now(); record.cancelled = state === 'cancelled'; record.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'; if (state !== 'completed') record.failureReason = state })
  void url
}

function beginDownload(tabId: string, url: string, agentId: string, proposedFilename?: string): BrowserDownloadRecord {
  const tab = tabs.get(tabId); if (!tab) throw new Error('Browser tab was closed.')
  const filename = sanitizeDownloadFilename(proposedFilename || path.basename(new URL(url).pathname) || 'download')
  const record: BrowserDownloadRecord & { destinationPath?: string } = { downloadId: randomUUID(), filename, origin: safeOrigin(url), state: 'pending', receivedBytes: 0, totalBytes: 0, startedAt: Date.now(), cancelled: false, destinationType: 'managed', displayLocation: 'Managed Browser Downloads', tabId, agentId, destinationPath: managedDestination(filename) }
  downloads.set(record.downloadId, record)
  expectedDownloads.set(tabId, { downloadId: record.downloadId, url, expiresAt: Date.now() + 10_000 })
  tab.view.webContents.downloadURL(url)
  return publicDownload(record) as BrowserDownloadRecord
}

// ── navigation-history shims ──────────────────────────────────────────────────
// Electron added webContents.navigationHistory (canGoBack/goBack live there) and
// is deprecating the direct webContents methods. The typings across the 30.x range
// disagree on which surface exists, so we probe both at runtime via `any`.
/* eslint-disable @typescript-eslint/no-explicit-any */
function navHistory(wc: WebContents): any {
  return (wc as any).navigationHistory
}

function canGoBack(wc: WebContents): boolean {
  const nh = navHistory(wc)
  if (nh && typeof nh.canGoBack === 'function') return nh.canGoBack()
  return typeof (wc as any).canGoBack === 'function' ? (wc as any).canGoBack() : false
}

function canGoForward(wc: WebContents): boolean {
  const nh = navHistory(wc)
  if (nh && typeof nh.canGoForward === 'function') return nh.canGoForward()
  return typeof (wc as any).canGoForward === 'function' ? (wc as any).canGoForward() : false
}

function historyGoBack(wc: WebContents): void {
  const nh = navHistory(wc)
  if (nh && typeof nh.goBack === 'function') nh.goBack()
  else (wc as any).goBack?.()
}

function historyGoForward(wc: WebContents): void {
  const nh = navHistory(wc)
  if (nh && typeof nh.goForward === 'function') nh.goForward()
  else (wc as any).goForward?.()
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── URL normalization ─────────────────────────────────────────────────────────
function assertAllowedUrl(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol === 'about:' && parsed.href !== NEW_TAB_URL) {
    throw new Error(`Blocked browser navigation to ${parsed.href}. Only about:blank is allowed for about: URLs.`)
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Blocked browser navigation to unsupported scheme: ${parsed.protocol.replace(':', '')}`)
  }
}

// A real address bar: pass through safe URLs, add https:// to ordinary hosts,
// use http:// for bare localhost, and route non-host text to a web search.
export function normalizeUrl(input: string): string {
  const raw = input.trim()
  if (!raw) return NEW_TAB_URL
  if (/^(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(raw) || /^\[::1\](?::\d+)?(?:\/|$)/i.test(raw)) {
    return `http://${raw}`
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    const parsed = new URL(raw)
    assertAllowedUrl(parsed.href)
    return parsed.href
  }
  // Looks like a host[:port][/path] with no spaces and a dot (or localhost).
  const hostLike = /^[^\s]+\.[^\s]+$/.test(raw)
  if (hostLike) return `https://${raw}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`
}

function toState(tab: BrowserTab): BrowserTabState {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    isLoading: tab.isLoading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    navigationError: tab.navigationError,
    previewMode: tab.previewMode,
  }
}

function emit(channel: string, payload: unknown): void {
  if (hostWindow && !hostWindow.isDestroyed()) {
    hostWindow.webContents.send(channel, payload)
  }
}

// Detach state must always reach the main window specifically, regardless of
// which window currently owns the views (emit() above targets hostWindow,
// which points at the detached window once detached — the main window's
// placeholder needs its own delivery path).
function emitToMain(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function emitUpdate(tab: BrowserTab): void {
  emit('browser:tabUpdated', toState(tab))
}

function refreshNavState(tab: BrowserTab): void {
  const wc = tab.view.webContents
  tab.canGoBack = canGoBack(wc)
  tab.canGoForward = canGoForward(wc)
}

function wireEvents(tab: BrowserTab): void {
  const wc = tab.view.webContents

  wc.on('did-start-loading', () => {
    browserApprovals.cancelElementActionsForTab(tab.id)
    tab.navigationGeneration += 1
    tab.isLoading = true
    tab.navigationError = null
    emitUpdate(tab)
  })
  wc.on('did-stop-loading', () => {
    tab.isLoading = false
    refreshNavState(tab)
    emitUpdate(tab)
  })
  const onNavigate = (_e: unknown, url: string) => {
    tab.url = url
    tab.navigationError = null
    tab.snapshotId = null
    tab.snapshotUrl = null
    refreshNavState(tab)
    emitUpdate(tab)
  }
  const guardNavigation = (event: Electron.Event, url: string) => {
    try {
      assertAllowedUrl(url)
      if (tab.previewMode && url !== NEW_TAB_URL && !isLocalPreviewUrl(url)) {
        throw new Error('Preview mode blocked navigation outside localhost.')
      }
    } catch (err) {
      event.preventDefault()
      tab.navigationError = err instanceof Error ? err.message : String(err)
      tab.isLoading = false
      emitUpdate(tab)
    }
  }
  wc.on('will-navigate', guardNavigation)
  wc.on('will-redirect', guardNavigation)
  wc.on('did-navigate', onNavigate as never)
  wc.on('did-navigate-in-page', onNavigate as never)
  wc.on('page-title-updated', (_e, title) => {
    tab.title = title
    emitUpdate(tab)
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return
    tab.isLoading = false
    tab.navigationError = `${desc || 'Navigation failed'} (${code})${url ? `: ${url}` : ''}`
    refreshNavState(tab)
    emitUpdate(tab)
  })
  // Popups cannot bypass the shared command/approval path. Page-initiated new
  // windows are denied; a future privileged approval command can reintroduce
  // them with explicit user intent.
  wc.setWindowOpenHandler(({ url }) => {
    try {
      assertAllowedUrl(url)
      tab.navigationError = `Blocked popup navigation pending explicit approval: ${url}`
    } catch {
      tab.navigationError = `Blocked popup navigation: ${url}`
    }
    emitUpdate(tab)
    return { action: 'deny' }
  })
}

function applyBounds(tab: BrowserTab, bounds: BrowserBounds): void {
  tab.bounds = bounds
  try {
    tab.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    })
  } catch { /* view may be gone */ }
}

function sanitizeBounds(bounds: BrowserBounds): BrowserBounds {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every(Number.isFinite)) throw new Error('Invalid browser bounds')
  return {
    x: Math.max(-100000, Math.min(100000, Math.round(bounds.x))),
    y: Math.max(-100000, Math.min(100000, Math.round(bounds.y))),
    width: Math.max(0, Math.min(10000, Math.round(bounds.width))),
    height: Math.max(0, Math.min(10000, Math.round(bounds.height))),
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function createBrowserTab(win: BrowserWindow, initialUrl?: string): string {
  hostWindow = win
  const id = randomUUID()
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession(),
      // Manual browsing only — the embedded pages get no Node access.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  })

  const tab: BrowserTab = {
    id,
    view,
    url: NEW_TAB_URL,
    title: 'New Tab',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    navigationError: null,
    previewMode: false,
    snapshotId: null,
    snapshotUrl: null,
    navigationGeneration: 0,
    snapshotGeneration: null,
    snapshotElements: [],
    bounds: HIDDEN_BOUNDS,
    visibleBounds: HIDDEN_BOUNDS,
  }
  tabs.set(id, tab)

  win.contentView.addChildView(view)
  // Hidden until the renderer measures and positions it (Part 3 bounds-sync).
  applyBounds(tab, HIDDEN_BOUNDS)
  wireEvents(tab)

  let target = NEW_TAB_URL
  try {
    target = initialUrl ? normalizeUrl(initialUrl) : NEW_TAB_URL
  } catch (err) {
    tab.navigationError = err instanceof Error ? err.message : String(err)
  }
  tab.url = target
  view.webContents.loadURL(target).catch(() => { /* offline / bad URL — event handlers report */ })

  emit('browser:tabCreated', { tabId: id })
  emitUpdate(tab)
  setActiveTab(id)
  return id
}

export function closeBrowserTab(tabId: string): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  tabs.delete(tabId)
  browserApprovals.cancelForTab(tabId)
  browserUploadHandles.cancelForTab(tabId)
  for (const record of downloads.values()) if (record.tabId === tabId && (record.state === 'pending' || record.state === 'progressing')) { try { record.item?.cancel() } catch { /* noop */ }; record.state = 'cancelled'; record.cancelled = true; record.failureReason = 'tab_closed' }
  try {
    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.contentView.removeChildView(tab.view)
    }
  } catch { /* already detached */ }
  try {
    tab.view.webContents.close()
  } catch { /* best effort */ }

  if (activeTabId === tabId) {
    // Promote the most recently inserted remaining tab, if any.
    const remaining = [...tabs.keys()]
    activeTabId = remaining.length > 0 ? remaining[remaining.length - 1] : null
    if (activeTabId) setActiveTab(activeTabId)
  }
  emit('browser:tabClosed', { tabId })
}

export function setActiveTab(tabId: string): void {
  const active = tabs.get(tabId)
  if (!active) return
  activeTabId = tabId
  // Only the active tab is positioned; every other view is parked off-screen so
  // it can't paint over the panel.
  for (const [id, tab] of tabs) {
    if (id !== tabId) applyBounds(tab, HIDDEN_BOUNDS)
  }
  // Reposition the newly-active tab immediately to its last known rect. Without
  // this, a tab that was parked at HIDDEN_BOUNDS while inactive would stay
  // invisible until the renderer's diff-checked rAF loop happened to notice a
  // rect change — which never fires when the panel size is unchanged, leaving
  // the view blank after a tab switch. A brand-new tab has no visibleBounds yet
  // (still HIDDEN_BOUNDS); the renderer's immediate push on activation covers it.
  applyBounds(active, active.visibleBounds)
}

export function navigateTab(tabId: string, url: string): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  let target: string
  try {
    target = tab.previewMode ? normalizePreviewUrl(url) : normalizeUrl(url)
  } catch (err) {
    tab.navigationError = err instanceof Error ? err.message : String(err)
    emitUpdate(tab)
    return
  }
  tab.url = target
  tab.navigationError = null
    tab.snapshotId = null
    tab.snapshotUrl = null
    tab.snapshotGeneration = null
    tab.snapshotElements = []
  tab.view.webContents.loadURL(target).catch(() => { /* reported via did-fail-load */ })
}

export function setPreviewMode(tabId: string, enabled: boolean): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  tab.previewMode = enabled
  tab.navigationError = null
  if (enabled && tab.url !== NEW_TAB_URL && !isLocalPreviewUrl(tab.url)) {
    tab.url = NEW_TAB_URL
    tab.view.webContents.loadURL(NEW_TAB_URL).catch(() => { /* event handlers report */ })
  }
  emitUpdate(tab)
}

export function navigatePreviewTab(tabId: string, url: string): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  tab.previewMode = true
  navigateTab(tabId, url)
}

// Agent navigation has one extra routing rule over the manual Browse address
// bar: loopback preview URLs belong to the built-in Preview surface. Keep this
// distinction in the app-owned controller so every MCP client gets the same
// behavior and no agent needs to fall back to an operating-system browser.
export function agentNavigateTab(tabId: string, url: string): { navigated: true; previewMode: boolean; url: string } {
  const target = normalizeUrl(url)
  if (isLocalPreviewUrl(target)) {
    navigatePreviewTab(tabId, target)
    setActiveTab(tabId)
    emit('browser:previewRequested', { tabId, url: target })
    return { navigated: true, previewMode: true, url: target }
  }
  setPreviewMode(tabId, false)
  navigateTab(tabId, target)
  setActiveTab(tabId)
  return { navigated: true, previewMode: false, url: target }
}

export async function inspectPreviewTab(tabId: string): Promise<BrowserPreviewInspection> {
  const tab = tabs.get(tabId)
  if (!tab || !tab.previewMode || !isLocalPreviewUrl(tab.url)) {
    throw new Error('Preview inspection is only available for an open local preview.')
  }
  const result = await tab.view.webContents.executeJavaScript(`(() => {
    const body = document.body
    if (!body) return { blank: true, textLength: 0, visualElementCount: 0, reason: 'empty-document' }
    const textLength = (body.innerText || '').trim().length
    const selectors = 'img,svg,canvas,video,iframe,input,textarea,button,select,[role="img"],[role="button"]'
    const visualElementCount = Array.from(body.querySelectorAll(selectors)).filter((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
    }).length
    const background = getComputedStyle(body).backgroundColor
    const hasBackground = background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent'
    const blank = textLength === 0 && visualElementCount === 0 && !hasBackground
    return { blank, textLength, visualElementCount, ...(blank ? { reason: 'no-visible-content' } : {}) }
  })()`, true) as BrowserPreviewInspection
  return result
}

export function goBack(tabId: string): void {
  const tab = tabs.get(tabId)
  if (tab && canGoBack(tab.view.webContents)) historyGoBack(tab.view.webContents)
}

export function goForward(tabId: string): void {
  const tab = tabs.get(tabId)
  if (tab && canGoForward(tab.view.webContents)) historyGoForward(tab.view.webContents)
}

export function reloadTab(tabId: string): void {
  tabs.get(tabId)?.view.webContents.reload()
}

export function stopTab(tabId: string): void {
  tabs.get(tabId)?.view.webContents.stop()
}

export function setBrowserViewBounds(tabId: string, bounds: BrowserBounds): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  const safeBounds = sanitizeBounds(bounds)
  // Ignore bounds for inactive tabs — they must stay hidden.
  if (tabId !== activeTabId) {
    applyBounds(tab, HIDDEN_BOUNDS)
    return
  }
  // Remember where this tab sits so re-activating it later can reposition
  // instantly (see setActiveTab).
  tab.visibleBounds = safeBounds
  applyBounds(tab, safeBounds)
}

// Park every view off-screen. Called by the renderer when the Browser panel is
// closed or covered by a fullscreened panel (the native view paints above DOM,
// so covering it with DOM is not enough).
export function hideAllBrowserViews(): void {
  for (const tab of tabs.values()) applyBounds(tab, HIDDEN_BOUNDS)
}

// Park every native view off-screen for the duration of a panel-header drag (or
// while the dock-zone debug overlay is on). The WebContentsView paints above the
// DOM *and* swallows pointer events, so a drag passing over the Browser panel
// would otherwise miss drop-zone hover/drop and the snap/debug overlays wouldn't
// show through. restoreAfterDrag re-applies the active tab's last on-screen rect
// (same reposition setActiveTab performs). The renderer's bounds-sync loop is
// gated off on the same signal (see BrowserPanel), so parking here holds for the
// whole drag instead of being re-pushed on the next animation frame.
export function parkAllForDrag(): void {
  for (const tab of tabs.values()) applyBounds(tab, HIDDEN_BOUNDS)
}

export function restoreAfterDrag(): void {
  if (!activeTabId) return
  const active = tabs.get(activeTabId)
  if (active) applyBounds(active, active.visibleBounds)
}

export function listBrowserTabs(): { tabs: BrowserTabState[]; activeTabId: string | null } {
  return { tabs: [...tabs.values()].map(toState), activeTabId }
}

export function getBrowserState(): {
  activeTabId: string | null
  activeTab: BrowserTabState | null
  panelVisible: boolean
  tabs: BrowserTabState[]
} {
  const active = activeTabId ? tabs.get(activeTabId) ?? null : null
  return {
    activeTabId,
    activeTab: active ? toState(active) : null,
    panelVisible: Boolean(active && active.bounds.width >= 2 && active.bounds.height >= 2),
    tabs: [...tabs.values()].map(toState),
  }
}

// Recreate every tab's view against the current persistence setting (called after
// the setting toggles). Session partition is fixed at view-creation time, so the
// only way to switch persistence for existing tabs is to rebuild them.
export function reloadBrowserSessions(win: BrowserWindow): void {
  hostWindow = win
  const snapshot = [...tabs.values()].map((t) => ({ id: t.id, url: t.url, previewMode: t.previewMode }))
  const previousActive = activeTabId
  for (const id of [...tabs.keys()]) {
    const tab = tabs.get(id)
    if (!tab) continue
    tabs.delete(id)
    try { win.contentView.removeChildView(tab.view) } catch { /* detached */ }
    try { tab.view.webContents.close() } catch { /* best effort */ }
  }
  activeTabId = null

  for (const { id, url, previewMode } of snapshot) {
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    })
    const tab: BrowserTab = {
      id,
      view,
      url,
      title: 'New Tab',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      navigationError: null,
      previewMode,
      snapshotId: null,
      snapshotUrl: null,
      navigationGeneration: 0,
      snapshotGeneration: null,
      snapshotElements: [],
      bounds: HIDDEN_BOUNDS,
      visibleBounds: HIDDEN_BOUNDS,
    }
    tabs.set(id, tab)
    win.contentView.addChildView(view)
    applyBounds(tab, HIDDEN_BOUNDS)
    wireEvents(tab)
    view.webContents.loadURL(url || NEW_TAB_URL).catch(() => { /* reported via events */ })
    emitUpdate(tab)
  }
  if (previousActive && tabs.has(previousActive)) setActiveTab(previousActive)
  else if (tabs.size > 0) setActiveTab([...tabs.keys()][tabs.size - 1])
}

// ── Agent control (Phase 2) ────────────────────────────────────────────────
//
// The local HTTP control server (browserControlServer.ts) proxies MCP tool
// calls to these functions. Only the running app owns the live WebContentsView
// instances, so all page interaction happens here. These reuse the same tab map
// and event wiring as the manual UI — an agent-created tab is a normal tab that
// the user can see and take over.

// Register the host BrowserWindow so agent-initiated tab creation works even
// before the user has opened a manual tab. Called once from index.ts.
export function registerBrowserHostWindow(win: BrowserWindow): void {
  mainWindow = win
  hostWindow = win
}

export function isBrowserPanelDetached(): boolean {
  return detachedWindow !== null && !detachedWindow.isDestroyed()
}

// Reparent every tab's view (not just the active one) so background tabs keep
// their live state; only the active tab's bounds actually show once the
// destination window's renderer starts pushing bounds again.
function moveAllViewsTo(win: BrowserWindow, from: BrowserWindow | null): void {
  for (const tab of tabs.values()) {
    if (from && !from.isDestroyed()) {
      try { from.contentView.removeChildView(tab.view) } catch { /* already detached */ }
    }
    try { win.contentView.addChildView(tab.view) } catch { /* view may be gone */ }
    applyBounds(tab, HIDDEN_BOUNDS)
  }
}

// Idempotent: guarded by `detachedWindow !== win` so it's safe whether called
// from the "Bring back" button (reattachBrowserPanel, which then also closes
// the window) or from the detached window's own OS close button (the `close`
// listener below) — whichever happens first does the real work.
function performReattach(win: BrowserWindow): void {
  if (detachedWindow !== win) return
  detachedWindow = null
  hostWindow = mainWindow
  if (mainWindow && !mainWindow.isDestroyed()) moveAllViewsTo(mainWindow, win)
  emitToMain('browser:detachedChanged', { detached: false } satisfies PanelDetachedChangedEvent)
}

export async function detachBrowserPanel(projectId: string, dropPoint?: ScreenPoint): Promise<PanelDetachedChangedEvent> {
  if (isBrowserPanelDetached()) {
    detachedWindow!.focus()
    return { detached: true }
  }
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('No main window to detach the Browser panel from.')

  const win = await createDetachedPanelWindow('browser', projectId, 'Browser — AI Workspace', mainWindow, dropPoint)
  moveAllViewsTo(win, mainWindow)
  detachedWindow = win
  hostWindow = win

  // 'closed' (not 'close'): some close paths — including how at least one
  // automated driver closes a secondary BrowserWindow — go straight to
  // destruction without emitting the cancelable 'close' event first. 'closed'
  // is the one event guaranteed to fire exactly once either way. By then `win`
  // itself is destroyed, but the reparented WebContentsViews are not (their
  // lifetime is independent, tied to our `tabs` map) — moveAllViewsTo's
  // `!from.isDestroyed()` guard already skips the now-invalid removeChildView
  // call and just re-adds each view to mainWindow.
  win.on('closed', () => performReattach(win))

  emitToMain('browser:detachedChanged', { detached: true } satisfies PanelDetachedChangedEvent)
  return { detached: true }
}

export function reattachBrowserPanel(): PanelDetachedChangedEvent {
  if (!isBrowserPanelDetached()) return { detached: false }
  const win = detachedWindow!
  performReattach(win)
  if (!win.isDestroyed()) {
    try { win.close() } catch { /* already closing */ }
  }
  return { detached: false }
}

interface AgentScriptError { __error: string }

function isScriptError(v: unknown): v is AgentScriptError {
  return Boolean(v) && typeof v === 'object' && typeof (v as AgentScriptError).__error === 'string'
}

// A real viewport size given to a WebContentsView while an agent operates on a
// tab the manual UI has not sized (Browser panel closed, or an agent-created tab
// the renderer never measured). Without a non-zero size the view has a
// degenerate 0×0 viewport: layout collapses (snapshots miss elements) and there
// is nothing to screenshot.
const RENDER_SIZE = { width: 1280, height: 900 }
// DOM operations (snapshot/content/click/type/scroll) only need correct *layout*,
// which the renderer computes for any widget size regardless of on-screen
// position — so we park the sized view far off-window where it can't paint over
// the UI. Screenshots additionally need the *compositor*, which only paints an
// on-window view, so agentCaptureTab positions on-window instead.
const OFFSCREEN_RENDER_BOUNDS: BrowserBounds = { x: -32000, y: 0, ...RENDER_SIZE }
const ONSCREEN_RENDER_BOUNDS: BrowserBounds = { x: 0, y: 0, ...RENDER_SIZE }

// Evaluate a script in the page, but never let a single eval hang this request:
// race it against a hard timeout and fall back to `undefined`. (rAF-based page
// promises can stall indefinitely for an off-window view whose rAF is throttled,
// so every in-page wait goes through here.)
function evalWithTimeout(wc: WebContents, code: string, timeoutMs: number): Promise<unknown> {
  return Promise.race([
    wc.executeJavaScript(code, true).catch(() => undefined),
    new Promise((res) => setTimeout(() => res(undefined), timeoutMs)),
  ])
}

// setBounds resizes the native view asynchronously — the render process only
// reflects the new size a few frames later. If we read the DOM before then, the
// page is still laid out at the old (0×0) size: full-width block elements like
// headings collapse to zero height and get filtered out of a snapshot, while
// intrinsically-sized form controls survive. So after a resize we poll the
// page's own innerWidth until it reflects the new size.
//
// HARD-BOUNDED: the poll runs at most RESIZE_POLL_TRIES × RESIZE_POLL_MS
// (~1000ms). If the size never confirms we log a warning and proceed anyway with
// whatever state exists — this loop can never hang. The known cost of proceeding
// early is that a snapshot taken immediately after a navigate may occasionally
// miss a heading or two; agents can simply call browser_snapshot again.
const RESIZE_POLL_TRIES = 10
const RESIZE_POLL_MS = 100
async function waitForResize(wc: WebContents, minWidth: number): Promise<void> {
  let matched = false
  for (let i = 0; i < RESIZE_POLL_TRIES; i++) {
    const w = await evalWithTimeout(wc, 'window.innerWidth', 250)
    if (typeof w === 'number' && w >= minWidth) { matched = true; break }
    await new Promise((r) => setTimeout(r, RESIZE_POLL_MS))
  }
  if (!matched) {
    console.warn('[browser] viewport resize not confirmed within budget; proceeding anyway (a snapshot may miss a heading — re-snapshot if it looks incomplete)')
  }
  // Best-effort single relayout frame, hard-capped in-page (setTimeout) so it
  // resolves even when rAF is throttled for an off-window view.
  await evalWithTimeout(
    wc,
    'new Promise(function(r){var d=false;function f(){if(d)return;d=true;r(1)}setTimeout(f,300);requestAnimationFrame(function(){requestAnimationFrame(f)})})',
    350
  )
}

// innerWidth is the viewport minus any scrollbar; accept a little slack.
const MIN_RENDER_WIDTH = RENDER_SIZE.width - 40

function restoreBounds(tab: BrowserTab, bounds: BrowserBounds): void {
  try {
    tab.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    })
  } catch { /* view may be gone */ }
}

// Run a DOM operation with a guaranteed-usable viewport. When the tab is already
// sized (visible in the panel) it runs as-is; when parked it is briefly given a
// real off-window size so layout is correct, then restored.
async function withRenderViewport<T>(tab: BrowserTab, op: () => Promise<T>): Promise<T> {
  const current = tab.bounds
  if (current.width >= 2 && current.height >= 2) return op()
  try { tab.view.setBounds(OFFSCREEN_RENDER_BOUNDS) } catch { /* view may be gone */ }
  try {
    await waitForResize(tab.view.webContents, MIN_RENDER_WIDTH)
    return await op()
  } finally {
    restoreBounds(tab, current)
  }
}

// Create a tab for an agent using the registered host window (the control
// server has no renderer event.sender to derive it from).
export function agentCreateTab(url?: string): string {
  if (!hostWindow || hostWindow.isDestroyed()) throw new Error('No host window for browser panel')
  const id = createBrowserTab(hostWindow)
  if (url) agentNavigateTab(id, url)
  return id
}

// Resolve after the tab finishes its current load, or after timeoutMs. Resolves
// immediately when the tab is not loading.
export function agentWaitForLoad(tabId: string, timeoutMs = 5000): Promise<{ ok: boolean; timedOut: boolean }> {
  const tab = tabs.get(tabId)
  if (!tab) return Promise.resolve({ ok: false, timedOut: false })
  const wc = tab.view.webContents
  if (!wc.isLoading()) return Promise.resolve({ ok: true, timedOut: false })
  return new Promise((resolve) => {
    let settled = false
    const finish = (timedOut: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { wc.removeListener('did-stop-loading', onStop) } catch { /* gone */ }
      resolve({ ok: !timedOut, timedOut })
    }
    const onStop = () => finish(false)
    wc.once('did-stop-loading', onStop)
    const timer = setTimeout(() => finish(true), timeoutMs)
  })
}

// PNG screenshot of the tab's current visual state.
//
// capturePage() only captures a view the compositor is actually painting. A tab
// visible in the panel captures directly. A parked/agent tab (0×0, or off-window)
// has no live surface, so we briefly position it on-window at a real size, let
// it paint, capture, then restore its previous bounds. In the intended Phase-2
// flow the Browser panel is open and the tab is already visible, so no temporary
// placement happens.
export async function agentCaptureTab(tabId: string): Promise<Buffer> {
  const tab = tabs.get(tabId)
  if (!tab) throw new Error(`No browser tab with id ${tabId}`)
  const wc = tab.view.webContents
  const current = tab.bounds
  if (current.width >= 2 && current.height >= 2) {
    const image = await wc.capturePage()
    return image.toPNG()
  }
  try { tab.view.setBounds(ONSCREEN_RENDER_BOUNDS) } catch { /* view may be gone */ }
  try {
    await waitForResize(wc, MIN_RENDER_WIDTH)
    const image = await wc.capturePage()
    return image.toPNG()
  } finally {
    restoreBounds(tab, current)
  }
}

// Cleaned readable text + title/url for the tab's current page.
export async function agentGetContent(tabId: string): Promise<{ title: string; url: string; text: string }> {
  const tab = tabs.get(tabId)
  if (!tab) throw new Error(`No browser tab with id ${tabId}`)
  const result = await withRenderViewport(tab, () => tab.view.webContents.executeJavaScript(contentScript(), true))
  if (isScriptError(result)) throw new Error(result.__error)
  return result as { title: string; url: string; text: string }
}

export interface AgentSnapshotElement {
  id: string
  tag: string
  role: string
  text: string
  type?: string
  boundingRect: { x: number; y: number; width: number; height: number }
  disabled: boolean
  multiple?: boolean
  accept?: string
}

export interface AgentSnapshotResponse {
  snapshotId: string
  url: string
  elements: AgentSnapshotElement[]
}

// Tag + return the interactive/context elements currently in (or near) view.
export async function agentSnapshot(tabId: string): Promise<AgentSnapshotResponse> {
  const tab = tabs.get(tabId)
  if (!tab) throw new Error(`No browser tab with id ${tabId}`)
  const snapshotId = randomUUID()
  const result = await withRenderViewport(tab, () => tab.view.webContents.executeJavaScript(snapshotScript(snapshotId), true))
  if (isScriptError(result)) throw new Error(result.__error)
  tab.snapshotId = snapshotId
  tab.snapshotUrl = tab.view.webContents.getURL()
  tab.snapshotGeneration = tab.navigationGeneration
  tab.snapshotElements = result as AgentSnapshotElement[]
  return { snapshotId, url: tab.snapshotUrl, elements: tab.snapshotElements }
}

function assertFreshSnapshot(tab: BrowserTab): { ok: true } | { ok: false; error: string; stale: true } {
  if (!tab.snapshotId || !tab.snapshotUrl) {
    return { ok: false, error: 'No element snapshot is active - call browser_get_elements first.', stale: true }
  }
  if (tab.snapshotUrl !== tab.view.webContents.getURL()) {
    return { ok: false, error: 'Stale element snapshot - the page navigated. Call browser_get_elements again.', stale: true }
  }
  if (tab.snapshotGeneration !== tab.navigationGeneration) {
    return { ok: false, error: 'Stale element snapshot - the page changed. Call browser_get_elements again.', stale: true }
  }
  return { ok: true }
}

export function getBrowserCommandContext(tabId?: string, elementId?: string): {
  tabId?: string
  currentUrl?: string
  currentOrigin?: string
  elementRole?: string
  elementName?: string
  sensitive: boolean
} {
  const tab = tabId ? tabs.get(tabId) : undefined
  const currentUrl = tab?.view.webContents.getURL() || tab?.url
  let currentOrigin: string | undefined
  try { currentOrigin = currentUrl ? new URL(currentUrl).origin : undefined } catch { /* about:blank */ }
  const element = elementId ? tab?.snapshotElements.find((item) => item.id === elementId) : undefined
  const descriptor = `${element?.role ?? ''} ${element?.type ?? ''} ${element?.text ?? ''}`
  const sensitive = /password|one.?time|otp|token|api.?key|credit|card|private.?key|secret|hidden|auth/i.test(descriptor)
  return {
    tabId,
    currentUrl,
    currentOrigin,
    elementRole: element?.role,
    elementName: element?.text,
    sensitive,
  }
}

export async function agentClick(tabId: string, elementId: string): Promise<{ ok: boolean; error?: string; stale?: boolean }> {
  const tab = tabs.get(tabId)
  if (!tab) throw new Error(`No browser tab with id ${tabId}`)
  const fresh = assertFreshSnapshot(tab)
  if (!fresh.ok) return fresh
  return withRenderViewport(tab, () => tab.view.webContents.executeJavaScript(clickScript(elementId), true))
}

export async function agentType(
  tabId: string,
  elementId: string,
  text: string,
  options: { replace?: boolean; pressEnter?: boolean } = {}
): Promise<{ ok: boolean; error?: string; stale?: boolean }> {
  const tab = tabs.get(tabId)
  if (!tab) throw new Error(`No browser tab with id ${tabId}`)
  const fresh = assertFreshSnapshot(tab)
  if (!fresh.ok) return fresh
  return withRenderViewport(tab, () => tab.view.webContents.executeJavaScript(typeScript(elementId, text, options), true))
}

export async function agentScroll(tabId: string, direction: 'up' | 'down', amount?: number): Promise<{ ok: boolean; error?: string }> {
  const tab = tabs.get(tabId)
  if (!tab) throw new Error(`No browser tab with id ${tabId}`)
  return withRenderViewport(tab, () => tab.view.webContents.executeJavaScript(scrollScript(direction, amount), true))
}

export async function agentPrepareUpload(identity: BrowserAgentIdentity, tabId: string | undefined, multiple: boolean): Promise<{ files: ReturnType<typeof browserUploadHandles.create>[]; multiple: boolean; cancelled: boolean }> {
  if (!hostWindow || hostWindow.isDestroyed()) throw new Error('No Browser host window is available.')
  const origin = tabId ? getBrowserCommandContext(tabId).currentOrigin : undefined
  const result = await dialog.showOpenDialog(hostWindow, { title: 'Select files to upload', properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'] })
  if (result.canceled || result.filePaths.length === 0) return { files: [], multiple, cancelled: true }
  const files = result.filePaths.map((selectedPath) => browserUploadHandles.create({ path: selectedPath, size: statSync(selectedPath).size, agentId: identity.agentId, tabId, origin }))
  return { files, multiple, cancelled: false }
}

export async function agentSetFileInput(identity: BrowserAgentIdentity, tabId: string, elementId: string, handles: string[]): Promise<{ status: string; tabId: string; elementId: string; filenames?: string[]; pageGeneration: number; uploadHandlesConsumed?: string[] }> {
  const tab = tabs.get(tabId)
  if (!tab) return { status: 'stale_page', tabId, elementId, pageGeneration: -1 }
  const fresh = assertFreshSnapshot(tab)
  if (!fresh.ok) return { status: 'stale_element', tabId, elementId, pageGeneration: tab.navigationGeneration }
  const element = tab.snapshotElements.find((candidate) => candidate.id === elementId)
  if (!element || element.tag !== 'input' || element.type !== 'file' || element.disabled) return { status: 'unsupported_input', tabId, elementId, pageGeneration: tab.navigationGeneration }
  if (!handles.length || handles.length > 20) return { status: 'invalid_handle', tabId, elementId, pageGeneration: tab.navigationGeneration }
  const origin = getBrowserCommandContext(tabId).currentOrigin
  const records = handles.map((id) => browserUploadHandles.getForUse(id, identity.agentId, tabId, origin))
  const invalid = records.find((record) => 'error' in record)
  if (invalid && 'error' in invalid) return { status: invalid.error, tabId, elementId, pageGeneration: tab.navigationGeneration }
  const valid = records as Exclude<typeof records[number], { error: string }>[]
  if (valid.length > 1 && !element.multiple) return { status: 'multiple_not_supported', tabId, elementId, pageGeneration: tab.navigationGeneration }
  try {
    // Electron owns the privileged path hand-off. Paths never cross the IPC/MCP boundary.
    await withRenderViewport(tab, async () => {
      const wc = tab.view.webContents as any
      if (typeof wc.setFileInputFiles !== 'function') throw new Error('This Electron runtime does not support controlled file input assignment.')
      wc.setFileInputFiles(valid.map((record) => record.path))
      return undefined
    })
  } catch {
    return { status: 'assignment_failed', tabId, elementId, pageGeneration: tab.navigationGeneration }
  }
  browserUploadHandles.consume(handles)
  return { status: 'ok', tabId, elementId, filenames: valid.map((record) => record.filename), pageGeneration: tab.navigationGeneration, uploadHandlesConsumed: handles }
}

export function agentGetDownloads(): ReturnType<typeof publicDownload>[] { return [...downloads.values()].map(publicDownload) }
export function agentDownload(tabId: string, url: string, identity: BrowserAgentIdentity): BrowserDownloadRecord { return beginDownload(tabId, url, identity.agentId) }
export function agentCancelDownload(downloadId: string): { cancelled: boolean } {
  const record = downloads.get(downloadId); if (!record || record.state === 'completed') return { cancelled: false }
  try { record.item?.cancel() } catch { /* noop */ }; record.state = 'cancelled'; record.cancelled = true; record.failureReason = 'cancelled_by_user'; return { cancelled: true }
}

// True when the given tab id exists (used by the control server for 404s).
export function browserTabExists(tabId: string): boolean {
  return tabs.has(tabId)
}

// Tear everything down on quit so no native views leak.
export function destroyAllBrowserTabs(): void {
  for (const tab of tabs.values()) {
    try {
      if (hostWindow && !hostWindow.isDestroyed()) hostWindow.contentView.removeChildView(tab.view)
    } catch { /* detached */ }
    try { tab.view.webContents.close() } catch { /* best effort */ }
  }
  tabs.clear()
  browserUploadHandles.clear()
  for (const record of downloads.values()) if (record.state === 'pending' || record.state === 'progressing') { try { record.item?.cancel() } catch { /* noop */ }; record.state = 'cancelled'; record.cancelled = true; record.failureReason = 'application_shutdown' }
  activeTabId = null
  // Never leave the detached Browser window orphaned when the app quits.
  if (detachedWindow && !detachedWindow.isDestroyed()) {
    try { detachedWindow.close() } catch { /* already closing */ }
  }
  detachedWindow = null
}
