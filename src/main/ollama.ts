// Thin client for a local Ollama server. This is the "model abstraction" seam:
// when the big laptop arrives, Nemotron drops in here as just another model tag.
// Nothing in the app may assume a specific model.

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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  images?: string[]
}

export async function listModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`)
    const data = (await res.json()) as { models: { name: string }[] }
    return data.models.map((m) => m.name)
  } catch {
    return [] // Ollama not running — UI shows guidance instead of crashing.
  }
}

export async function* streamChat(
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal
): AsyncGenerator<string> {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model, messages, stream: true }),
    signal
  })
  if (!res.ok || !res.body) throw new Error(`Ollama error: ${res.status}`)
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
      if (!line.trim()) continue
      try {
        const chunk = JSON.parse(line)
        if (chunk.message?.content) yield chunk.message.content as string
      } catch {
        continue // skip malformed NDJSON lines instead of killing the stream
      }
    }
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

export async function* streamCloudChat(
  model: string,
  messages: ChatMessage[],
  apiKey: string,
  signal?: AbortSignal
): AsyncGenerator<string> {
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
          const content = chunk.choices?.[0]?.delta?.content
          if (typeof content === 'string' && content) yield content
        } catch { /* bad JSON */ }
      }
    }
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
