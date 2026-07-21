// "Is local inference on this machine fast enough to chat with?"
//
// The point of this module is to answer that from *evidence Ollama already
// reports*, not from a blanket "local = slow" assumption. Two signals, in order
// of preference — both come out of Ollama's existing HTTP API, so this adds no
// dependency and no new detection machinery:
//
//  1. GPU residency (`GET /api/ps`). For every model currently resident Ollama
//     reports `size` (total weights) and `size_vram` (bytes actually on the
//     GPU). `size_vram === 0` means the model is running wholly on the CPU —
//     that is the exact condition behind the multi-minute replies on this
//     machine. `size_vram >= ~90% of size` means it is GPU-resident and fast.
//     This is free and definitive, but only works while a model is loaded.
//
//  2. A timed generation (`POST /api/generate`, 8 tokens). Ollama's non-stream
//     response carries `eval_count` and `eval_duration` (nanoseconds spent
//     generating), so we get a true tokens/sec that *excludes* model load time
//     rather than a wall-clock guess. Used only when signal 1 is unavailable or
//     ambiguous (a partial GPU offload).
//
// Deliberately NOT used: system GPU enumeration (needs a native dep or shelling
// out to vendor tools) and raw wall-clock latency (conflates cold model load
// with generation speed, and would flag a fast GPU box on its first prompt).

import { isE2EFakeEnabled } from './e2e'
import { ollamaHost } from './ollama'

/** Below this measured rate, a reply to a normal chat prompt takes minutes. */
const SLOW_TOKENS_PER_SECOND = 10

/** A model 90%+ resident in VRAM is GPU-bound; the remainder is rounding/KV cache. */
const VRAM_RESIDENT_RATIO = 0.9

/** Ceiling for the generation probe. Failing to make 8 tokens in 45s IS the answer. */
const PROBE_TIMEOUT_MS = 45_000

/** Re-probing on every wizard step / chat mount would be wasteful; hardware doesn't move. */
const PROBE_CACHE_MS = 10 * 60_000

export type LocalSpeedVerdict = 'fast' | 'slow' | 'unknown'

export interface LocalSpeedProbe {
  verdict: LocalSpeedVerdict
  /** Measured generation rate, when signal === 'generate'. Null otherwise. */
  tokensPerSecond: number | null
  /** Which evidence produced the verdict — surfaced in the UI so it isn't a black box. */
  signal: 'vram' | 'generate' | 'unavailable'
  /** Human-readable justification, shown as the nudge's supporting line. */
  detail: string
  probedAt: number
}

interface PsModel {
  name: string
  size?: number
  size_vram?: number
}

interface TagModel {
  name: string
  size?: number
}

let cached: LocalSpeedProbe | null = null
let inFlight: Promise<LocalSpeedProbe> | null = null

function unknown(detail: string): LocalSpeedProbe {
  return { verdict: 'unknown', tokensPerSecond: null, signal: 'unavailable', detail, probedAt: Date.now() }
}

