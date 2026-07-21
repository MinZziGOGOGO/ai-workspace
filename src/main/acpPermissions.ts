// Shared ACP (Agent Client Protocol) permission-classification helpers.
//
// Hermes (src/main/hermes.ts) implements this same logic privately — the
// catastrophic/destructive regex lists, the approval matrix, and the
// best-effort ACP `session/request_permission` params parsing. Hermes's copy
// is left untouched here (kept stable, no behavioral risk to an existing
// milestone) rather than refactored in place; this module is the single
// source of truth for the *new* Kimi ACP integration (src/main/kimi.ts) and
// for any future ACP-based agent, so we don't grow a third copy. If Hermes
// is ever touched again, switching it to import from here is the natural
// follow-up cleanup.

export type AcpActionKind = 'read' | 'create' | 'edit' | 'execute' | 'destructive' | 'catastrophic'
export type AcpPermissionMode = 1 | 2 | 3 | 4 | 5

// Kinds listed for a mode are the ones that still require approval at that
// mode. Anything not listed is auto-approved. Mode 1 asks before everything;
// mode 5 asks only for genuinely dangerous ops.
export const APPROVAL_MATRIX: Record<AcpPermissionMode, ReadonlySet<AcpActionKind>> = {
  1: new Set(['read', 'create', 'edit', 'execute', 'destructive', 'catastrophic']),
  2: new Set(['edit', 'execute', 'destructive', 'catastrophic']),
  3: new Set(['execute', 'destructive', 'catastrophic']),
  4: new Set(['destructive', 'catastrophic']),
  5: new Set(['catastrophic']),
}

export function requiresApproval(mode: AcpPermissionMode, kind: AcpActionKind): boolean {
  return APPROVAL_MATRIX[mode].has(kind)
}

// Smallest mode that would auto-approve this kind of action (catastrophic
// never auto-approves at any mode — falls through to 5, which still asks).
export function modeThatAutoApproves(kind: AcpActionKind): AcpPermissionMode {
  for (const m of [1, 2, 3, 4, 5] as AcpPermissionMode[]) {
    if (!requiresApproval(m, kind)) return m
  }
  return 5
}

export const CATASTROPHIC_PATTERNS: RegExp[] = [
  /\bforce\b[\s\S]{0,20}\bpush\b/i,
  /\bpush\b[\s\S]{0,12}--force/i,
  /\bpush\b[\s\S]{0,6}(^|\s)-f(\s|$)/i,
  /rm\s+-rf\s+(\/|~|\*|\$HOME)/i,
  /del\s+\/s\s+\/q/i,
  /format\s+[a-z]:/i,
  /drop\s+(table|database)/i,
  /truncate\s+table/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-z]*d[a-z]*f/i
]

export const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/i, /\bdel\b/i, /\bremove-item\b/i, /\bunlink\b/i,
  /\bdrop\b/i, /\bkill\b/i, /\bshutdown\b/i, /\breboot\b/i,
  /\bchmod\b/i, /\bchown\b/i
]

export function matchesAny(patterns: RegExp[], text: string): boolean {
  return text.length > 0 && patterns.some((re) => re.test(text))
}

function extractActionText(params: any): string {
  const toolCall = params?.toolCall ?? {}
  const rawInput = toolCall.rawInput ?? params?.rawInput ?? {}
  const parts = [
    toolCall.title, toolCall.description, params?.title, params?.description,
    rawInput.command, Array.isArray(rawInput.args) ? rawInput.args.join(' ') : rawInput.args
  ]
  return parts.filter((p) => typeof p === 'string' && p).join(' ')
}

function extractActionPath(params: any): string | undefined {
  const toolCall = params?.toolCall ?? {}
  const rawInput = toolCall.rawInput ?? params?.rawInput ?? {}
  const loc = Array.isArray(toolCall.locations) ? toolCall.locations[0] : undefined
  return loc?.path ?? rawInput.path ?? rawInput.file_path ?? params?.path
}

