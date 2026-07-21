import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { isE2EFakeEnabled } from './e2e'
import type { AgentEffortLevel, AgentModelInfo } from '../shared/ipcTypes'

// Model catalogs for the agent tabs (Claude Code, Kimi, Codex).
//
// Every entry comes from a real, verifiable source — the CLI's own caches /
// config files, or knowledge verified against the installed CLI versions —
// never from docs guesswork. When a source file is missing or unparseable we
// fall back to a static copy of the verified data so the pickers never render
// empty. Descriptions/badges are only set where a real source provides them.
//
// Under the E2E fakes (E2E_FAKE_<AGENT>, same guard the launchers use) each
// provider returns a small deterministic fake list so tests never read the
// developer's real home-dir files.

// ---------------------------------------------------------------------------
// Claude Code (verified against CLI 2.1.207: `--model` accepts full ids,
// `--effort` accepts low|medium|high|xhigh|max, plus the CLI's own
// additionalModelOptionsCache in ~/.claude.json for extra entitled models).
// ---------------------------------------------------------------------------

const CLAUDE_EFFORTS: AgentEffortLevel[] = [
  { value: 'default', label: 'Default', description: "Omit --effort (use the CLI's default)" },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' }
]

function withClaudeEfforts(m: Omit<AgentModelInfo, 'efforts' | 'defaultEffort'>): AgentModelInfo {
  return { ...m, efforts: CLAUDE_EFFORTS, defaultEffort: 'default' }
}

