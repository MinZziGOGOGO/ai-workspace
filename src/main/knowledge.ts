import { getDb } from './db'
import { embed } from './ollama'
import { randomUUID } from 'crypto'

// The shared knowledge layer. Chat calls this directly; Hermes and Claude Code
// will reach it through the MCP server (Milestone: knowledge-mcp), so memory is
// implemented exactly once. All writes pass through a single serialized queue —
// multiple AIs writing concurrently must never interleave graph mutations.

export type SearchScope = 'project' | 'related' | 'global'

export interface MemoryItem {
  id: string
  project_id: string | null
  type: string
  title: string
  content: string
  source: string
  tags: string[]
  created_at: number
  updated_at: number
  last_accessed_at?: number | null
  access_count?: number
  stale_at?: number | null
  quality_flags?: string[]
  quality_reason?: string | null
  score?: number
}

export interface MemoryQualityResult {
  allowed: boolean
  reason: string | null
  flags: string[]
}

export interface KnowledgeDiagnostics {
  total: number
  byType: Record<string, number>
  bySource: Record<string, number>
  embeddingsPresent: number
  embeddingsMissing: number
  staleCount: number
  unusedCount: number
  recentlyAccessedCount: number
  lowQualityCount: number
  lastConsolidationAt: number | null
  lowQualityCandidates: MemoryItem[]
}

export class MemoryQualityError extends Error {
  constructor(public reason: string, public flags: string[]) {
    super(reason)
    this.name = 'MemoryQualityError'
  }
}

// ---- single-writer queue -------------------------------------------------
let writeChain: Promise<unknown> = Promise.resolve()
function enqueueWrite<T>(job: () => Promise<T>): Promise<T> {
  const next = writeChain.then(job, job)
  writeChain = next.catch(() => undefined)
  return next
}

