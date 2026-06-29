type MessageLike = { role: string; content: string }

const GENERIC_TITLE_RE = /^(?:new\s+(?:chat|task)|untitled|chat(?:\s+\d+(?:[./-]\d+){0,2})?|task(?:\s+\d+(?:[./-]\d+){0,2})?)$/i
const TITLE_PREFIX_RE = /^(?:title|session|chat|task)\s*:\s*/i

export function isGenericSessionTitle(title: string | null | undefined): boolean {
  const normalized = (title ?? '').trim()
  return normalized.length === 0 || GENERIC_TITLE_RE.test(normalized)
}

export function cleanupGeneratedTitle(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? '')
    .replace(/[`*_#>]/g, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(TITLE_PREFIX_RE, '')
    .replace(/[.!?;:,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned || isGenericSessionTitle(cleaned)) return null

  const words = cleaned.split(' ').filter(Boolean)
  if (words.length === 0) return null
  return words.slice(0, 5).join(' ')
}

export function fallbackTitleFromText(text: string): string | null {
  return cleanupGeneratedTitle(
    text
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

export function firstExchange<T extends MessageLike>(messages: T[]): { user: T; assistant: T } | null {
  const user = messages.find((m) => m.role === 'user' && m.content.trim())
  if (!user) return null
  const assistant = messages.find((m) => m.role === 'assistant' && m.content.trim())
  return assistant ? { user, assistant } : null
}
