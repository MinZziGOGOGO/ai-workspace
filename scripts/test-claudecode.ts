// End-to-end test for M5 — the Claude Code launcher.
// Exercises the REAL CLI against a throwaway project. No Electron.
// Run: npm run test:claudecode
//
// Two outcomes are both a PASS:
//   • Logged in  → the task runs, hello.ts appears, the activity log records the
//                  file write, and a task summary is saved to memory.
//   • Not logged in / not installed → the launcher detects it and reports a
//                  clear setup message instead of crashing (a required feature).

import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initDb, getDb } from '../src/main/db'
import { importFolder } from '../src/main/projects'
import { saveMemory } from '../src/main/knowledge'
import { checkClaudeCode, runClaudeCode, summarizeRun, type CCEvent } from '../src/main/claudecode'

async function main() {
  const userData = mkdtempSync(join(tmpdir(), 'aiws-cc-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'aiws-ccp-'))
  await initDb(userData)
  const project = importFolder(projectDir, 'Claude Code Test')

  let ok = true
  const fail = (m: string) => { console.error(`❌ FAIL: ${m}`); ok = false }
  const cleanup = () => {
    try { rmSync(userData, { recursive: true, force: true }) } catch {}
    try { rmSync(projectDir, { recursive: true, force: true }) } catch {}
  }

  // ---- 1) install check ----
  const check = await checkClaudeCode()
  console.error('[test] checkClaudeCode():', JSON.stringify(check))
  if (!check.installed) {
    console.error('[test] Claude Code CLI not installed — setup path is what the UI shows. SKIP run.')
    cleanup()
    console.error('\n⚠️  SKIP: CLI not installed (nothing to fail; build is fine)')
    process.exit(0)
  }
  if (!check.version) fail('installed CLI reported no version')

  // ---- 2) run a simple file-creating task ----
  const prompt =
    "Create a file named hello.ts in the current working directory containing exactly: " +
    "console.log('hello world'). Create only that one file, then stop."
  const events: CCEvent[] = []
  console.error('[test] running task (real CLI)…')
  const run = await runClaudeCode({
    projectPath: projectDir,
    prompt,
    onEvent: (e) => {
      events.push(e)
      if (e.kind === 'tool') console.error(`   • tool: ${e.name} ${e.summary}`)
      else if (e.kind === 'tool-result') console.error(`   • result: ${e.ok ? 'ok' : 'ERR'} ${e.summary}`)
      else if (e.kind === 'system') console.error(`   • ${e.summary}`)
      else if (e.kind === 'error') console.error(`   • error: ${e.message}`)
    }
  })
  console.error('[test] run:', JSON.stringify({ ok: run.ok, loginRequired: run.loginRequired, activity: run.activity.length, error: run.error?.slice(0, 80) }))

  // The structured event stream must always work, regardless of auth.
  if (!events.some((e) => e.kind === 'system')) fail('no system/init event was parsed from the stream')

  if (run.loginRequired) {
    // Required setup path: detected + clear guidance, no crash.
    if (run.ok) fail('loginRequired but run reported ok')
    if (!run.error || !/log\s?in/i.test(run.error)) fail('login error message is not clear')
    console.error('[test] not logged in → detected with a clear setup message — setup path OK')
    console.error('[test] (file creation cannot be verified without a subscription login on this machine)')
  } else {
    // Logged in: the task must actually have done the work.
    if (!run.ok) fail(`run was not ok: ${run.error}`)
    if (!existsSync(join(projectDir, 'hello.ts'))) fail('hello.ts was not created in the project folder')
    if (!run.activity.some((a) => /write|edit|create|notebook/i.test(a.name)))
      fail('activity log has no file-writing tool call')
    else console.error('[test] hello.ts created and file-write logged in activity — OK')

    // ---- 3) post-task summary saved to memory (single write queue) ----
    const { title, content } = summarizeRun(prompt, run)
    await saveMemory({ projectId: project.id, type: 'task', title, content, source: 'claudecode', tags: ['claudecode'] })
    const saved = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE project_id = ? AND source = 'claudecode'`)
      .get(project.id) as { n: number }
    if (saved.n < 1) fail('no task summary memory was saved')
    else console.error('[test] task summary saved to memory — OK')
  }

  // ---- 4) summarizeRun is robust regardless of outcome ----
  const summary = summarizeRun(prompt, run)
  if (!summary.title || !summary.content.includes('Task:')) fail('summarizeRun produced a malformed summary')

  cleanup()
  if (ok) { console.error('\n✅ PASS: Claude Code launcher (events + run/setup path + summary)'); process.exit(0) }
  else { console.error('\n❌ FAILED'); process.exit(1) }
}

main().catch((err) => { console.error('[test] fatal:', err); process.exit(1) })