// ---- memory items ----------------------------------------------------------
export function saveMemory(input: {
  projectId: string | null
  type: string
  title: string
  content: string
  source: string
  tags?: string[]
}): Promise<MemoryItem> {
  return enqueueWrite(async () => {
    const quality = evaluateMemoryQuality(input)
    if (!quality.allowed) throw new MemoryQualityError(quality.reason ?? 'Memory was skipped.', quality.flags)

    const now = Date.now()
    const vector = await embed(`${input.title}\n${input.content}`)
    const item: MemoryItem = {
      id: randomUUID(),
      project_id: input.projectId,
      type: input.type,
      title: input.title,
      content: input.content,
      source: input.source,
      tags: input.tags ?? [],
      created_at: now,
      updated_at: now,
      last_accessed_at: null,
      access_count: 0,
      stale_at: null,
      quality_flags: quality.flags,
      quality_reason: quality.reason
    }
    getDb()
      .prepare(
        `INSERT INTO memory_items (
           id, project_id, type, title, content, source, tags, embedding, created_at, updated_at,
           quality_flags, quality_reason
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id, item.project_id, item.type, item.title, item.content, item.source,
        JSON.stringify(item.tags), vector ? Buffer.from(vector.buffer) : null,
        item.created_at, item.updated_at, JSON.stringify(item.quality_flags), item.quality_reason
      )
    return item
  })
}

// ---- indexer writes --------------------------------------------------------
// The file watcher/indexer (Milestone 3) feeds summaries in here. Like every
// other writer, it goes through the single serialized queue — a file summary
// touches three tables (memory_items + a file node + its edge) and those
// mutations must not interleave with concurrent writers. Keyed on (project, path)
// so re-indexing a changed file upserts in place instead of duplicating.
export function saveIndexedFile(input: {
  projectId: string
  relPath: string
  summary: string
  ext: string
}): Promise<MemoryItem> {
  return enqueueWrite(async () => {
    const db = getDb()
    const now = Date.now()
    const { projectId, relPath, summary, ext } = input
    const vector = await embed(`${relPath}\n${summary}`)
    const blob = vector ? Buffer.from(vector.buffer) : null
    const tags = JSON.stringify(ext ? [ext] : [])

    const existing = db
      .prepare(`SELECT id, created_at FROM memory_items WHERE project_id = ? AND type = 'file' AND title = ?`)
      .get(projectId, relPath) as { id: string; created_at: number } | undefined

    let item: MemoryItem
    if (existing) {
      db.prepare(
        `UPDATE memory_items
         SET content = ?, source = 'indexer', tags = ?, embedding = ?, updated_at = ?,
             quality_flags = '[]', quality_reason = NULL
         WHERE id = ?`
      ).run(summary, tags, blob, now, existing.id)
      item = {
        id: existing.id, project_id: projectId, type: 'file', title: relPath, content: summary,
        source: 'indexer', tags: ext ? [ext] : [], created_at: existing.created_at, updated_at: now,
        last_accessed_at: null, access_count: 0, stale_at: null, quality_flags: [], quality_reason: null
      }
    } else {
      const id = randomUUID()
      db.prepare(
        `INSERT INTO memory_items (
           id, project_id, type, title, content, source, tags, embedding, created_at, updated_at,
           quality_flags, quality_reason
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL)`
      ).run(id, projectId, 'file', relPath, summary, 'indexer', tags, blob, now, now)
      item = {
        id, project_id: projectId, type: 'file', title: relPath, content: summary,
        source: 'indexer', tags: ext ? [ext] : [], created_at: now, updated_at: now,
        last_accessed_at: null, access_count: 0, stale_at: null, quality_flags: [], quality_reason: null
      }
    }

    // Graph half: a file node under a per-project system root, deduped so
    // re-indexing never piles up duplicate nodes or edges.
    const project = db.prepare(`SELECT name FROM projects WHERE id = ?`).get(projectId) as
      | { name: string }
      | undefined
    const fileNodeId = upsertNode(projectId, 'file', relPath, summary)
    if (project) {
      const rootId = upsertNode(projectId, 'system', project.name)
      const edge = db
        .prepare(`SELECT id FROM edges WHERE src_id = ? AND dst_id = ? AND relation = 'has_file'`)
        .get(rootId, fileNodeId) as { id: string } | undefined
      if (!edge) linkNodes(rootId, fileNodeId, 'has_file')
    }
    return item
  })
}

/** Remove an indexed file's memory item and graph node (on a file 'unlink' event). */
export function removeIndexedFile(projectId: string, relPath: string): Promise<void> {
  return enqueueWrite(async () => {
    const db = getDb()
    db.prepare(`DELETE FROM memory_items WHERE project_id = ? AND type = 'file' AND title = ?`).run(projectId, relPath)
    const node = db
      .prepare(`SELECT id FROM nodes WHERE project_id = ? AND type = 'file' AND name = ?`)
      .get(projectId, relPath) as { id: string } | undefined
    if (node) {
      db.prepare(`DELETE FROM edges WHERE src_id = ? OR dst_id = ?`).run(node.id, node.id)
      db.prepare(`DELETE FROM nodes WHERE id = ?`).run(node.id)
    }
  })
}

export function listMemory(projectId: string | null, limit = 200): MemoryItem[] {
  const rows = projectId
    ? getDb().prepare(`SELECT * FROM memory_items WHERE (project_id = ? OR project_id IS NULL) ORDER BY updated_at DESC LIMIT ?`).all(projectId, limit)
    : getDb().prepare(`SELECT * FROM memory_items ORDER BY updated_at DESC LIMIT ?`).all(limit)
  return rows.map(hydrate)
}

export function deleteMemory(id: string): Promise<void> {
  return enqueueWrite(async () => {
    getDb().prepare(`DELETE FROM memory_items WHERE id = ?`).run(id)
  })
}

export function touchMemory(id: string): Promise<void> {
  return enqueueWrite(async () => {
    getDb()
      .prepare(
        `UPDATE memory_items
         SET last_accessed_at = ?, access_count = COALESCE(access_count, 0) + 1
         WHERE id = ?`
      )
      .run(Date.now(), id)
  })
}

export function markMemoryStale(id: string, stale: boolean): Promise<void> {
  return enqueueWrite(async () => {
    getDb()
      .prepare(`UPDATE memory_items SET stale_at = ? WHERE id = ?`)
      .run(stale ? Date.now() : null, id)
  })
}

/** Count of memory items scoped to one project (excludes global items). */
export function countMemory(projectId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE project_id = ?`)
    .get(projectId) as { n: number }
  return row.n
}

/**
 * Delete every memory item scoped to a project (global items survive).
 * Settings-panel escape hatch; like all writes it goes through the queue.
 * Returns how many items were removed.
 */
export function clearProjectMemory(projectId: string): Promise<number> {
  return enqueueWrite(async () => {
    const db = getDb()
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE project_id = ?`)
      .get(projectId) as { n: number }
    db.prepare(`DELETE FROM memory_items WHERE project_id = ?`).run(projectId)
    return n
  })
}

export async function searchMemory(
  query: string,
  scope: SearchScope,
  projectId: string | null,
  limit = 8
): Promise<MemoryItem[]> {
  // Search is intentionally read-only: result scores are transient ranking
  // metadata and do not increment access_count. Only deliberate inspection via
  // touchMemory() counts as a memory "use", keeping telemetry meaningful and
  // preventing background retrieval from aging every returned item.
  const db = getDb()
  let candidates: any[]
  if (scope === 'global' || !projectId) {
    candidates = db.prepare(`SELECT * FROM memory_items`).all()
  } else if (scope === 'related') {
    candidates = db
      .prepare(
        `SELECT * FROM memory_items WHERE project_id IS NULL OR project_id = ?
         OR project_id IN (SELECT dst_project_id FROM project_links WHERE src_project_id = ?)`
      )
      .all(projectId, projectId)
  } else {
    candidates = db
      .prepare(`SELECT * FROM memory_items WHERE project_id = ? OR project_id IS NULL`)
      .all(projectId)
  }

  const qVec = await embed(query)
  if (qVec) {
    const scored = candidates
      .filter((r) => r.embedding)
      .map((r) => ({ row: r, score: cosine(qVec, new Float32Array(toArrayBuffer(r.embedding))) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
    if (scored.length > 0) {
      return scored.map((s) => ({ ...hydrate(s.row), score: s.score }))
    }
  }
  // Fallback when embedder is offline or nothing is embedded yet: keyword match.
  const q = query.toLowerCase()
  const results = candidates
    .filter((r) => (r.title + ' ' + r.content).toLowerCase().includes(q))
    .slice(0, limit)
    .map(hydrate)
  return results
}

export function getKnowledgeDiagnostics(projectId: string | null): KnowledgeDiagnostics {
  const db = getDb()
  const rows = (projectId
    ? db.prepare(`SELECT * FROM memory_items WHERE project_id = ? OR project_id IS NULL`).all(projectId)
    : db.prepare(`SELECT * FROM memory_items`).all()) as any[]
  const now = Date.now()
  const staleCutoff = now - 90 * 24 * 60 * 60 * 1000
  const recentCutoff = now - 7 * 24 * 60 * 60 * 1000
  const byType: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  let embeddingsPresent = 0
  let embeddingsMissing = 0
  let staleCount = 0
  let unusedCount = 0
  let recentlyAccessedCount = 0
  const lowQualityCandidates: MemoryItem[] = []

  for (const row of rows) {
    byType[row.type] = (byType[row.type] ?? 0) + 1
    bySource[row.source] = (bySource[row.source] ?? 0) + 1
    if (row.embedding) embeddingsPresent++
    else embeddingsMissing++
    const accessCount = Number(row.access_count ?? 0)
    if (accessCount === 0) unusedCount++
    if (row.last_accessed_at && Number(row.last_accessed_at) >= recentCutoff) recentlyAccessedCount++
    if (row.stale_at || (accessCount === 0 && Number(row.updated_at ?? 0) < staleCutoff)) staleCount++

    const quality = evaluateMemoryQuality({
      projectId: row.project_id,
      type: row.type,
      title: row.title,
      content: row.content,
      source: row.source,
      tags: safeJsonArray(row.tags)
    })
    if (!quality.allowed || quality.flags.length > 0 || row.quality_reason) {
      lowQualityCandidates.push({
        ...hydrate(row),
        quality_flags: quality.flags.length > 0 ? quality.flags : safeJsonArray(row.quality_flags),
        quality_reason: quality.reason ?? row.quality_reason ?? null
      })
    }
  }

  const lastConsolidation = db
    .prepare(`SELECT value FROM app_meta WHERE key = 'last_consolidation'`)
    .get() as { value: string } | undefined

  return {
    total: rows.length,
    byType,
    bySource,
    embeddingsPresent,
    embeddingsMissing,
    staleCount,
    unusedCount,
    recentlyAccessedCount,
    lowQualityCount: lowQualityCandidates.length,
    lastConsolidationAt: lastConsolidation ? Number(lastConsolidation.value) || null : null,
    lowQualityCandidates: lowQualityCandidates.slice(0, 50)
  }
}

export function deleteLowQualityCandidates(projectId: string | null): Promise<number> {
  return enqueueWrite(async () => {
    const ids = getKnowledgeDiagnostics(projectId).lowQualityCandidates
      .filter(canBulkDeleteLowQuality)
      .map((item) => item.id)
    if (ids.length === 0) return 0
    const db = getDb()
    const del = db.prepare(`DELETE FROM memory_items WHERE id = ?`)
    for (const id of ids) del.run(id)
    return ids.length
  })
}

function canBulkDeleteLowQuality(item: MemoryItem): boolean {
  const source = item.source.toLowerCase()
  const type = item.type.toLowerCase()
  if (source === 'user' || source === 'mcp') return false
  if (type === 'decision' || type === 'preference') return false
  return true
}

export function evaluateMemoryQuality(input: {
  projectId: string | null
  type: string
  title: string
  content: string
  source: string
  tags?: string[]
}): MemoryQualityResult {
  const title = cleanText(input.title)
  const content = cleanText(input.content)
  const combined = cleanText(`${title} ${content}`)
  const source = input.source.toLowerCase()
  const type = input.type.toLowerCase()
  const flags: string[] = []

  if (!content || !title) return rejected('Memory needs both a title and content.', ['empty'])
  if (/^(n\/a|none|null|undefined|no summary|summary pending|empty)$/i.test(content)) {
    return rejected('Memory content is empty or only placeholder text.', ['empty-summary'])
  }
  if (/^(test|testing|asdf|lorem ipsum)$/i.test(combined)) {
    return rejected('Memory content looks like test or placeholder text.', ['placeholder'])
  }

  const chatDerived = source === 'chat' || source === 'extractor'
  const explicit = source === 'user' || source === 'mcp'
  if (explicit && !chatDerived) return { allowed: true, reason: null, flags }
  if (!chatDerived) return { allowed: true, reason: null, flags }

  if (/^(hi|hello|hey|yo|thanks|thank you|ok|okay|cool|great|nice|lol|haha|yes|no)[.!? ]*$/i.test(content)) {
    return rejected('Skipped low-value chat residue: greeting or acknowledgement.', ['greeting'])
  }
  if (/\b(how can i help|how may i help|what can i help|happy to help|i am an ai|i'm an ai|as an ai)\b/i.test(combined)) {
    return rejected('Skipped generic assistant boilerplate.', ['assistant-boilerplate'])
  }
  if (/\b(knock knock|dad joke|tell me a joke|why did .+ cross|here'?s a joke)\b/i.test(combined)) {
    return rejected('Skipped joke or entertainment residue.', ['joke'])
  }
  if (/\b(copy full prompt|search memory|no knowledge saved|loading|click to|press enter|shift\+enter|esc to cancel)\b/i.test(combined)) {
    return rejected('Skipped accidental UI boilerplate.', ['ui-boilerplate'])
  }
  if (content.length < 32 && !/decision|prefer|remember|use |must |should |because|path|project|api|schema|model|database/i.test(combined)) {
    return rejected('Skipped very short generic chat note.', ['too-short'])
  }
  if ((type === 'note' || type === 'research' || type === 'decision') && content.split(/\s+/).length < 5) {
    flags.push('thin-content')
  }
  return { allowed: true, reason: flags.length ? 'Memory may need review for thin content.' : null, flags }
}

// ---- graph primitives ------------------------------------------------------
export function upsertNode(projectId: string | null, type: string, name: string, summary = ''): string {
  const db = getDb()
  const existing = db
    .prepare(`SELECT id FROM nodes WHERE name = ? AND type = ? AND COALESCE(project_id, '') = COALESCE(?, '')`)
    .get(name, type, projectId) as { id: string } | undefined
  if (existing) {
    if (summary) db.prepare(`UPDATE nodes SET summary = ? WHERE id = ?`).run(summary, existing.id)
    return existing.id
  }
  const id = randomUUID()
  db.prepare(`INSERT INTO nodes (id, project_id, type, name, summary) VALUES (?, ?, ?, ?, ?)`)
    .run(id, projectId, type, name, summary)
  return id
}

export function linkNodes(srcId: string, dstId: string, relation: string): void {
  getDb()
    .prepare(`INSERT INTO edges (id, src_id, dst_id, relation) VALUES (?, ?, ?, ?)`)
    .run(randomUUID(), srcId, dstId, relation)
}

// ---- project context -------------------------------------------------------
// Backs the get_project_context MCP tool and the UI's "Inject memory" button:
// a compact snapshot of what an AI should know before working in a project —
// the project itself, its standing decisions and preferences, the most recent
// knowledge, and the systems mapped in the graph.
export interface ProjectContext {
  project: { id: string; name: string; path: string; status: string } | null
  decisions: MemoryItem[]
  preferences: MemoryItem[]
  recent: MemoryItem[]
  systems: { name: string; summary: string }[]
}

export function getProjectContext(projectId: string): ProjectContext {
  const db = getDb()
  const project =
    (db.prepare(`SELECT id, name, path, status FROM projects WHERE id = ?`).get(projectId) as
      | ProjectContext['project']
      | undefined) ?? null

  // Project-scoped items include global (project_id IS NULL) knowledge too.
  const byType = (type: string, limit: number): MemoryItem[] =>
    db
      .prepare(
        `SELECT * FROM memory_items WHERE (project_id = ? OR project_id IS NULL) AND type = ?
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(projectId, type, limit)
      .map(hydrate)

  const recent = db
    .prepare(
      `SELECT * FROM memory_items WHERE project_id = ? OR project_id IS NULL
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(projectId, 15)
    .map(hydrate)

  const systems = db
    .prepare(`SELECT name, summary FROM nodes WHERE project_id = ? AND type = 'system' ORDER BY name LIMIT ?`)
    .all(projectId, 20) as { name: string; summary: string }[]

  return {
    project,
    decisions: byType('decision', 10),
    preferences: byType('preference', 10),
    recent,
    systems
  }
}

// Render a ProjectContext as a readable Markdown block for prompt injection.
// Backs the Claude Code "Inject memory" button: get_project_context() → this →
// prepended to the task sent to the CLI. (The MCP server formats its own copy
// for external clients; this is the in-process renderer.)
export function formatProjectContext(ctx: ProjectContext): string {
  if (!ctx.project) return ''
  const p = ctx.project
  const lines: string[] = [`# Project context: ${p.name}`, `Path: ${p.path} · Status: ${p.status}`, '']
  const section = (title: string, items: { title: string; content: string }[]) => {
    if (items.length === 0) return
    lines.push(`## ${title}`)
    for (const it of items) lines.push(`- **${it.title}** — ${it.content}`)
    lines.push('')
  }
  section('Decisions', ctx.decisions)
  section('Preferences', ctx.preferences)
  if (ctx.systems.length > 0) {
    lines.push('## Systems')
    for (const s of ctx.systems) lines.push(`- **${s.name}**${s.summary ? ` — ${s.summary}` : ''}`)
    lines.push('')
  }
  section('Recent knowledge', ctx.recent)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

// ---- helpers ---------------------------------------------------------------
function hydrate(row: any): MemoryItem {
  return {
    ...row,
    tags: safeJsonArray(row.tags),
    quality_flags: safeJsonArray(row.quality_flags),
    quality_reason: row.quality_reason ?? null,
    last_accessed_at: row.last_accessed_at ?? null,
    access_count: Number(row.access_count ?? 0),
    stale_at: row.stale_at ?? null
  }
}

function safeJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string')
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function cleanText(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function rejected(reason: string, flags: string[]): MemoryQualityResult {
  return { allowed: false, reason, flags }
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength)
  new Uint8Array(ab).set(buf)
  return ab
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}
