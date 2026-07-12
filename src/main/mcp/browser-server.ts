// Browser control MCP server: the agent-facing face of the shared Browser panel.
//
// This process owns no Electron objects. It is a thin stdio-to-HTTP proxy to the
// loopback control server running inside the AI Workspace Electron app.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { randomUUID } from 'crypto'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'

const DEFAULT_PORT = 8973
const PORT = (() => {
  const raw = Number(process.env.AIWORKSPACE_BROWSER_PORT)
  return Number.isInteger(raw) && raw >= 1024 && raw <= 65535 ? raw : DEFAULT_PORT
})()
const BASE = `http://127.0.0.1:${PORT}`
const APP_NOT_RUNNING =
  "AI Workspace isn't running, or its Browser control server is not reachable. Open AI Workspace and try again."

class AppUnavailableError extends Error {}

interface HttpResult {
  status: number
  json: any
  buffer?: Buffer
  contentType: string
}

async function call(method: string, path: string, body?: unknown, wantBinary = false): Promise<HttpResult> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'x-aiw-agent-id': process.env.AIWORKSPACE_BROWSER_AGENT_ID || 'external-mcp',
        'x-aiw-agent-name': process.env.AIWORKSPACE_BROWSER_AGENT_NAME || 'External MCP client',
        'x-aiw-identity-source': process.env.AIWORKSPACE_BROWSER_IDENTITY_SOURCE || 'unverified',
        'x-aiw-control-token': process.env.AIWORKSPACE_BROWSER_CONTROL_TOKEN || '',
        'x-aiw-request-id': randomUUID(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    })
  } catch (e: any) {
    if (e?.name === 'TimeoutError') throw new AppUnavailableError('The Browser control server did not respond in time.')
    throw new AppUnavailableError(APP_NOT_RUNNING)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (wantBinary && contentType.includes('image/png')) {
    const buffer = Buffer.from(await res.arrayBuffer())
    return { status: res.status, json: null, buffer, contentType }
  }
  let json: any = null
  try { json = await res.json() } catch { json = null }
  if (res.ok && json?.ok === true && Object.prototype.hasOwnProperty.call(json, 'result')) json = json.result
  return { status: res.status, json, contentType }
}

