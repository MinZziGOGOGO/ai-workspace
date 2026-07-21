import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserDownloadStatus, BrowserPreviewDetectionResult, BrowserPreviewInspection, BrowserTabState, Project } from '../types'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'

// The BrowserPanel draws the browser CHROME (tab bar, URL bar, nav buttons) as
// normal React DOM. The actual web page is a native Electron WebContentsView that
// renders ABOVE the DOM — it is not a React element. Our job is to keep that
// native view exactly overlaid on the `.browser-viewport` placeholder by measuring
// the placeholder's on-screen rect and streaming it to the main process. When the
// panel is inactive (closed, or another panel fullscreened over it) we hide the
// native view, because a view that paints above the DOM would otherwise show
// through on top of whatever is covering us.

function displayUrl(url: string): string {
  if (!url || url === 'about:blank') return ''
  return url
}

function faviconOrigin(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

type BrowserMode = 'browse' | 'preview'

const PREVIEW_PRESETS = [
  { label: 'Vite', port: 5173 },
  { label: 'React / Next', port: 3000 },
  { label: 'Vite preview', port: 4173 },
  { label: 'Vite alt', port: 5174 },
]

function previewStorageKey(projectId: string): string {
  return `aiworkspace.browserPreview.${projectId}`
}

function loadPreviewState(projectId: string): { mode: BrowserMode; url: string } {
  try {
    const parsed = JSON.parse(localStorage.getItem(previewStorageKey(projectId)) ?? '{}') as { mode?: unknown; url?: unknown }
    return {
      mode: parsed.mode === 'preview' ? 'preview' : 'browse',
      url: typeof parsed.url === 'string' ? parsed.url : '',
    }
  } catch {
    return { mode: 'browse', url: '' }
  }
}

function savePreviewState(projectId: string, mode: BrowserMode, url: string): void {
  localStorage.setItem(previewStorageKey(projectId), JSON.stringify({ mode, url }))
}

function localPreviewUrl(input: string): string | null {
  const raw = input.trim()
  const value = /^(localhost|127\.0\.0\.1)(:\d+)?(?:\/|$)/i.test(raw) || /^\[::1\](?::\d+)?(?:\/|$)/i.test(raw)
    ? `http://${raw}`
    : raw
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) return null
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
    return parsed.href
  } catch {
    return null
  }
}

