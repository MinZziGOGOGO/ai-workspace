// Counts completed user→assistant exchanges in a message list. Used to decide
// when to regenerate a session's auto-summary (every 4 exchanges).
export function exchangeCount(messages: { role: string }[]): number {
  let count = 0
  let sawUser = false
  for (const m of messages) {
    if (m.role === 'user') sawUser = true
    else if (m.role === 'assistant' && sawUser) {
      count++
      sawUser = false
    }
  }
  return count
}
