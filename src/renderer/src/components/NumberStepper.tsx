import { type KeyboardEvent } from 'react'

interface NumberStepperProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  label?: string
  testId?: string
}

function clamp(value: number, min?: number, max?: number) {
  let next = value
  if (typeof min === 'number') next = Math.max(min, next)
  if (typeof max === 'number') next = Math.min(max, next)
  return next
}

function roundStep(value: number, step: number) {
  const decimals = String(step).split('.')[1]?.length ?? 0
  return Number(value.toFixed(Math.min(decimals, 10)))
}

export default function NumberStepper(props: NumberStepperProps) {
  const step = props.step ?? 1
  const value = clamp(Number.isFinite(props.value) ? props.value : props.min ?? 0, props.min, props.max)
  const canDecrement = typeof props.min !== 'number' || value > props.min
  const canIncrement = typeof props.max !== 'number' || value < props.max
  const baseTestId = props.testId ?? 'number-stepper'

  function update(delta: number) {
    const next = clamp(roundStep(value + delta * step, step), props.min, props.max)
    if (next !== value) props.onChange(next)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      update(1)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      update(-1)
    }
  }

  return (
    <div className="number-stepper" data-testid={baseTestId}>
      <button
        type="button"
        className="number-stepper-btn number-stepper-btn-left"
        onClick={() => update(-1)}
        disabled={!canDecrement}
        aria-label={props.label ? `Decrease ${props.label}` : 'Decrease value'}
        data-testid={`${baseTestId}-decrement`}
      >
        &minus;
      </button>
      <div
        className="number-stepper-value"
        role="spinbutton"
        tabIndex={0}
        aria-label={props.label}
        aria-valuenow={value}
        aria-valuemin={props.min}
        aria-valuemax={props.max}
        onKeyDown={onKeyDown}
        data-testid={`${baseTestId}-value`}
      >
        {value}
      </div>
      <button
        type="button"
        className="number-stepper-btn number-stepper-btn-right"
        onClick={() => update(1)}
        disabled={!canIncrement}
        aria-label={props.label ? `Increase ${props.label}` : 'Increase value'}
        data-testid={`${baseTestId}-increment`}
      >
        +
      </button>
    </div>
  )
}
