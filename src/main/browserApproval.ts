import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import type {
  BrowserApprovalDecision,
  BrowserApprovalRequest,
  BrowserPermissionCategory,
  HermesPermissionMode,
} from '../shared/ipcTypes'

export interface BrowserAgentIdentity {
  agentId: string
  agentName: string
  identityVerified: boolean
  transport: string
  clientRequestId?: string
}

export interface BrowserApprovalDraft extends Omit<BrowserApprovalRequest,
  'requestId' | 'createdAt' | 'expiresAt' | 'status' | 'agentId' | 'agentName' |
  'identityVerified' | 'transport'> {
  mutation: boolean
}

export type BrowserCommandOutcome<T = unknown> =
  | { ok: true; value: T; approval: { requestId?: string; category: BrowserPermissionCategory; prompted: boolean } }
  | { ok: false; code: 'denied' | 'timed_out' | 'cancelled' | 'failed'; error: string; requestId?: string }

const STRICT = new Set<BrowserPermissionCategory>([
  'browser.sensitive', 'browser.download', 'browser.upload', 'browser.privileged'
])

export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase()
    if (host === 'localhost' || host === '::1' || host === '[::1]') return true
    const match = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    return Boolean(match && match.slice(1).every((part) => Number(part) <= 255))
  } catch {
    return false
  }
}

export function classifyBrowserTool(toolName: string, targetUrl?: string): BrowserPermissionCategory {
  switch (toolName) {
    case 'browser_get_state':
    case 'browser_list_tabs':
    case 'browser_get_content':
    case 'browser_get_elements':
    case 'browser_snapshot':
    case 'browser_screenshot':
    case 'browser_get_downloads':
    case 'browser_reload':
    case 'browser_wait_for_load':
      return 'browser.read'
    case 'browser_navigate':
    case 'browser_create_tab':
      return targetUrl && isLoopbackUrl(targetUrl) ? 'browser.navigate.local' : 'browser.navigate.external'
    case 'browser_go_back':
    case 'browser_go_forward':
      return targetUrl && isLoopbackUrl(targetUrl) ? 'browser.navigate.local' : 'browser.navigate.external'
    case 'browser_click':
    case 'browser_scroll':
    case 'browser_close_tab':
      return 'browser.interact'
    case 'browser_type':
      return 'browser.type'
    case 'browser_prepare_upload':
    case 'browser_set_file_input':
      return 'browser.upload'
    case 'browser_download':
      return 'browser.download'
    default:
      return 'browser.privileged'
  }
}

export function browserRequiresApproval(mode: HermesPermissionMode, category: BrowserPermissionCategory): boolean {
  if (STRICT.has(category)) return true
  if (category === 'browser.read' || category === 'browser.navigate.local') return mode === 1
  if (category === 'browser.interact' || category === 'browser.type') return mode < 3
  return mode < 4
}

export function redactBrowserInput(text: string, sensitive: boolean): string {
  if (!text) return ''
  if (sensitive) return `[redacted ${text.length} characters]`
  const clean = text.replace(/[\r\n\t]+/g, ' ')
  return clean.length <= 80 ? clean : `${clean.slice(0, 77)}...`
}

interface Pending<T = unknown> {
  publicRequest: BrowserApprovalRequest
  identity: BrowserAgentIdentity
  execute: () => Promise<T>
  resolve: (result: BrowserCommandOutcome<T>) => void
  timer: NodeJS.Timeout
  dedupeKey?: string
  settled: boolean
  mutation: boolean
}

export class BrowserApprovalService {
  private pending = new Map<string, Pending<any>>()
  private sessionAllows = new Set<string>()
  private dedupe = new Map<string, Promise<BrowserCommandOutcome<any>>>()
  private mutationTails = new Map<string, Promise<void>>()
  private hostWindow: BrowserWindow | null = null

  constructor(private readonly timeoutMs = 60_000) {}

  setHostWindow(win: BrowserWindow | null): void {
    this.hostWindow = win
  }

  listPending(): BrowserApprovalRequest[] {
    return [...this.pending.values()].map((item) => ({ ...item.publicRequest, riskFlags: [...item.publicRequest.riskFlags] }))
  }

  private emit(): void {
    if (this.hostWindow && !this.hostWindow.isDestroyed()) {
      this.hostWindow.webContents.send('approvals:changed', this.listPending())
    }
  }

  private allowKey(identity: BrowserAgentIdentity, category: BrowserPermissionCategory): string {
    return `${identity.agentId}:${category}`
  }

