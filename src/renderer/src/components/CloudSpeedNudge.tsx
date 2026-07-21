import { useCallback, useEffect, useState } from 'react'
import type { LocalSpeedProbe } from '../../../shared/ipcTypes'

// The "local inference looks slow → Ollama Cloud is faster" suggestion, shared
// by the setup wizard and the Chat composer so both read identically and share
// one dismissal. Built on the existing .tip-banner shell (see TipBanner) rather
// than a new visual pattern.
//
// It only ever appears on *evidence*: a 'slow' verdict from the main-process
// probe (measured tokens/sec or Ollama reporting a CPU-only model). A 'fast' or
// 'unknown' verdict shows nothing — a good GPU box never sees this, and neither
// does someone whose Ollama simply isn't running yet.

const DISMISS_KEY = 'ollama_slow_hint_dismissed'

export interface CloudNudgeGate {
  /** False until both facts are known, so the nudge can't flash before we're sure. */
  eligible: boolean
  dismiss: () => void
  /** Call after a key is saved so the nudge retires without a reload. */
  markConfigured: () => void
}

/**
 * The half of the decision that has nothing to do with *how* slowness was
 * detected: is Ollama Cloud still unconfigured, and has the user already waved
 * this suggestion away? The dismissal is shared — saying no in the wizard also
 * silences the in-chat hint.
 */
export function useCloudNudgeGate(enabled: boolean): CloudNudgeGate {
  const [cloudConfigured, setCloudConfigured] = useState<boolean | null>(null)
  const [dismissed, setDismissed] = useState<boolean | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      const [summary, dismissedValue] = await Promise.all([
        window.api.settings.summary().catch(() => null),
        window.api.settings.get(DISMISS_KEY).catch(() => null)
      ])
      if (cancelled) return
      setCloudConfigured(Boolean(summary?.secrets.ollama_cloud_key?.configured))
      setDismissed(dismissedValue === 'true')
    })()
    return () => { cancelled = true }
  }, [enabled])

  const dismiss = useCallback(() => {
    setDismissed(true)
    void window.api.settings.set(DISMISS_KEY, 'true')
  }, [])

  const markConfigured = useCallback(() => setCloudConfigured(true), [])

  return { eligible: enabled && cloudConfigured === false && dismissed === false, dismiss, markConfigured }
}

export interface SlowLocalNudgeState extends CloudNudgeGate {
  /** True only when slow inference is proven AND cloud isn't set up AND not dismissed. */
  show: boolean
  probe: LocalSpeedProbe | null
}

/**
 * Wizard-side variant: asks the main process to measure, since there's no live
 * chat turn to learn from. `enabled` holds the probe back until it's relevant
 * (the wizard only asks once Ollama is actually detected) because the probe can
 * take up to ~45s on exactly the machines this targets.
 */
export function useSlowLocalNudge(enabled: boolean): SlowLocalNudgeState {
  const [probe, setProbe] = useState<LocalSpeedProbe | null>(null)
  const gate = useCloudNudgeGate(enabled)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void window.api.models.speedProbe()
      .then((result) => { if (!cancelled) setProbe(result) })
      .catch(() => { /* unreachable Ollama → stay silent */ })
    return () => { cancelled = true }
  }, [enabled])

  return { ...gate, show: gate.eligible && probe?.verdict === 'slow', probe }
}

export default function CloudSpeedNudge(props: {
  probe: LocalSpeedProbe | null
  testId: string
  onDismiss: () => void
  onConfigured: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    const trimmed = key.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await window.api.settings.set('ollama_cloud_key', trimmed)
      setKey('')
      setExpanded(false)
      props.onConfigured()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="tip-banner cloud-speed-nudge" data-testid={props.testId}>
      <div className="cloud-speed-nudge-main">
        <span className="tip-banner-text">
          ☁ Local models on this machine may be slow for chat. Configure Ollama Cloud for faster responses?
        </span>
        {props.probe?.detail && (
          <span className="muted small cloud-speed-nudge-detail">{props.probe.detail}</span>
        )}
        {expanded && (
          <div className="cloud-key-row cloud-speed-nudge-row">
            <input
              type="password"
              className="cloud-key-input"
              placeholder="ollama_..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
              aria-label="Ollama Cloud API key"
              data-testid={`${props.testId}-key-input`}
              autoFocus
            />
            <button className="primary" disabled={!key.trim() || saving} onClick={() => void save()} data-testid={`${props.testId}-save`}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
        {expanded && (
          <span className="muted small cloud-speed-nudge-detail">
            Get a key at ollama.com/settings — it&apos;s stored locally in this workspace.
          </span>
        )}
      </div>
      <div className="tip-banner-actions">
        {!expanded && (
          <button className="ghost tiny" data-testid={`${props.testId}-configure`} onClick={() => setExpanded(true)}>
            Configure Ollama Cloud
          </button>
        )}
        <button
          className="ghost tiny tip-banner-close"
          aria-label="Dismiss Ollama Cloud suggestion"
          title="Dismiss"
          data-testid={`${props.testId}-dismiss`}
          onClick={props.onDismiss}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
