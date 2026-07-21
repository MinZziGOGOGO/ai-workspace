// Test for the Hermes ACP client (src/main/hermes.ts). No Electron, no WSL.
// Run: npm run test:hermes
//
// This replaces the original M6 test, which still targeted the long-removed
// HTTP client (runTask/hermesHealth/HERMES_PORT) and had stopped building.
//
// Covers the parts that are pure or DB-backed and therefore verifiable without
// a live Hermes:
//   1. toSwitchableModelId — the workaround for Hermes's model-id parser, which
//      splits on the LAST colon and so corrupts its own advertised ids whenever
//      the model name contains one (every Ollama tag).
//   2. Per-session model/effort persistence, including re-attach of the ACP id.
//   3. The embedded ACP patch text matches scripts/hermes-patches/*.patch byte
//      for byte, so the copy shipped to remote hosts can never drift.
//   4. checkHermes() stays honest and non-throwing whatever the environment.
//
// The live protocol behavior these rest on (session/new advertising models,
// set_model, set_config_option, mid-turn /steer) was verified directly against
// hermes-agent 0.16.0; see docs and src/main/hermesPatch.ts for the findings.

import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initDb, getDb } from '../src/main/db'
import { importFolder } from '../src/main/projects'
import {
  checkHermes,
  toSwitchableModelId,
  isHermesEffort,
  getHermesSessionSettings,
  setHermesSessionModel,
  setHermesSessionEffort,
  HERMES_EFFORT_LEVELS
} from '../src/main/hermes'
import { HERMES_PATCH_TEXT } from '../src/main/hermesPatch'

async function main() {
  const userData = mkdtempSync(join(tmpdir(), 'aiws-hermes-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'aiws-hermesp-'))
  await initDb(userData)
  const project = importFolder(projectDir, 'Hermes Test')

  let ok = true
  const fail = (m: string) => { console.error(`❌ FAIL: ${m}`); ok = false }
  const cleanup = () => {
    try { rmSync(userData, { recursive: true, force: true }) } catch {}
    try { rmSync(projectDir, { recursive: true, force: true }) } catch {}
  }

  // ---- 1) model id normalization -------------------------------------------
  // Hermes advertises `custom:gemma4:12b` but parses it back as provider
  // "custom:gemma4" / model "12b" — so colon-bearing names must be sent bare.
  const modelCases: Array<[string, string]> = [
    ['custom:gemma4:12b', 'gemma4:12b'],
    ['custom:gemma4-workspace:12b', 'gemma4-workspace:12b'],
    ['custom:nomic-embed-text:latest', 'nomic-embed-text:latest'],
    // No colon inside the model name: the full id parses correctly and is kept,
    // which is what preserves cross-provider switching.
    ['anthropic:claude-opus-4-8', 'anthropic:claude-opus-4-8'],
    ['openrouter:openai/gpt-5.6-sol', 'openrouter:openai/gpt-5.6-sol'],
    // Already bare — a single colon is indistinguishable from a provider
    // prefix, and passing it through unchanged is correct either way.
    ['gemma4:12b', 'gemma4:12b'],
    ['claude-opus-4-8', 'claude-opus-4-8']
  ]
  for (const [input, expected] of modelCases) {
    const actual = toSwitchableModelId(input)
    if (actual !== expected) fail(`toSwitchableModelId(${input}) = ${actual}, expected ${expected}`)
  }
  console.error('[test] model id normalization — OK')

  // ---- 2) effort level validation ------------------------------------------
  for (const level of HERMES_EFFORT_LEVELS) {
    if (!isHermesEffort(level)) fail(`isHermesEffort rejected its own level ${level}`)
  }
  for (const bogus of ['ultra', 'MEDIUM', '', 'off']) {
    if (isHermesEffort(bogus)) fail(`isHermesEffort accepted ${JSON.stringify(bogus)}`)
  }
  console.error('[test] effort levels — OK')

  // ---- 3) per-session settings persistence ---------------------------------
  const db = getDb()
  const sessionId = 'hermes-test-session'
  db.prepare(
    'INSERT INTO sessions (id, project_id, mode, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sessionId, project.id, 'hermes', 'Test', Date.now(), Date.now())

  const empty = getHermesSessionSettings(sessionId)
  if (empty.model || empty.effort || empty.acpSessionId) fail('fresh session reported stale Hermes settings')

  setHermesSessionModel(sessionId, 'gemma4-hermes:latest')
  setHermesSessionEffort(sessionId, 'high')
  const saved = getHermesSessionSettings(sessionId)
  if (saved.model !== 'gemma4-hermes:latest') fail(`model not persisted (got ${saved.model})`)
  if (saved.effort !== 'high') fail(`effort not persisted (got ${saved.effort})`)

  // 'default' is our passthrough — it must clear the column, not store a value,
  // so the next session/new is left on whatever Hermes is configured for.
  setHermesSessionEffort(sessionId, 'default')
  if (getHermesSessionSettings(sessionId).effort !== undefined) fail("effort 'default' was persisted instead of cleared")

  // A value that is no longer a valid level must not be handed back to callers.
  db.prepare('UPDATE sessions SET hermes_effort = ? WHERE id = ?').run('bogus', sessionId)
  if (getHermesSessionSettings(sessionId).effort !== undefined) fail('invalid stored effort was returned')

  // Unknown session ids must be answered, not thrown on.
  const missing = getHermesSessionSettings('does-not-exist')
  if (missing.model || missing.effort) fail('unknown session returned settings')
  console.error('[test] per-session model/effort persistence — OK')

  // ---- 4) ACP patch text integrity -----------------------------------------
  const patchFile = readFileSync('scripts/hermes-patches/0001-acp-reasoning-effort.patch', 'utf8').replace(/\r\n/g, '\n')
  if (patchFile !== HERMES_PATCH_TEXT) {
    fail(`embedded patch text differs from the .patch file (${HERMES_PATCH_TEXT.length} vs ${patchFile.length} chars)`)
  } else {
    console.error('[test] embedded patch matches .patch file — OK')
  }
  if (!HERMES_PATCH_TEXT.includes('reasoning_effort')) fail('patch text does not mention reasoning_effort')

  // ---- 5) checkHermes stays honest -----------------------------------------
  const check = await checkHermes()
  console.error('[test] checkHermes():', JSON.stringify(check))
  for (const k of ['wsl2', 'installed', 'connected'] as const) {
    if (typeof check[k] !== 'boolean') fail(`check.${k} is not a boolean`)
  }

  cleanup()
  if (ok) { console.error('\n✅ PASS: Hermes ACP client (model ids, effort, session settings, patch integrity)'); process.exit(0) }
  console.error('\n❌ FAILED')
  process.exit(1)
}

main().catch((err) => { console.error('[test] fatal:', err); process.exit(1) })