// `pathExists` is injected so this module has no filesystem dependency of its
// own (keeps it trivially testable / reusable).
export function classifyAcpAction(params: any, pathExists: (p: string) => boolean): AcpActionKind {
  const text = extractActionText(params)
  if (matchesAny(CATASTROPHIC_PATTERNS, text)) return 'catastrophic'

  const rawKind = String(params?.toolCall?.kind ?? params?.kind ?? '').toLowerCase()

  if (rawKind === 'delete' || rawKind === 'move') return 'destructive'
  if (matchesAny(DESTRUCTIVE_PATTERNS, text)) return 'destructive'

  if (rawKind === 'read' || rawKind === 'search' || rawKind === 'think' || rawKind === 'fetch') return 'read'
  if (rawKind === 'edit') {
    const path = extractActionPath(params)
    if (path) {
      try { return pathExists(path) ? 'edit' : 'create' } catch { /* fall through to text heuristic */ }
    }
    return /\bcreate\b|\bnew file\b/i.test(text) ? 'create' : 'edit'
  }
  return 'execute'
}

export function describeAcpAction(params: any, kind: AcpActionKind): string {
  const toolCall = params?.toolCall ?? {}
  const rawInput = toolCall.rawInput ?? params?.rawInput ?? {}
  const title: string | undefined = toolCall.title ?? params?.title
  if (title) return title
  const command: string | undefined = rawInput.command
  if (command) return `Run command \`${command}\``
  const path = extractActionPath(params)
  if (path) {
    const verb = kind === 'create' ? 'Create' : kind === 'edit' ? 'Edit' : kind === 'read' ? 'Read' : 'Delete'
    return `${verb} \`${path}\``
  }
  return `Perform a ${kind} action`
}

export function compactJson(value: unknown, max = 220): string {
  if (value === undefined || value === null || value === '') return ''
  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    return raw.length > max ? `${raw.slice(0, max - 3)}...` : raw
  } catch {
    return String(value)
  }
}

export function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function toolNameFromUpdate(update: any): string {
  const toolCall = update?.toolCall ?? update?.tool_call ?? update?.call ?? {}
  const rawInput = toolCall.rawInput ?? toolCall.input ?? update?.rawInput ?? update?.input ?? update?.args ?? {}
  const name = firstText(
    update?.toolName,
    update?.tool_name,
    update?.name,
    update?.title,
    toolCall.name,
    toolCall.toolName,
    toolCall.title,
    rawInput.command,
    rawInput.path,
    rawInput.file_path,
    rawInput.query
  )
  if (name && name.toLowerCase() !== 'tool') return name
  return 'Tool'
}

export function toolArgsFromUpdate(update: any): unknown {
  const toolCall = update?.toolCall ?? update?.tool_call ?? update?.call ?? {}
  return update?.args ?? update?.input ?? update?.params ?? toolCall.rawInput ?? toolCall.input ?? undefined
}

export function toolResultFromUpdate(update: any): string {
  return compactJson(update?.result ?? update?.output ?? update?.response ?? update?.content?.text ?? update?.error, 480)
}

export function planEntriesFromUpdate(update: any): Array<{ content: string; status: string }> {
  const candidates = [
    update?.entries,
    update?.plan?.entries,
    update?.plan,
    update?.todos,
    update?.tasks,
    update?.items,
    update?.content?.entries
  ]
  const rawEntries = candidates.find((value) => Array.isArray(value)) as any[] | undefined
  if (!rawEntries) return []
  return rawEntries
    .map((entry) => ({
      content: String(entry?.content ?? entry?.title ?? entry?.text ?? entry?.description ?? '').trim(),
      status: String(entry?.status ?? entry?.state ?? (entry?.done ? 'completed' : 'pending')).trim() || 'pending'
    }))
    .filter((entry) => entry.content)
}

// This build responds to permission requests with a plain `{ granted }`
// boolean. If a future build sends the richer ACP `options` array, respond in
// that shape instead so we don't silently break either variant.
export function buildPermissionResult(params: any, approved: boolean): any {
  const options: any[] = Array.isArray(params?.options) ? params.options : []
  if (options.length > 0) {
    const wanted = approved ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
    const opt = options.find((o: any) => wanted.includes(o?.kind)) ?? options[0]
    return { outcome: { outcome: 'selected', optionId: opt?.optionId } }
  }
  return { granted: approved }
}
