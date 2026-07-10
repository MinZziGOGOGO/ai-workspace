// Deterministic Knowledge quality + telemetry test.
// No Electron, no Ollama dependency required.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { initDb, getDb } from '../src/main/db'
import { importFolder } from '../src/main/projects'
import { isE2EFakeEnabled } from '../src/main/e2e'
import {
  deleteLowQualityCandidates,
  evaluateMemoryQuality,
  getKnowledgeDiagnostics,
  markMemoryStale,
  MemoryQualityError,
  saveMemory,
  searchMemory,
  touchMemory
} from '../src/main/knowledge'

async function main() {
  const userData = mkdtempSync(join(tmpdir(), 'aiws-kq-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'aiws-kqp-'))
  const legacyId = randomUUID()
  let ok = true
  const fail = (msg: string) => { console.error(`FAIL: ${msg}`); ok = false }

  try {
    const legacyDb = new Database(join(userData, 'workspace.db'))
    legacyDb.exec(`
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        embedding BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    legacyDb.prepare(
      `INSERT INTO memory_items (id, project_id, type, title, content, source, tags, created_at, updated_at)
       VALUES (?, NULL, 'note', 'Legacy row', 'Existing old database row with enough retained detail.', 'chat', '[]', ?, ?)`
    ).run(legacyId, Date.now(), Date.now())
    legacyDb.close()

    await initDb(userData)
    const db = getDb()
    const project = importFolder(projectDir, 'Knowledge Quality Test')

    const cols = new Set(
      (db.prepare('PRAGMA table_info(memory_items)').all() as { name: string }[]).map((c) => c.name)
    )
    for (const col of ['last_accessed_at', 'access_count', 'stale_at', 'quality_flags', 'quality_reason']) {
      if (!cols.has(col)) fail(`missing migration column ${col}`)
    }
    const legacyRow = db
      .prepare('SELECT access_count, quality_flags, quality_reason FROM memory_items WHERE id = ?')
      .get(legacyId) as { access_count: number; quality_flags: string; quality_reason: string | null } | undefined
    if (!legacyRow) fail('legacy row did not survive migration')
    else {
      if (legacyRow.access_count !== 0) fail('legacy access_count default was not applied safely')
      if (legacyRow.quality_flags !== '[]') fail('legacy quality_flags default was not applied safely')
      if (legacyRow.quality_reason !== null) fail('legacy quality_reason should default to NULL')
    }

    const oldFake = process.env.E2E_FAKE_OLLAMA
    const oldTestData = process.env.AIWORKSPACE_TEST_USER_DATA
    process.env.E2E_FAKE_OLLAMA = '1'
    delete process.env.AIWORKSPACE_TEST_USER_DATA
    if (isE2EFakeEnabled('E2E_FAKE_OLLAMA')) fail('E2E fake activated without isolated test user data')
    process.env.AIWORKSPACE_TEST_USER_DATA = userData
    if (!isE2EFakeEnabled('E2E_FAKE_OLLAMA')) fail('E2E fake did not activate under test harness')
    if (oldFake === undefined) delete process.env.E2E_FAKE_OLLAMA
    else process.env.E2E_FAKE_OLLAMA = oldFake
    if (oldTestData === undefined) delete process.env.AIWORKSPACE_TEST_USER_DATA
    else process.env.AIWORKSPACE_TEST_USER_DATA = oldTestData

    const low = evaluateMemoryQuality({
      projectId: project.id,
      type: 'note',
      title: 'Hello',
      content: 'Hello',
      source: 'chat'
    })
    if (low.allowed || !low.reason) fail('chat greeting was not rejected with a reason')

    const explicit = evaluateMemoryQuality({
      projectId: project.id,
      type: 'decision',
      title: 'Use SQLite',
      content: 'Use SQLite for the local workspace database.',
      source: 'user'
    })
    if (!explicit.allowed) fail('explicit user decision was blocked')

    let skipped = false
    try {
      await saveMemory({ projectId: project.id, type: 'note', title: 'Hello', content: 'Hello', source: 'chat' })
    } catch (err) {
      skipped = err instanceof MemoryQualityError && /greeting/i.test(err.reason)
    }
    if (!skipped) fail('low-value chat memory did not throw MemoryQualityError')

    const item = await saveMemory({
      projectId: project.id,
      type: 'decision',
      title: 'Telemetry keyword',
      content: 'Telemetry keyword should be searchable without a real embedding service.',
      source: 'user',
      tags: ['test']
    })

    const found = await searchMemory('Telemetry keyword', 'project', project.id, 5)
    if (!found.some((r) => r.id === item.id)) fail('keyword search did not find saved memory')
    const afterSearch = db
      .prepare('SELECT last_accessed_at, access_count FROM memory_items WHERE id = ?')
      .get(item.id) as { last_accessed_at: number | null; access_count: number }
    if (afterSearch.last_accessed_at !== null || afterSearch.access_count !== 0)
      fail('search wrote access telemetry; search results should be read-only')

    await touchMemory(item.id)
    const opened = db
      .prepare('SELECT last_accessed_at, access_count FROM memory_items WHERE id = ?')
      .get(item.id) as { last_accessed_at: number | null; access_count: number }
    if (!opened.last_accessed_at || opened.access_count !== 1)
      fail('touchMemory should increment access count exactly once per call')

    await markMemoryStale(item.id, true)
    const diagnostics = getKnowledgeDiagnostics(project.id)
    if (diagnostics.total < 1) fail('diagnostics did not count memories')
    if (diagnostics.byType.decision !== 1) fail('diagnostics byType is wrong')
    if (diagnostics.bySource.user !== 1) fail('diagnostics bySource is wrong')
    if (diagnostics.staleCount < 1) fail('diagnostics did not count stale memory')
    if (diagnostics.recentlyAccessedCount < 1) fail('diagnostics did not count recently accessed memory')

    const protectedUserId = randomUUID()
    const protectedDecisionId = randomUUID()
    const deletableId = randomUUID()
    const now = Date.now()
    const insertFlagged = db.prepare(
      `INSERT INTO memory_items (
         id, project_id, type, title, content, source, tags, created_at, updated_at,
         quality_flags, quality_reason
       ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`
    )
    insertFlagged.run(
      protectedUserId, project.id, 'note', 'User thin note', 'x', 'user',
      now, now, JSON.stringify(['thin-content']), 'Review suggested'
    )
    insertFlagged.run(
      protectedDecisionId, project.id, 'decision', 'Extractor decision', 'x', 'extractor',
      now, now, JSON.stringify(['thin-content']), 'Review suggested'
    )
    insertFlagged.run(
      deletableId, project.id, 'note', 'How can I help?', 'How can I help you today?', 'chat',
      now, now, '[]', null
    )
    const removed = await deleteLowQualityCandidates(project.id)
    if (removed !== 1) fail(`bulk low-quality delete removed ${removed} rows instead of exactly one deletable candidate`)
    const protectedRemaining = db
      .prepare('SELECT COUNT(*) AS n FROM memory_items WHERE id IN (?, ?)')
      .get(protectedUserId, protectedDecisionId) as { n: number }
    if (protectedRemaining.n !== 2) fail('bulk low-quality delete removed protected user/decision memory')
    const deletedCandidate = db
      .prepare('SELECT COUNT(*) AS n FROM memory_items WHERE id = ?')
      .get(deletableId) as { n: number }
    if (deletedCandidate.n !== 0) fail('bulk low-quality delete did not remove eligible chat residue')

    // Simulate an older existing DB row with no quality fields populated by inserting
    // directly. The additive migration should keep diagnostics safe on legacy rows.
    db.prepare(
      `INSERT INTO memory_items (id, project_id, type, title, content, source, tags, created_at, updated_at)
       VALUES (?, ?, 'note', 'How can I help?', 'How can I help you today?', 'chat', '[]', ?, ?)`
    ).run(randomUUID(), project.id, Date.now(), Date.now())
    const withCandidate = getKnowledgeDiagnostics(project.id)
    if (withCandidate.lowQualityCount < 1) fail('diagnostics did not identify low-quality candidate')
  } finally {
    try { rmSync(userData, { recursive: true, force: true }) } catch {}
    try { rmSync(projectDir, { recursive: true, force: true }) } catch {}
  }

  if (!ok) process.exit(1)
  console.error('PASS: Knowledge quality + telemetry')
}

main().catch((err) => {
  console.error('[test] fatal:', err)
  process.exit(1)
})
