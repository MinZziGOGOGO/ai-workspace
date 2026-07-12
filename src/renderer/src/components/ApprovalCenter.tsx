import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BrowserApprovalRequest } from '../types'

function targetLabel(request: BrowserApprovalRequest): string | null {
  return request.targetOrigin || request.currentOrigin || null
}

export default function ApprovalCenter() {
  const [requests, setRequests] = useState<BrowserApprovalRequest[]>([])
  const [responding, setResponding] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const current = requests[0]

  useEffect(() => {
    let disposed = false
    void window.api.approvals.list().then((items) => { if (!disposed) setRequests(items) })
    const off = window.api.approvals.onChanged(setRequests)
    return () => { disposed = true; off() }
  }, [])

  useEffect(() => {
    const covered = requests.length > 0
    window.dispatchEvent(new CustomEvent('approval-overlay-change', { detail: { covered } }))
    if (covered) {
      void window.api.browser.hideAll()
      requestAnimationFrame(() => cardRef.current?.focus())
    }
  }, [requests.length])

  async function respond(approved: boolean, allowForSession = false) {
    if (!current || responding) return
    setResponding(true)
    try {
      await window.api.approvals.respond({ requestId: current.requestId, approved, allowForSession })
    } finally {
      setResponding(false)
    }
  }

  if (!current) return null
  const target = targetLabel(current)
  return createPortal(
    <div className="approval-overlay" data-testid="approval-overlay">
      <div
        ref={cardRef}
        className="approval-card"
        data-testid="browser-approval-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        tabIndex={-1}
      >
        <header className="approval-card-header">
          <div>
            <div className="approval-eyebrow">Browser permission</div>
            <h2 id="approval-title">{current.actionSummary}</h2>
          </div>
          <span className={`approval-scope ${current.leavesLocalhost ? 'external' : 'local'}`}>
            {current.leavesLocalhost ? 'External' : 'Local'}
          </span>
        </header>

        <div className="approval-agent">
          <span>{current.agentName}</span>
          {!current.identityVerified && <span className="approval-unverified">Unverified identity</span>}
        </div>

        {target && <div className="approval-target" title={current.targetUrl || current.currentUrl}>{target}</div>}
        {(current.elementRole || current.elementName) && (
          <div className="approval-detail">
            {current.elementRole || 'element'}{current.elementName ? ` · ${current.elementName}` : ''}
          </div>
        )}
        {current.redactedInputPreview && (
          <div className={`approval-preview${current.sensitive ? ' sensitive' : ''}`}>
            {current.redactedInputPreview}
          </div>
        )}
        {current.characterCount != null && <div className="approval-detail">{current.characterCount} characters</div>}
        {current.riskFlags.length > 0 && (
          <ul className="approval-risks">
            {current.riskFlags.map((risk) => <li key={risk}>{risk}</li>)}
          </ul>
        )}

        <div className="approval-actions">
          <button className="ghost" data-testid="browser-approval-deny" disabled={responding} onClick={() => void respond(false)}>Deny</button>
          <button className="primary" data-testid="browser-approval-approve" disabled={responding} onClick={() => void respond(true)}>Approve once</button>
          <button className="ghost" data-testid="browser-approval-session" disabled={responding || current.sensitive} onClick={() => void respond(true, true)}>Allow for session</button>
        </div>
        {requests.length > 1 && <div className="approval-queue-count">{requests.length - 1} more request{requests.length === 2 ? '' : 's'} waiting</div>}
      </div>
    </div>,
    document.body,
  )
}
