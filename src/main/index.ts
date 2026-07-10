import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpc, killAllPtys } from './ipc'
import { initDb, flushDb } from './db'
import { stopAllWatchers } from './indexer'
import { consolidateIfOverdue } from './extractor'
import { initWebCompanionFromConfig, stopWebCompanion } from './webCompanion'
import { readMcpServers, writeMcpServers } from './mcp'

// E2E smoke tests run the real Electron app against an isolated throwaway DB.
// This keeps automated UI verification from mutating the user's normal workspace.
if (process.env.AIWORKSPACE_TEST_USER_DATA) {
  app.setPath('userData', process.env.AIWORKSPACE_TEST_USER_DATA)
}

// Disable GPU rendering to prevent crashes
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('in-process-gpu')
app.disableHardwareAcceleration()

const perfLogsEnabled = process.env.AIWORKSPACE_PERF_LOGS === '1'
const startupStartedAt = Date.now()

function perfLog(label: string): void {
  if (!perfLogsEnabled) return
  console.log(`[perf:start] ${label} ${Date.now() - startupStartedAt}ms`)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#141519',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.webContents.once('did-finish-load', () => perfLog('renderer-loaded'))
  // Clear whatever background-completion attention cue window:notifyActivity set.
  win.on('focus', () => {
    win.flashFrame(false)
    app.setBadgeCount(0)
  })
  return win
}

async function ensureKnowledgeMcp(): Promise<void> {
  try {
    const servers = readMcpServers()
    if (servers['ai-workspace-knowledge']) {
      console.log('[MCP] ai-workspace-knowledge already configured')
      return
    }
    const serverCjsPath = join(app.getAppPath(), 'out', 'mcp', 'server.cjs')
    const dbDir = app.getPath('userData')
    servers['ai-workspace-knowledge'] = {
      command: 'node',
      args: [serverCjsPath],
      env: { AIWORKSPACE_DB_DIR: dbDir }
    }
    writeMcpServers(servers)
    console.log('[MCP] Added ai-workspace-knowledge to Claude Desktop config')
  } catch (err) {
    console.warn('[MCP] Failed to update Claude Desktop config:', err)
  }
}

app.whenReady().then(async () => {
  try {
    perfLog('app-ready')
    console.log('[Main] App ready, initializing database...')
    await initDb(app.getPath('userData'))
    console.log('[Main] Database initialized successfully')
    perfLog('db-ready')

    console.log('[Main] Registering IPC handlers...')
    registerIpc()
    console.log('[Main] IPC handlers registered')
    perfLog('ipc-ready')

    console.log('[Main] Creating window...')
    const win = createWindow()
    console.log('[Main] Window created')
    perfLog('window-created')

    const startDeferredStartupTasks = () => {
      perfLog('deferred-start')
      ensureKnowledgeMcp().finally(() => perfLog('knowledge-mcp-ready'))

      initWebCompanionFromConfig()
        .then((status) => {
          if (status.running) console.log(`[Main] Web Companion listening on ${status.localUrl}`)
          perfLog('web-companion-ready')
        })
        .catch((err) => console.error('[Main] Web Companion startup failed:', err))
    }

    win.webContents.once('did-finish-load', () => {
      setTimeout(startDeferredStartupTasks, 0)
    })

    // M4: overdue-triggered memory consolidation. Non-blocking — never delay
    // the UI on startup hygiene, and never crash the app if it fails.
    consolidateIfOverdue()
      .then((r) => r && console.log(`[Main] Consolidation removed ${r.removed} duplicate(s)`))
      .catch((err) => console.error('[Main] Consolidation failed:', err))

    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
  } catch (err) {
    console.error('[Main] Startup error:', err)
    process.exit(1)
  }
})
app.on('window-all-closed', () => {
  console.log('[Main] All windows closed')
  process.platform !== 'darwin' && app.quit()
})

// Flush the debounced sql.js persist before teardown starts, so the last
// write batch is never lost to the 500ms persist window.
app.on('before-quit', () => {
  flushDb()
})

// Stop watchers and kill PTYs cleanly before the app exits.
app.on('will-quit', () => {
  stopAllWatchers()
  killAllPtys()
  void stopWebCompanion()
  // Final flush: teardown above may have triggered one last debounced write.
  flushDb()
})

process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason)
})
