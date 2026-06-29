// End-to-end test for M4 — memory extraction + consolidation.
// Exercises the REAL pipeline against a throwaway DB. No Electron.
// Run: npm run test:extractor

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { initDb, getDb } from '../src/main/db'
import { importFolder } from '../src/main/projects'
import { saveMemory } from '../src/main/knowledge'
import { extractFromSession, consolidateMemories, consolidateIfOverdue } from '../src/main/extractor'

async function main() {
  const userData = mkdtempSync(join(tmpdir(), 'aiws-ext-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'aiws-extp-'))
  await initDb(userData)
  const project = importFolder(projectDir, 'Extractor Test')
  const db = getDb()

  let ok = true
  const fail = (m: string) => { console.error(`❌ FAIL: ${m}`); ok = false }

  // ---- 1) extraction (live model smoke test) ----
  const sessionId = randomUUID()
  db.prepare(`INSERT INTO sessions (id, project_id, mode, title, created_at) VALUES (?, ?, 'chat', 'Test', ?)`)
    .run(sessionId, project.id, Date.now())
  const convo: [string, string][] = [
    ['user', 'I want to build the storage layer. Should I use Postgres or SQLite?'],
    ['assistant', 'For a local-first desktop app, SQLite is the better choice — zero servers, single file, easy backups.'],
    ['user', 'Agreed. Let us go with SQLite as a single file in the user data directory. Also I strongly prefer TypeScript everywhere, no Python in this repo.'],
    ['assistant', 'Good. Decision recorded: SQLite single-file storage; TypeScript-only codebase. One research note: sql.js rewrites the whole file on every write, so batch writes when possible.']
  ]
  let t = Date.now()
  for (const [role, content] of convo) {
    db.prepare(`INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), sessionId, role, content, t++)
  }

  console.error('[test] running extraction (live model)...')
  const extracted = await extractFromSession(project.id, sessionId)
  console.error('[test] extracted:', JSON.stringify(extracted.map((e) => ({ type: e.type, title: e.title })), null, 2))

  if (!Array.isArray(extracted)) fail('extraction did not return an array')
  for (const it of extracted) {
    if (!['decision', 'preference', 'research'].includes(it.type)) fail(`bad type: ${it.type}`)
    if (it.source !== 'extractor') fail('extracted item source is not "extractor"')
    if (!it.title || !it.content) fail('extracted item missing title/content')
  }
  // Persisted?
  const persisted = db.prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE source = 'extractor'`).get() as { n: number }
  if (persisted.n !== extracted.length) fail(`persisted ${persisted.n} != returned ${extracted.length}`)
  console.error(`[test] extraction produced ${extracted.length} item(s) — ${extracted.length > 0 ? 'OK' : 'model returned none (tolerated)'}`)

  // Re-extracting the same session: the semantic guard should skip the facts
  // it already saved. The model is nondeterministic, so we don't demand a
  // perfect 0 — we demand the guard doesn't make things worse, and rely on
  // consolidation (below) to guarantee no duplicates survive.
  const again = await extractFromSession(project.id, sessionId)
  if (again.length > extracted.length) fail(`re-extraction added MORE than the first run (${again.length} > ${extracted.length}) — guard not working`)
  else console.error(`[test] re-extraction added ${again.length} item(s) (guard skipped the rest)`)

  // ---- 2) consolidation (deterministic) ----
  // Two near-identical memories (same content) + one distinct.
  const dupA = await saveMemory({ projectId: project.id, type: 'decision', title: 'Use SQLite', content: 'The app stores everything in one SQLite file in the user data directory.', source: 'user' })
  await saveMemory({ projectId: project.id, type: 'decision', title: 'Storage choice', content: 'The app stores everything in one SQLite file in the user data directory.', source: 'chat' })
  const distinct = await saveMemory({ projectId: project.id, type: 'preference', title: 'TypeScript only', content: 'No Python in this repo; TypeScript is used everywhere.', source: 'user' })

  const countBefore = (db.prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE project_id = ?`).get(project.id) as { n: number }).n
  console.error('[test] running consolidation...')
  const result = await consolidateMemories(project.id)
  const countAfter = (db.prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE project_id = ?`).get(project.id) as { n: number }).n

  if (result.removed < 1) fail(`consolidation removed ${result.removed}, expected >= 1 duplicate`)
  if (countAfter !== countBefore - result.removed) fail(`count mismatch: ${countBefore} - ${result.removed} != ${countAfter}`)
  // The distinct preference must survive.
  const distinctAlive = db.prepare(`SELECT id FROM memory_items WHERE id = ?`).get(distinct.id)
  if (!distinctAlive) fail('consolidation removed a NON-duplicate item')
  // Exactly one of the two identical decisions remains.
  const dupsLeft = db.prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE project_id = ? AND content = ?`).get(project.id, dupA.content) as { n: number }
  if (dupsLeft.n !== 1) fail(`expected 1 copy of the duplicate to remain, found ${dupsLeft.n}`)
  console.error(`[test] consolidation removed ${result.removed} duplicate(s); distinct survived — OK`)

  // End-to-end invariant: after extract×2 + consolidation, NO near-duplicate
  // pairs survive in the project. This is the real guarantee (deterministic),
  // independent of the model's run-to-run wording.
  const all = db
    .prepare(`SELECT id, embedding FROM memory_items WHERE project_id = ? AND type != 'file'`)
    .all(project.id) as { id: string; embedding: any }[]
  const vecs = all.map((r) => toVec(r.embedding)).filter((v): v is Float32Array => v !== null)
  let nearDupPairs = 0
  for (let i = 0; i < vecs.length; i++)
    for (let j = i + 1; j < vecs.length; j++)
      if (cosine(vecs[i], vecs[j]) >= 0.95) nearDupPairs++
  if (nearDupPairs > 0) fail(`${nearDupPairs} near-duplicate pair(s) survived consolidation`)
  else console.error('[test] no near-duplicate pairs survive consolidation — convergence OK')

  // ---- 3) overdue gate writes app_meta and is idempotent within 24h ----
  const firstRun = await consolidateIfOverdue()
  if (firstRun === null) fail('consolidateIfOverdue returned null on first run (no app_meta yet)')
  const meta = db.prepare(`SELECT value FROM app_meta WHERE key = 'last_consolidation'`).get() as { value: string } | undefined
  if (!meta) fail('app_meta last_consolidation not written')
  const secondRun = await consolidateIfOverdue()
  if (secondRun !== null) fail('consolidateIfOverdue ran again within 24h (should be gated)')
  else console.error('[test] overdue gate: ran once, skipped second run within 24h — OK')

  try { rmSync(userData, { recursive: true, force: true }) } catch {}
  try { rmSync(projectDir, { recursive: true, force: true }) } catch {}

  if (ok) { console.error('\n✅ PASS: extraction + idempotency + consolidation + overdue gate'); process.exit(0) }
  else { console.error('\n❌ FAILED'); process.exit(1) }
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
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

main().catch((err) => { console.error('[test] fatal:', err); process.exit(1) })
