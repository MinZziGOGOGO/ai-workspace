import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BrowserApprovalRequest } from '../types'
import { useWindowFocused } from '../notify'
import { revealPanel, stopMotion } from '../motion'

function targetLabel(request: BrowserApprovalRequest): string | null {
  return request.targetOrigin || request.currentOrigin || null
}

/**
 * Approval scopes are the *agent identity* the request carries, not the panel
 * name — Step 3 established that a detached window may only decide the cards
 * its own agent raised, and Step 4 keeps that per-agent rather than collapsing
 * the four new tabs into one "detached" bucket. Chat never appears here: it has
 * no MCP client, so it can never originate a Browser approval.
 */
export type ApprovalScope = 'main' | 'claudecode' | 'hermes' | 'codex' | 'kimi'

export default function ApprovalCenter({ scope = 'main' }: { scope?: ApprovalScope }) {
  const [allRequests, setAllRequests] = useState<BrowserApprovalRequest[]>([])
  const [detachedAgents, setDetachedAgents] = useState<Set<string>>(
    () => (scope === 'main' ? new Set<string>() : new Set([scope]))
  )
  const [responding, setResponding] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const notifiedRef = useRef<Set<string>>(new Set())
  const focused = useWindowFocused()
  const requests = allRequests.filter((request) => (
    scope === 'main'
      ? !detachedAgents.has(request.agentId)
      : request.agentId === scope
  ))
  const current = requests[0]

  useEffect(() => {
    let disposed = false
    void window.api.approvals.list().then((items) => { if (!disposed) setAllRequests(items) })
    const off = window.api.approvals.onChanged(setAllRequests)
    return () => { disposed = true; off() }
  }, [])

  // The main window hides a card only while the agent that raised it owns its
  // own window. Claude Code reports through its pilot channels; Hermes/Codex/Kimi
  // through the shared Step 4 registry. An agent that is *not* detached keeps
  // showing its approvals here, so no request can end up displayed nowhere.
  useEffect(() => {
    if (scope !== 'main') return
    let disposed = false
    const update = (agent: string, detached: boolean) => setDetachedAgents((prev) => {
      const next = new Set(prev)
      if (detached) next.add(agent); else next.delete(agent)
      return next
    })
    void window.api.claudeCode.isDetached().then((detached) => { if (!disposed) update('claudecode', detached) })
    void window.api.agentPanel.listDetached().then((panels) => {
      if (disposed) return
      for (const panel of panels) update(panel, true)
    })
    const offClaudeCode = window.api.claudeCode.onDetachedChanged(({ detached }) => update('claudecode', detached))
    const offAgents = window.api.agentPanel.onDetachedChanged(({ panel, detached }) => update(panel, detached))
    return () => { disposed = true; offClaudeCode(); offAgents() }
  }, [scope])

  useEffect(() => {
    const covered = requests.length > 0
    window.dispatchEvent(new CustomEvent('approval-overlay-change', { detail: { covered } }))
    if (covered) {
      void window.api.browser.hideAll()
      requestAnimationFrame(() => cardRef.current?.focus())
    }
  }, [requests.length])

  useEffect(() => {
    if (!current) return
    if (notifiedRef.current.has(current.requestId)) return
    notifiedRef.current.add(current.requestId)
    void window.api.window.notifyApproval({ source: 'browser', summary: current.actionSummary, panelActive: focused })
  }, [current?.requestId])

  // Drop ids that are no longer pending. This set only exists to fire the
  // notification once per request, so anything already resolved is dead weight —
  // and request ids are fresh uuids, so a pruned id can never come back. It grew
  // for the life of the app before; now that reads prompt by default, approvals
  // are common enough that "small and unbounded" would stop being harmless.
  useEffect(() => {
    if (notifiedRef.current.size === 0) return
    const live = new Set(requests.map((request) => request.requestId))
    for (const id of notifiedRef.current) if (!live.has(id)) notifiedRef.current.delete(id)
  }, [requests])

  // Re-runs per request id, not just on first appearance: the card is reused for
  // queued requests, so without this a second request would swap the text in
  // place with no signal. The rise doubles as "this is a new decision".
  useEffect(() => {
    if (!current) return
    const anim = revealPanel(cardRef.current)
    return () => stopMotion(anim)
  }, [current?.requestId])

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