  async submit<T>(
    identity: BrowserAgentIdentity,
    mode: HermesPermissionMode,
    draft: BrowserApprovalDraft,
    execute: () => Promise<T>,
  ): Promise<BrowserCommandOutcome<T>> {
    const dedupeKey = identity.clientRequestId ? `${identity.agentId}:${identity.clientRequestId}` : undefined
    const existing = dedupeKey ? this.dedupe.get(dedupeKey) : undefined
    if (existing) return existing as Promise<BrowserCommandOutcome<T>>

    let task: Promise<BrowserCommandOutcome<T>>
    if (!browserRequiresApproval(mode, draft.category) || this.sessionAllows.has(this.allowKey(identity, draft.category))) {
      task = this.executeQueued(draft.tabId, draft.mutation, draft.category, execute)
    } else {
      task = new Promise<BrowserCommandOutcome<T>>((resolve) => {
        const requestId = randomUUID()
        const createdAt = Date.now()
        const publicRequest: BrowserApprovalRequest = {
          ...draft,
          requestId,
          createdAt,
          expiresAt: createdAt + this.timeoutMs,
          status: 'pending',
          agentId: identity.agentId,
          agentName: identity.agentName,
          identityVerified: identity.identityVerified,
          transport: identity.transport,
        }
        delete (publicRequest as BrowserApprovalRequest & { mutation?: boolean }).mutation
        const timer = setTimeout(() => this.finish(requestId, 'timed_out', 'Approval request timed out.'), this.timeoutMs)
        this.pending.set(requestId, { publicRequest, identity, execute, resolve, timer, dedupeKey, settled: false, mutation: draft.mutation })
        this.emit()
      })
    }
    if (dedupeKey) {
      this.dedupe.set(dedupeKey, task)
      void task.finally(() => setTimeout(() => this.dedupe.delete(dedupeKey), 30_000))
    }
    return task
  }

  async respond(decision: BrowserApprovalDecision): Promise<{ success: boolean; error?: string }> {
    const item = this.pending.get(decision.requestId)
    if (!item || item.settled) return { success: false, error: 'Approval request is no longer pending.' }
    if (!decision.approved) {
      this.finish(decision.requestId, 'denied', 'Browser action denied by the user.')
      return { success: true }
    }
    item.settled = true
    clearTimeout(item.timer)
    this.pending.delete(decision.requestId)
    if (decision.allowForSession && !STRICT.has(item.publicRequest.category)) {
      this.sessionAllows.add(this.allowKey(item.identity, item.publicRequest.category))
    }
    this.emit()
    const result = await this.executeQueued(item.publicRequest.tabId, item.mutation, item.publicRequest.category, item.execute, decision.requestId)
    item.resolve(result)
    return { success: true }
  }

  cancelForTab(tabId: string): void {
    for (const [id, item] of this.pending) {
      if (item.publicRequest.tabId === tabId) this.finish(id, 'cancelled', 'Browser tab was closed.')
    }
  }

  cancelElementActionsForTab(tabId: string): void {
    for (const [id, item] of this.pending) {
      if (item.publicRequest.tabId === tabId && item.publicRequest.elementId) {
        this.finish(id, 'cancelled', 'Page changed while the Browser action was awaiting approval.')
      }
    }
  }

  cancelForAgent(agentId: string): void {
    for (const [id, item] of this.pending) {
      if (item.identity.agentId === agentId) this.finish(id, 'cancelled', 'Requesting client disconnected.')
    }
  }

  cancelAll(reason = 'Application is closing.'): void {
    for (const id of [...this.pending.keys()]) this.finish(id, 'cancelled', reason)
  }

  private finish(requestId: string, code: 'denied' | 'timed_out' | 'cancelled', error: string): void {
    const item = this.pending.get(requestId)
    if (!item || item.settled) return
    item.settled = true
    clearTimeout(item.timer)
    this.pending.delete(requestId)
    this.emit()
    item.resolve({ ok: false, code, error, requestId })
  }

  private async executeQueued<T>(tabId: string | undefined, mutation: boolean, category: BrowserPermissionCategory, execute: () => Promise<T>, requestId?: string): Promise<BrowserCommandOutcome<T>> {
    const run = async (): Promise<BrowserCommandOutcome<T>> => {
      try {
        return { ok: true, value: await execute(), approval: { requestId, category, prompted: Boolean(requestId) } }
      } catch (error) {
        return { ok: false, code: 'failed', error: error instanceof Error ? error.message : String(error), requestId }
      }
    }
    if (!mutation) return run()
    const key = tabId || '__global__'
    const previous = this.mutationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    this.mutationTails.set(key, tail)
    await previous
    try { return await run() } finally {
      release()
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key)
    }
  }
}

export const browserApprovals = new BrowserApprovalService()
