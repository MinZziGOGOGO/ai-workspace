import { randomUUID } from 'crypto'
import { getDb } from './db'

// Lightweight daily usage counters — message/task counts and a rough token
// estimate per agent, no dollar amounts (pricing changes too often to
// hardcode reliably). Never throws: a usage-tracking failure must not affect
// the send/receive flow of any agent tab.

export interface UsageSummaryRow {
  agent: string
  date: string
  message_count: number
  estimated_tokens: number
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD, local process TZ via ISO UTC date
}

export function recordUsage(agent: string, estimatedTokens: number): void {
  try {
    const db = getDb()
    const date = todayKey()
    const tokens = Math.max(0, Math.round(estimatedTokens))
    const existing = db
      .prepare(`SELECT id, message_count, estimated_tokens FROM usage_log WHERE agent = ? AND date = ?`)
      .get(agent, date) as { id: string; message_count: number; estimated_tokens: number } | undefined
    if (existing) {
      db.prepare(`UPDATE usage_log SET message_count = ?, estimated_tokens = ? WHERE id = ?`)
        .run(existing.message_count + 1, existing.estimated_tokens + tokens, existing.id)
    } else {
      db.prepare(
        `INSERT INTO usage_log (id, agent, date, message_count, estimated_tokens) VALUES (?, ?, ?, 1, ?)`
      ).run(randomUUID(), agent, date, tokens)
    }
  } catch (err) {
    console.error('[usage] record failed:', err)
  }
}

export function getTodayUsage(): UsageSummaryRow[] {
  try {
    return getDb()
      .prepare(`SELECT agent, date, message_count, estimated_tokens FROM usage_log WHERE date = ?`)
      .all(todayKey()) as UsageSummaryRow[]
  } catch (err) {
    console.error('[usage] getTodayUsage failed:', err)
    return []
  }
}
