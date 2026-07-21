import { app, BrowserWindow, ipcMain, session } from 'electron'
import http from 'node:http'
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

// Verbose renderer content dumps (full markup, raw served body). These were the
// probes used to diagnose the corrupted-cache bug; that cause is understood and
// the health check below now auto-recovers from it, so they no longer earn a
// place in every launch's log. Kept — behind an opt-in — because they are the
// tool of choice if a similar "page parsed but looks wrong" report ever returns.
// The cheap one-line signals (contentType, HTTP status) stay unconditional.
const diagVerbose = process.env.AIWORKSPACE_DIAG_VERBOSE === '1'

if (!app.isPackaged && process.platform === 'win32') {
  // electron-vite development launches can fail to create the renderer process
  // under the Windows sandbox (exit code 49), leaving the Vite page half-loaded.
  // Keep this limited to unpackaged Windows runs; production stays sandboxed.
  app.commandLine.appendSwitch('no-sandbox')
  console.log(
    '[Diag] no-sandbox switch registered:',
    app.commandLine.hasSwitch('no-sandbox'),
    'value:',
    JSON.stringify(app.commandLine.getSwitchValue('no-sandbox'))
  )
}

// Renderer-failure diagnostics: environment context printed once at startup so
// pasted logs from an affected machine carry version + memory info.
console.log(
  '[Diag] versions:',
  JSON.stringify({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  })
)
try {
  console.log('[Diag] system memory (KB):', JSON.stringify(process.getSystemMemoryInfo()))
} catch (err) {
  console.error('[Diag] getSystemMemoryInfo failed:', err)
}

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

// --- Renderer self-healing (corrupted Chromium disk-cache recovery) ---------
// Root cause: a repeated force-kill of the app during dev debugging left
// %APPDATA%/ai-workspace/Cache in a state where Chromium kept serving a
// stale/garbled 304-reused entry for index.html even though the real dev
// server response was always clean. That's not a bug in this app's code, but
// the same failure mode (crash, forced shutdown, power loss, disk error, AV
// interference mid-write) could hit a packaged build too, so the app checks
// its own renderer health after every load and self-heals instead of leaving
// a real user stuck on a permanently broken window.
const EXPECTED_TITLE = 'AI Workspace'
const HEALTH_CHECK_SETTLE_MS = 500

// Test hook only: forces the health check to report unhealthy so the
// cache-clear-and-reload / fallback-screen paths can be exercised without
// hand-corrupting the real Chromium cache. 'once' fails a single check (to
// verify the auto-recovery reload path); 'always' fails every check (to
// verify the fallback error screen).
let forceHealthCheckFailOnce = process.env.AIWORKSPACE_FORCE_HEALTH_CHECK_FAIL === 'once'

async function verifyRendererHealth(win: BrowserWindow): Promise<boolean> {
  if (win.isDestroyed()) return false
  if (process.env.AIWORKSPACE_FORCE_HEALTH_CHECK_FAIL === 'always') {
    console.log('[Recovery] health check forced unhealthy via AIWORKSPACE_FORCE_HEALTH_CHECK_FAIL=always')
    return false
  }
  if (forceHealthCheckFailOnce) {
    forceHealthCheckFailOnce = false
    console.log('[Recovery] health check forced unhealthy via AIWORKSPACE_FORCE_HEALTH_CHECK_FAIL=once')
    return false
  }
  try {
    const probe = await win.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('root')
      // Defensive signature check for the exact garbled-cache symptom seen in
      // the incident: raw response bytes dumped as text directly under <body>,
      // outside the mounted #root app.
      let strayText = false
      if (document.body) {
        for (const node of Array.from(document.body.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE && node.textContent && /[\\x00-\\x08\\x0E-\\x1F]/.test(node.textContent)) {
            strayText = true
            break
          }
        }
      }
      return { title: document.title || '', rootChildren: root ? root.childElementCount : 0, strayText: strayText }
    })()`)
    const healthy =
      typeof probe?.title === 'string' &&
      probe.title === EXPECTED_TITLE &&
      typeof probe?.rootChildren === 'number' &&
      probe.rootChildren > 0 &&
      !probe.strayText
    console.log('[Recovery] health check probe:', JSON.stringify(probe), 'healthy:', healthy)
    return healthy
  } catch (err) {
    console.error('[Recovery] health check probe threw:', err)
    return false
  }
}

function fallbackErrorScreenHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>AI Workspace</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    background: #141519;
    color: #e8e8ea;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .box { max-width: 420px; text-align: center; padding: 32px; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  p { font-size: 14px; line-height: 1.5; color: #a8a8ae; margin: 0 0 24px; }
  button {
    background: #7c5cff;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 10px 22px;
    font-size: 14px;
    cursor: pointer;
  }
  button:hover { background: #8f72ff; }
  button:disabled { opacity: 0.6; cursor: default; }
</style>
</head>
<body>
  <div class="box">
    <h1>AI Workspace failed to load correctly.</h1>
    <p>This is usually fixed by resetting the local cache.</p>
    <button id="reset-btn">Reset and Restart</button>
  </div>
  <script>
    document.getElementById('reset-btn').addEventListener('click', (e) => {
      e.target.disabled = true
      e.target.textContent = 'Resetting...'
      window.api.app.resetAndRestart()
    })
  </script>
</body>
</html>`
}

