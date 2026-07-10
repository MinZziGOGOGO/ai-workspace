import { getDb } from './db'
import { chat, defaultChatModel, embed, type ChatMessage } from './ollama'
import { saveMemory, deleteMemory, MemoryQualityError, type MemoryItem } from './knowledge'

// Milestone 4 — memory extraction agent.
//
// Two jobs, both backed by the local Ollama model and the single write queue
// in knowledge.ts:
//   1. extractFromSession — review a finished chat and distil durable knowledge
//      (decisions / preferences / research) into memory_items.
//   2. consolidation — an overdue-triggered hygiene pass that removes
//      near-duplicate memories, keeping the most informative copy.
//
// Like the indexer, this runs only in the Electron main process (never the MCP
// stdio server), logs to stderr, and routes every write through saveMemory /
// deleteMemory so graph/vector mutations stay serialized.

const EXTRACT_TYPES = new Set(['decision', 'preference', 'research'])
const MAX_TRANSCRIPT = 12000 // chars of conversation sent to the model
const CHAT_TIMEOUT_MS = 180000 // give the local model up to 3 min, then give up gracefully
const DEDUP_COSINE = 0.95 // consolidation: cosine ≥ this ⇒ same memory
const EXTRACT_DEDUP_COSINE = 0.9 // extraction: a bit looser, so a reworded re-run of the same fact is skipped
const CONSOLIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000

const EXTRACT_SYSTEM =
  'You are a memory-extraction agent for a developer workspace. Review the conversation ' +
  'and pull out durable knowledge worth remembering across future sessions.\n\n' +
  'Extract only genuinely important items:\n' +
  '- "decision": an architecture/design/technical choice that was made\n' +
  '- "preference": how the user likes to work, tools/styles they prefer\n' +
  '- "research": a concrete finding, fact, or conclusion worth keeping\n\n' +
  'Ignore greetings, questions, half-formed ideas, and transient chatter.\n' +
  'Respond with ONLY a JSON array (no prose, no code fences). Each element:\n' +
  '{"type":"decision|preference|research","title":"short label","content":"1-3 factual sentences"}\n' +
  'If nothing is worth saving, respond with [].'

interface RawItem { type?: string; title?: string; content?: string }

// ---- extraction ------------------------------------------------------------
export async function extractFromSession(projectId: string | null, sessionId: string): Promise<MemoryItem[]> {
  const db = getDb()
  const rows = db
    .prepare(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId) as { role: string; content: string }[]
  const convo = rows.filter((r) => r.role === 'user' || r.role === 'assistant')
  if (convo.length === 0) return []

  let transcript = convo.map((r) => `${r.role.toUpperCase()}: ${r.content}`).join('\n\n')
  if (transcript.length > MAX_TRANSCRIPT) transcript = transcript.slice(-MAX_TRANSCRIPT)

  const model = await defaultChatModel()
  if (!model) {
    console.error('[extractor] no chat model available — skipping extraction')
    throw new Error('Memory extraction needs a local Ollama chat model.')
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `Conversation:\n\n${transcript}\n\nReturn the JSON array now.` }
  ]
  const out = await chat(model, messages, CHAT_TIMEOUT_MS)
  if (!out) throw new Error('Memory extraction failed because the local model did not respond.')

  const items = parseItems(out)
  if (items.length === 0) return []

  // Idempotency guard for repeated clicks: skip items that already exist in
  // this project's memory. Exact-text catches the easy case; a semantic check
  // (embed + cosine) catches the model rewording the same fact on a re-run.
  const existing = (projectId
    ? db
        .prepare(`SELECT content, embedding FROM memory_items WHERE project_id = ? OR project_id IS NULL`)
        .all(projectId)
    : db.prepare(`SELECT content, embedding FROM memory_items WHERE project_id IS NULL`).all()) as {
      content: string
      embedding: any
    }[]
  const seenText = new Set(existing.map((e) => norm(e.content)))
  const seenVecs = existing.map((e) => toVec(e.embedding)).filter((v): v is Float32Array => v !== null)

  const saved: MemoryItem[] = []
  for (const it of items) {
    const type = (it.type || '').toLowerCase()
    if (!EXTRACT_TYPES.has(type)) continue
    const title = (it.title || '').trim()
    const content = (it.content || '').trim()
    if (!title || !content) continue
    if (seenText.has(norm(content))) continue
    // saveMemory embeds `${title}\n${content}`; embed the same string here so
    // the dedup comparison is in the identical vector space.
    const vec = await embed(`${title}\n${content}`)
    if (vec && seenVecs.some((v) => cosine(vec, v) >= EXTRACT_DEDUP_COSINE)) continue
    let item: MemoryItem
    try {
      item = await saveMemory({ projectId, type, title, content, source: 'extractor', tags: ['extracted'] })
    } catch (err) {
      if (err instanceof MemoryQualityError) {
        console.error(`[extractor] skipped low-value memory candidate: ${err.reason}`)
        continue
      }
      throw err
    }
    seenText.add(norm(content))
    if (vec) seenVecs.push(vec)
    saved.push(item)
  }
  console.error(`[extractor] session ${sessionId}: saved ${saved.length} memory item(s)`)
  return saved
}

