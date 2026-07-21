import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { AgentEffortLevel, AgentModelInfo, KimiConfigSelect } from '../types'

// Model pickers for the agent tabs, modeled on the reference UIs:
// - ModelPicker (default flat list): label + description rows, right
//   checkmark, optional 1..n number chips.
// - ClaudeModelPicker: two pills — a "Models" popover (numbered main rows,
//   real-data badge chips, "More models ›" submenu with older models and a
//   custom-id input) plus an effort pill opening a discrete Faster/Smarter
//   slider.
// - CodexModelPicker: one combined pill opening select rows (Model / Effort /
//   Speed) that drill into submenus with a back row. The Speed row only
//   appears for models with a real fast service tier.
// - KimiModelPicker: the flat list plus drill-in rows (e.g. "Thinking
//   effort", "Conversation capacity") for whatever non-model config selects
//   the ACP server actually reports — nothing is hardcoded. Hermes reuses this
//   one: same shape (live ACP model list + a "Reasoning effort" drill-in), so
//   despite the name it is the shared ACP picker, not a Kimi-only component.
// Shared conventions: combobox/listbox ARIA, outside-click close, Escape
// close, {testId}-list / {testId}-option-{sanitized} testids.

// Model ids can contain characters that are awkward in testids (Kimi uses
// 'kimi-code/k3') — collapse anything non-alphanumeric to '-'.
export function sanitizeModelTestId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, '-')
}

function titleCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value
}

// Outside-click close for a popover anchored inside rootRef.
function useOutsideDismiss(open: boolean, setOpen: (v: boolean) => void, rootRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, setOpen, rootRef])
}

// ---- shared rows -------------------------------------------------------------

function PanelTitle(props: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="model-picker-panel-title">
      <span className="model-picker-panel-title-text">{props.children}</span>
      {props.trailing}
    </div>
  )
}

interface ModelRowProps {
  option: AgentModelInfo
  selected: boolean
  highlighted?: boolean
  /** 1-based number chip; omitted = no chip. */
  index?: number
  testId: string
  id?: string
  onSelect: () => void
  onHover?: () => void
}

function ModelRow(props: ModelRowProps) {
  return (
    <button
      type="button"
      id={props.id}
      className={`model-picker-option${props.selected ? ' selected' : ''}${props.highlighted ? ' highlighted' : ''}`}
      role="option"
      aria-selected={props.selected}
      onMouseEnter={props.onHover}
      onClick={props.onSelect}
      data-testid={props.testId}
    >
      {props.index !== undefined && <span className="model-picker-option-index" aria-hidden>{props.index}</span>}
      <span className="model-picker-option-main">
        <span className="model-picker-option-label">
          {props.option.label}
          {props.option.badge && <span className="model-picker-option-badge">{props.option.badge}</span>}
        </span>
        {props.option.description && <span className="model-picker-option-description">{props.option.description}</span>}
      </span>
      {props.selected && <span className="model-picker-option-check" aria-hidden>✓</span>}
    </button>
  )
}

// Label left, muted value + › right — drills into a submenu.
function SelectRow(props: { label: string; value?: string; testId: string; onClick: () => void }) {
  return (
    <button type="button" className="model-picker-select-row" onClick={props.onClick} data-testid={props.testId}>
      <span className="model-picker-select-row-label">{props.label}</span>
      <span className="model-picker-select-row-value">
        {props.value}
        <span className="model-picker-select-row-chevron" aria-hidden>›</span>
      </span>
    </button>
  )
}

function BackRow(props: { testId: string; onClick: () => void }) {
  return (
    <button type="button" className="model-picker-back-row" onClick={props.onClick} data-testid={props.testId}>
      <span className="model-picker-back-row-chevron" aria-hidden>‹</span> Back
    </button>
  )
}

// ---- default flat picker (Kimi) ----------------------------------------------

interface ModelPickerProps {
  value: string
  onChange: (id: string) => void
  options: AgentModelInfo[]
  disabled?: boolean
  label?: string
  testId: string
  /** Show 1..n number chips and enable number-key jump select (default true). */
  numbered?: boolean
}

