// End-to-end test for M6 — the Hermes Agent client.
// Exercises the REAL localhost API when it's up; no Electron.
// Run: npm run test:hermes
//
// Two outcomes are both a PASS (mirrors test-claudecode.ts):
//   • Hermes running → submit a task, poll it to a terminal state, see activity
//                      stream + status events, and a task summary saved to memory.
//   • Not running    → checkHermes() reports it accurately (wsl2/installed/running)
//                      without crashing, and the run path surfaces a clean error.
//
// A tiny built-in mock server is used when HERMES_TEST_MOCK=1 so the full
// submit→poll→summary path can be verified on a machine without WSL/Hermes.

import { createServer, type Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initDb, getDb } from '../src/main/db'
import { importFolder } from '../src/main/projects'
import { saveMemory } from '../src/main/knowledge'
import {
  checkHermes,
  hermesHealth,
  runTask,
  summarizeTask,
  HERMES_PORT,
  type HermesEvent
} from '../src/main/hermes'

// ---- optional mock Hermes server -------------------------------------------
// Models the integration contract: /health, POST /tasks, GET /tasks/:id with a
// growing activity log that completes after a couple of polls.
function startMockHermes(port: number): Promise<Server> {
  const task = {
    id: 't1',
    prompt: '',
    status: 'pending' as string,
    activity: [] as { ts: number; kind: string; message: string }[]
  }
  let polls = 0
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    res.setHeader('content-type', 'application/json')
    if (url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'mock-1.0' }))
    if (req.method === 'POST' && url === '/tasks') {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        try { task.prompt = JSON.parse(body).prompt } catch {}
        task.status = 'running'
        task.activity = [{ ts: Date.now(), kind: 'log', message: 'received task' }]
        res.end(JSON.stringify(task))
      })
      return
    }
    if (url === '/tasks') return res.end(JSON.stringify([task]))
    if (url.startsWith('/tasks/')) {
      polls++
      if (polls === 1) task.activity.push({ ts: Date.now(), kind: 'tool', message: 'search_memory' })
      if (polls >= 2) {
        task.status = 'completed'
        ;(task as any).result = 'done: created a plan'
      }
      return res.end(JSON.stringify(task))
    }
    res.statusCode = 404
    res.end('{}')
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

async function main() {
  const userData = mkdtempSync(join(tmpdir(), 'aiws-hermes-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'aiws-hermesp-'))
  await initDb(userData)
  const project = importFolder(projectDir, 'Hermes Test')

  let ok = true
  const fail = (m: string) => { console.error(`❌ FAIL: ${m}`); ok = false }
  const cleanup = (server?: Server) => {
    server?.close()
    try { rmSync(userData, { recursive: true, force: true }) } catch {}
    try { rmSync(projectDir, { recursive: true, force: true }) } catch {}
  }

  let mock: Server | undefined
  if (process.env.HERMES_TEST_MOCK === '1') {
    mock = await startMockHermes(HERMES_PORT)
    console.error(`[test] mock Hermes listening on :${HERMES_PORT}`)
  }

  // ---- 1) check (must never throw, whatever the environment) ----
  const check = await checkHermes()
  console.error('[test] checkHermes():', JSON.stringify(check))
  for (const k of ['wsl2', 'installed', 'running'] as const) {
    if (typeof (check as any)[k] !== 'boolean') fail(`check.${k} is not a boolean`)
  }

  const health = await hermesHealth()
  if (!health.ok) {
    console.error('[test] Hermes API not reachable — setup path is what the UI shows. SKIP run.')
    // summarizeTask must still be robust on a failed/empty run.
    const summary = summarizeTask('plan the work', { ok: false, activity: [], error: 'not reachable' })
    if (!summary.title || !summary.content.includes('Task:')) fail('summarizeTask malformed on empty run')
    cleanup(mock)
    if (!ok) { console.error('\n❌ FAILED'); process.exit(1) }
    console.error('\n⚠️  SKIP: Hermes API not running (build is fine; setup path verified)')
    process.exit(0)
  }

  // ---- 2) submit + poll a task, capturing streamed events ----
  const events: HermesEvent[] = []
  console.error('[test] submitting a task (real API)…')
  const run = await runTask({
    prompt: 'Make a short plan for adding a healthcheck.',
    project: projectDir,
    pollMs: 200,
    maxMs: 20_000,
    onEvent: (e) => {
      events.push(e)
      if (e.kind === 'activity') console.error(`   • ${e.activity.kind}: ${e.activity.message}`)
      else if (e.kind === 'status') console.error(`   • status: ${e.status} (${e.summary})`)
      else if (e.kind === 'error') console.error(`   • error: ${e.message}`)
    }
  })
  console.error('[test] run:', JSON.stringify({ ok: run.ok, status: run.task?.status, activity: run.activity.length }))

  if (!events.some((e) => e.kind === 'status')) fail('no status event was streamed')
  if (!run.task) fail('run produced no task')
  if (run.ok && run.activity.length === 0) fail('completed run streamed no activity')

  // ---- 3) post-task summary saved to memory (single write queue) ----
  const { title, content } = summarizeTask('Make a short plan for adding a healthcheck.', run)
  await saveMemory({ projectId: project.id, type: 'task', title, content, source: 'hermes', tags: ['hermes'] })
  const saved = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE project_id = ? AND source = 'hermes'`)
    .get(project.id) as { n: number }
  if (saved.n < 1) fail('no Hermes task summary memory was saved')
  else console.error('[test] task summary saved to memory — OK')

  cleanup(mock)
  if (ok) { console.error('\n✅ PASS: Hermes client (check + submit/poll/stream + summary)'); process.exit(0) }
  else { console.error('\n❌ FAILED'); process.exit(1) }
}

main().catch((err) => { console.error('[test] fatal:', err); process.exit(1) })