function showFallbackErrorScreen(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  console.error('[Recovery] Showing fallback error screen (health check still failing after cache-clear retry)')
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fallbackErrorScreenHtml()))
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
  // --- Renderer-failure diagnostics (attached before any load starts) ---
  // Captures the real reason when the renderer process dies or a load fails,
  // instead of guessing from the symptom. Verbose on purpose; trim after the
  // garbled-renderer bug is root-caused.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[RENDERER GONE]', JSON.stringify(details))
  })
  win.webContents.on('unresponsive', () => {
    console.error('[RENDERER UNRESPONSIVE]')
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error('[LOAD FAILED]', errorCode, errorDescription, 'url:', validatedURL, 'mainFrame:', isMainFrame)
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[PRELOAD ERROR]', preloadPath, error)
  })
  // Surface renderer-side warnings/errors in the terminal (levels: 0=verbose,
  // 1=info, 2=warning, 3=error).
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[RENDERER CONSOLE] ${message} (${sourceId}:${line})`)
  })
  // Discriminator for the "raw page source shown as text" symptom: if the
  // document parsed as text/plain instead of text/html, scripts render as
  // literal text — a MIME/parsing failure, not a renderer crash.
  win.webContents.once('did-finish-load', () => {
    win.webContents
      .executeJavaScript(
        '({ contentType: document.contentType, title: document.title, bodyChildren: document.body ? document.body.childElementCount : -1 })'
      )
      .then((info) => console.log('[Diag] document after load:', JSON.stringify(info)))
      .catch((err) => console.error('[Diag] document probe failed:', err))
    // Full markup of whatever actually parsed, so an empty-body probe result can
    // be told apart from a blank page vs. source-rendered-as-text.
    if (diagVerbose) {
      win.webContents
        .executeJavaScript('document.documentElement.outerHTML')
        .then((html: string) => console.log('[Diag] outerHTML (first 2000 chars):', html.slice(0, 2000)))
        .catch((err) => console.error('[Diag] outerHTML probe failed:', err))
    }
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const loadRenderer = (): void => {
    console.log('[Diag] loading renderer from:', rendererUrl ?? join(__dirname, '../renderer/index.html'))
    if (rendererUrl) win.loadURL(rendererUrl)
    else win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  loadRenderer()

  // Self-healing health check: after each load finishes, verify the page
  // actually rendered the app (not a corrupted/garbled cache hit). Runs in
  // both dev and packaged builds — this protects real users, not just dev
  // debugging. Waits a beat past did-finish-load so React's async mount has
  // time to paint before the #root-children check runs (did-finish-load only
  // means the page's own load event fired, not that React has mounted yet).
  let recoveryAttempted = false
  // Guards against the fallback error page's own did-finish-load re-entering
  // this handler and reloading itself forever — once the fallback is shown,
  // the health check never runs again for this window.
  let fallbackShown = false
  win.webContents.on('did-finish-load', () => {
    if (fallbackShown) return
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_SETTLE_MS))
      if (win.isDestroyed() || fallbackShown) return
      const healthy = await verifyRendererHealth(win)
      if (healthy) {
        if (recoveryAttempted) console.log('[Recovery] Renderer healthy after cache-clear retry')
        return
      }
      if (recoveryAttempted) {
        fallbackShown = true
        showFallbackErrorScreen(win)
        return
      }
      recoveryAttempted = true
      console.error('[Recovery] Renderer health check failed — clearing cache and reloading (one automatic retry)')
      try {
        await session.defaultSession.clearCache()
        await session.defaultSession.clearStorageData({ storages: ['cachestorage'] })
        console.log('[Recovery] Cache cleared, reloading renderer')
      } catch (err) {
        console.error('[Recovery] Cache clear failed, reloading anyway:', err)
      }
      if (win.isDestroyed()) return
      loadRenderer()
    })()
  })

  // Same URL fetched outside Electron: shows the bytes and Content-Type Vite is
  // really serving, independent of any renderer-side weirdness.
  if (!app.isPackaged && rendererUrl?.startsWith('http://')) {
    http
      .get(rendererUrl, (res) => {
        console.log('[Diag] raw HTTP status:', res.statusCode, 'content-type:', res.headers['content-type'])
        if (!diagVerbose) {
          res.resume() // Drain; nothing is reading the body.
          return
        }
        console.log('[Diag] raw HTTP headers:', JSON.stringify(res.headers))
        let body = ''
        res.on('data', (chunk) => {
          if (body.length < 500) body += chunk
        })
        res.on('end', () => console.log('[Diag] raw HTTP body (first 500 chars):', body.slice(0, 500)))
      })
      .on('error', (err) => console.error('[Diag] raw HTTP probe failed:', err))
  }
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

// Belt-and-suspenders reset triggered from the fallback error screen: clear
// the cache again (in case the automatic retry's clear didn't take, e.g. the
// corruption was in a different storage area) and do a full process relaunch
// rather than another in-place reload, since a fresh process is the more
// reliable recovery once the automatic single-retry path has already failed.
ipcMain.handle('app:resetAndRestart', async () => {
  console.log('[Recovery] Reset and Restart requested from fallback error screen')
  try {
    await session.defaultSession.clearCache()
    await session.defaultSession.clearStorageData({ storages: ['cachestorage'] })
    console.log('[Recovery] Cache cleared before relaunch')
  } catch (err) {
    console.error('[Recovery] Cache clear before relaunch failed:', err)
  }
  app.relaunch()
  app.exit(0)
})

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
