import { useMemo, useState } from 'react'

export interface QuestionnaireQuestion {
  id: string
  question: string
  mode: 'single' | 'multiple'
  options: string[]
  allowFreewrite: boolean
  freewriteLabel?: string
}

export interface QuestionnaireRequest {
  id: string
  title?: string
  questions: QuestionnaireQuestion[]
  fallbackParsed?: boolean
}

export interface QuestionnaireAnswer {
  title?: string
  questions: {
    question: string
    selected: string[]
    freewrite: string
  }[]
  notes: string
}

export const QUESTIONNAIRE_BLOCK_RE = /```questionnaire\s*([\s\S]*?)```/i

function normalizeQuestion(raw: unknown, index: number): QuestionnaireQuestion | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const question = typeof item.question === 'string' ? item.question.trim() : ''
  const mode = item.mode === 'multiple' ? 'multiple' : item.mode === 'single' ? 'single' : null
  const options = Array.isArray(item.options)
    ? item.options
      .filter((opt: unknown): opt is string => typeof opt === 'string' && opt.trim().length > 0)
      .map((opt: string) => opt.trim())
      .slice(0, 8)
    : []
  const allowFreewrite = item.allowFreewrite === true
  const freewriteLabel = typeof item.freewriteLabel === 'string' && item.freewriteLabel.trim()
    ? item.freewriteLabel.trim()
    : undefined
  const id = typeof item.id === 'string' && item.id.trim()
    ? item.id.trim()
    : `question-${index + 1}-${question}:${options.join('|')}`

  if (!question || !mode || options.length < 2) return null
  return { id, question, mode, options, allowFreewrite, freewriteLabel }
}

export function parseQuestionnaireRequest(content: string): {
  request: QuestionnaireRequest | null
  markdown: string
} {
  const match = QUESTIONNAIRE_BLOCK_RE.exec(content)
  if (!match) return { request: null, markdown: content }

  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>
    const questions = Array.isArray(raw.questions)
      ? raw.questions.map(normalizeQuestion).filter((q): q is QuestionnaireQuestion => q !== null)
      : []
    const id = typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim()
      : `questionnaire:${questions.map((q) => q.id).join('|')}`
    const title = typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.trim()
      : undefined

    if (questions.length < 1) return { request: null, markdown: content }
    return {
      request: { id, title, questions },
      markdown: content.replace(match[0], '').trim()
    }
  } catch {
    return { request: null, markdown: content }
  }
}