// Main rows shown directly in the Models popover; `extra` entries live under
// the "More models ›" submenu (older generations, still valid --model ids).
function claudeCoreModels(): AgentModelInfo[] {
  return [
    withClaudeEfforts({ id: 'default', label: 'Default', description: "Recommended — uses the CLI's default model" }),
    withClaudeEfforts({ id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Most capable Opus-tier model' }),
    withClaudeEfforts({ id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Everyday coding default' }),
    withClaudeEfforts({ id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest, for lightweight tasks' }),
    withClaudeEfforts({ id: 'claude-opus-4-7', label: 'Opus 4.7', extra: true }),
    withClaudeEfforts({ id: 'claude-opus-4-6', label: 'Opus 4.6', extra: true }),
    withClaudeEfforts({ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', extra: true })
  ]
}

// The CLI records extra entitled models in ~/.claude.json
// (additionalModelOptionsCache) and limited-time inclusion in
// tengu_usage_overage_included_models + tengu_startup_announcements.
interface ClaudeHomeExtras {
  cache: Array<{ value: string; label?: string; description?: string }>
  badge?: string
}

function readClaudeHomeExtras(): ClaudeHomeExtras {
  const out: ClaudeHomeExtras = { cache: [] }
  try {
    const raw = readFileSync(join(homedir(), '.claude.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (Array.isArray(parsed.additionalModelOptionsCache)) {
      for (const entry of parsed.additionalModelOptionsCache) {
        const e = entry as { value?: unknown; label?: unknown; description?: unknown }
        if (typeof e?.value === 'string' && e.value) {
          out.cache.push({
            value: e.value,
            label: typeof e.label === 'string' ? e.label : undefined,
            description: typeof e.description === 'string' ? e.description : undefined
          })
        }
      }
    }
    // Fable inclusion badge: only when the CLI's own usage-overage list names
    // Fable. Text from the startup announcement title ("Extended through July
    // 19" → "Included until July 19"); tolerant fallback when unparseable.
    const included = Array.isArray(parsed.tengu_usage_overage_included_models)
      ? parsed.tengu_usage_overage_included_models.some((m) => typeof m === 'string' && /fable/i.test(m))
      : false
    if (included) {
      out.badge = 'Included for a limited time'
      if (Array.isArray(parsed.tengu_startup_announcements)) {
        for (const a of parsed.tengu_startup_announcements) {
          const ann = a as { id?: unknown; title?: unknown }
          if (typeof ann?.id === 'string' && /fable/i.test(ann.id) && typeof ann?.title === 'string') {
            const m = ann.title.match(/through\s+(.+)$/i)
            if (m?.[1]) {
              out.badge = `Included until ${m[1].trim()}`
              break
            }
          }
        }
      }
    }
  } catch {
    /* no cache available — core list only */
  }
  return out
}

export function listClaudeCodeModels(): AgentModelInfo[] {
  if (isE2EFakeEnabled('E2E_FAKE_CLAUDE_CODE')) {
    return [
      withClaudeEfforts({ id: 'default', label: 'Default', description: "Recommended — uses the CLI's default model" }),
      withClaudeEfforts({ id: 'claude-fake-fable', label: 'Fake Fable', description: 'E2E fake most-capable model', badge: 'Included until July 19' }),
      withClaudeEfforts({ id: 'claude-fake-sonnet', label: 'Fake Sonnet', description: 'E2E fake everyday model' }),
      withClaudeEfforts({ id: 'claude-fake-opus', label: 'Fake Opus', description: 'E2E fake capable model' }),
      withClaudeEfforts({ id: 'claude-fake-legacy', label: 'Fake Legacy', extra: true })
    ]
  }
  const models = claudeCoreModels()
  const extras = readClaudeHomeExtras()
  const seen = new Set(models.map((m) => m.id))
  // Cache extras (e.g. Fable) are the CLI's headline models — insert them
  // right after Default, ahead of the core list.
  const fromCache: AgentModelInfo[] = []
  for (const entry of extras.cache) {
    if (seen.has(entry.value)) continue
    seen.add(entry.value)
    fromCache.push(
      withClaudeEfforts({
        id: entry.value,
        label: entry.label || entry.value,
        description: entry.description,
        badge: /fable/i.test(entry.value) || (entry.label ? /fable/i.test(entry.label) : false) ? extras.badge : undefined
      })
    )
  }
  const [first, ...rest] = models
  return [first, ...fromCache, ...rest]
}

// ---------------------------------------------------------------------------
// Codex (verified against codex-cli 0.144.x: ~/.codex/models_cache.json is the
// CLI's own backend-fetched catalog with per-model supported reasoning levels
// and service tiers).
// ---------------------------------------------------------------------------

interface CodexCacheLevel { effort?: unknown; description?: unknown }
interface CodexCacheModel {
  slug?: unknown
  display_name?: unknown
  description?: unknown
  default_reasoning_level?: unknown
  supported_reasoning_levels?: unknown
  visibility?: unknown
  service_tiers?: unknown
}

function codexStaticFallback(): AgentModelInfo[] {
  // Static copy of the verified models_cache.json contents (fetched_at
  // 2026-07-17). Per-level descriptions are omitted here; they ship verbatim
  // when the real cache file is readable.
  const levels = (...names: string[]): AgentEffortLevel[] => names.map((n) => ({ value: n, label: n }))
  const fast = { badge: 'Fast tier available', fastTier: true, fastTierDescription: '1.5x speed, increased usage' }
  return [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'Latest frontier agentic coding model.', ...fast, efforts: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), defaultEffort: 'low' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: 'Balanced agentic coding model for everyday work.', ...fast, efforts: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), defaultEffort: 'medium' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', description: 'Fast and affordable agentic coding model.', ...fast, efforts: levels('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'medium' },
    { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Frontier model for complex coding, research, and real-world work.', ...fast, efforts: levels('low', 'medium', 'high', 'xhigh'), defaultEffort: 'medium' },
    { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Strong model for everyday coding.', ...fast, efforts: levels('low', 'medium', 'high', 'xhigh'), defaultEffort: 'medium' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', description: 'Small, fast, and cost-efficient model for simpler coding tasks.', efforts: levels('low', 'medium', 'high', 'xhigh'), defaultEffort: 'medium' }
  ]
}

export function listCodexModels(): AgentModelInfo[] {
  if (isE2EFakeEnabled('E2E_FAKE_CODEX')) {
    return [
      { id: 'gpt-fake-pro', label: 'GPT-Fake-Pro', description: 'E2E fake frontier model.', badge: 'Fast tier available', fastTier: true, fastTierDescription: '1.5x speed, increased usage', efforts: [{ value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }], defaultEffort: 'low' },
      { id: 'gpt-fake-mini', label: 'GPT-Fake-Mini', description: 'E2E fake small model.', efforts: [{ value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }], defaultEffort: 'medium' }
    ]
  }
  try {
    const raw = readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8')
    const parsed = JSON.parse(raw) as { models?: unknown }
    const entries = Array.isArray(parsed.models) ? (parsed.models as CodexCacheModel[]) : []
    const models: AgentModelInfo[] = []
    for (const entry of entries) {
      // Hidden catalog entries (e.g. codex-auto-review) are not user-pickable.
      if (entry.visibility !== 'list') continue
      if (typeof entry.slug !== 'string' || !entry.slug) continue
      const efforts = Array.isArray(entry.supported_reasoning_levels)
        ? (entry.supported_reasoning_levels as CodexCacheLevel[])
            .filter((l): l is CodexCacheLevel & { effort: string } => typeof l?.effort === 'string' && l.effort.length > 0)
            .map((l) => ({
              value: l.effort,
              label: l.effort,
              description: typeof l.description === 'string' ? l.description : undefined
            }))
        : []
      // Real service tiers (e.g. {id:'priority', name:'Fast', description:'1.5x
      // speed, increased usage'}) drive both the badge and the Speed submenu.
      const tiers = Array.isArray(entry.service_tiers) ? (entry.service_tiers as Array<{ name?: unknown; description?: unknown }>) : []
      const fastTier = tiers.length > 0
      const fastTierDescription = tiers.map((t) => (typeof t?.description === 'string' ? t.description : '')).find(Boolean)
      models.push({
        id: entry.slug,
        label: typeof entry.display_name === 'string' && entry.display_name ? entry.display_name : entry.slug,
        description: typeof entry.description === 'string' ? entry.description : undefined,
        badge: fastTier ? 'Fast tier available' : undefined,
        fastTier: fastTier || undefined,
        fastTierDescription: fastTier ? fastTierDescription : undefined,
        efforts: efforts.length > 0 ? efforts : undefined,
        defaultEffort: typeof entry.default_reasoning_level === 'string' ? entry.default_reasoning_level : undefined
      })
    }
    if (models.length > 0) return models
  } catch {
    /* cache missing/unparseable — fall through to static copy */
  }
  return codexStaticFallback()
}

// ---------------------------------------------------------------------------
// Kimi (verified against kimi-code 0.27.0: the ACP session/new configOptions
// model list matches ~/.kimi-code/config.toml [models.*] entries — the only
// real catalog source; no descriptions exist beyond the highspeed variant).
// ---------------------------------------------------------------------------

function kimiStaticFallback(): AgentModelInfo[] {
  return [
    { id: 'kimi-code/kimi-for-coding', label: 'K2.7 Coding', description: 'Default coding model', contextSize: 262144 },
    { id: 'kimi-code/kimi-for-coding-highspeed', label: 'K2.7 Coding Highspeed', description: 'Highspeed variant', contextSize: 262144 },
    { id: 'kimi-code/k3', label: 'K3', contextSize: 262144 }
  ]
}

// Tolerant line scanner for [models."<id>"] sections with display_name and
// max_context_size keys — no TOML dependency needed for this narrow shape.
export function parseKimiConfigToml(text: string): AgentModelInfo[] {
  const models: AgentModelInfo[] = []
  let current: AgentModelInfo | null = null
  const flush = () => {
    if (current) models.push(current)
    current = null
  }
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[models\."([^"]+)"\]\s*$/)
    if (section) {
      flush()
      const id = section[1]
      current = { id, label: id }
      // The only real per-model descriptions available anywhere.
      if (id === 'kimi-code/kimi-for-coding') current.description = 'Default coding model'
      else if (id.includes('highspeed')) current.description = 'Highspeed variant'
      continue
    }
    // Any other [section] header ends the current models.* block.
    if (/^\s*\[/.test(line)) {
      flush()
      continue
    }
    if (current) {
      const name = line.match(/^\s*display_name\s*=\s*"([^"]*)"/)
      if (name && name[1]) current.label = name[1]
      const ctx = line.match(/^\s*max_context_size\s*=\s*(\d+)/)
      if (ctx) current.contextSize = Number(ctx[1])
    }
  }
  flush()
  return models
}

export function listKimiModels(): AgentModelInfo[] {
  if (isE2EFakeEnabled('E2E_FAKE_KIMI')) {
    return [
      { id: 'kimi-fake/coding', label: 'Fake K Coding', description: 'Default coding model', contextSize: 262144 },
      { id: 'kimi-fake/coding-highspeed', label: 'Fake K Coding Highspeed', description: 'Highspeed variant', contextSize: 262144 },
      { id: 'kimi-fake/k3', label: 'Fake K3', contextSize: 262144 }
    ]
  }
  try {
    const raw = readFileSync(join(homedir(), '.kimi-code', 'config.toml'), 'utf8')
    const models = parseKimiConfigToml(raw)
    if (models.length > 0) return models
  } catch {
    /* config missing/unparseable — fall through to static copy */
  }
  return kimiStaticFallback()
}
