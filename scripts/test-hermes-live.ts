// Live integration test for the Hermes ACP client. Requires a working Hermes
// (local WSL2 or the configured remote); skips cleanly when there isn't one.
// Run: npm run test:hermes-live
//
// This is the only automated proof of the parts that cannot be faked:
//   1. ensureHermesSession creates ONE ACP session and re-attaches to it on the
//      next turn via session/load, instead of the old session/new-per-prompt.
//   2. Hermes therefore remembers earlier turns (server-side history).
//   3. A model switch round-trips and the switched model actually serves.
//   4. /context runs while idle and its reply is captured by the command sink
//      rather than leaking into the transcript.
//
// Turns are deliberately tiny — the default local provider is Ollama on CPU.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initDb, getDb } from '../src/main/db'
import { importFolder } from '../src/main/projects'
import {
  checkHermes,
  connectHermes,
  disconnectHermes,
  ensureHermesSession,
  runHermesPrompt,
  runHermesCommand,
  applyHermesModel,
  getHermesSessionSettings,
  type HermesEvent,
  type HermesModelInfo
} from '../src/main/hermes'

async function main() {
  const userData = mkdtempSync(join(tmpdir(), 'aiws-hermes-live-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'aiws-hermes-livep-'))
  await initDb(userData)
  const project = importFolder(projectDir, 'Hermes Live Test')

  let ok = true
  const fail = (m: string) => { console.error(`❌ FAIL: ${m}`); ok = false }
  const cleanup = () => {
    disconnectHermes()
    try { rmSync(userData, { recursive: true, force: true }) } catch {}
    try { rmSync(projectDir, { recursive: true, force: true }) } catch {}
  }

  const check = await checkHermes()
  if (!check.installed) {
    console.error('[test] Hermes not installed here:', check.error)
    cleanup()
    console.error('\n⚠️  SKIP: no Hermes available (build is fine)')
    process.exit(0)
  }

  const conn = await connectHermes(check.distro ?? 'Ubuntu')
  if (!conn.connected) {
    console.error('[test] could not connect:', conn.error)
    cleanup()
    console.error('\n⚠️  SKIP: Hermes present but not connectable')
    process.exit(0)
  }
  console.error('[test] connected to Hermes', conn.version)

  const sessionId = 'hermes-live-session'
  getDb().prepare(
    'INSERT INTO sessions (id, project_id, mode, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sessionId, project.id, 'hermes', 'Live', Date.now(), Date.now())

  // ---- 1) first attach: creates an ACP session and advertises models --------
  let models: HermesModelInfo[] = []
  const acp1 = await ensureHermesSession(sessionId, projectDir, [], (e) => {
    if (e.kind === 'models') models = e.models
  })
  console.error('[test] acp session:', acp1)
  console.error('[test] models advertised:', models.map((m) => m.id).join(', ') || '(none)')
  if (!acp1) fail('ensureHermesSession returned no session id')
  if (models.length === 0) fail('session/new advertised no models (readModelState is reading the wrong shape?)')
  if (getHermesSessionSettings(sessionId).acpSessionId !== acp1) fail('ACP session id was not persisted')

  // ---- 2) second attach: must REUSE the same session, not create another ----
  const acp2 = await ensureHermesSession(sessionId, projectDir, [])
  if (acp2 !== acp1) fail(`session was not reused (${acp1} → ${acp2}) — session/load re-attach failed`)
  else console.error('[test] session reuse via session/load — OK')

  // ---- 3) /context while idle: the command sink must capture the reply ------
  const ctx = await runHermesCommand(sessionId, '/context')
  console.error('[test] /context:', (ctx.text ?? ctx.error ?? '').replace(/\n/g, ' | ').slice(0, 160))
  if (!ctx.ok) fail(`/context failed: ${ctx.error}`)
  else if (!ctx.text) fail('/context returned no text — the command sink captured nothing')

  // ---- 4) model switch round-trip ------------------------------------------
  // Hermes legitimately refuses some models it advertises — an embedding model
  // such as nomic-embed-text has a 2K context and is rejected against Hermes's
  // 64K minimum. That refusal is correct behavior, not a client bug, so try
  // candidates until one is accepted and only fail if none are.
  let other: HermesModelInfo | undefined
  let lastRefusal = ''
  for (const candidate of models.filter((m) => m.id !== models[0]?.id)) {
    const attempt = await applyHermesModel(sessionId, candidate.id)
    if (attempt.ok) { other = candidate; break }
    lastRefusal = attempt.error ?? ''
    console.error(`[test] ${candidate.id} refused by Hermes: ${lastRefusal.slice(0, 100)}`)
    // A refused model must not stick, or every later turn retries it.
    if (getHermesSessionSettings(sessionId).model === candidate.id) {
      fail(`refused model ${candidate.id} was persisted anyway`)
    }
  }
  if (models.length > 1 && !other) fail(`no advertised model could be switched to (last: ${lastRefusal})`)
  if (other) {
    {
      const readback = await runHermesCommand(sessionId, '/model')
      const text = readback.text ?? ''
      console.error('[test] after switch, /model says:', text.replace(/\n/g, ' | ').slice(0, 120))
      // Hermes reports the bare name; a corrupted parse shows a truncated tail
      // like "12b" (the bug toSwitchableModelId works around).
      const bare = other.switchId
      if (!text.includes(bare)) fail(`model readback does not mention ${bare} — id normalization is wrong`)
      else console.error('[test] model switch round-trip — OK')
      // Put it back so the memory turns below run on the original model.
      await applyHermesModel(sessionId, models[0].id)
    }
  } else {
    console.error('[test] only one model available — switch test skipped')
  }

  // ---- 5) cross-turn memory (the whole point of session reuse) --------------
  // Two real model turns; on a CPU-bound local Ollama that is minutes, so
  // HERMES_LIVE_QUICK=1 skips them when iterating on the protocol wiring.
  if (process.env.HERMES_LIVE_QUICK === '1') {
    cleanup()
    if (ok) { console.error('\n✅ PASS (quick): session reuse, commands, model switch'); process.exit(0) }
    console.error('\n❌ FAILED (quick)')
    process.exit(1)
  }
  const events: HermesEvent[] = []
  const t1 = await runHermesPrompt({
    sessionId, projectPath: projectDir,
    prompt: 'Remember this word and reply with just: ok. The word is: albatross.',
    onEvent: (e) => events.push(e)
  })
  console.error('[test] turn 1:', t1.ok ? t1.text.slice(0, 80) : `ERROR ${t1.error}`)
  if (!t1.ok) fail(`first turn failed: ${t1.error}`)

  const t2 = await runHermesPrompt({
    sessionId, projectPath: projectDir,
    prompt: 'What word did I ask you to remember? Reply with only that word.',
    onEvent: (e) => events.push(e)
  })
  console.error('[test] turn 2:', t2.ok ? t2.text.slice(0, 80) : `ERROR ${t2.error}`)
  if (!t2.ok) fail(`second turn failed: ${t2.error}`)
  else if (!/albatross/i.test(t2.text)) {
    fail('Hermes did not recall the first turn — session history is not persisting across turns')
  } else {
    console.error('[test] cross-turn memory — OK')
  }

  // Command output must never have leaked into the turn transcript.
  const transcript = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('')
  if (/Context usage:|Steer queued/i.test(transcript)) {
    fail('slash-command output leaked into the conversation transcript')
  }

  cleanup()
  if (ok) { console.error('\n✅ PASS: live Hermes ACP (session reuse, memory, model switch, commands)'); process.exit(0) }
  console.error('\n❌ FAILED')
  process.exit(1)
}

main().catch((err) => { console.error('[test] fatal:', err); process.exit(1) })
