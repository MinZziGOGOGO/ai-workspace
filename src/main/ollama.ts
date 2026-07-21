// Thin client for a local Ollama server. This is the "model abstraction" seam:
// when the big laptop arrives, Nemotron drops in here as just another model tag.
// Nothing in the app may assume a specific model.

import { isE2EFakeEnabled } from './e2e'

// OLLAMA_HOST is conventionally a *server* bind value (e.g. "0.0.0.0:11434")
// and often has no URL scheme. Normalize it into a client-connectable URL:
// add http:// when missing, and rewrite the bind-all 0.0.0.0 to a loopback
// address (0.0.0.0 is not a valid connect target on Windows).
function resolveOllamaHost(): string {
  let host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
  if (!/^https?:\/\//i.test(host)) host = `http://${host}`
  return host.replace('0.0.0.0', '127.0.0.1').replace(/\/+$/, '')
}

const OLLAMA = resolveOllamaHost()
export const EMBED_MODEL = 'nomic-embed-text'

/** The resolved local Ollama base URL, for sibling modules that probe it directly. */
export function ollamaHost(): string {
  return OLLAMA
}

function isFakeOllama(): boolean {
  return isE2EFakeEnabled('E2E_FAKE_OLLAMA')
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  images?: string[]
}

export type ChatStreamPart = { kind: 'answer' | 'thinking'; text: string }

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringField(value)
    if (text) return text
  }
  return null
}

export async function listModels(): Promise<string[]> {
  if (isFakeOllama()) return ['e2e-chat-model']
  try {
    const res = await fetch(`${OLLAMA}/api/tags`)
    const data = (await res.json()) as { models: { name: string }[] }
    return data.models.map((m) => m.name)
  } catch {
    return [] // Ollama not running — UI shows guidance instead of crashing.
  }
}

// Longest a single streamed local turn may run before we give up. Local CPU
// inference on this machine is minutes-per-reply, so the old "no timeout at all"
// left a wedged model to hang until undici's socket died with an opaque error
// (the 9-minute dead-end this pass exists to fix). 8 minutes is a real ceiling —
// generous enough that a genuinely-slow-but-working reply completes, bounded
// enough that a stuck one fails with a friendly, retryable message. Cloud turns
// keep the tighter implicit fetch timeout; they have no excuse to be this slow.
const LOCAL_STREAM_TIMEOUT_MS = 8 * 60_000

// AbortSignal.timeout fires on total elapsed time, which would kill a slow but
// healthy stream mid-flow. We want an *idle* timeout instead: reset the clock
// every time a chunk arrives, so only a true stall (no bytes for the window)
// aborts. Returns a signal linked to the caller's Stop signal plus a poke().
function idleTimeoutSignal(base: AbortSignal | undefined, windowMs: number): { signal: AbortSignal; poke: () => void; done: () => void } {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new DOMException('Idle timeout', 'TimeoutError')), windowMs)
  }
  const onBaseAbort = () => controller.abort(base?.reason)
  if (base) {
    if (base.aborted) controller.abort(base.reason)
    else base.addEventListener('abort', onBaseAbort, { once: true })
  }
  arm()
  return {
    signal: controller.signal,
    poke: arm,
    done: () => { if (timer) clearTimeout(timer); base?.removeEventListener('abort', onBaseAbort) }
  }
}

export async function* streamChatParts(
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): AsyncGenerator<ChatStreamPart> {
  if (isFakeOllama()) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const text = `Fake Chat response: ${lastUser?.content ?? 'empty prompt'}`
    for (const token of text.match(/.{1,24}/g) ?? [text]) {
      if (signal?.aborted) return
      yield { kind: 'answer', text: token }
    }
    return
  }
  const idle = idleTimeoutSignal(signal, LOCAL_STREAM_TIMEOUT_MS)
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model, messages, stream: true }),
    signal: idle.signal
  }).catch((err) => { idle.done(); throw err })
  if (!res.ok || !res.body) { idle.done(); throw new Error(`Ollama error: ${res.status}`) }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      idle.poke() // bytes arrived — reset the idle clock, not the total budget
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const chunk = JSON.parse(line)
          const thinking = pickString(
            chunk.message?.thinking,
            chunk.message?.reasoning_content,
            chunk.message?.reasoning,
            chunk.message?.thought
          )
          if (thinking) yield { kind: 'thinking', text: thinking }
          const content = stringField(chunk.message?.content)
          if (content) yield { kind: 'answer', text: content }
        } catch {
          continue // skip malformed NDJSON lines instead of killing the stream
        }
      }
    }
  } finally {
    idle.done()
  }
}

export async function* streamChat(
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): AsyncGenerator<string> {
  for await (const part of streamChatParts(model, messages, signal)) {
    if (part.kind === 'answer') yield part.text
  }
}

/**
 * Pick a chat model to use when no specific one is supplied (e.g. the background
 * indexer, which has no user-selected model). Honours OLLAMA_CHAT_MODEL, else the
 * first installed non-embedding model. Returns null if Ollama has none — callers
 * must degrade gracefully (the app never assumes a specific model exists).
 */
