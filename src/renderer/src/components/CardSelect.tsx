import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'

export interface CardSelectOption {
  value: string
  label: string
  description: string
  stack?: string
}

interface CardSelectProps {
  value: string
  onChange: (value: string) => void
  options: CardSelectOption[]
  label?: string
  testId?: string
}

export default function CardSelect(props: CardSelectProps) {
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selectedIndex = Math.max(0, props.options.findIndex((option) => option.value === props.value))
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex)
  const selected = props.options[selectedIndex] ?? props.options[0]

  useEffect(() => {
    if (open) setHighlightedIndex(selectedIndex)
  }, [open, selectedIndex])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function selectOption(option: CardSelectOption) {
    props.onChange(option.value)
    setOpen(false)
  }

  function moveHighlight(delta: number) {
    if (props.options.length === 0) return
    setHighlightedIndex((current) => (current + delta + props.options.length) % props.options.length)
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement | HTMLDivElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) setOpen(true)
      else moveHighlight(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) setOpen(true)
      else moveHighlight(-1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const option = props.options[highlightedIndex]
      if (option) selectOption(option)
      return
    }
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    }
  }

  const selectedStyle: CSSProperties | undefined = selected?.stack ? { fontFamily: selected.stack } : undefined

  return (
    <div className="card-select" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="card-select-trigger"
        role="combobox"
        aria-label={props.label}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-option-${highlightedIndex}` : undefined}
        onClick={() => setOpen((next) => !next)}
        data-testid={props.testId}
      >
        <span className="card-select-value" style={selectedStyle}>{selected?.label ?? 'Select'}</span>
        <span className="card-select-chevron" aria-hidden>v</span>
      </button>
      {open && (
        <div className="card-select-list" id={`${id}-list`} role="listbox" aria-label={props.label} data-testid={`${props.testId ?? 'card-select'}-list`}>
          {props.options.map((option, index) => {
            const selectedOption = option.value === props.value
            const highlighted = index === highlightedIndex
            const optionStyle: CSSProperties | undefined = option.stack ? { fontFamily: option.stack } : undefined
            return (
              <button
                type="button"
                id={`${id}-option-${index}`}
                key={option.value}
                className={`card-select-option${selectedOption ? ' selected' : ''}${highlighted ? ' highlighted' : ''}`}
                role="option"
                aria-selected={selectedOption}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => selectOption(option)}
                data-testid={`${props.testId ?? 'card-select'}-option-${option.value}`}
              >
                <span className="card-select-option-label" style={optionStyle}>{option.label}</span>
                <span className="card-select-option-description">{option.description}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
