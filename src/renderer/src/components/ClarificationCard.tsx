import { useMemo, useState } from 'react'

export interface ClarificationRequest {
  id: string
  question: string
  mode: 'single' | 'multiple'
  options: string[]
  allowFreewrite: boolean
  freewriteLabel?: string
}

export interface ClarificationAnswer {
  question: string
  selected: string[]
  freewrite: string
}

export const CLARIFICATION_BLOCK_RE = /```clarification\s*([\s\S]*?)```/i
export const CHOICE_QUESTION_BLOCK_RE = /```choice_question\s*([\s\S]*?)```/i

function normalizeChoiceRequest(raw: unknown): ClarificationRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const question = typeof item.question === 'string' ? cleanMarkdownText(item.question) : ''
  const mode = item.mode === 'multiple' ? 'multiple' : item.mode === 'single' ? 'single' : null
  const options = Array.isArray(item.options)
    ? item.options
      .filter((opt: unknown): opt is string => typeof opt === 'string' && opt.trim().length > 0)
      .map((opt: string) => cleanMarkdownText(opt))
      .filter((opt) => opt.length > 0)
      .slice(0, 8)
    : []
  const allowFreewrite = item.allowFreewrite === true
  const freewriteLabel = typeof item.freewriteLabel === 'string' && item.freewriteLabel.trim()
    ? item.freewriteLabel.trim()
    : undefined
  const id = typeof item.id === 'string' && item.id.trim()
    ? item.id.trim()
    : `${question}:${options.join('|')}`

  if (!question || !mode || options.length < 2) return null
  return { id, question, mode, options, allowFreewrite, freewriteLabel }
}

function cleanMarkdownText(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s*/, '')
    .replace(/^[^\p{L}\p{N}"']+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseClarificationRequest(content: string): {
  request: ClarificationRequest | null
  markdown: string
} {
  const match = CLARIFICATION_BLOCK_RE.exec(content)
  if (!match) return { request: null, markdown: content }

  try {
    const raw = JSON.parse(match[1])
    const request = normalizeChoiceRequest(raw)
    if (!request) return { request: null, markdown: content }

    return {
      request,
      markdown: content.replace(match[0], '').trim()
    }
  } catch {
    return { request: null, markdown: content }
  }
}

export function parseChoiceQuestionRequest(content: string): {
  request: ClarificationRequest | null
  markdown: string
} {
  const match = CHOICE_QUESTION_BLOCK_RE.exec(content)
  if (!match) return { request: null, markdown: content }

  try {
    const request = normalizeChoiceRequest(JSON.parse(match[1]))
    if (!request) return { request: null, markdown: content }
    return {
      request,
      markdown: content.replace(match[0], '').trim()
    }
  } catch {
    return { request: null, markdown: content }
  }
}

function extractLetteredOptions(text: string): { options: string[]; start: number; end: number } | null {
  const labelRe = /(?:^|\s)(?:\*\*)?([A-Ha-h])[\).:](?:\*\*)?\s+/g
  const matches = [...text.matchAll(labelRe)]
  if (matches.length < 3) return null

  const options: string[] = []
  for (let i = 0; i < matches.length; i++) {
    const start = (matches[i].index ?? 0) + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length
    const option = cleanMarkdownText(text.slice(start, end).replace(/\n+/g, ' '))
    if (!option || option.length > 80 || option.endsWith('?')) return null
    options.push(option)
  }

  return {
    options,
    start: matches[0].index ?? 0,
    end: text.length
  }
}

function hasLetteredOptionLabel(line: string): boolean {
  return /(?:^|\s)(?:\*\*)?[A-Ha-h][\).:](?:\*\*)?\s+/.test(line)
}

