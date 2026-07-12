import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserDownloadStatus, BrowserTabState } from '../types'

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

export default function BrowserPanel({ active }: { active: boolean }) {
  const [tabs, setTabs] = useState<BrowserTabState[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [addressDraft, setAddressDraft] = useState('')
  const [persistSession, setPersistSession] = useState(false)
  const [approvalCovered, setApprovalCovered] = useState(false)
  const [downloads, setDownloads] = useState<BrowserDownloadStatus[]>([])

  const viewportRef = useRef<HTMLDivElement>(null)
  const addressFocusedRef = useRef(false)
  const lastBoundsRef = useRef<string>('')
  const rafRef = useRef<number | null>(null)
  const activeTabIdRef = useRef<string | null>(null)
  activeTabIdRef.current = activeTabId

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  useEffect(() => {
    const onOverlay = (event: Event) => setApprovalCovered(Boolean((event as CustomEvent<{ covered?: boolean }>).detail?.covered))
    window.addEventListener('approval-overlay-change', onOverlay)
    return () => window.removeEventListener('approval-overlay-change', onOverlay)
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
  }, [refresh])

  useEffect(() => {
    const refreshDownloads = () => void window.api.browser.getDownloads().then(setDownloads).catch(() => undefined)
    refreshDownloads()
    const timer = window.setInterval(refreshDownloads, 800)
    return () => window.clearInterval(timer)
  }, [])

  // When the active tab changes, refresh the address bar (unless focused).
  useEffect(() => {
    if (addressFocusedRef.current) return
    setAddressDraft(displayUrl(activeTab?.url ?? ''))
  }, [activeTabId, activeTab?.url])

  // ── Bounds sync: keep the native view overlaid on the placeholder ──────────
  useEffect(() => {
    if (!active || !activeTabId || approvalCovered) {
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
  }, [active, activeTabId, approvalCovered])

  // ── Actions ────────────────────────────────────────────────────────────────
  function submitAddress(e: React.FormEvent) {
    e.preventDefault()
    if (!activeTabId) return
    void window.api.browser.navigate(activeTabId, addressDraft)
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
    await window.api.browser.createTab()
    await refresh()
  }

  async function togglePersist(next: boolean) {
    setPersistSession(next)
    await window.api.settings.set('browser_persist_session', next ? 'true' : 'false')
    await window.api.browser.reloadSessions()
    lastBoundsRef.current = ''
  }

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
      </div>

      {/* URL / nav bar */}
      <form className="browser-urlbar" onSubmit={submitAddress}>
        <button
          type="button"
          className="browser-nav-btn"
          data-testid="browser-back"
          aria-label="Back"
          title="Back"
          disabled={!activeTab?.canGoBack}
          onClick={() => activeTabId && window.api.browser.goBack(activeTabId)}
        >
          ‹
        </button>
        <button
          type="button"
          className="browser-nav-btn"
          data-testid="browser-forward"
          aria-label="Forward"
          title="Forward"
          disabled={!activeTab?.canGoForward}
          onClick={() => activeTabId && window.api.browser.goForward(activeTabId)}
        >
          ›
        </button>
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
          placeholder="Search or enter address"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onFocus={(e) => { addressFocusedRef.current = true; e.currentTarget.select() }}
          onBlur={() => { addressFocusedRef.current = false }}
          onChange={(e) => setAddressDraft(e.target.value)}
        />
        <button type="submit" className="browser-go-btn" data-testid="browser-go" aria-label="Go">
          Go
        </button>
        <label className="browser-persist-toggle" title="Keep cookies and logins between app restarts">
          <input
            type="checkbox"
            data-testid="browser-persist-toggle"
            checked={persistSession}
            onChange={(e) => void togglePersist(e.target.checked)}
          />
          Persist
        </label>
      </form>

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
          {activeTab.navigationError}
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