// ---- consolidation ---------------------------------------------------------
/** Run consolidation only if it hasn't run in the last 24h. Called at launch. */
export async function consolidateIfOverdue(): Promise<{ removed: number } | null> {
  const db = getDb()
  const last = (db.prepare(`SELECT value FROM app_meta WHERE key = 'last_consolidation'`).get() as
    | { value: string }
    | undefined)?.value
  if (last && Date.now() - Number(last) < CONSOLIDATE_INTERVAL_MS) return null

  const result = await consolidateMemories(null)
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES ('last_consolidation', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(Date.now()))
  console.error(`[extractor] consolidation removed ${result.removed} duplicate(s)`)
  return result
}

/**
 * Remove near-duplicate memories, keeping the most informative copy in each
 * cluster. Scoped per project (NULL/global treated as its own group) so a
 * decision shared across projects isn't collapsed. Skips 'file' items — those
 * are indexer-owned and keyed by path.
 */
export async function consolidateMemories(scopeProjectId: string | null): Promise<{ removed: number }> {
  const db = getDb()
  const rows = (scopeProjectId
    ? db
        .prepare(`SELECT * FROM memory_items WHERE (project_id = ? OR project_id IS NULL) AND type != 'file'`)
        .all(scopeProjectId)
    : db.prepare(`SELECT * FROM memory_items WHERE type != 'file'`).all()) as any[]

  const groups = new Map<string, any[]>()
  for (const r of rows) {
    const key = r.project_id ?? '∅'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }

  const toDelete: string[] = []
  for (const items of groups.values()) {
    const kept: any[] = []
    for (const it of items) {
      let dup = false
      for (let k = 0; k < kept.length; k++) {
        if (isDuplicate(it, kept[k])) {
          dup = true
          // Keep whichever has more content; drop the other.
          if ((it.content?.length ?? 0) > (kept[k].content?.length ?? 0)) {
            toDelete.push(kept[k].id)
            kept[k] = it
          } else {
            toDelete.push(it.id)
          }
          break
        }
      }
      if (!dup) kept.push(it)
    }
  }

  for (const id of toDelete) await deleteMemory(id)
  return { removed: toDelete.length }
}

// ---- helpers ---------------------------------------------------------------
function parseItems(text: string): RawItem[] {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return []
  try {
    const arr = JSON.parse(t.slice(start, end + 1))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function norm(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function isDuplicate(a: any, b: any): boolean {
  if (norm(a.content) === norm(b.content)) return true
  const va = toVec(a.embedding)
  const vb = toVec(b.embedding)
  if (va && vb) return cosine(va, vb) >= DEDUP_COSINE
  // No embeddings to compare — fall back to identical titles.
  return norm(a.title) === norm(b.title)
}

function toVec(blob: any): Float32Array | null {
  if (!blob) return null
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob)
  if (u8.byteLength === 0 || u8.byteLength % 4 !== 0) return null
  const ab = new ArrayBuffer(u8.byteLength)
  new Uint8Array(ab).set(u8)
  return new Float32Array(ab)
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