function textResult(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text' as const, text }] }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

function ensureOk(r: HttpResult): void {
  if (r.status >= 200 && r.status < 300) return
  const msg = r.json && typeof r.json.error === 'string'
    ? JSON.stringify({ code: r.json.code ?? 'control_error', error: r.json.error, requestId: r.json.requestId })
    : `Control server returned HTTP ${r.status}`
  throw new Error(msg)
}

async function activeTabId(): Promise<string> {
  const r = await call('GET', '/browser/state')
  ensureOk(r)
  const tabId = typeof r.json?.activeTabId === 'string' ? r.json.activeTabId : ''
  if (!tabId) throw new Error('No active browser tab. Open the Browser panel or call browser_create_tab first.')
  return tabId
}

async function tabArg(args: Record<string, any>, requiredName: string): Promise<string> {
  if (typeof args.tabId === 'string' && args.tabId.trim()) return args.tabId.trim()
  if (requiredName === 'required') throw new Error('This tool requires a "tabId" string.')
  return activeTabId()
}

const tabIdSchema = { tabId: { type: 'string', description: 'Optional tab id. Defaults to the active Browser tab.' } }

const tools: Tool[] = [
  {
    name: 'browser_get_state',
    description: 'Return active tab id, URL, title, loading state, panel visibility, history availability, tabs, and navigation error.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_list_tabs',
    description: 'List Browser-panel tabs. Prefer browser_get_state when you only need the active page.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_create_tab',
    description: 'Open a new Browser-panel tab, optionally navigating to a safe URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Optional URL. Bare hosts get https://; bare localhost gets http://.' } }
    }
  },
  {
    name: 'browser_close_tab',
    description: 'Close a Browser-panel tab by id.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] }
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a Browser tab to a safe URL and wait briefly for loading to settle.',
    inputSchema: {
      type: 'object',
      properties: { ...tabIdSchema, url: { type: 'string', description: 'Destination URL.' } },
      required: ['url']
    }
  },
  {
    name: 'browser_go_back',
    description: 'Go back one history entry. Defaults to the active tab.',
    inputSchema: { type: 'object', properties: tabIdSchema }
  },
  {
    name: 'browser_go_forward',
    description: 'Go forward one history entry. Defaults to the active tab.',
    inputSchema: { type: 'object', properties: tabIdSchema }
  },
  {
    name: 'browser_reload',
    description: 'Reload a tab. Defaults to the active tab.',
    inputSchema: { type: 'object', properties: tabIdSchema }
  },
  {
    name: 'browser_get_content',
    description: 'Return page title, URL, readable visible text, and truncation metadata without dumping an unbounded DOM.',
    inputSchema: { type: 'object', properties: tabIdSchema }
  },
  {
    name: 'browser_get_elements',
    description: 'Return a structured interaction map for visible or near-visible elements. Use returned ids for browser_click/browser_type.',
    inputSchema: { type: 'object', properties: tabIdSchema }
  },
  {
    name: 'browser_snapshot',
    description: 'Alias of browser_get_elements, formatted as compact text for older prompts.',
    inputSchema: { type: 'object', properties: tabIdSchema }
  },
  {
    name: 'browser_click',
    description: 'Click an element id from the latest browser_get_elements snapshot.',
    inputSchema: {
      type: 'object',
      properties: { ...tabIdSchema, elementId: { type: 'string' } },
      required: ['elementId']
    }
  },
  {
    name: 'browser_type',
    description: 'Type into an editable element id from the latest browser_get_elements snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        ...tabIdSchema,
        elementId: { type: 'string' },
        text: { type: 'string' },
        replace: { type: 'boolean', description: 'Replace existing value. Defaults to true.' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' }
      },
      required: ['elementId', 'text']
    }
  },
  {
    name: 'browser_scroll',
    description: 'Scroll a tab by direction and optional amount. Defaults to the active tab.',
    inputSchema: {
      type: 'object',
      properties: {
        ...tabIdSchema,
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number' }
      },
      required: ['direction']
    }
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the current page or Browser view.',
    inputSchema: { type: 'object', properties: tabIdSchema }
  }
  ,{
    name: 'browser_prepare_upload',
    description: 'Open an approved native file picker and return only short-lived opaque upload handles plus safe file metadata.',
    inputSchema: { type: 'object', properties: { ...tabIdSchema, multiple: { type: 'boolean' } } }
  },
  {
    name: 'browser_set_file_input',
    description: 'Attach one-time upload handles to a file input from the latest browser_get_elements snapshot. Never accepts filesystem paths.',
    inputSchema: { type: 'object', properties: { ...tabIdSchema, elementId: { type: 'string' }, uploadHandles: { type: 'array', items: { type: 'string' } } }, required: ['elementId', 'uploadHandles'] }
  },
  {
    name: 'browser_get_downloads',
    description: 'Return safe status and progress for controlled Browser downloads. Does not expose filesystem paths.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_download',
    description: 'Download an http/https URL to the application-managed Browser Downloads directory after explicit approval.',
    inputSchema: { type: 'object', properties: { ...tabIdSchema, url: { type: 'string' } }, required: ['url'] }
  }
]

