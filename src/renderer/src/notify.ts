import { useCallback, useEffect, useRef, useState } from 'react'

const SOUND_SETTING_KEY = 'notify_sound_enabled'
export const SETTING_CHANGED_EVENT = 'aiworkspace:setting-changed'

export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  return focused
}

// A short, soft blip synthesized with Web Audio rather than a bundled audio
// asset, so the (off-by-default) sound has zero footprint until enabled.
export function playCompletionSound(): void {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 800
    gain.gain.setValueAtTime(0.1, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)
    osc.start()
    osc.stop(ctx.currentTime + 0.15)
    osc.onended = () => void ctx.close()
  } catch { /* Web Audio unavailable in this environment — skip silently */ }
}

// Call from an agent tab's onDone handler once a response finishes. Plays the
// completion chime (if the setting is on) and pings the main process for a
// taskbar cue — but only when the window is unfocused or this tab isn't the
// visible panel. Never fires for a completion the user is already looking at.
export function useCompletionNotifier(panelActive: boolean): () => void {
  const focused = useWindowFocused()
  const [soundEnabled, setSoundEnabled] = useState(false)
  const stateRef = useRef({ focused, panelActive, soundEnabled })
  stateRef.current = { focused, panelActive, soundEnabled }

  useEffect(() => {
    window.api.settings.get(SOUND_SETTING_KEY).then((v) => setSoundEnabled(v === 'true')).catch(() => {})
    function onChange(e: Event) {
      const detail = (e as CustomEvent<{ key: string; value: string }>).detail
      if (detail?.key === SOUND_SETTING_KEY) setSoundEnabled(detail.value === 'true')
    }
    window.addEventListener(SETTING_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(SETTING_CHANGED_EVENT, onChange)
  }, [])

  return useCallback(() => {
    const { focused: isFocused, panelActive: isPanelActive, soundEnabled: isSoundEnabled } = stateRef.current
    if (isFocused && isPanelActive) return
    if (isSoundEnabled) playCompletionSound()
    void window.api.window.notifyActivity()
  }, [])
}
