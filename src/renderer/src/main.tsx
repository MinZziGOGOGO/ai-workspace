import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import DetachedPanelWindow, { DETACHABLE_REACT_PANELS, type DetachablePanelId } from './components/DetachedPanelWindow'
import './styles.css'

const DETACHABLE_PANEL_IDS = new Set<string>(['browser', 'preview', ...DETACHABLE_REACT_PANELS])

// A detached Browser/Preview/agent-tab window loads this same bundle with
// ?detachedPanel=<id>&projectId=<id> (see src/main/detachedPanelWindow.ts).
// Routed here, before React mounts anything, rather than as a conditional
// return inside App() — App() calls hooks unconditionally per the Rules of
// Hooks, and the query string never changes for the lifetime of a given
// window, so this is a one-time root choice, not per-render branching.
function resolveRoot(): React.ReactElement {
  const params = new URLSearchParams(window.location.search)
  const detachedPanel = params.get('detachedPanel')
  const projectId = params.get('projectId')
  if (detachedPanel && DETACHABLE_PANEL_IDS.has(detachedPanel) && projectId) {
    return <DetachedPanelWindow panelId={detachedPanel as DetachablePanelId} projectId={projectId} />
  }
  return <App />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {resolveRoot()}
  </React.StrictMode>
)
