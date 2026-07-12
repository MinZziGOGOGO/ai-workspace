// Local HTTP control server for agent browser control (Phase 2).
//
// Binds to 127.0.0.1 only — same security posture as the Web Companion's local
// mode — and exposes REST endpoints that drive the live WebContentsView tabs in
// browserPanel.ts. Only the running Electron app owns those native views, so
// this server is the bridge the stdio MCP server (out/mcp/browser-server.cjs)
// proxies to over loopback. When the app isn't running, nothing is listening
// and the MCP server surfaces that as a friendly "open the app" error.
//
// This is intentionally separate from webCompanion.ts: the Web Companion is a
// user-facing chat surface gated behind a bearer token and an enable toggle,
// whereas this is an always-on, localhost-only control plane for the local
// agents. It reuses the same createServer/port-binding shape.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import {
  agentCaptureTab,
  agentClick,
  agentCreateTab,
  agentGetContent,
  agentScroll,
  agentSnapshot,
  agentType,
  agentWaitForLoad,
  agentPrepareUpload,
  agentSetFileInput,
  agentGetDownloads,
  agentDownload,
  browserTabExists,
  closeBrowserTab,
  getBrowserState,
  getBrowserCommandContext,
  goBack as browserGoBack,
  goForward as browserGoForward,
  listBrowserTabs,
  navigateTab,
  reloadTab as browserReload,
  normalizeUrl
} from './browserPanel'
import { browserApprovals, classifyBrowserTool, isLoopbackUrl, redactBrowserInput, type BrowserAgentIdentity } from './browserApproval'
import { getHermesPermissionMode } from './hermes'

const DEFAULT_PORT = 8973
const MAX_BODY_BYTES = 256 * 1024

let server: Server | null = null
export const browserControlIdentityToken = randomBytes(32).toString('hex')

function hasValidIdentityToken(value: string): boolean {
  if (value.length !== browserControlIdentityToken.length) return false
  return timingSafeEqual(Buffer.from(value), Buffer.from(browserControlIdentityToken))
}

function requestIdentity(req: IncomingMessage): BrowserAgentIdentity {
  const supplied = String(req.headers['x-aiw-agent-id'] ?? '').trim()
  const name = String(req.headers['x-aiw-agent-name'] ?? '').trim()
  const token = String(req.headers['x-aiw-control-token'] ?? '')
  // Loopback callers are locally reachable but only app-launched MCP processes
  // receive the application-owned identity environment. This is attribution,
  // not a cryptographic claim; unlabelled callers are shown as unverified.
  return {
    agentId: supplied || `unverified:${req.socket.remotePort ?? 'local'}`,
    agentName: name || 'Unverified local MCP client',
    identityVerified: req.headers['x-aiw-identity-source'] === 'app-launch' && hasValidIdentityToken(token),
    transport: 'loopback-http',
    clientRequestId: String(req.headers['x-aiw-request-id'] ?? '').trim() || undefined,
  }
}

function originOf(url?: string): string | undefined {
  try { return url ? new URL(url).origin : undefined } catch { return undefined }
}

async function approved<T>(
  req: IncomingMessage,
  toolName: string,
  options: { tabId?: string; targetUrl?: string; elementId?: string; text?: string; mutation: boolean; summary: string; riskFlags?: string[] },
  execute: () => Promise<T> | T,
) {
  const context = getBrowserCommandContext(options.tabId, options.elementId)
  const sensitive = context.sensitive && options.text !== undefined
  const category = sensitive ? 'browser.sensitive' : classifyBrowserTool(toolName, options.targetUrl)
  return browserApprovals.submit(requestIdentity(req), getHermesPermissionMode(), {
    ...context,
    category,
    toolName,
    targetUrl: options.targetUrl,
    targetOrigin: originOf(options.targetUrl),
    leavesLocalhost: Boolean(options.targetUrl && !isLoopbackUrl(options.targetUrl)),
    elementId: options.elementId,
    actionSummary: options.summary,
    redactedInputPreview: options.text === undefined ? undefined : redactBrowserInput(options.text, sensitive),
    characterCount: options.text?.length,
    sensitive,
    riskFlags: options.riskFlags ?? [],
    mutation: options.mutation,
  }, async () => execute())
}

function sendOutcome(res: ServerResponse, outcome: Awaited<ReturnType<typeof approved>>): void {
  if (outcome.ok) sendJson(res, 200, { ok: true, result: outcome.value, approval: outcome.approval })
  else sendJson(res, outcome.code === 'failed' ? 422 : 403, outcome)
}

/**
 * Fixed loopback port for the control server. Stable across restarts so the
 * registered MCP server config stays valid; overridable for tests/conflicts via
 * AIWORKSPACE_BROWSER_CONTROL_PORT.
 */