export function parseMarkdownQuestionnaire(content: string): {
  request: QuestionnaireRequest | null
  markdown: string
} {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const questions: QuestionnaireQuestion[] = []
  let firstQuestionLine = -1
  let lastOptionLine = -1
  let i = 0

  while (i < lines.length) {
    const questionMatch = /^\s*(\d+)\.\s+(.+\?)\s*$/.exec(lines[i])
    if (!questionMatch) {
      i++
      continue
    }

    const question = questionMatch[2].trim()
    const options: string[] = []
    let j = i + 1
    let lastSeenOption = i

    while (j < lines.length) {
      const line = lines[j]
      if (/^\s*\d+\.\s+.+\?\s*$/.test(line)) break
      if (line.trim().length === 0) {
        j++
        continue
      }

      const option = line.trim()
      const isIndented = /^\s+/.test(line)
      const isShort = option.length > 0 && option.length <= 64
      const isPlain = !/^[-*+]\s+/.test(option) && !/^```/.test(option) && !option.includes('|')
      const looksLikeOption = isIndented && isShort && isPlain && !option.endsWith('?') && !option.endsWith(':')
      if (!looksLikeOption) break

      options.push(option)
      lastSeenOption = j
      j++
    }

    if (options.length >= 2) {
      if (firstQuestionLine === -1) firstQuestionLine = i
      lastOptionLine = lastSeenOption
      questions.push({
        id: `markdown-${questionMatch[1]}-${question}:${options.join('|')}`,
        question,
        mode: 'single',
        options,
        allowFreewrite: true,
        freewriteLabel: 'Other / notes'
      })
      i = j
      continue
    }

    i++
  }

  if (questions.length < 2 || firstQuestionLine === -1 || lastOptionLine === -1) {
    return { request: null, markdown: content }
  }

  const before = lines.slice(0, firstQuestionLine).join('\n').trim()
  const after = lines.slice(lastOptionLine + 1).join('\n').trim()
  const markdown = [before, after].filter(Boolean).join('\n\n')
  return {
    request: {
      id: `markdown-questionnaire:${questions.map((q) => q.id).join('|')}`,
      title: 'A few questions',
      questions,
      fallbackParsed: true
    },
    markdown
  }
}

export function formatQuestionnaireAnswer(answer: QuestionnaireAnswer): string {
  const lines = ['Clarification answers:']
  answer.questions.forEach((item, index) => {
    lines.push('', `${index + 1}. ${item.question}`)
    if (item.selected.length > 0) lines.push(`   Selected: ${item.selected.join(', ')}`)
    if (item.freewrite.trim()) lines.push(`   Additional details: ${item.freewrite.trim()}`)
  })
  if (answer.notes.trim()) lines.push('', 'Additional notes:', answer.notes.trim())
  return lines.join('\n')
}

export default function ClarificationQuestionnaire(props: {
  request: QuestionnaireRequest
  onSubmit: (answer: QuestionnaireAnswer) => void
  onDismiss?: () => void
}) {
  const [selectedById, setSelectedById] = useState<Record<string, string[]>>({})
  const [freewriteById, setFreewriteById] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')

  const canSubmit = useMemo(() => (
    props.request.questions.some((q) => (selectedById[q.id]?.length ?? 0) > 0) ||
    Object.values(freewriteById).some((value) => value.trim().length > 0) ||
    notes.trim().length > 0
  ), [freewriteById, notes, props.request.questions, selectedById])

  function toggleOption(question: QuestionnaireQuestion, option: string) {
    setSelectedById((prev) => {
      const current = prev[question.id] ?? []
      if (question.mode === 'single') return { ...prev, [question.id]: [option] }
      return {
        ...prev,
        [question.id]: current.includes(option)
          ? current.filter((item) => item !== option)
          : [...current, option]
      }
    })
  }

  function submit() {
    props.onSubmit({
      title: props.request.title,
      questions: props.request.questions.map((question) => ({
        question: question.question,
        selected: selectedById[question.id] ?? [],
        freewrite: freewriteById[question.id] ?? ''
      })),
      notes
    })
  }

  return (
    <div className="clarification-card questionnaire-card" data-testid="questionnaire-card">
      {props.request.title && <div className="questionnaire-title">{props.request.title}</div>}
      <div className="questionnaire-list">
        {props.request.questions.map((question, index) => (
          <fieldset key={question.id} className="questionnaire-question" data-testid="questionnaire-question">
            <legend>{index + 1}. {question.question}</legend>
            <div className="clarification-options">
              {question.options.map((option) => {
                const checked = (selectedById[question.id] ?? []).includes(option)
                return (
                  <label key={option} className="clarification-option" data-testid="questionnaire-option">
                    <input
                      type={question.mode === 'multiple' ? 'checkbox' : 'radio'}
                      name={`questionnaire-${props.request.id}-${question.id}`}
                      checked={checked}
                      onChange={() => toggleOption(question, option)}
                    />
                    <span>{option}</span>
                  </label>
                )
              })}
            </div>
            {question.allowFreewrite && (
              <textarea
                className="clarification-freewrite"
                data-testid="questionnaire-question-freewrite"
                placeholder={question.freewriteLabel ?? 'Add your own answer'}
                value={freewriteById[question.id] ?? ''}
                onChange={(e) => setFreewriteById((prev) => ({ ...prev, [question.id]: e.target.value }))}
              />
            )}
          </fieldset>
        ))}
      </div>
      <textarea
        className="clarification-freewrite"
        data-testid="questionnaire-freewrite"
        placeholder="Additional notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="clarification-actions">
        {props.onDismiss && (
          <button className="ghost tiny" onClick={props.onDismiss}>Dismiss</button>
        )}
        <button
          className="primary tiny"
          data-testid="questionnaire-submit"
          disabled={!canSubmit}
          onClick={submit}
        >
          Submit
        </button>
      </div>
    </div>
  )
}