async function getJson<T>(path: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(`${ollamaHost()}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Signal 1: is anything resident, and is it on the GPU? */
async function vramSignal(): Promise<LocalSpeedProbe | null> {
  const data = await getJson<{ models?: PsModel[] }>('/api/ps', 2500)
  const loaded = (data?.models ?? []).filter((m) => typeof m.size === 'number' && m.size > 0)
  if (loaded.length === 0) return null

  // Judge the largest resident model: it dominates the response time.
  const model = loaded.reduce((a, b) => ((b.size ?? 0) > (a.size ?? 0) ? b : a))
  const size = model.size ?? 0
  const vram = model.size_vram ?? 0

  if (vram === 0) {
    return {
      verdict: 'slow',
      tokensPerSecond: null,
      signal: 'vram',
      detail: `Ollama reports ${model.name} running entirely on the CPU (0 bytes in VRAM).`,
      probedAt: Date.now()
    }
  }
  if (vram >= size * VRAM_RESIDENT_RATIO) {
    return {
      verdict: 'fast',
      tokensPerSecond: null,
      signal: 'vram',
      detail: `Ollama reports ${model.name} fully loaded into VRAM.`,
      probedAt: Date.now()
    }
  }
  // Partial offload — genuinely ambiguous, so measure instead of guessing.
  return null
}

/** Pick the cheapest model to probe with: smallest installed non-embedding model. */
async function smallestChatModel(): Promise<string | null> {
  const data = await getJson<{ models?: TagModel[] }>('/api/tags', 2500)
  const candidates = (data?.models ?? []).filter((m) => m.name && !m.name.includes('embed'))
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => ((b.size ?? Infinity) < (a.size ?? Infinity) ? b : a)).name
}

/** Signal 2: generate 8 tokens and read Ollama's own eval timings. */
async function generateSignal(): Promise<LocalSpeedProbe> {
  const model = await smallestChatModel()
  if (!model) return unknown('Ollama has no local chat models installed yet.')

  try {
    const res = await fetch(`${ollamaHost()}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model, prompt: 'ping', stream: false, options: { num_predict: 8 } }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    if (!res.ok) return unknown(`Ollama returned HTTP ${res.status} for the speed probe.`)
    const data = (await res.json()) as { eval_count?: number; eval_duration?: number }
    const count = data.eval_count ?? 0
    const durationNs = data.eval_duration ?? 0
    if (count <= 0 || durationNs <= 0) return unknown('Ollama did not report generation timings.')

    const rate = count / (durationNs / 1e9)
    const rounded = Math.round(rate * 10) / 10
    return {
      verdict: rate < SLOW_TOKENS_PER_SECOND ? 'slow' : 'fast',
      tokensPerSecond: rounded,
      signal: 'generate',
      detail: `Measured ${rounded} tokens/sec generating with ${model}.`,
      probedAt: Date.now()
    }
  } catch (err) {
    // A timeout here is not a failure to measure — it IS the measurement: the
    // machine could not produce 8 tokens in 45 seconds.
    const timedOut = (err as { name?: string })?.name === 'TimeoutError'
    if (timedOut) {
      return {
        verdict: 'slow',
        tokensPerSecond: null,
        signal: 'generate',
        detail: `${model} could not produce 8 tokens within ${PROBE_TIMEOUT_MS / 1000}s.`,
        probedAt: Date.now()
      }
    }
    return unknown('Could not reach the Ollama server to measure speed.')
  }
}

/**
 * Verdict on local inference speed. Cached for PROBE_CACHE_MS and de-duplicated
 * while in flight, so the wizard and Chat can both ask freely. Never throws —
 * an unreachable Ollama yields 'unknown', which callers must treat as "say
 * nothing" rather than "slow".
 */
export async function probeLocalSpeed(force = false): Promise<LocalSpeedProbe> {
  if (isE2EFakeEnabled('E2E_FAKE_OLLAMA')) {
    // Let the suite drive both branches: default fast (so nudges stay silent in
    // unrelated specs), slow only when a spec asks for it.
    return process.env.E2E_FAKE_SLOW_LOCAL === '1'
      ? { verdict: 'slow', tokensPerSecond: 1.2, signal: 'generate', detail: 'Measured 1.2 tokens/sec generating with e2e-chat-model.', probedAt: Date.now() }
      : { verdict: 'fast', tokensPerSecond: 80, signal: 'generate', detail: 'Measured 80 tokens/sec generating with e2e-chat-model.', probedAt: Date.now() }
  }

  if (!force && cached && Date.now() - cached.probedAt < PROBE_CACHE_MS) return cached
  if (inFlight) return inFlight

  inFlight = (async () => {
    const fromVram = await vramSignal()
    const result = fromVram ?? (await generateSignal())
    // Don't cache 'unknown': Ollama may simply not be up yet, and the next ask
    // (after the user starts it) should get a real answer.
    if (result.verdict !== 'unknown') cached = result
    return result
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}
