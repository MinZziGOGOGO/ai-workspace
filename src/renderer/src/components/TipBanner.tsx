import { useState } from 'react'
import { useActiveTip } from '../tips'

// Renders the single app-session tip (if any) chosen by tips.ts. Hosted in
// Chat since it's the workspace's landing panel — the tip conditions are
// evaluated once regardless of which panel first mounts this.
export default function TipBanner() {
  const tip = useActiveTip()
  const [dismissed, setDismissed] = useState(false)

  if (!tip || dismissed) return null

  function dismiss() {
    setDismissed(true)
    void window.api.tips.dismiss(tip!.id)
  }

  function runCta() {
    const action = tip!.cta?.action
    if (action?.startsWith('open_panel:')) {
      const panel = action.slice('open_panel:'.length)
      window.dispatchEvent(new CustomEvent('workspace:openPanel', { detail: { panel } }))
    }
    dismiss()
  }

  return (
    <div className="tip-banner" data-testid={`tip-${tip.id}`}>
      <span className="tip-banner-text">💡 {tip.text}</span>
      <div className="tip-banner-actions">
        {tip.cta && <button className="ghost tiny" onClick={runCta}>{tip.cta.label}</button>}
        <button className="ghost tiny tip-banner-close" aria-label="Dismiss tip" title="Dismiss" onClick={dismiss}>✕</button>
      </div>
    </div>
  )
}
