import { Fragment } from 'react'

type AiContextBarProps = {
  testId: string
  usedTokens?: number
  maxTokens?: number
  tokensApproximate?: boolean
  model?: string
  modelBadge?: import('react').ReactNode
  mode?: string
  status?: string
  disabledReason?: string
}

function formatTokens(tokens: number, approximate?: boolean): string {
  const value = Math.max(0, Math.round(tokens)).toLocaleString()
  return `${approximate ? '≈ ' : ''}${value} tokens`
}

export function estimateTokensFromText(text: string): number | undefined {
  const chars = text.trim().length
  if (chars === 0) return undefined
  return Math.max(1, Math.ceil(chars / 4))
}

export default function AiContextBar(props: AiContextBarProps) {
  const hasMax = typeof props.maxTokens === 'number' && props.maxTokens > 0
  const hasUsed = typeof props.usedTokens === 'number' && Number.isFinite(props.usedTokens)
  const percent = hasMax && hasUsed
    ? Math.min(100, Math.max(0, Math.round((props.usedTokens! / props.maxTokens!) * 100)))
    : undefined
  const fillScale = percent === undefined ? 1 : percent / 100

  const modelText = props.model?.trim() || 'model unknown'
  const details = [
    percent === undefined ? 'context unknown' : `${percent}% context`,
    hasUsed ? formatTokens(props.usedTokens!, props.tokensApproximate) : undefined,
    modelText,
    props.mode?.trim(),
    props.status?.trim(),
    props.disabledReason?.trim()
  ].filter((item): item is string => Boolean(item))
  const label = details.join(' · ')

  return (
    <div className="context-bar" data-testid={props.testId} aria-label={`AI context status: ${label}`} title={label}>
      <div className={`context-meter ${percent === undefined ? 'unknown' : ''}`} aria-hidden>
        <AnimatedScaleBar className="context-meter-fill" value={fillScale} unknown={percent === undefined} />
      </div>
      <div className="context-items">
        {details.map((item, i) => (
          <Fragment key={i}>
            <span className="context-item">{item}</span>
            {item === modelText && props.modelBadge && (
              <span className="context-item context-item-badge">{props.modelBadge}</span>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  )
}
import { AnimatedScaleBar } from '../motion'
