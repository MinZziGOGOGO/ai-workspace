import { randomUUID } from 'crypto'
import path from 'path'

export interface UploadHandleRecord {
  id: string
  path: string
  filename: string
  extension: string
  mimeType: string | null
  size: number
  createdAt: number
  expiresAt: number
  agentId: string
  tabId?: string
  origin?: string
  used: boolean
  cancelled: boolean
}

export interface SafeUploadMetadata {
  uploadHandle: string
  filename: string
  extension: string
  mimeType: string | null
  size: number
  expiresAt: number
}

const WINDOWS_DEVICES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
])
const MAX_FILENAME_LENGTH = 180

/** Turn untrusted server filenames into a single safe Windows filename. */
export function sanitizeDownloadFilename(value: string | undefined, fallback = 'download'): string {
  let name = String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '')
  // Treat both separator styles as path components even while tests run on a
  // non-Windows host; only the final filename is ever retained.
  name = path.posix.basename(name.replace(/\\/g, '/'))
  name = name.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/g, '').trim()
  if (!name || name === '.' || name === '..') name = fallback
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length) || fallback
  if (WINDOWS_DEVICES.has(stem.toUpperCase())) name = `_${name}`
  if (name.length > MAX_FILENAME_LENGTH) {
    const safeExt = ext.length <= 20 ? ext : ''
    name = `${name.slice(0, MAX_FILENAME_LENGTH - safeExt.length).replace(/[. ]+$/g, '') || fallback}${safeExt}`
  }
  return name || fallback
}

export function classifyDownloadRisks(filename: string): string[] {
  const lower = filename.toLowerCase()
  const flags: string[] = []
  if (/\.(exe|msi|bat|cmd|com|ps1|vbs|js|jar|scr|dll|iso|img)$/i.test(lower)) flags.push('Potentially executable file')
  if (/\.(zip|rar|7z|tar|gz)$/i.test(lower)) flags.push('Archive content cannot be inspected')
  if (/\.(pfx|p12|pem|key|crt)$/i.test(lower)) flags.push('Certificate or private-key material')
  if (/\.[a-z0-9]{1,8}\.(exe|msi|bat|cmd|com|ps1|vbs|js)$/i.test(lower)) flags.push('Misleading double extension')
  return flags
}

function mimeFor(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase()
  return ({ '.txt': 'text/plain', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json', '.csv': 'text/csv' } as Record<string, string>)[ext] ?? null
}

export class UploadHandleRegistry {
  private records = new Map<string, UploadHandleRecord>()
  constructor(private readonly ttlMs = 5 * 60_000) {}

  create(input: { path: string; size: number; agentId: string; tabId?: string; origin?: string }): SafeUploadMetadata {
    this.sweep()
    const filename = sanitizeDownloadFilename(path.basename(input.path), 'selected-file')
    const record: UploadHandleRecord = {
      id: randomUUID(), path: input.path, filename, extension: path.extname(filename).toLowerCase(), mimeType: mimeFor(filename), size: input.size,
      createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs, agentId: input.agentId, tabId: input.tabId, origin: input.origin, used: false, cancelled: false,
    }
    this.records.set(record.id, record)
    return this.public(record)
  }

  getForUse(id: string, agentId: string, tabId: string, origin?: string): UploadHandleRecord | { error: string } {
    this.sweep()
    const record = this.records.get(id)
    if (!record) return { error: 'invalid_handle' }
    if (record.agentId !== agentId) return { error: 'wrong_client' }
    if (record.used || record.cancelled) return { error: 'invalid_handle' }
    if (record.expiresAt <= Date.now()) return { error: 'expired_handle' }
    if (record.tabId && record.tabId !== tabId) return { error: 'wrong_tab' }
    if (record.origin && origin && record.origin !== origin) return { error: 'wrong_origin' }
    return record
  }

  consume(ids: string[]): void { for (const id of ids) { const r = this.records.get(id); if (r) r.used = true } }
  cancel(ids: string[]): void { for (const id of ids) { const r = this.records.get(id); if (r) r.cancelled = true } }
  cancelForAgent(agentId: string): void { for (const r of this.records.values()) if (r.agentId === agentId) r.cancelled = true }
  cancelForTab(tabId: string): void { for (const r of this.records.values()) if (r.tabId === tabId) r.cancelled = true }
  clear(): void { this.records.clear() }
  sweep(): void { const now = Date.now(); for (const [id, r] of this.records) if (r.expiresAt <= now || r.used || r.cancelled) this.records.delete(id) }
  private public(r: UploadHandleRecord): SafeUploadMetadata { return { uploadHandle: r.id, filename: r.filename, extension: r.extension, mimeType: r.mimeType, size: r.size, expiresAt: r.expiresAt } }
}

export const browserUploadHandles = new UploadHandleRegistry()