export async function defaultChatModel(): Promise<string | null> {
  const pinned = process.env.OLLAMA_CHAT_MODEL
  if (pinned) return pinned
  const models = await listModels()
  return models.find((m) => !m.includes('embed')) ?? null
}

/**
 * Non-streaming chat completion. Returns the full assistant text, or null if the
 * model/host is unavailable (offline-tolerant, mirrors embed()). Used by the
 * indexer to summarize files; nothing here assumes a particular model.
 */
export async function chat(model: string, messages: ChatMessage[], timeoutMs?: number): Promise<string | null> {
  if (isFakeOllama()) {
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    if (/Reply with ONLY a JSON object/i.test(last) && /handoff/i.test(last)) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      const message = last.match(/Message:\s*"([\s\S]*?)"/)?.[1] ?? ''
      const agent = /hermes/i.test(message) ? 'hermes' : /claude\s*code|claude/i.test(message) ? 'claudecode' : /codex/i.test(message) ? 'codex' : null
      return JSON.stringify({ handoff: Boolean(agent), agent, newSession: /\b(new|fresh|start a new)\b/i.test(message) })
    }
    if (/write a\s+clear, complete, well-structured prompt/i.test(last)) {
      const task = last.match(/User:\s*([^\n]+)\s*$/)?.[1] ?? 'Complete the requested task.'
      return `# E2E handoff prompt\n\n${task}\n\nVerify the result before finishing.`
    }
    if (/concise 3 to 5 word title|one short phrase/i.test(last)) return 'E2E session summary'
    return `Fake Chat completion: ${last.slice(0, 120)}`
  }
  try {
    // Optional bound so a wedged model can't hang a caller's UI forever. Omitted
    // by default (the indexer is happy to wait); the extractor passes a budget.
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ model, messages, stream: false }),
      signal
    })
    if (!res.ok) return null
    const data = (await res.json()) as { message?: { content?: string } }
    return data.message?.content ?? null
  } catch {
    return null
  }
}

/**
 * Connection status for the settings panel: is the server reachable, and which
 * chat model would be used by default (same rule as defaultChatModel)?
 */
export async function ollamaStatus(): Promise<{ connected: boolean; defaultModel: string | null }> {
  if (isFakeOllama()) return { connected: true, defaultModel: 'e2e-chat-model' }
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return { connected: false, defaultModel: null }
    const data = (await res.json()) as { models: { name: string }[] }
    const names = data.models.map((m) => m.name)
    const defaultModel =
      process.env.OLLAMA_CHAT_MODEL ?? names.find((m) => !m.includes('embed')) ?? null
    return { connected: true, defaultModel }
  } catch {
    return { connected: false, defaultModel: null }
  }
}

const OLLAMA_CLOUD = 'https://ollama.com/v1'

export async function* streamCloudChatParts(
  model: string,
  messages: ChatMessage[],
  apiKey: string,
  signal?: AbortSignal
): AsyncGenerator<ChatStreamPart> {
  const res = await fetch(`${OLLAMA_CLOUD}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: true }),
    signal
  })
  if (!res.ok || !res.body) throw new Error(`Ollama Cloud error: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]') continue
      if (trimmed.startsWith('data: ')) {
        try {
          const chunk = JSON.parse(trimmed.slice(6))
          const delta = chunk.choices?.[0]?.delta
          const thinking = pickString(delta?.thinking, delta?.reasoning_content, delta?.reasoning, delta?.thought)
          if (thinking) yield { kind: 'thinking', text: thinking }
          const content = stringField(delta?.content)
          if (content) yield { kind: 'answer', text: content }
        } catch { /* bad JSON */ }
      }
    }
  }
}

export async function* streamCloudChat(
  model: string,
  messages: ChatMessage[],
  apiKey: string,
  signal?: AbortSignal
): AsyncGenerator<string> {
  for await (const part of streamCloudChatParts(model, messages, apiKey, signal)) {
    if (part.kind === 'answer') yield part.text
  }
}

export async function cloudChat(
  model: string,
  messages: ChatMessage[],
  apiKey: string,
  timeoutMs?: number
): Promise<string | null> {
  try {
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    const res = await fetch(`${OLLAMA_CLOUD}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: false }),
      signal
    })
    if (!res.ok) return null
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? null
  } catch {
    return null
  }
}

/** Analyze an image using a multimodal Ollama model. Returns a text description, or null on failure. */
export async function analyzeImage(model: string, base64: string, _mimeType: string, prompt: string): Promise<string | null> {
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt, images: [base64] }],
        stream: false
      })
    })
    if (!res.ok) return null
    const data = (await res.json()) as { message?: { content?: string } }
    return data.message?.content ?? null
  } catch {
    return null
  }
}

/** Returns a float32 embedding, or null if the embedder is unavailable (offline-tolerant). */
export async function embed(text: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(`${OLLAMA}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ model: EMBED_MODEL, input: text })
    })
    if (!res.ok) return null
    const data = (await res.json()) as { embeddings: number[][] }
    return Float32Array.from(data.embeddings[0])
  } catch {
    return null
  }
}
