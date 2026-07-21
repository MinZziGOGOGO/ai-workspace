import { useEffect, useRef, useState } from 'react'
import type { PreviewDevServerDetectedEvent, PreviewPanelState, Project } from '../types'

// PreviewPanel is a read-only, user-only live viewer — a second, isolated
// WebContentsView surface from the agent-controlled Browser panel. It carries
// no MCP exposure: nothing here is reachable by Hermes/Claude Code/Codex, it
// exists purely so the human can watch their own dev server hot-reload while
// an agent edits files. Chrome is plain DOM (this component); the actual page
// is a native view kept overlaid on the `.preview-viewport` placeholder,
// exactly like BrowserPanel's bounds-sync loop.

function displayUrl(url: string): string {
  if (!url || url === 'about:blank') return ''
  return url
}

export default function PreviewPanel({ active, project, isDetachedWindow = false }: { active: boolean; project: Project; isDetachedWindow?: boolean }) {
  const [state, setState] = useState<PreviewPanelState>({ url: '', title: '', isLoading: false, navigationError: null })
  const [addressDraft, setAddressDraft] = useState('')
  const [detectedUrl, setDetectedUrl] = useState<string | null>(null)
  const [menuCovered, setMenuCovered] = useState(false)
  const [dragCovered, setDragCovered] = useState(false)
  // See BrowserPanel's identical prop/state: only the main window's instance
  // shows the "detached" placeholder.
  const [panelDetached, setPanelDetached] = useState(false)

  const viewportRef = useRef<HTMLDivElement>(null)
  const addressFocusedRef = useRef(false)
  const lastBoundsRef = useRef<string>('')
  const rafRef = useRef<number | null>(null)

  const loaded = Boolean(state.url && state.url !== 'about:blank' && !state.isLoading && !state.navigationError)

  useEffect(() => {
    void window.api.preview.getState().then((next) => {
      setState(next)
      if (!addressFocusedRef.current) setAddressDraft(displayUrl(next.url))
    })
    void window.api.preview.getDetectedUrl(project.id).then(setDetectedUrl)
    const offUpdated = window.api.preview.onUpdated((next) => {
      setState(next)
      if (!addressFocusedRef.current) setAddressDraft(displayUrl(next.url))
    })
    const offDetected = window.api.preview.onDevServerDetected((event: PreviewDevServerDetectedEvent) => {
      setDetectedUrl(event.url)
    })
    return () => {
      offUpdated()
      offDetected()
    }
  }, [project.id])

  useEffect(() => {
    const onMenu = (event: Event) => setMenuCovered(Boolean((event as CustomEvent<{ covered?: boolean }>).detail?.covered))
    const onDrag = (event: Event) => setDragCovered(Boolean((event as CustomEvent<{ covered?: boolean }>).detail?.covered))
    window.addEventListener('menu-overlay-change', onMenu)
    window.addEventListener('preview-drag-change', onDrag)
    return () => {
      window.removeEventListener('menu-overlay-change', onMenu)
      window.removeEventListener('preview-drag-change', onDrag)
    }
  }, [])

  // Track whether the Preview panel currently lives in a detached window (see
  // BrowserPanel's identical effect for why refresh-on-reattach matters here:
  // preview:updated events went to the detached window while it owned the view).
  useEffect(() => {
    if (isDetachedWindow) return
    let disposed = false
    void window.api.preview.isDetached().then((detached) => { if (!disposed) setPanelDetached(detached) })
    const off = window.api.preview.onDetachedChanged(({ detached }) => {
      setPanelDetached(detached)
      if (!detached) void window.api.preview.getState().then((next) => { if (!disposed) setState(next) })
    })
    return () => { disposed = true; off() }
  }, [isDetachedWindow])

  // ── Bounds sync: keep the native view overlaid on the placeholder ──────────
  useEffect(() => {
    if (!active || menuCovered || dragCovered || panelDetached) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      lastBoundsRef.current = ''
      void window.api.preview.hideAll()
      return
    }

    const tick = () => {
      const el = viewportRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        const bounds = {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        }
        const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
        if (key !== lastBoundsRef.current) {
          lastBoundsRef.current = key
          void window.api.preview.setBounds(bounds)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    lastBoundsRef.current = ''
    tick()

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [active, menuCovered, dragCovered, panelDetached])

  function submitAddress(e: React.FormEvent) {
    e.preventDefault()
    void window.api.preview.navigate(addressDraft)
    addressFocusedRef.current = false
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  function openDetected() {
    if (!detectedUrl) return
    setAddressDraft(detectedUrl)
    void window.api.preview.navigate(detectedUrl)
  }

  // No "open in another window" placeholder — see BrowserPanel for the same
  // note: the dock slot itself is closed while this panel is detached, so
  // `panelDetached` only parks the native view until the unmount lands.

  return (
    <div className="preview-panel" data-testid="preview-panel-content">
      <form className="preview-urlbar" onSubmit={submitAddress}>
        <button
          type="button"
          className="preview-nav-btn"
          data-testid="preview-reload"
          aria-label={state.isLoading ? 'Stop' : 'Reload'}
          title={state.isLoading ? 'Stop' : 'Reload'}
          onClick={() => (state.isLoading ? window.api.preview.stop() : window.api.preview.reload())}
        >
          {state.isLoading ? '×' : '⟳'}
        </button>
        <input
          className="preview-url-input"
          data-testid="preview-url-input"
          value={addressDraft}
          placeholder="localhost:3000"
          aria-label="Preview URL"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onFocus={(e) => { addressFocusedRef.current = true; e.currentTarget.select() }}
          onBlur={() => { addressFocusedRef.current = false }}
          onChange={(e) => setAddressDraft(e.target.value)}
        />
        <button type="submit" className="preview-go-btn" data-testid="preview-go" aria-label="Open">Open</button>
        <button
          type="button"
          className="preview-nav-btn"
          data-testid={isDetachedWindow ? 'preview-dock-back' : 'preview-detach'}
          aria-label={isDetachedWindow ? 'Dock back to the main window' : 'Open in a separate window'}
          title={isDetachedWindow ? 'Dock back to the main window' : 'Open in a separate window'}
          onClick={() => void (isDetachedWindow ? window.api.preview.reattach() : window.api.preview.detach(project.id))}
        >
          {isDetachedWindow ? '⧈' : '⧉'}
        </button>
      </form>

      {!loaded && (
        <section className="preview-empty-state" data-testid="preview-empty-state">
          {detectedUrl ? (
            <>
              <p className="muted">Detected a dev server running at <code>{detectedUrl}</code>.</p>
              <button className="primary" data-testid="preview-open-detected" onClick={openDetected}>
                Open {detectedUrl}
              </button>
            </>
          ) : (
            <>
              <p className="muted">No dev server detected yet. Start one in Terminal, or enter a URL above.</p>
            </>
          )}
          {state.navigationError && (
            <p className="preview-nav-error" data-testid="preview-navigation-error">{state.navigationError}</p>
          )}
        </section>
      )}

      <div className={`preview-progress${state.isLoading ? ' loading' : ''}`} aria-hidden />

      <div className="preview-viewport" data-testid="preview-viewport" ref={viewportRef} />
    </div>
  )
}