export function parseInlineChoiceQuestion(content: string): {
  request: ClarificationRequest | null
  markdown: string
} {
  const lines = content.replace(/\r\n/g, '\n').split('\n')

  for (let optionLineIndex = 0; optionLineIndex < lines.length; optionLineIndex++) {
    if (!hasLetteredOptionLabel(lines[optionLineIndex])) continue

    const optionLines: string[] = []
    let lastOptionLineIndex = optionLineIndex

    for (let next = optionLineIndex; next < Math.min(lines.length, optionLineIndex + 8); next++) {
      if (!lines[next].trim()) break
      if (next > optionLineIndex && !hasLetteredOptionLabel(lines[next])) break
      optionLines.push(lines[next])
      lastOptionLineIndex = next
    }

    const parsed = extractLetteredOptions(optionLines.join('\n'))
    if (!parsed || parsed.options.length < 3) continue

    let questionLineIndex = -1
    for (let prev = optionLineIndex - 1; prev >= Math.max(0, optionLineIndex - 4); prev--) {
      const candidate = lines[prev].trim()
      if (!candidate) continue
      const cleaned = cleanMarkdownText(candidate)
      const looksLikeQuestion = cleaned.endsWith('?') || /^\s*(#+|\*\*)/.test(candidate)
      if (looksLikeQuestion && cleaned.length >= 10 && cleaned.length <= 180) {
        questionLineIndex = prev
        break
      }
    }

    if (questionLineIndex === -1) continue

    const question = cleanMarkdownText(lines[questionLineIndex])
    const before = lines.slice(0, questionLineIndex).join('\n').trim()
    const after = lines.slice(lastOptionLineIndex + 1).join('\n').trim()
    return {
      request: {
        id: `inline-choice:${question}:${parsed.options.join('|')}`,
        question,
        mode: 'single',
        options: parsed.options,
        allowFreewrite: false
      },
      markdown: [before, after].filter(Boolean).join('\n\n')
    }
  }

  return { request: null, markdown: content }
}

export function formatClarificationAnswer(answer: ClarificationAnswer): string {
  const lines = [
    'Clarification answer:',
    `Question: ${answer.question}`
  ]
  if (answer.selected.length > 0) lines.push(`Selected: ${answer.selected.join(', ')}`)
  if (answer.freewrite.trim()) lines.push(`Additional details: ${answer.freewrite.trim()}`)
  return lines.join('\n')
}

export function formatChoiceAnswer(answer: ClarificationAnswer): string {
  const lines = [
    'Answer:',
    `Question: ${answer.question}`
  ]
  if (answer.selected.length > 0) lines.push(`Selected: ${answer.selected.join(', ')}`)
  if (answer.freewrite.trim()) lines.push(`Additional details: ${answer.freewrite.trim()}`)
  return lines.join('\n')
}

export default function ClarificationCard(props: {
  request: ClarificationRequest
  onSubmit: (answer: ClarificationAnswer) => void
  onDismiss?: () => void
  cardTestId?: string
  optionTestId?: string
  freewriteTestId?: string
  submitTestId?: string
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [freewrite, setFreewrite] = useState('')

  const canSubmit = useMemo(
    () => selected.length > 0 || freewrite.trim().length > 0,
    [freewrite, selected.length]
  )

  function toggleOption(option: string) {
    if (props.request.mode === 'single') {
      setSelected([option])
      return
    }
    setSelected((prev) => (
      prev.includes(option)
        ? prev.filter((item) => item !== option)
        : [...prev, option]
    ))
  }

  return (
    <div className="clarification-card" data-testid={props.cardTestId ?? 'clarification-card'}>
      <div className="clarification-question">{props.request.question}</div>
      <div className="clarification-options">
        {props.request.options.map((option) => {
          const checked = selected.includes(option)
          return (
            <label key={option} className="clarification-option" data-testid={props.optionTestId ?? 'clarification-option'}>
              <input
                type={props.request.mode === 'multiple' ? 'checkbox' : 'radio'}
                name={`clarification-${props.request.id}`}
                checked={checked}
                onChange={() => toggleOption(option)}
              />
              <span>{option}</span>
            </label>
          )
        })}
      </div>
      {props.request.allowFreewrite && (
        <textarea
          className="clarification-freewrite"
          data-testid={props.freewriteTestId ?? 'clarification-freewrite'}
          placeholder={props.request.freewriteLabel ?? 'Add your own answer'}
          value={freewrite}
          onChange={(e) => setFreewrite(e.target.value)}
        />
      )}
      <div className="clarification-actions">
        {props.onDismiss && (
          <button className="ghost tiny" onClick={props.onDismiss}>Dismiss</button>
        )}
        <button
          className="primary tiny"
          data-testid={props.submitTestId ?? 'clarification-submit'}
          disabled={!canSubmit}
          onClick={() => props.onSubmit({ question: props.request.question, selected, freewrite })}
        >
          Submit
        </button>
      </div>
    </div>
  )
}
