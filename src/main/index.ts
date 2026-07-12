import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpc, killAllPtys } from './ipc'
import { destroyAllBrowserTabs, registerBrowserHostWindow } from './browserPanel'
import { browserApprovals } from './browserApproval'
import { startBrowserControlServer, stopBrowserControlServer, browserControlPort, browserControlIdentityToken } from './browserControlServer'
import { initDb, flushDb } from './db'
import { stopAllWatchers } from './indexer'
import { consolidateIfOverdue } from './extractor'
import { initWebCompanionFromConfig, stopWebCompanion } from './webCompanion'
import { readMcpServers, writeMcpServers, knowledgeMcpLaunchConfig, browserMcpLaunchConfig } from './mcp'

// E2E smoke tests run the real Electron app against an isolated throwaway DB.
// This keeps automated UI verification from mutating the user's normal workspace.
if (process.env.AIWORKSPACE_TEST_USER_DATA) {
  app.setPath('userData', process.env.AIWORKSPACE_TEST_USER_DATA)
}

// Use GPU acceleration by default for smoother scrolling, animation, and
// compositing. Keep an explicit software-rendering escape hatch for driver
// issues or headless test launches.
const gpuDisabled =
  process.env.ELECTRON_DISABLE_GPU === '1' ||
  process.env.AIWORKSPACE_DISABLE_GPU === '1'

if (gpuDisabled) {
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.commandLine.appendSwitch('in-process-gpu')
  app.disableHardwareAcceleration()
} else {
  app.commandLine.appendSwitch('force_high_performance_gpu')
}

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
  // E2E test runs launch out/main/index.js directly (not via the repo root),
  // so app.getAppPath() and userData resolve to test-only paths here. Never
  // let a test run sync those into the developer's real, shared Claude
  // Desktop config.
  if (process.env.AIWORKSPACE_TEST_USER_DATA) return
  try {
    const servers = readMcpServers()
    const serverCjsPath = join(app.getAppPath(), 'out', 'mcp', 'server.cjs')
    const dbDir = app.getPath('userData')
    // Launch via the app's Electron binary in run-as-node mode so the server
    // loads the Electron-ABI better-sqlite3 build (see knowledgeMcpLaunchConfig).
    const desired = knowledgeMcpLaunchConfig(serverCjsPath, dbDir)
    const current = servers['ai-workspace-knowledge']
    // Always re-sync this entry to the current launch config (never just
    // add-if-missing) so a stale pre-migration entry (e.g. a bare `node`
    // launch predating the better-sqlite3/Electron-as-Node switch) gets
    // auto-healed on the next app start instead of failing forever.
    if (current && JSON.stringify(current) === JSON.stringify(desired)) {
      console.log('[MCP] ai-workspace-knowledge already up to date')
      return
    }
    servers['ai-workspace-knowledge'] = desired
    writeMcpServers(servers)
    console.log(
      current
        ? '[MCP] Synced ai-workspace-knowledge to current launch config'
        : '[MCP] Added ai-workspace-knowledge to Claude Desktop config'
    )
  } catch (err) {
    console.warn('[MCP] Failed to update Claude Desktop config:', err)
  }
}

async function ensureBrowserMcp(): Promise<void> {
  // Same test guard as ensureKnowledgeMcp: never let an isolated E2E run sync
  // test-only paths into the developer's real Claude Desktop config.
  if (process.env.AIWORKSPACE_TEST_USER_DATA) return
  try {
    const servers = readMcpServers()
    const serverCjsPath = join(app.getAppPath(), 'out', 'mcp', 'browser-server.cjs')
    // Plain `node` here (no native modules, no Electron ABI needed); the control
    // server's loopback port is baked into the env.
    const desired = browserMcpLaunchConfig(serverCjsPath, browserControlPort(), browserControlIdentityToken)
    const current = servers['ai-workspace-browser']
    // Re-sync (not add-if-missing) so a stale port/path auto-heals on next start.
    if (current && JSON.stringify(current) === JSON.stringify(desired)) {
      console.log('[MCP] ai-workspace-browser already up to date')
      return
    }
    servers['ai-workspace-browser'] = desired
    writeMcpServers(servers)
    console.log(
      current
        ? '[MCP] Synced ai-workspace-browser to current launch config'
        : '[MCP] Added ai-workspace-browser to Claude Desktop config'
    )
  } catch (err) {
    console.warn('[MCP] Failed to register browser MCP server:', err)
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
    // Let agent-initiated browser-tab creation resolve a host window even
    // before the user opens a manual tab.
    registerBrowserHostWindow(win)
    browserApprovals.setHostWindow(win)
    console.log('[Main] Window created')
    perfLog('window-created')

    const startDeferredStartupTasks = () => {
      perfLog('deferred-start')
      ensureKnowledgeMcp().finally(() => perfLog('knowledge-mcp-ready'))
      ensureBrowserMcp().finally(() => perfLog('browser-mcp-ready'))

      // Always-on localhost control plane for agent browser control (Phase 2).
      // Skipped under E2E so parallel test runs never contend on the port.
      if (!process.env.AIWORKSPACE_TEST_USER_DATA || process.env.E2E_BROWSER_CONTROL === '1') {
        startBrowserControlServer()
          .then((s) => {
            if (s.running) console.log(`[Main] Browser control server listening on 127.0.0.1:${s.port}`)
            else console.error('[Main] Browser control server failed to start:', s.error)
            perfLog('browser-control-ready')
          })
          .catch((err) => console.error('[Main] Browser control server startup failed:', err))
      }

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

// Stop watchers and kill PTYs cleanly before the app exits. In WAL mode every
// write is already durable on disk the moment it returns — there is no
// debounced buffer to lose — so the old before-quit flush is gone. The single
// flushDb() here just checkpoints the WAL back into workspace.db to leave a
// tidy file behind.
app.on('will-quit', () => {
  stopAllWatchers()
  killAllPtys()
  destroyAllBrowserTabs()
  browserApprovals.cancelAll()
  void stopBrowserControlServer()
  void stopWebCompanion()
  flushDb()
})

process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason)
})
