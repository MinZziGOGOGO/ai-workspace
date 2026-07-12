type ToolSyntaxLanguage = 'auto' | 'json' | 'shell' | 'text'

interface SyntaxToken {
  text: string
  className?: string
}

function pushPlain(tokens: SyntaxToken[], text: string) {
  if (text) tokens.push({ text })
}

function jsonLanguageFor(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || !/^[{[]/.test(trimmed)) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function shellLanguageFor(value: string): boolean {
  return /(^|\n)\s*(?:\$|>|terminal:)\s+/i.test(value) ||
    /\s(?:&&|\|\||\|)\s/.test(value) ||
    /\b(?:npm|pnpm|yarn|node|git|rg|grep|python|pip|wsl|powershell|cmd|date|whoami|uname)\b/.test(value)
}

function languageFor(value: string, language: ToolSyntaxLanguage): Exclude<ToolSyntaxLanguage, 'auto'> {
  if (language !== 'auto') return language
  if (jsonLanguageFor(value)) return 'json'
  if (shellLanguageFor(value)) return 'shell'
  return 'text'
}

function tokenizeJson(value: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = []
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\btrue\b|\bfalse\b|\bnull\b|[{}\[\],:]/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(value)) !== null) {
    pushPlain(tokens, value.slice(last, match.index))
    const raw = match[0]
    let className = 'syntax-punctuation'
    if (match[1]) className = match[2] ? 'syntax-key' : 'syntax-string'
    else if (/^-?\d/.test(raw)) className = 'syntax-number'
    else if (/^(true|false)$/.test(raw)) className = 'syntax-boolean'
    else if (raw === 'null') className = 'syntax-null'
    tokens.push({ text: raw, className })
    last = match.index + raw.length
  }
  pushPlain(tokens, value.slice(last))
  return tokens
}

function tokenizeShellLine(line: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = []
  const re = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|&&|\|\||[|;<>]|\$\s*|--?[A-Za-z0-9][A-Za-z0-9_-]*|\/[A-Za-z0-9._/-]+|[A-Za-z_][\w.-]*)/g
  let last = 0
  let commandExpected = true
  let match: RegExpExecArray | null

  while ((match = re.exec(line)) !== null) {
    const gap = line.slice(last, match.index)
    pushPlain(tokens, gap)
    if (/\bterminal:\s*$/i.test(line.slice(0, match.index))) commandExpected = true

    const raw = match[0]
    const lower = raw.toLowerCase()
    let className: string | undefined

    if (/^\$\s*$/.test(raw)) className = 'syntax-prompt'
    else if (/^['"]/.test(raw)) className = 'syntax-string'
    else if (/^(?:&&|\|\||[|;<>])$/.test(raw)) {
      className = 'syntax-operator'
      commandExpected = true
    } else if (/^--?/.test(raw)) {
      className = 'syntax-flag'
    } else if (commandExpected && !/^terminal$/i.test(raw)) {
      className = 'syntax-command'
      commandExpected = ['sudo', 'command', 'env', 'time'].includes(lower)
    } else if (/^(?:true|false|null)$/.test(raw)) {
      className = 'syntax-boolean'
    }

    tokens.push({ text: raw, className })
    if (className !== 'syntax-operator' && className !== 'syntax-prompt' && className !== 'syntax-command') {
      commandExpected = false
    }
    last = match.index + raw.length
  }

  pushPlain(tokens, line.slice(last))
  return tokens
}

function tokenizeShell(value: string): SyntaxToken[] {
  const lines = value.split('\n')
  return lines.flatMap((line, index) => {
    const lineTokens = tokenizeShellLine(line)
    return index === lines.length - 1 ? lineTokens : [...lineTokens, { text: '\n' }]
  })
}

function tokenizeText(value: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = []
  const re = /\b(?:TOOL|STATUS|REMOTE PAYLOAD|INPUT|RESULT|done|running|pending|error|failed|success)\b|[\u2713\u2715]/gi
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(value)) !== null) {
    pushPlain(tokens, value.slice(last, match.index))
    const raw = match[0]
    const lower = raw.toLowerCase()
    let className = 'syntax-label'
    if (raw === '\u2713' || lower === 'done' || lower === 'success') className = 'syntax-success'
    else if (raw === '\u2715' || lower === 'error' || lower === 'failed') className = 'syntax-error'
    else if (lower === 'running' || lower === 'pending') className = 'syntax-status'
    tokens.push({ text: raw, className })
    last = match.index + raw.length
  }
  pushPlain(tokens, value.slice(last))
  return tokens
}

export default function ToolSyntaxBlock(props: { value: string; language?: ToolSyntaxLanguage; className?: string }) {
  const language = languageFor(props.value, props.language ?? 'auto')
  const value = language === 'json' ? formatJson(props.value) : props.value
  const tokens =
    language === 'json' ? tokenizeJson(value) :
    language === 'shell' ? tokenizeShell(value) :
    tokenizeText(value)

  return (
    <pre className={`syntax-block syntax-${language}${props.className ? ` ${props.className}` : ''}`}>
      {tokens.map((token, index) => (
        token.className
          ? <span key={index} className={token.className}>{token.text}</span>
          : token.text
      ))}
    </pre>
  )
}
