// Standalone end-to-end test for the M3 file watcher + indexer.
// Exercises the REAL code path (chokidar → index_queue → debounced drain →
// knowledge write queue) against a throwaway DB and folder. No Electron, no GUI.
// Run: node out/test/test-indexer.cjs  (bundled by esbuild, electron externalized)

import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initDb, getDb } from '../src/main/db'
import { importFolder } from '../src/main/projects'
import { startWatcher, stopAllWatchers } from '../src/main/indexer'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Poll the DB until `check` returns true (chokidar cold-start on Windows +
// awaitWriteFinish + debounce + the local model summarizing the file). The
// window is generous because on a CPU-bound Ollama a single summary can take
// ~50s; it resolves as soon as the condition is met.
async function waitFor(label: string, check: () => boolean): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    if (check()) { console.error(`[test] ${label} after ~${i + 1}s`); return true }
  }
  console.error(`[test] TIMEOUT waiting for ${label}`)
  return false
}

async function main() {
  const userData = mkdtempSync(join(tmpdir(), 'aiws-db-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'aiws-proj-'))
  console.error('[test] userData:', userData)
  console.error('[test] project :', projectDir)

  await initDb(userData)
  const project = importFolder(projectDir, 'Indexer Test Project')
  console.error('[test] project id:', project.id)

  // Open == start watching (mirrors the projects:open IPC handler).
  startWatcher(project.id, project.path)

  // Create a source file in the watched folder.
  const filePath = join(projectDir, 'greeter.ts')
  writeFileSync(
    filePath,
    `export function greet(name: string): string {\n  return \`Hello, \${name}!\`\n}\n`
  )
  console.error('[test] wrote greeter.ts; waiting for debounced drain...')

  const db = getDb()
  const fileItems = () =>
    db.prepare(`SELECT title, type, source, content, updated_at FROM memory_items WHERE project_id = ? AND type = 'file' AND title = 'greeter.ts'`)
      .all(project.id) as { title: string; type: string; source: string; content: string; updated_at: number }[]
  const fileNodes = () =>
    db.prepare(`SELECT name FROM nodes WHERE project_id = ? AND type = 'file' AND name = 'greeter.ts'`)
      .all(project.id) as { name: string }[]
  const edgeCount = () =>
    (db.prepare(`SELECT COUNT(*) AS n FROM edges`).get() as { n: number }).n

  let ok = true
  const fail = (msg: string) => { console.error(`❌ FAIL: ${msg}`); ok = false }

  // ---- 1) add ----
  if (!(await waitFor('add → indexed', () => fileItems().length > 0))) fail('greeter.ts never indexed')
  let items = fileItems()
  if (items.length !== 1) fail(`expected 1 file item, got ${items.length}`)
  if (items[0] && items[0].source !== 'indexer') fail('source is not "indexer"')
  if (fileNodes().length !== 1) fail(`expected 1 file node, got ${fileNodes().length}`)
  const edgesAfterAdd = edgeCount()
  console.error('[test] after add: content =', JSON.stringify(items[0]?.content), '| edges =', edgesAfterAdd)

  // ---- 2) change (upsert in place, no duplicate node/edge) ----
  writeFileSync(filePath, `// changed\nexport const PI = 3.14159\n`)
  console.error('[test] modified greeter.ts...')
  // Without a local model the placeholder summary text stays the same, so detect the
  // re-index by its timestamp (and accept a changed summary when a model is available)
  const before = items[0]
  const reindexed = () => {
    const now = fileItems()[0]
    return !!now && (now.updated_at > before.updated_at || now.content !== before.content)
  }
  if (!(await waitFor('change → re-indexed', reindexed))) fail('change not re-indexed')
  items = fileItems()
  if (items.length !== 1) fail(`change created a duplicate item (${items.length})`)
  if (fileNodes().length !== 1) fail(`change created a duplicate node (${fileNodes().length})`)
  if (edgeCount() !== edgesAfterAdd) fail(`change created a duplicate edge (${edgeCount()} vs ${edgesAfterAdd})`)
  console.error('[test] after change: content =', JSON.stringify(items[0]?.content))

  // ---- 3) unlink (removal) ----
  unlinkSync(filePath)
  console.error('[test] deleted greeter.ts...')
  if (!(await waitFor('unlink → removed', () => fileItems().length === 0))) fail('unlink did not remove item')
  if (fileNodes().length !== 0) fail('file node not removed on unlink')

  const queue = db
    .prepare(`SELECT processed_at FROM index_queue WHERE project_id = ?`)
    .all(project.id) as { processed_at: number | null }[]
  if (!queue.every((q) => q.processed_at)) fail('some queue rows left unprocessed')
  console.error('[test] queue rows:', queue.length, '| all processed:', queue.every((q) => q.processed_at))

  stopAllWatchers()
  // Cleanup
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
  try { rmSync(projectDir, { recursive: true, force: true }) } catch {}

  if (ok) {
    console.error('\n✅ PASS: add → indexed, change → upserted (no dupes), unlink → removed, queue drained.')
    process.exit(0)
  } else {
    console.error('\n❌ FAILED')
    process.exit(1)
  }
}

main().catch((err) => { console.error('[test] fatal:', err); process.exit(1) })
