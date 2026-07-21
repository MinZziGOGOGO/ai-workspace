import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import type { ScreenPoint } from '../shared/ipcTypes'

// Shared window-creation helper for detaching a WebContentsView-backed panel
// (Browser, Preview) into its own native OS window. See WINDOW_DETACH_DESIGN.md
// §2.1 — the panel's WebContentsView is reparented onto this window via
// contentView.addChildView/removeChildView; this file only creates the empty
// host window and points it at the renderer bundle in "detached panel" mode
// (?detachedPanel=<id>), it does not touch any view.

export type DetachablePanelId = 'browser' | 'preview' | 'claudecode' | 'hermes' | 'codex' | 'kimi' | 'chat'

// Same bundling unit as index.ts's createWindow() (electron-vite rolls all of
// src/main/** into one out/main/index.js), so __dirname resolves identically.
function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

function rendererEntry(query: string): { url?: string; file?: string } {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) return { url: `${rendererUrl}?${query}` }
  return { file: join(__dirname, '../renderer/index.html') }
}

// A gesture drop anchors the new window's top chrome 80px left / 18px above
// the cursor, so the pointer remains over the same tab-like area it just
// dragged. Button-triggered detaches retain Step 1's main-window offset.
// Both paths are clamped to the target display's work area.
function placement(
  anchor: Electron.Rectangle,
  width: number,
  height: number,
  dropPoint?: ScreenPoint,
): { x: number; y: number } {
  const point = dropPoint ?? { x: anchor.x + 60, y: anchor.y + 60 }
  const display = screen.getDisplayNearestPoint(point)
  const area = display.workArea
  const desiredX = dropPoint ? point.x - 80 : point.x
  const desiredY = dropPoint ? point.y - 18 : point.y
  const maxX = area.x + Math.max(0, area.width - width)
  const maxY = area.y + Math.max(0, area.height - height)
  const x = Math.min(Math.max(desiredX, area.x), maxX)
  const y = Math.min(Math.max(desiredY, area.y), maxY)
  return { x, y }
}

export async function createDetachedPanelWindow(
  panelId: DetachablePanelId,
  projectId: string,
  title: string,
  mainWindow: BrowserWindow | null,
  dropPoint?: ScreenPoint,
): Promise<BrowserWindow> {
  const anchorBounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : { x: 100, y: 100, width: 1280, height: 840 }
  const width = 1000
  const height = 700
  const { x, y } = placement(anchorBounds, width, height, dropPoint)

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: '#141519',
    autoHideMenuBar: true,
    title,
    webPreferences: {
      preload: preloadPath(),
    },
  })

  const query = `detachedPanel=${panelId}&projectId=${encodeURIComponent(projectId)}`
  const entry = rendererEntry(query)
  if (entry.url) await win.loadURL(entry.url)
  else if (entry.file) await win.loadFile(entry.file, { search: query })

  return win
}