export default function ModelPicker(props: ModelPickerProps) {
  const numbered = props.numbered ?? true
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selectedIndex = Math.max(0, props.options.findIndex((option) => option.id === props.value))
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex)
  const selected = props.options[selectedIndex] ?? props.options[0]

  useOutsideDismiss(open, setOpen, rootRef)

  useEffect(() => {
    if (open) setHighlightedIndex(selectedIndex)
  }, [open, selectedIndex])

  function selectOption(option: AgentModelInfo) {
    props.onChange(option.id)
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
      return
    }
    // Number keys 1..9 jump straight to a row while the list is open.
    if (numbered && open && /^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1
      const option = props.options[index]
      if (option) {
        event.preventDefault()
        selectOption(option)
      }
    }
  }

  return (
    <div className={`model-picker${open ? ' open' : ''}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="model-picker-trigger"
        role="combobox"
        aria-label={props.label ?? 'Model'}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-option-${highlightedIndex}` : undefined}
        disabled={props.disabled}
        title={selected?.description || selected?.label}
        onClick={() => setOpen((next) => !next)}
        data-testid={props.testId}
      >
        <span className="model-picker-value">{selected?.label ?? 'Select model'}</span>
        <span className="model-picker-chevron" aria-hidden>⌄</span>
      </button>
      {open && (
        <div className="model-picker-list" id={`${id}-list`} role="listbox" aria-label={props.label ?? 'Model'} data-testid={`${props.testId}-list`}>
          {props.options.map((option, index) => (
            <ModelRow
              key={option.id}
              id={`${id}-option-${index}`}
              option={option}
              index={numbered ? index + 1 : undefined}
              selected={option.id === props.value}
              highlighted={index === highlightedIndex}
              onHover={() => setHighlightedIndex(index)}
              onSelect={() => selectOption(option)}
              testId={`${props.testId}-option-${sanitizeModelTestId(option.id)}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Claude Code: models pill + effort slider pill ----------------------------

interface ClaudeModelPickerProps {
  models: AgentModelInfo[]
  model: string
  onModelChange: (id: string) => void
  effort: string
  onEffortChange: (value: string) => void
  disabled?: boolean
  testId?: string
  effortTestId?: string
}

// Real CLI effort levels, used when the selected (custom) model carries no
// catalog entry. 'default' is the passthrough — it is never a slider stop.
const CLAUDE_FALLBACK_STOPS: AgentEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v, label: v }))

export function ClaudeModelPicker(props: ClaudeModelPickerProps) {
  const testId = props.testId ?? 'claude-code-model'
  const effortTestId = props.effortTestId ?? 'claude-code-effort-pill'
  const effortBase = effortTestId.replace(/-pill$/, '')
  const rootRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [view, setView] = useState<'main' | 'more'>('main')
  const [customEditing, setCustomEditing] = useState(false)
  const [customDraft, setCustomDraft] = useState('')

  const mainModels = props.models.filter((m) => !m.extra)
  const extraModels = props.models.filter((m) => m.extra)
  const selected = props.models.find((m) => m.id === props.model)
  const selectedLabel = selected?.label ?? props.model
  const isCustom = !selected

  // Discrete slider stops: the model's real levels minus the 'default'
  // passthrough. A persisted 'default' simply shows no active stop.
  const catalogStops = (selected?.efforts ?? []).filter((l) => l.value !== 'default')
  const stops = catalogStops.length > 0 ? catalogStops : CLAUDE_FALLBACK_STOPS
  const currentIndex = stops.findIndex((s) => s.value === props.effort)

  useEffect(() => {
    if (!modelsOpen && !effortOpen) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) closeAll()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [modelsOpen, effortOpen])

  function closeAll() {
    setModelsOpen(false)
    setEffortOpen(false)
    setView('main')
    setCustomEditing(false)
  }

  function selectModel(id: string) {
    props.onModelChange(id)
    closeAll()
  }

  function commitCustom() {
    const value = customDraft.trim()
    setCustomEditing(false)
    setCustomDraft('')
    if (value) selectModel(value)
  }

  function setEffortStop(index: number) {
    const clamped = Math.max(0, Math.min(stops.length - 1, index))
    const stop = stops[clamped]
    if (stop) props.onEffortChange(stop.value)
  }

  function onSliderKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      setEffortStop((currentIndex < 0 ? 0 : currentIndex) - 1)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      setEffortStop(currentIndex + 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setEffortStop(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setEffortStop(stops.length - 1)
    }
  }

  function onRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      if (modelsOpen || effortOpen) {
        event.stopPropagation()
        closeAll()
      }
      return
    }
    // Number keys 1..9 jump straight to a main-list row while it is open.
    if (modelsOpen && view === 'main' && /^[1-9]$/.test(event.key)) {
      const option = mainModels[Number(event.key) - 1]
      if (option) {
        event.preventDefault()
        selectModel(option.id)
      }
    }
  }

  return (
    <div className="model-picker-claude" ref={rootRef} onKeyDown={onRootKeyDown}>
      <div className={`model-picker${modelsOpen ? ' open' : ''}`}>
        <button
          type="button"
          className="model-picker-trigger"
          aria-label="Model passed to Claude Code (--model)"
          aria-expanded={modelsOpen}
          aria-haspopup="listbox"
          disabled={props.disabled}
          title={selected?.description || selectedLabel}
          onClick={() => {
            if (modelsOpen) closeAll()
            else {
              setModelsOpen(true)
              setEffortOpen(false)
            }
          }}
          data-testid={testId}
        >
          <span className="model-picker-value">{selectedLabel}</span>
          <span className="model-picker-chevron" aria-hidden>⌄</span>
        </button>
        {modelsOpen && (
          <div className="model-picker-list" role="listbox" aria-label="Model" data-testid={`${testId}-list`}>
            {view === 'main' ? (
              <>
                <PanelTitle>Models</PanelTitle>
                {isCustom && (
                  <ModelRow
                    option={{ id: props.model, label: props.model, description: 'Custom model ID' }}
                    selected
                    onSelect={closeAll}
                    testId={`${testId}-option-${sanitizeModelTestId(props.model)}`}
                  />
                )}
                {mainModels.map((option, index) => (
                  <ModelRow
                    key={option.id}
                    option={option}
                    index={index + 1}
                    selected={option.id === props.model}
                    onSelect={() => selectModel(option.id)}
                    testId={`${testId}-option-${sanitizeModelTestId(option.id)}`}
                  />
                ))}
                <div className="model-picker-divider" aria-hidden />
                <SelectRow label="More models" testId={`${testId}-more`} onClick={() => setView('more')} />
              </>
            ) : (
              <>
                <BackRow testId={`${testId}-back`} onClick={() => { setView('main'); setCustomEditing(false) }} />
                {extraModels.map((option) => (
                  <ModelRow
                    key={option.id}
                    option={option}
                    selected={option.id === props.model}
                    onSelect={() => selectModel(option.id)}
                    testId={`${testId}-option-${sanitizeModelTestId(option.id)}`}
                  />
                ))}
                <div className="model-picker-divider" aria-hidden />
                {customEditing ? (
                  <input
                    className="model-picker-custom-input"
                    data-testid="claude-code-model-custom-input"
                    autoFocus
                    placeholder="Custom model ID…"
                    value={customDraft}
                    onChange={(e) => setCustomDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        e.stopPropagation()
                        commitCustom()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        e.stopPropagation()
                        setCustomEditing(false)
                        setCustomDraft('')
                      }
                    }}
                  />
                ) : (
                  <SelectRow label="Custom model ID…" testId={`${testId}-custom`} onClick={() => setCustomEditing(true)} />
                )}
              </>
            )}
          </div>
        )}
      </div>
      <div className={`model-picker${effortOpen ? ' open' : ''}`}>
        <button
          type="button"
          className="model-picker-trigger"
          aria-label="Effort passed to Claude Code (--effort)"
          aria-expanded={effortOpen}
          aria-haspopup="dialog"
          disabled={props.disabled}
          title="Reasoning effort (--effort)"
          onClick={() => {
            if (effortOpen) closeAll()
            else {
              setEffortOpen(true)
              setModelsOpen(false)
            }
          }}
          data-testid={effortTestId}
        >
          <span className="model-picker-value">{titleCase(props.effort)}</span>
          <span className="model-picker-chevron" aria-hidden>⌄</span>
        </button>
        {effortOpen && (
          <div className="model-picker-list model-picker-effort-panel" role="dialog" aria-label="Effort" data-testid={`${effortBase}-list`}>
            <PanelTitle
              trailing={
                <span
                  className="model-picker-help"
                  title="How hard the model thinks before answering. Faster = less reasoning, Smarter = more. Default omits --effort."
                >
                  ?
                </span>
              }
            >
              Effort {titleCase(props.effort)}
            </PanelTitle>
            <div className="effort-slider-anchors" aria-hidden>
              <span>Faster</span>
              <span>Smarter</span>
            </div>
            <div
              className="effort-slider"
              role="slider"
              tabIndex={0}
              aria-label="Effort"
              aria-valuemin={1}
              aria-valuemax={stops.length}
              aria-valuenow={currentIndex >= 0 ? currentIndex + 1 : undefined}
              aria-valuetext={currentIndex >= 0 ? stops[currentIndex].label : 'Default'}
              data-testid={`${effortBase}-slider`}
              onKeyDown={onSliderKeyDown}
              ref={sliderRef}
            >
              {stops.map((stop, index) => (
                <span
                  key={stop.value}
                  className={`effort-stop${index === currentIndex ? ' active' : ''}`}
                  title={stop.description ?? stop.label}
                  data-testid={`${effortBase}-stop-${stop.value}`}
                  onClick={() => {
                    props.onEffortChange(stop.value)
                    sliderRef.current?.focus()
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---- Codex: combined pill with Model / Effort / Speed select rows -------------

interface CodexModelPickerProps {
  /** Catalog + recently used customs + the trailing "Custom…" sentinel row. */
  models: AgentModelInfo[]
  model: string
  onModelChange: (id: string) => void
  effort: string
  onEffortChange: (value: string) => void
  speed: string
  onSpeedChange: (value: string) => void
  disabled?: boolean
  testId?: string
}

export function CodexModelPicker(props: CodexModelPickerProps) {
  const testId = props.testId ?? 'codex-model'
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'main' | 'models' | 'effort' | 'speed'>('main')

  const selected = props.models.find((m) => m.id === props.model)
  const selectedLabel = selected?.label ?? props.model
  const effortLevels = selected?.efforts ?? []
  const effortLabel = props.effort ? titleCase(props.effort) : ''
  const speedLabel = props.speed === 'priority' ? 'Fast' : 'Standard'

  useOutsideDismiss(open, setOpen, rootRef)

  function close() {
    setOpen(false)
    setView('main')
  }

  function onRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && open) {
      event.stopPropagation()
      close()
    }
  }

  return (
    <div className={`model-picker${open ? ' open' : ''}`} ref={rootRef} onKeyDown={onRootKeyDown}>
      <button
        type="button"
        className="model-picker-trigger"
        aria-label="Codex model (-m), reasoning effort, and service tier"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={props.disabled}
        title={selected?.description || selectedLabel}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid={testId}
      >
        <span className="model-picker-value">
          {selectedLabel}
          {effortLabel ? ` · ${effortLabel}` : ''}
        </span>
        <span className="model-picker-chevron" aria-hidden>⌄</span>
      </button>
      {open && (
        <div className="model-picker-list" role="listbox" aria-label="Codex model settings" data-testid={`${testId}-list`}>
          {view === 'main' && (
            <>
              <SelectRow label="Model" value={selectedLabel} testId={`${testId}-row-model`} onClick={() => setView('models')} />
              {effortLevels.length > 0 && (
                <SelectRow label="Effort" value={effortLabel} testId={`${testId}-row-effort`} onClick={() => setView('effort')} />
              )}
              {selected?.fastTier && (
                <SelectRow label="Speed" value={speedLabel} testId={`${testId}-row-speed`} onClick={() => setView('speed')} />
              )}
            </>
          )}
          {view === 'models' && (
            <>
              <BackRow testId={`${testId}-back`} onClick={() => setView('main')} />
              {props.models.map((option) => (
                <ModelRow
                  key={option.id}
                  option={option}
                  selected={option.id === props.model}
                  onSelect={() => {
                    props.onModelChange(option.id)
                    close()
                  }}
                  testId={`${testId}-option-${sanitizeModelTestId(option.id)}`}
                />
              ))}
            </>
          )}
          {view === 'effort' && (
            <>
              <BackRow testId={`${testId}-back`} onClick={() => setView('main')} />
              {effortLevels.map((level) => (
                <ModelRow
                  key={level.value}
                  option={{ id: level.value, label: level.label, description: level.description }}
                  selected={level.value === props.effort}
                  onSelect={() => {
                    props.onEffortChange(level.value)
                    close()
                  }}
                  testId={`${testId}-effort-${level.value}`}
                />
              ))}
            </>
          )}
          {view === 'speed' && (
            <>
              <BackRow testId={`${testId}-back`} onClick={() => setView('main')} />
              <ModelRow
                option={{ id: 'standard', label: 'Standard', description: 'Default service tier' }}
                selected={props.speed !== 'priority'}
                onSelect={() => {
                  props.onSpeedChange('standard')
                  close()
                }}
                testId={`${testId}-speed-standard`}
              />
              <ModelRow
                option={{ id: 'priority', label: 'Fast', description: selected?.fastTierDescription }}
                selected={props.speed === 'priority'}
                onSelect={() => {
                  props.onSpeedChange('priority')
                  close()
                }}
                testId={`${testId}-speed-priority`}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---- Kimi: flat model list + drill-in config-select rows ----------------------

interface KimiModelPickerProps {
  models: AgentModelInfo[]
  model: string
  onModelChange: (id: string) => void
  /** Non-model ACP config selects reported by the server (may be empty). */
  configSelects: KimiConfigSelect[]
  /** User's chosen values keyed by config id; falls back to server currentValue. */
  configValues: Record<string, string>
  onConfigChange: (configId: string, value: string) => void
  disabled?: boolean
  testId?: string
}

export function KimiModelPicker(props: KimiModelPickerProps) {
  const testId = props.testId ?? 'kimi-model'
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // 'main' shows the model list (+ config rows); any other value is the id of
  // the config select being drilled into.
  const [view, setView] = useState<'main' | string>('main')

  const selected = props.models.find((m) => m.id === props.model)
  const selectedLabel = selected?.label ?? props.model
  const activeSelect = view === 'main' ? null : props.configSelects.find((s) => s.id === view) ?? null

  useOutsideDismiss(open, setOpen, rootRef)

  function close() {
    setOpen(false)
    setView('main')
  }

  function currentValueOf(select: KimiConfigSelect): string | undefined {
    return props.configValues[select.id] ?? select.currentValue
  }

  function currentLabelOf(select: KimiConfigSelect): string | undefined {
    const value = currentValueOf(select)
    return select.options.find((o) => o.value === value)?.name ?? value
  }

  function onRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && open) {
      event.stopPropagation()
      close()
    }
  }

  return (
    <div className={`model-picker${open ? ' open' : ''}`} ref={rootRef} onKeyDown={onRootKeyDown}>
      <button
        type="button"
        className="model-picker-trigger"
        aria-label="Kimi model"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={props.disabled}
        title={selected?.description || selectedLabel}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid={testId}
      >
        <span className="model-picker-value">{selectedLabel}</span>
        <span className="model-picker-chevron" aria-hidden>⌄</span>
      </button>
      {open && (
        <div className="model-picker-list" role="listbox" aria-label="Kimi model settings" data-testid={`${testId}-list`}>
          {!activeSelect ? (
            <>
              {props.models.map((option) => (
                <ModelRow
                  key={option.id}
                  option={option}
                  selected={option.id === props.model}
                  onSelect={() => {
                    props.onModelChange(option.id)
                    close()
                  }}
                  testId={`${testId}-option-${sanitizeModelTestId(option.id)}`}
                />
              ))}
              {props.configSelects.length > 0 && <div className="model-picker-divider" aria-hidden />}
              {props.configSelects.map((select) => (
                <SelectRow
                  key={select.id}
                  label={select.name}
                  value={currentLabelOf(select)}
                  testId={`${testId}-config-${sanitizeModelTestId(select.id)}`}
                  onClick={() => setView(select.id)}
                />
              ))}
            </>
          ) : (
            <>
              <BackRow testId={`${testId}-back`} onClick={() => setView('main')} />
              {activeSelect.options.map((option) => (
                <ModelRow
                  key={option.value}
                  option={{ id: option.value, label: option.name, description: option.description }}
                  selected={option.value === currentValueOf(activeSelect)}
                  onSelect={() => {
                    props.onConfigChange(activeSelect.id, option.value)
                    close()
                  }}
                  testId={`${testId}-config-${sanitizeModelTestId(activeSelect.id)}-option-${sanitizeModelTestId(option.value)}`}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