export function browserControlPort(): number {
  const raw = Number(process.env.AIWORKSPACE_BROWSER_CONTROL_PORT)
  return Number.isInteger(raw) && raw >= 1024 && raw <= 65535 ? raw : DEFAULT_PORT
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function sendPng(res: ServerResponse, png: Buffer): void {
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store',
    'Content-Length': png.length
  })
  res.end(png)
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// Route table keyed on method + a path regex. `:id` captures a tab id.
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  const path = (req.url ?? '/').split('?')[0]

  // GET /browser/tabs
  if (method === 'GET' && path === '/browser/tabs') {
    return sendOutcome(res, await approved(req, 'browser_list_tabs', { mutation: false, summary: 'List Browser tabs' }, () => listBrowserTabs()))
  }

  // GET /browser/state
  if (method === 'GET' && path === '/browser/state') {
    return sendOutcome(res, await approved(req, 'browser_get_state', { mutation: false, summary: 'Read Browser state' }, () => getBrowserState()))
  }

  if (method === 'GET' && path === '/browser/downloads') {
    return sendOutcome(res, await approved(req, 'browser_get_downloads', { mutation: false, summary: 'View controlled Browser downloads' }, () => agentGetDownloads()))
  }

  if (method === 'POST' && path === '/browser/uploads/prepare') {
    const body = await readBody(req)
    const tabId = typeof body.tabId === 'string' && body.tabId ? body.tabId : undefined
    if (tabId && !browserTabExists(tabId)) return sendJson(res, 404, { error: `No tab with id ${tabId}` })
    const multiple = body.multiple === true
    return sendOutcome(res, await approved(req, 'browser_prepare_upload', { tabId, mutation: true, summary: 'Select local files for Browser upload', riskFlags: ['Native file picker; selected paths stay in the app'] }, () => agentPrepareUpload(requestIdentity(req), tabId, multiple)))
  }

  // POST /browser/tabs  { url? }
  if (method === 'POST' && path === '/browser/tabs') {
    const body = await readBody(req)
    const url = typeof body.url === 'string' && body.url.trim() ? normalizeUrl(body.url.trim()) : 'about:blank'
    return sendOutcome(res, await approved(req, 'browser_create_tab', { targetUrl: url, mutation: true, summary: `Open Browser tab to ${originOf(url) ?? url}` }, () => ({ tabId: agentCreateTab(url) })))
  }

  const tabMatch = path.match(/^\/browser\/tabs\/([^/]+)(?:\/([a-z-]+))?$/)
  if (!tabMatch) return sendJson(res, 404, { error: 'Not found' })

  const tabId = decodeURIComponent(tabMatch[1])
  const action = tabMatch[2] ?? ''

  // DELETE /browser/tabs/:id
  if (method === 'DELETE' && !action) {
    if (!browserTabExists(tabId)) return sendJson(res, 404, { error: `No tab with id ${tabId}` })
    return sendOutcome(res, await approved(req, 'browser_close_tab', { tabId, mutation: true, summary: 'Close Browser tab' }, () => { closeBrowserTab(tabId); return { closed: true } }))
  }

  // Everything below operates on an existing tab.
  if (!browserTabExists(tabId)) return sendJson(res, 404, { error: `No tab with id ${tabId}` })

  if (method === 'POST' && action === 'navigate') {
    const body = await readBody(req)
    const url = normalizeUrl(String(body.url ?? '').trim())
    if (!url) return sendJson(res, 400, { error: 'url is required' })
    return sendOutcome(res, await approved(req, 'browser_navigate', { tabId, targetUrl: url, mutation: true, summary: `Navigate to ${originOf(url) ?? url}`, riskFlags: isLoopbackUrl(url) ? [] : ['Leaves localhost'] }, () => { navigateTab(tabId, url); return { navigated: true } }))
  }

  if (method === 'POST' && action === 'back') {
    return sendOutcome(res, await approved(req, 'browser_go_back', { tabId, mutation: true, summary: 'Go back in Browser history' }, () => { browserGoBack(tabId); return { navigated: true } }))
  }

  if (method === 'POST' && action === 'forward') {
    return sendOutcome(res, await approved(req, 'browser_go_forward', { tabId, mutation: true, summary: 'Go forward in Browser history' }, () => { browserGoForward(tabId); return { navigated: true } }))
  }

  if (method === 'POST' && action === 'reload') {
    return sendOutcome(res, await approved(req, 'browser_reload', { tabId, mutation: true, summary: 'Reload the current Browser page' }, () => { browserReload(tabId); return { reloaded: true } }))
  }

  if (method === 'POST' && action === 'wait-for-load') {
    return sendOutcome(res, await approved(req, 'browser_wait_for_load', { tabId, mutation: false, summary: 'Wait for Browser page load' }, () => agentWaitForLoad(tabId, 5000)))
  }

  if (method === 'GET' && action === 'screenshot') {
    const outcome = await approved(req, 'browser_screenshot', { tabId, mutation: false, summary: 'Capture Browser screenshot' }, () => agentCaptureTab(tabId))
    if (!outcome.ok) return sendJson(res, 403, outcome)
    return sendPng(res, outcome.value)
  }

  if (method === 'GET' && action === 'content') {
    return sendOutcome(res, await approved(req, 'browser_get_content', { tabId, mutation: false, summary: 'Read visible Browser content' }, () => agentGetContent(tabId)))
  }

  if (method === 'GET' && action === 'snapshot') {
    return sendOutcome(res, await approved(req, 'browser_get_elements', { tabId, mutation: false, summary: 'Inspect interactive Browser elements' }, () => agentSnapshot(tabId)))
  }

  if (method === 'POST' && action === 'click') {
    const body = await readBody(req)
    const elementId = String(body.elementId ?? '').trim()
    if (!elementId) return sendJson(res, 400, { error: 'elementId is required' })
    return sendOutcome(res, await approved(req, 'browser_click', { tabId, elementId, mutation: true, summary: 'Click a Browser element', riskFlags: ['May navigate, submit, or trigger a side effect'] }, () => agentClick(tabId, elementId)))
  }

  if (method === 'POST' && action === 'type') {
    const body = await readBody(req)
    const elementId = String(body.elementId ?? '').trim()
    if (!elementId) return sendJson(res, 400, { error: 'elementId is required' })
    const text = typeof body.text === 'string' ? body.text : String(body.text ?? '')
    return sendOutcome(res, await approved(req, 'browser_type', { tabId, elementId, text, mutation: true, summary: 'Type into a Browser field', riskFlags: body.pressEnter === true ? ['Presses Enter and may submit a form'] : [] }, () => agentType(tabId, elementId, text, {
      replace: body.replace !== false,
      pressEnter: body.pressEnter === true
    })))
  }

  if (method === 'POST' && action === 'scroll') {
    const body = await readBody(req)
    const direction = body.direction === 'up' ? 'up' : 'down'
    const rawAmount = Number(body.amount)
    const amount = Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : undefined
    return sendOutcome(res, await approved(req, 'browser_scroll', { tabId, mutation: true, summary: `Scroll Browser ${direction}` }, () => agentScroll(tabId, direction, amount)))
  }

  if (method === 'POST' && action === 'set-file-input') {
    const body = await readBody(req)
    const elementId = String(body.elementId ?? '').trim()
    const handles = Array.isArray(body.uploadHandles) ? body.uploadHandles.filter((value: unknown): value is string => typeof value === 'string' && value.length <= 128) : []
    if (!elementId || !handles.length) return sendJson(res, 400, { error: 'elementId and uploadHandles are required' })
    return sendOutcome(res, await approved(req, 'browser_set_file_input', { tabId, elementId, mutation: true, summary: 'Attach selected files to Browser upload field', riskFlags: ['Consumes one-time upload handles'] }, () => agentSetFileInput(requestIdentity(req), tabId, elementId, handles)))
  }

  if (method === 'POST' && action === 'download') {
    const body = await readBody(req)
    const url = String(body.url ?? '').trim()
    let parsed: URL
    try { parsed = new URL(url) } catch { return sendJson(res, 400, { error: 'A valid http or https URL is required' }) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return sendJson(res, 400, { error: 'Only http and https downloads are allowed' })
    return sendOutcome(res, await approved(req, 'browser_download', { tabId, targetUrl: parsed.toString(), mutation: true, summary: `Download from ${parsed.origin}`, riskFlags: ['Saved to Managed Browser Downloads'] }, () => agentDownload(tabId, parsed.toString(), requestIdentity(req))))
  }

  return sendJson(res, 404, { error: 'Not found' })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const identity = requestIdentity(req)
  res.on('close', () => {
    if (!res.writableEnded) browserApprovals.cancelForAgent(identity.agentId)
  })
  try {
    await route(req, res)
  } catch (e: any) {
    if (!res.headersSent) sendJson(res, 500, { error: String(e?.message ?? e) })
    else res.end()
  }
}

export function startBrowserControlServer(): Promise<{ running: boolean; port: number; error: string | null }> {
  const port = browserControlPort()
  return new Promise((resolve) => {
    if (server?.listening) return resolve({ running: true, port, error: null })
    const srv = createServer((req, res) => void handleRequest(req, res))
    srv.once('error', (e: any) => {
      server = null
      console.error('[browser-control] failed to start:', e?.message ?? e)
      resolve({ running: false, port, error: String(e?.message ?? e) })
    })
    srv.listen(port, '127.0.0.1', () => {
      server = srv
      console.log(`[browser-control] listening on http://127.0.0.1:${port}`)
      resolve({ running: true, port, error: null })
    })
  })
}

export function stopBrowserControlServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve()
    const closing = server
    server = null
    closing.close(() => resolve())
  })
}