const server = new Server(
  { name: 'ai-workspace-browser', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params
  const args = (req.params.arguments ?? {}) as Record<string, any>
  try {
    switch (name) {
      case 'browser_get_state': {
        const r = await call('GET', '/browser/state')
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_list_tabs': {
        const r = await call('GET', '/browser/tabs')
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_create_tab': {
        const r = await call('POST', '/browser/tabs', { url: typeof args.url === 'string' ? args.url : undefined })
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_close_tab': {
        const id = await tabArg(args, 'required')
        const r = await call('DELETE', `/browser/tabs/${encodeURIComponent(id)}`)
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_navigate': {
        const id = await tabArg(args, 'optional')
        if (typeof args.url !== 'string' || !args.url.trim()) throw new Error('browser_navigate requires a "url" string.')
        const nav = await call('POST', `/browser/tabs/${encodeURIComponent(id)}/navigate`, { url: args.url })
        ensureOk(nav)
        await call('POST', `/browser/tabs/${encodeURIComponent(id)}/wait-for-load`, {})
        const state = await call('GET', '/browser/state')
        ensureOk(state)
        return textResult({ ok: true, state: state.json })
      }
      case 'browser_go_back': {
        const id = await tabArg(args, 'optional')
        const r = await call('POST', `/browser/tabs/${encodeURIComponent(id)}/back`, {})
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_go_forward': {
        const id = await tabArg(args, 'optional')
        const r = await call('POST', `/browser/tabs/${encodeURIComponent(id)}/forward`, {})
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_reload': {
        const id = await tabArg(args, 'optional')
        const r = await call('POST', `/browser/tabs/${encodeURIComponent(id)}/reload`, {})
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_screenshot': {
        const id = await tabArg(args, 'optional')
        const r = await call('GET', `/browser/tabs/${encodeURIComponent(id)}/screenshot`, undefined, true)
        ensureOk(r)
        if (!r.buffer) throw new Error('No image data returned.')
        return { content: [{ type: 'image' as const, data: r.buffer.toString('base64'), mimeType: 'image/png' }] }
      }
      case 'browser_get_content': {
        const id = await tabArg(args, 'optional')
        const r = await call('GET', `/browser/tabs/${encodeURIComponent(id)}/content`)
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_get_elements': {
        const id = await tabArg(args, 'optional')
        const r = await call('GET', `/browser/tabs/${encodeURIComponent(id)}/snapshot`)
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_snapshot': {
        const id = await tabArg(args, 'optional')
        const r = await call('GET', `/browser/tabs/${encodeURIComponent(id)}/snapshot`)
        ensureOk(r)
        const elements = (r.json?.elements ?? []) as any[]
        if (elements.length === 0) return textResult('No interactive elements found in view. Try browser_scroll or browser_get_content.')
        const lines = elements.map((el) => {
          const parts = [`[${el.id}] <${el.tag}${el.type ? ` type=${el.type}` : ''}> role=${el.role}`]
          if (el.disabled) parts.push('(disabled)')
          if (el.text) parts.push(`"${el.text}"`)
          return parts.join(' ')
        })
        return textResult(lines.join('\n'))
      }
      case 'browser_click': {
        const id = await tabArg(args, 'optional')
        if (typeof args.elementId !== 'string' || !args.elementId.trim()) throw new Error('browser_click requires an "elementId" string.')
        const r = await call('POST', `/browser/tabs/${encodeURIComponent(id)}/click`, { elementId: args.elementId })
        if (r.status === 422) return errorResult(JSON.stringify(r.json ?? { error: 'Click failed' }, null, 2))
        ensureOk(r)
        return textResult({ ok: true })
      }
      case 'browser_type': {
        const id = await tabArg(args, 'optional')
        if (typeof args.elementId !== 'string' || !args.elementId.trim()) throw new Error('browser_type requires an "elementId" string.')
        if (typeof args.text !== 'string') throw new Error('browser_type requires a "text" string.')
        const r = await call('POST', `/browser/tabs/${encodeURIComponent(id)}/type`, {
          elementId: args.elementId,
          text: args.text,
          replace: args.replace !== false,
          pressEnter: args.pressEnter === true
        })
        if (r.status === 422) return errorResult(JSON.stringify(r.json ?? { error: 'Type failed' }, null, 2))
        ensureOk(r)
        return textResult({ ok: true })
      }
      case 'browser_scroll': {
        const id = await tabArg(args, 'optional')
        const direction = args.direction === 'up' ? 'up' : 'down'
        const amount = typeof args.amount === 'number' && Number.isFinite(args.amount) ? args.amount : undefined
        const r = await call('POST', `/browser/tabs/${encodeURIComponent(id)}/scroll`, { direction, amount })
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_prepare_upload': {
        const id = await tabArg(args, 'optional')
        const r = await call('POST', '/browser/uploads/prepare', { tabId: id, multiple: args.multiple === true })
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_set_file_input': {
        const id = await tabArg(args, 'optional')
        if (typeof args.elementId !== 'string' || !Array.isArray(args.uploadHandles)) throw new Error('browser_set_file_input requires elementId and uploadHandles.')
        const r = await call('POST', `/browser/tabs/${encodeURIComponent(id)}/set-file-input`, { elementId: args.elementId, uploadHandles: args.uploadHandles })
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_get_downloads': {
        const r = await call('GET', '/browser/downloads')
        ensureOk(r)
        return textResult(r.json)
      }
      case 'browser_download': {
        const id = await tabArg(args, 'optional')
        if (typeof args.url !== 'string') throw new Error('browser_download requires a URL.')
        const r = await call('POST', `/browser/tabs/${encodeURIComponent(id)}/download`, { url: args.url })
        ensureOk(r)
        return textResult(r.json)
      }
      default:
        return errorResult(`Unknown tool: ${name}`)
    }
  } catch (err: any) {
    if (err instanceof AppUnavailableError) return errorResult(err.message)
    console.error(`[browser-mcp] tool "${name}" failed:`, err)
    return errorResult(`Tool "${name}" failed: ${err?.message ?? String(err)}`)
  }
})

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[browser-mcp] connected over stdio; control server base: ${BASE}`)
}

main().catch((err) => {
  console.error('[browser-mcp] fatal:', err)
  process.exit(1)
})