export default function BrowserPanel({ active, project, isDetachedWindow = false }: { active: boolean; project: Project; isDetachedWindow?: boolean }) {
  const initialPreview = loadPreviewState(project.id)
  const [tabs, setTabs] = useState<BrowserTabState[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  // Only the MAIN window's instance ever shows the "detached" placeholder —
  // the detached window's own instance of this same component IS the panel,
  // so it always renders normally regardless of the global detached flag.
  const [panelDetached, setPanelDetached] = useState(false)
  const [addressDraft, setAddressDraft] = useState('')
  const [persistSession, setPersistSession] = useState(false)
  const [approvalCovered, setApprovalCovered] = useState(false)
  const [menuCovered, setMenuCovered] = useState(false)
  const [dragCovered, setDragCovered] = useState(false)
  const [downloads, setDownloads] = useState<BrowserDownloadStatus[]>([])
  const [mode, setMode] = useState<BrowserMode>(initialPreview.mode)
  const [savedPreviewUrl, setSavedPreviewUrl] = useState(initialPreview.url)
  const [detection, setDetection] = useState<BrowserPreviewDetectionResult | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [previewNotice, setPreviewNotice] = useState('')
  const [previewMenuOpen, setPreviewMenuOpen] = useState(false)
  const [previewInspection, setPreviewInspection] = useState<BrowserPreviewInspection | null>(null)

  const viewportRef = useRef<HTMLDivElement>(null)
  const previewMenuRef = useRef<HTMLDivElement>(null)
  const addressFocusedRef = useRef(false)
  const lastBoundsRef = useRef<string>('')
  const rafRef = useRef<number | null>(null)
  const activeTabIdRef = useRef<string | null>(null)
  const modeRef = useRef<BrowserMode>(mode)
  const activeUrlRef = useRef('')
  const activeRef = useRef(active)
  const previewRefreshTimerRef = useRef<number | null>(null)
  activeTabIdRef.current = activeTabId
  modeRef.current = mode
  activeRef.current = active

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  activeUrlRef.current = activeTab?.url ?? ''
  const isGlobal = isGlobalProjectId(project.id)

  // The main process is authoritative for agent-triggered preview routing. If
  // an MCP request switched the active tab before this panel mounted (or while
  // it was hidden), mirror that state into the existing Preview chrome.
  useEffect(() => {
    if (activeTab?.previewMode && localPreviewUrl(activeTab.url)) {
      setMode('preview')
      setAddressDraft(activeTab.url)
      setSavedPreviewUrl(activeTab.url)
      setPreviewNotice('Opened by the agent in AI Workspace Browser Preview.')
      savePreviewState(project.id, 'preview', activeTab.url)
    } else if (activeTab?.previewMode === false && modeRef.current === 'preview' && activeTab.url !== 'about:blank') {
      setMode('browse')
      setAddressDraft(displayUrl(activeTab.url))
      setPreviewNotice('')
      savePreviewState(project.id, 'browse', savedPreviewUrl)
    }
  }, [activeTab?.previewMode, activeTab?.url, project.id, savedPreviewUrl])

  useEffect(() => {
    const next = loadPreviewState(project.id)
    setMode(next.mode)
    setSavedPreviewUrl(next.url)
    setAddressDraft(next.mode === 'preview' ? next.url : displayUrl(activeTab?.url ?? ''))
    setDetection(null)
    setDetecting(false)
    setPreviewNotice('')
    setPreviewMenuOpen(false)
    setPreviewInspection(null)
  }, [project.id])

  useEffect(() => {
    if (!previewMenuOpen) return
    const close = (event: PointerEvent) => {
      if (!previewMenuRef.current?.contains(event.target as Node)) setPreviewMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreviewMenuOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [previewMenuOpen])

  useEffect(() => {
    const onApproval = (event: Event) => setApprovalCovered(Boolean((event as CustomEvent<{ covered?: boolean }>).detail?.covered))
    // Topbar dropdowns (Tools/AI/Knowledge, layout presets, etc.) are plain DOM
    // and can never paint over the native WebContentsView. Park the native view
    // while any such menu is open so the menu is actually visible.
    const onMenu = (event: Event) => setMenuCovered(Boolean((event as CustomEvent<{ covered?: boolean }>).detail?.covered))
    // A panel-header drag (or the dock-zone debug overlay) parks the native view
    // via IPC; we must also stop the bounds-sync loop below so it can't re-push
    // setBounds and un-park the view mid-drag (the placeholder reflows when a
    // sibling panel is hidden during the drag).
    const onDrag = (event: Event) => setDragCovered(Boolean((event as CustomEvent<{ covered?: boolean }>).detail?.covered))
    window.addEventListener('approval-overlay-change', onApproval)
    window.addEventListener('menu-overlay-change', onMenu)
    window.addEventListener('browser-drag-change', onDrag)
    return () => {
      window.removeEventListener('approval-overlay-change', onApproval)
      window.removeEventListener('menu-overlay-change', onMenu)
      window.removeEventListener('browser-drag-change', onDrag)
    }
  }, [])

  // ── Load tab list + subscribe to live updates ──────────────────────────────
  const refresh = useCallback(async () => {
    const { tabs: list, activeTabId: active } = await window.api.browser.listTabs()
    setTabs(list)
    setActiveTabId(active)
  }, [])

  useEffect(() => {
    let disposed = false

    void (async () => {
      const { tabs: list, activeTabId: active } = await window.api.browser.listTabs()
      if (disposed) return
      if (list.length === 0) {
        // First open of the panel: start with a blank tab.
        await window.api.browser.createTab()
        if (!disposed) await refresh()
      } else {
        setTabs(list)
        setActiveTabId(active)
        const activeState = list.find((tab) => tab.id === active)
        if (activeState?.previewMode && localPreviewUrl(activeState.url)) {
          setMode('preview')
          setAddressDraft(activeState.url)
          setSavedPreviewUrl(activeState.url)
          savePreviewState(project.id, 'preview', activeState.url)
        } else if (active && loadPreviewState(project.id).mode === 'preview') {
          // Restore a user-saved Preview mode only when main has not already
          // established a stronger agent-owned preview state.
          await window.api.browser.setPreviewMode(active, true)
        }
      }
    })()

    void window.api.settings.get('browser_persist_session').then((value) => {
      if (!disposed) setPersistSession(value === 'true')
    })

    const offUpdated = window.api.browser.onTabUpdated((state) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === state.id)
        if (idx === -1) return [...prev, state]
        const next = prev.slice()
        next[idx] = state
        return next
      })
      // Keep the address bar in sync with the active tab unless the user is typing.
      setActiveTabId((current) => {
        if (state.id === current && !addressFocusedRef.current) {
          setAddressDraft(displayUrl(state.url))
          if (modeRef.current === 'preview') {
            const safeUrl = localPreviewUrl(state.url)
            if (safeUrl) {
              setSavedPreviewUrl(safeUrl)
              savePreviewState(project.id, 'preview', safeUrl)
            }
          }
        }
        return current
      })
    })
    const offCreated = window.api.browser.onTabCreated(() => { void refresh() })
    const offClosed = window.api.browser.onTabClosed(() => { void refresh() })

    return () => {
      disposed = true
      offUpdated()
      offCreated()
      offClosed()
    }
  }, [project.id, refresh])

  // Track whether the Browser panel currently lives in a detached window. The
  // detached window's own instance never shows the placeholder (see the prop
  // comment above); the main window's instance shows it and, on reattach,
  // re-fetches tab state immediately rather than waiting on the next
  // browser:tabUpdated event (those went to the detached window while it owned
  // the views — see browserPanel.ts's hostWindow/mainWindow split).
  useEffect(() => {
    if (isDetachedWindow) return
    let disposed = false
    void window.api.browser.isDetached().then((detached) => { if (!disposed) setPanelDetached(detached) })
    const off = window.api.browser.onDetachedChanged(({ detached }) => {
      setPanelDetached(detached)
      if (!detached) void refresh()
    })
    return () => { disposed = true; off() }
  }, [isDetachedWindow, refresh])

  // Downloads are pulled, not pushed, so this needs a timer — but it does not
  // need this one. A closed Browser panel stays mounted to preserve tab state,
  // so the old ungated 800ms poll ran for the life of the app, whether or not
  // anything was transferring. Gated on `active` like the models/health polls,
  // then self-paced: 800ms only while bytes are actually moving, and a lazy
  // 4s otherwise purely to notice a transfer starting (there is no
  // download-changed event to subscribe to — see the report).
  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: number | undefined
    const transferring = (list: BrowserDownloadStatus[]): boolean =>
      list.some((d) => d.state === 'pending' || d.state === 'progressing')
    const tick = async (): Promise<void> => {
      let list: BrowserDownloadStatus[] | null = null
      try {
        list = await window.api.browser.getDownloads()
      } catch {
        list = null
      }
      if (cancelled) return
      if (list) setDownloads(list)
      timer = window.setTimeout(tick, list && transferring(list) ? 800 : 4000)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [active])

  // When the active tab changes, refresh the address bar (unless focused).
  useEffect(() => {
    if (addressFocusedRef.current) return
    if (mode === 'preview') {
      setAddressDraft(displayUrl(activeTab?.url ?? '') || savedPreviewUrl)
    } else {
      setAddressDraft(displayUrl(activeTab?.url ?? ''))
    }
  }, [activeTabId, activeTab?.url, mode, savedPreviewUrl])

  // ── Bounds sync: keep the native view overlaid on the placeholder ──────────
  useEffect(() => {
    if (!active || !activeTabId || approvalCovered || menuCovered || dragCovered || previewMenuOpen || panelDetached) {
      // Panel hidden or covered — park the native view off-screen.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      lastBoundsRef.current = ''
      void window.api.browser.hideAll()
      return
    }

    const tick = () => {
      const el = viewportRef.current
      const id = activeTabIdRef.current
      if (el && id) {
        const r = el.getBoundingClientRect()
        const bounds = {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        }
        const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
        // Only push when the rect actually moved/resized — covers panel resize,
        // redock/drag, fullscreen, and window resize with one loop.
        if (key !== lastBoundsRef.current) {
          lastBoundsRef.current = key
          void window.api.browser.setBounds(id, bounds)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    // Force one immediate push for the newly-active tab, bypassing the diff
    // check above. This effect re-runs on every activeTabId change (tab switch,
    // new tab, window.open, first mount); a tab that was parked at {0,0,0,0}
    // while inactive would otherwise stay blank because the placeholder rect
    // itself hasn't changed, so the diff-check loop never pushes its new rect.
    lastBoundsRef.current = ''
    tick()

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [active, activeTabId, approvalCovered, menuCovered, dragCovered, previewMenuOpen, panelDetached])

  // ── Actions ────────────────────────────────────────────────────────────────
  function submitAddress(e: React.FormEvent) {
    e.preventDefault()
    if (!activeTabId) return
    if (mode === 'preview') {
      const safeUrl = localPreviewUrl(addressDraft)
      if (safeUrl) {
        setSavedPreviewUrl(safeUrl)
        savePreviewState(project.id, mode, safeUrl)
        setPreviewNotice('Opening local preview...')
      } else {
        setPreviewNotice('Preview mode only allows localhost, 127.0.0.1, or [::1].')
      }
      void window.api.browser.navigatePreview(activeTabId, addressDraft)
    } else {
      void window.api.browser.navigate(activeTabId, addressDraft)
    }
    addressFocusedRef.current = false
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  function selectTab(id: string) {
    if (id === activeTabId) return
    setActiveTabId(id)
    lastBoundsRef.current = ''
    void window.api.browser.setActiveTab(id)
  }

  function closeTab(e: React.MouseEvent, id: string) {
    e.stopPropagation()
    void window.api.browser.closeTab(id)
  }

  async function newTab() {
    const id = await window.api.browser.createTab()
    if (mode === 'preview') await window.api.browser.setPreviewMode(id, true)
    await refresh()
  }

  async function togglePersist(next: boolean) {
    setPersistSession(next)
    await window.api.settings.set('browser_persist_session', next ? 'true' : 'false')
    await window.api.browser.reloadSessions()
    lastBoundsRef.current = ''
  }

  async function changeMode(next: BrowserMode) {
    setMode(next)
    setPreviewNotice('')
    savePreviewState(project.id, next, savedPreviewUrl)
    if (activeTabId) await window.api.browser.setPreviewMode(activeTabId, next === 'preview')
    setAddressDraft(next === 'preview' ? savedPreviewUrl : displayUrl(activeTab?.url ?? ''))
  }

  async function openPreview(url: string, targetTabId = activeTabId) {
    if (!targetTabId) return
    const safeUrl = localPreviewUrl(url)
    setMode('preview')
    setAddressDraft(url)
    setPreviewNotice(safeUrl ? 'Opening local preview...' : 'Preview mode blocked this URL because it is not local.')
    if (safeUrl) {
      setSavedPreviewUrl(safeUrl)
      savePreviewState(project.id, 'preview', safeUrl)
    }
    await window.api.browser.setPreviewMode(targetTabId, true)
    await window.api.browser.navigatePreview(targetTabId, url)
  }

  async function detectPreview(): Promise<BrowserPreviewDetectionResult | null> {
    setDetecting(true)
    setDetection(null)
    setPreviewNotice('')
    try {
      const result = await window.api.browser.detectPreview(project.id)
      setDetection(result)
      return result
    } catch (err) {
      setDetection({ urls: [], suggestions: [], signals: [], probedPorts: [], timeoutMs: 450, error: err instanceof Error ? err.message : String(err) })
      return null
    } finally {
      setDetecting(false)
    }
  }

  async function copyText(value: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(value)
      setPreviewNotice(successMessage)
    } catch {
      setPreviewNotice('Clipboard access was unavailable. Select the text and copy it manually.')
    }
  }

  const currentPreviewUrl = localPreviewUrl(addressDraft) ?? localPreviewUrl(activeTab?.url ?? '')
  const previewLoaded = Boolean(
    mode === 'preview' &&
    currentPreviewUrl &&
    activeTab?.url !== 'about:blank' &&
    !activeTab?.isLoading &&
    !activeTab?.navigationError
  )

  useEffect(() => {
    if (mode !== 'preview' || !previewLoaded || !activeTabId) {
      setPreviewInspection(null)
      return
    }
    let disposed = false
    const timer = window.setTimeout(() => {
      void window.api.browser.inspectPreview(activeTabId).then((result) => {
        if (!disposed) setPreviewInspection(result)
      }).catch(() => {
        if (!disposed) setPreviewInspection(null)
      })
    }, 650)
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [activeTabId, activeTab?.url, activeTab?.isLoading, activeTab?.navigationError, mode, previewLoaded])

  useEffect(() => {
    function onPreviewEdit(event: Event) {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail
      if (detail?.projectId !== project.id || !activeRef.current || modeRef.current !== 'preview') return
      if (!activeTabIdRef.current || !localPreviewUrl(activeUrlRef.current)) return
      if (previewRefreshTimerRef.current !== null) window.clearTimeout(previewRefreshTimerRef.current)
      previewRefreshTimerRef.current = window.setTimeout(() => {
        const tabId = activeTabIdRef.current
        if (activeRef.current && tabId && modeRef.current === 'preview' && localPreviewUrl(activeUrlRef.current)) {
          void window.api.browser.reload(tabId)
          setPreviewNotice('Preview refreshed after agent edits.')
        }
        previewRefreshTimerRef.current = null
      }, 1000)
    }
    window.addEventListener('preview:webFilesChanged', onPreviewEdit)
    return () => {
      window.removeEventListener('preview:webFilesChanged', onPreviewEdit)
      if (previewRefreshTimerRef.current !== null) window.clearTimeout(previewRefreshTimerRef.current)
    }
  }, [project.id])

  useEffect(() => {
    async function onOpenLivePreview(event: Event) {
      const detail = (event as CustomEvent<{ projectId?: string; url?: string }>).detail
      if (detail?.projectId !== project.id) return
      let tabId = activeTabIdRef.current
      if (!tabId) {
        tabId = await window.api.browser.createTab()
        await refresh()
      }
      setMode('preview')
      setPreviewMenuOpen(false)
      savePreviewState(project.id, 'preview', detail.url ?? savedPreviewUrl)
      await window.api.browser.setPreviewMode(tabId, true)
      if (detail.url) {
        await openPreview(detail.url, tabId)
        return
      }
      const result = await detectPreview()
      if (result?.urls[0]) await openPreview(result.urls[0], tabId)
      else setPreviewNotice('Project detected. Start its dev server, then detect again.')
    }
    window.addEventListener('browser:openLivePreview', onOpenLivePreview)
    return () => window.removeEventListener('browser:openLivePreview', onOpenLivePreview)
  }, [project.id, refresh, savedPreviewUrl])

  const showPreviewHelp = mode === 'preview' && Boolean(activeTab?.navigationError || previewInspection?.blank)

  // No "open in another window" placeholder: WorkspaceShell closes this panel's
  // dock slot outright while it is detached, so this component is unmounted in
  // the main window for the whole detached period. `panelDetached` survives only
  // to park the native view during the frame between the event and that unmount.

  return (
    <div className="browser-panel" data-testid="browser-panel-content">
      {/* Tab bar */}
      <div className="browser-tabbar" data-testid="browser-tabbar">
        <div className="browser-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`browser-tab${tab.id === activeTabId ? ' active' : ''}`}
              data-testid="browser-tab"
              onClick={() => selectTab(tab.id)}
              title={tab.title || tab.url}
            >
              {tab.isLoading
                ? <span className="browser-tab-spinner" aria-hidden />
                : <span className="browser-tab-favicon" aria-hidden>{faviconOrigin(tab.url).slice(0, 1).toUpperCase() || '•'}</span>}
              <span className="browser-tab-title">{tab.title || faviconOrigin(tab.url) || 'New Tab'}</span>
              <button
                className="browser-tab-close"
                data-testid="browser-tab-close"
                aria-label="Close tab"
                onClick={(e) => closeTab(e, tab.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          className="browser-newtab"
          data-testid="browser-new-tab"
          aria-label="New tab"
          title="New tab"
          onClick={() => void newTab()}
        >
          +
        </button>
        <div className="browser-mode-toggle" role="group" aria-label="Browser mode" data-testid="browser-mode-toggle">
          <button
            type="button"
            className={mode === 'browse' ? 'active' : ''}
            aria-pressed={mode === 'browse'}
            data-testid="browser-mode-browse"
            onClick={() => void changeMode('browse')}
          >
            Browse
          </button>
          <button
            type="button"
            className={mode === 'preview' ? 'active' : ''}
            aria-pressed={mode === 'preview'}
            data-testid="browser-mode-preview"
            onClick={() => void changeMode('preview')}
          >
            Preview
          </button>
        </div>
        <button
          type="button"
          className="browser-nav-btn"
          data-testid={isDetachedWindow ? 'browser-dock-back' : 'browser-detach'}
          aria-label={isDetachedWindow ? 'Dock back to the main window' : 'Open in a separate window'}
          title={isDetachedWindow ? 'Dock back to the main window' : 'Open in a separate window'}
          onClick={() => void (isDetachedWindow ? window.api.browser.reattach() : window.api.browser.detach(project.id))}
        >
          {isDetachedWindow ? '⧈' : '⧉'}
        </button>
      </div>

      {/* URL / nav bar */}
      <form className="browser-urlbar" onSubmit={submitAddress}>
        {mode === 'browse' && (
          <>
            <button type="button" className="browser-nav-btn" data-testid="browser-back" aria-label="Back" title="Back" disabled={!activeTab?.canGoBack} onClick={() => activeTabId && window.api.browser.goBack(activeTabId)}>‹</button>
            <button type="button" className="browser-nav-btn" data-testid="browser-forward" aria-label="Forward" title="Forward" disabled={!activeTab?.canGoForward} onClick={() => activeTabId && window.api.browser.goForward(activeTabId)}>›</button>
          </>
        )}
        <button
          type="button"
          className="browser-nav-btn"
          data-testid="browser-reload"
          aria-label={activeTab?.isLoading ? 'Stop' : 'Reload'}
          title={activeTab?.isLoading ? 'Stop' : 'Reload'}
          onClick={() =>
            activeTabId &&
            (activeTab?.isLoading
              ? window.api.browser.stop(activeTabId)
              : window.api.browser.reload(activeTabId))
          }
        >
          {activeTab?.isLoading ? '×' : '⟳'}
        </button>
        <input
          className="browser-url-input"
          data-testid="browser-url-input"
          value={addressDraft}
          placeholder={mode === 'preview' ? 'http://localhost:5173' : 'Search or enter address'}
          aria-label={mode === 'preview' ? 'Preview URL' : 'Browser address'}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onFocus={(e) => { addressFocusedRef.current = true; e.currentTarget.select() }}
          onBlur={() => { addressFocusedRef.current = false }}
          onChange={(e) => setAddressDraft(e.target.value)}
        />
        <button type="submit" className="browser-go-btn" data-testid="browser-go" aria-label="Go">
          {mode === 'preview' ? 'Open' : 'Go'}
        </button>
        {mode === 'preview' ? (
          <>
            <button type="button" className="browser-preview-detect" data-testid="browser-preview-detect" disabled={detecting || isGlobal} onClick={() => void detectPreview()}>
              {detecting ? 'Detecting…' : 'Detect'}
            </button>
            <div className="browser-preview-menu-wrap" ref={previewMenuRef}>
              <button type="button" className="browser-preview-menu-trigger" data-testid="browser-preview-menu-trigger" aria-label="More preview actions" aria-expanded={previewMenuOpen} onClick={() => setPreviewMenuOpen((open) => !open)}>•••</button>
              {previewMenuOpen && (
                <div className="browser-preview-menu" data-testid="browser-preview-menu" role="menu">
                  <button type="button" role="menuitem" data-testid="browser-preview-copy-url" disabled={!currentPreviewUrl} onClick={() => currentPreviewUrl && void copyText(currentPreviewUrl, 'Preview URL copied.')}>Copy URL</button>
                  <button type="button" role="menuitem" data-testid="browser-preview-open-external" disabled={!currentPreviewUrl} onClick={() => currentPreviewUrl && void window.api.shell.openExternal(currentPreviewUrl)}>Open externally</button>
                  <div className="browser-preview-menu-separator" />
                  <span className="browser-preview-menu-label">Presets</span>
                  {PREVIEW_PRESETS.map((preset) => (
                    <button key={preset.port} type="button" role="menuitem" data-testid={`browser-preview-preset-${preset.port}`} onClick={() => { setPreviewMenuOpen(false); void openPreview(`http://localhost:${preset.port}`) }}>
                      <span>{preset.label}</span><code>:{preset.port}</code>
                    </button>
                  ))}
                  <div className="browser-preview-menu-separator" />
                  <label className="browser-preview-menu-toggle"><input type="checkbox" data-testid="browser-persist-toggle" checked={persistSession} onChange={(e) => void togglePersist(e.target.checked)} />Persist session</label>
                  {detection?.suggestions.map((suggestion) => (
                    <button key={suggestion.command} type="button" role="menuitem" data-testid={`browser-preview-command-${suggestion.script}`} onClick={() => void copyText(suggestion.command, `${suggestion.command} copied.`)}>
                      <span>Copy command</span><code>{suggestion.command}</code>
                    </button>
                  ))}
                  {!isGlobal && <button type="button" role="menuitem" data-testid="browser-preview-open-terminal" onClick={() => { setPreviewMenuOpen(false); window.dispatchEvent(new CustomEvent('workspace:openPanel', { detail: { panel: 'terminal' } })) }}>Open Terminal</button>}
                </div>
              )}
            </div>
          </>
        ) : (
          <label className="browser-persist-toggle" title="Keep cookies and logins between app restarts">
            <input type="checkbox" data-testid="browser-persist-toggle" checked={persistSession} onChange={(e) => void togglePersist(e.target.checked)} />Persist
          </label>
        )}
      </form>

      {mode === 'preview' && (
        <section className="browser-preview-tools" data-testid="browser-preview-tools" aria-label="Project preview controls">
          <div className="browser-preview-status" data-testid="browser-preview-status" aria-live="polite">
            {previewLoaded ? (
              <span className="success">Preview loaded from {currentPreviewUrl}</span>
            ) : isGlobal ? (
              <span>Select a project workspace to detect its development server.</span>
            ) : detecting ? (
              <span>Checking likely local ports with a short timeout...</span>
            ) : detection?.error ? (
              <span className="error">{detection.error}</span>
            ) : detection && detection.urls.length === 0 ? (
              <span>No dev server detected. Start one in Terminal, then detect again.</span>
            ) : detection && detection.urls.length > 0 ? (
              <span className="browser-preview-detected">
                Detected {detection.urls.map((url) => (
                  <button key={url} type="button" onClick={() => void openPreview(url)}>{url}</button>
                ))}
              </span>
            ) : activeTab?.isLoading ? (
              <span>Loading preview...</span>
            ) : (
              <span>Enter a local URL, choose a preset, or detect the project server.</span>
            )}
            {previewNotice && <span className="browser-preview-notice">{previewNotice}</span>}
          </div>
        </section>
      )}

      {showPreviewHelp && (
        <div className="browser-preview-help" data-testid="browser-preview-help" role="status">
          <div>
            <strong>{activeTab?.navigationError ? 'Preview could not load.' : 'Preview looks blank.'}</strong>
            <span>Refresh, check the dev server or browser console, or use Terminal to restart it.</span>
          </div>
          <div className="browser-preview-help-actions">
            <button type="button" data-testid="browser-preview-help-refresh" onClick={() => activeTabId && window.api.browser.reload(activeTabId)}>Refresh</button>
            <button type="button" data-testid="browser-preview-help-external" disabled={!currentPreviewUrl} onClick={() => currentPreviewUrl && void window.api.shell.openExternal(currentPreviewUrl)}>Open externally</button>
            {!isGlobal && <button type="button" data-testid="browser-preview-help-terminal" onClick={() => window.dispatchEvent(new CustomEvent('workspace:openPanel', { detail: { panel: 'terminal' } }))}>Open Terminal</button>}
          </div>
        </div>
      )}

      {/* Loading progress bar */}
      <div className={`browser-progress${activeTab?.isLoading ? ' loading' : ''}`} aria-hidden />

      {downloads.some((download) => download.state === 'pending' || download.state === 'progressing') && (
        <div className="browser-transfer-status" data-testid="browser-transfer-status">
          {downloads.filter((download) => download.state === 'pending' || download.state === 'progressing').map((download) => (
            <span key={download.downloadId} title={`${download.displayLocation} · ${download.origin}`}>
              Downloading {download.filename}{download.totalBytes ? ` · ${Math.round(download.receivedBytes / download.totalBytes * 100)}%` : ''}
            </span>
          ))}
        </div>
      )}

      {activeTab?.navigationError && (
        <div className="browser-error" data-testid="browser-navigation-error" title={activeTab.navigationError}>
          {mode === 'preview' && /ERR_CONNECTION_REFUSED/i.test(activeTab.navigationError)
            ? 'Dev server is not running or refused the connection.'
            : activeTab.navigationError}
        </div>
      )}

      {/* Native WebContentsView overlays exactly this placeholder */}
      <div className="browser-viewport" data-testid="browser-viewport" ref={viewportRef}>
        {tabs.length === 0 && (
          <div className="browser-empty">
            <p className="muted">No tabs open.</p>
            <button className="primary" onClick={() => void newTab()}>Open a tab</button>
          </div>
        )}
      </div>
    </div>
  )
}
