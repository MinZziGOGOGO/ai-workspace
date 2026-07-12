import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Project, MemoryItem, KnowledgeDiagnostics } from '../types'
import { GLOBAL_PROJECT_ID, isGlobalProjectId } from '../../../shared/globalWorkspace'
import { StatusBadge, WorkspaceEmptyState } from './WorkspacePrimitives'
import { useToast } from './ToastContext'
import { collapseElement } from '../motion'

// Memory you can't inspect is memory you can't trust. This panel ships with
// the memory system itself, not after it: list, search, delete - now across
// three scopes (M7): this project, related (project_links), or everything.

const SCOPES = [
  { id: 'project', label: 'This project' },
  { id: 'related', label: 'Related' },
  { id: 'global', label: 'All projects' }
] as const
type Scope = (typeof SCOPES)[number]['id']

const GLOBAL_SCOPES: { id: Scope; label: string }[] = [
  { id: 'project', label: 'Global memory' },
  { id: 'global', label: 'All projects' }
]

function snippetAt(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf(' ', max)
  return text.slice(0, cut > 0 ? cut : max) + '...'
}

function formatDate(ts: number | null | undefined): string {
  if (!ts) return 'Unknown'
  return new Date(ts).toLocaleString()
}

function KnowledgeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H20v14H6.5A2.5 2.5 0 0 1 4 15.5z" />
      <path d="M4 15.5A2.5 2.5 0 0 0 6.5 18H20" />
      <path d="M8 8h8M8 11h6" />
    </svg>
  )
}

export default function KnowledgePanel(props: {
  project: Project
  onOpenProject?: (p: Project) => void
}) {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [selectedItem, setSelectedItem] = useState<MemoryItem | null>(null)
  const [diagnostics, setDiagnostics] = useState<KnowledgeDiagnostics | null>(null)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('project')
  const [searching, setSearching] = useState(false)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [staleUpdatingId, setStaleUpdatingId] = useState<string | null>(null)
  const [linkedProjects, setLinkedProjects] = useState<Project[]>([])
  const [showLinkModal, setShowLinkModal] = useState(false)
  const [availableProjects, setAvailableProjects] = useState<Project[]>([])
  const [linkTarget, setLinkTarget] = useState('')
  const { addToast } = useToast()
  const itemRefs = useRef<Record<string, HTMLLIElement | null>>({})
  const isGlobalWorkspace = isGlobalProjectId(props.project.id)
  // Use the sentinel for global-panel "project" scope. The backend's project
  // scope returns sentinel-scoped items plus project_id NULL shared memories,
  // without pulling in folder-specific memory from normal projects.
  const scopedProjectId = isGlobalWorkspace ? GLOBAL_PROJECT_ID : props.project.id
  const scopes = isGlobalWorkspace ? GLOBAL_SCOPES : SCOPES

  // The unfiltered list only distinguishes project vs everything; the finer
  // "related" scope matters when searching (it widens the candidate set).
  async function refreshDiagnostics(s: Scope = scope) {
    setDiagnosticsLoading(true)
    try {
      setDiagnostics(await window.api.memory.diagnostics(s === 'global' ? null : scopedProjectId))
    } catch (err) {
      addToast(`Failed to refresh diagnostics: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setDiagnosticsLoading(false)
    }
  }

  async function refresh(s: Scope = scope) {
    try {
      const [nextItems] = await Promise.all([
        window.api.memory.list(s === 'global' ? null : scopedProjectId),
        refreshDiagnostics(s)
      ])
      setItems(nextItems)
    } catch (err) {
      addToast(`Failed to refresh Knowledge: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  useEffect(() => {
    setScope('project')
    setSelectedItem(null)
    void refresh('project')
  }, [props.project.id, scopedProjectId])

  // Linked projects only exist for folder-backed projects, not the sentinel.
  useEffect(() => {
    setShowLinkModal(false)
    if (isGlobalWorkspace) {
      setLinkedProjects([])
      return
    }
    window.api.projects.getLinks(props.project.id).then(setLinkedProjects)
  }, [props.project.id, isGlobalWorkspace])

  useEffect(() => {
    setSelectedItem((current) => {
      if (!current) return null
      return items.find((item) => item.id === current.id) ?? null
    })
  }, [items])

  useEffect(() => {
    if (!selectedItem) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (editing?.id === selectedItem.id) setEditing(null)
      else setSelectedItem(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editing, selectedItem])

  useEffect(() => {
    setCopyState('idle')
    setEditing(null)
  }, [selectedItem?.id])

  // Live-refresh when the background indexer writes memory for this project,
  // but only while showing the unfiltered list (don't clobber active searches).
  useEffect(() => {
    return window.api.memory.onIndexed((d) => {
      if (!query.trim() && (scope === 'global' || d.projectIds.includes(scopedProjectId))) refresh()
    })
  }, [query, scope, scopedProjectId])

  async function search(s: Scope = scope) {
    setSearching(true)
    try {
      if (!query.trim()) {
        await refresh(s)
        return
      }
      setItems(await window.api.memory.search(query, s, scopedProjectId))
      await refreshDiagnostics(s)
    } catch (err) {
      addToast(`Knowledge search failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setSearching(false)
    }
  }

  function changeScope(s: Scope) {
    setScope(s)
    // Re-run the current view (search or list) under the new scope.
    void search(s)
  }

  // Persist an edited memory: memory:save always inserts a new row, so save
  // the corrected copy first (re-embedding it), then remove the stale one.
  async function commitEdit(item: MemoryItem) {
    const content = editing?.value.trim() ?? ''
    if (editing?.id !== item.id) return
    if (!content) {
      addToast('Memory content cannot be empty')
      return
    }
    if (content === item.content) {
      setEditing(null)
      return
    }
    setEditSaving(true)
    try {
      const saved = await window.api.memory.save({
        projectId: item.project_id,
        type: item.type,
        title: item.title,
        content,
        source: item.source,
        tags: item.tags
      }) as MemoryItem
      await window.api.memory.delete(item.id)
      setSelectedItem(saved)
      setEditing(null)
      await refresh()
      addToast('Memory updated')
    } catch (err) {
      setEditing({ id: item.id, value: content })
      addToast(`Failed to update memory: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setEditSaving(false)
    }
  }

  async function inspectItem(item: MemoryItem) {
    const alreadyOpen = selectedItem?.id === item.id
    setSelectedItem(item)
    if (alreadyOpen) return
    try {
      await window.api.memory.touch(item.id)
      setItems((prev) => prev.map((m) => m.id === item.id ? {
        ...m,
        last_accessed_at: Date.now(),
        access_count: (m.access_count ?? 0) + 1
      } : m))
      setSelectedItem((prev) => prev?.id === item.id ? {
        ...prev,
        last_accessed_at: Date.now(),
        access_count: (prev.access_count ?? 0) + 1
      } : prev)
      await refreshDiagnostics()
    } catch {
      // Telemetry should never block inspection.
    }
  }

  async function deleteItem(item: MemoryItem) {
    const ok = window.confirm(`Delete "${item.title}" from Knowledge? This cannot be undone.`)
    if (!ok) return
    setDeletingId(item.id)
    try {
      await window.api.memory.delete(item.id)
      const row = itemRefs.current[item.id]
      if (row) await collapseElement(row)
      if (selectedItem?.id === item.id) setSelectedItem(null)
      await refresh()
      addToast('Memory deleted')
    } catch (err) {
      addToast(`Failed to delete memory: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setDeletingId(null)
    }
  }

  async function toggleStale(item: MemoryItem) {
    const stale = !item.stale_at
    setStaleUpdatingId(item.id)
    try {
      await window.api.memory.markStale(item.id, stale)
      const patch = { stale_at: stale ? Date.now() : null }
      setItems((prev) => prev.map((m) => m.id === item.id ? { ...m, ...patch } : m))
      setSelectedItem((prev) => prev?.id === item.id ? { ...prev, ...patch } : prev)
      await refreshDiagnostics()
      addToast(stale ? 'Marked stale' : 'Stale mark removed')
    } catch (err) {
      addToast(`Failed to update stale state: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setStaleUpdatingId(null)
    }
  }

  async function reviewLowQualityCandidates() {
    setDiagnosticsLoading(true)
    try {
      const diag = diagnostics ?? await window.api.memory.diagnostics(scope === 'global' ? null : scopedProjectId)
      setDiagnostics(diag)
      setQuery('')
      setSelectedItem(null)
      setItems(diag.lowQualityCandidates)
    } catch (err) {
      addToast(`Failed to review candidates: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setDiagnosticsLoading(false)
    }
  }

  async function deleteLowQualityCandidates() {
    const count = diagnostics?.lowQualityCount ?? 0
    if (count === 0) return
    const phrase = 'DELETE LOW QUALITY'
    const typed = window.prompt(
      `Type "${phrase}" to bulk-delete low-quality Knowledge candidates. Decisions and user-created notes are skipped. This cannot be undone.`
    )
    if (typed !== phrase) return
    setDiagnosticsLoading(true)
    try {
      const removed = await window.api.memory.deleteLowQualityCandidates(scope === 'global' ? null : scopedProjectId)
      setSelectedItem(null)
      await refresh()
      addToast(`Deleted ${removed} candidate${removed === 1 ? '' : 's'}`)
    } catch (err) {
      addToast(`Failed to delete candidates: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setDiagnosticsLoading(false)
    }
  }

  async function openLinkModal() {
    const available = await window.api.projects.getAvailableLinkTargets(props.project.id)
    setAvailableProjects(available)
    setLinkTarget(available[0]?.id ?? '')
    setShowLinkModal(true)
  }

  async function linkProject() {
    if (!linkTarget) return
    const result = await window.api.projects.addLink(props.project.id, linkTarget)
    if (result.success) {
      const target = availableProjects.find((p) => p.id === linkTarget)
      setLinkedProjects(await window.api.projects.getLinks(props.project.id))
      setShowLinkModal(false)
      addToast(`Linked to ${target?.name ?? 'project'}`)
    } else {
      addToast(`Failed to link: ${result.error}`)
    }
  }

  async function removeLink(target: Project) {
    const result = await window.api.projects.removeLink(props.project.id, target.id)
    if (result.success) {
      setLinkedProjects((prev) => prev.filter((p) => p.id !== target.id))
      addToast(`Unlinked from ${target.name}`)
    } else {
      addToast(`Failed to unlink: ${result.error}`)
    }
  }

  async function copySelectedContent() {
    if (!selectedItem) return
    try {
      await navigator.clipboard.writeText(selectedItem.content || '')
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  const scopeLabel = scopes.find(s => s.id === scope)?.label ?? 'Memory'
  const selectedTags = selectedItem?.tags?.length ? selectedItem.tags.join(', ') : 'None'

  return (
    <aside className="knowledge-panel">
      <div className="knowledge-panel-head">
        <div>
          <h3>Knowledge</h3>
          <p className="muted small">
            {isGlobalWorkspace
              ? 'Shared memory not tied to a project. Wrong memories can be deleted.'
              : 'What the workspace knows. Wrong memories can be deleted.'}
          </p>
        </div>
        <StatusBadge tone={items.length > 0 ? 'success' : 'neutral'}>{items.length} {items.length === 1 ? 'item' : 'items'}</StatusBadge>
      </div>
      <div className="knowledge-search">
        <input
          placeholder="Search memory..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !searching && search()}
        />
        <button className="ghost tiny" onClick={() => search()} disabled={!query.trim() || searching}>
          {searching ? 'Searching...' : 'Search'}
        </button>
        {query.trim() && (
          <button className="ghost tiny" onClick={() => { setQuery(''); void refresh() }}>
            Clear
          </button>
        )}
      </div>
      <div className="scope-seg" role="group" aria-label="Search scope">
        {scopes.map((s) => (
          <button
            key={s.id}
            className={`scope-seg-btn ${scope === s.id ? 'active' : ''}`}
            onClick={() => changeScope(s.id)}
            title={
              s.id === 'project'
                ? 'This project + global knowledge'
                : s.id === 'related'
                  ? 'Adds linked projects'
                  : 'Everything, including archived projects'
            }
          >
            {s.label}
          </button>
        ))}
      </div>
      <section className="knowledge-diagnostics" data-testid="knowledge-diagnostics" aria-label="Knowledge diagnostics">
        <div className="knowledge-diag-grid">
          <div><span>Total</span><strong>{diagnostics?.total ?? items.length}</strong></div>
          <div><span>Embedded</span><strong>{diagnostics ? `${diagnostics.embeddingsPresent}/${diagnostics.total}` : '...'}</strong></div>
          <div><span>Unused</span><strong>{diagnostics?.unusedCount ?? '...'}</strong></div>
          <div><span>Stale</span><strong>{diagnostics?.staleCount ?? '...'}</strong></div>
          <div><span>Recent hits</span><strong>{diagnostics?.recentlyAccessedCount ?? '...'}</strong></div>
          <div><span>Review</span><strong>{diagnostics?.lowQualityCount ?? '...'}</strong></div>
        </div>
        <div className="knowledge-diag-actions">
          <button className="ghost tiny" onClick={() => refreshDiagnostics()} disabled={diagnosticsLoading}>{diagnosticsLoading ? 'Refreshing...' : 'Refresh diagnostics'}</button>
          <button className="ghost tiny" onClick={reviewLowQualityCandidates} disabled={!diagnostics?.lowQualityCount || diagnosticsLoading} data-testid="knowledge-review-low-quality">
            Review candidates
          </button>
          <button className="ghost tiny settings-danger-link" onClick={deleteLowQualityCandidates} disabled={!diagnostics?.lowQualityCount || diagnosticsLoading} data-testid="knowledge-delete-low-quality">
            Delete candidates
          </button>
        </div>
        {diagnostics && (
          <p className="muted small">
            Types: {Object.entries(diagnostics.byType).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.
            {' '}Sources: {Object.entries(diagnostics.bySource).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.
          </p>
        )}
      </section>
      {items.length === 0 && (
        <WorkspaceEmptyState
          compact
          icon={<KnowledgeIcon />}
          title={query.trim() ? 'No matching knowledge' : 'No knowledge saved yet'}
          body={query.trim()
            ? `Nothing matched "${query.trim()}" in ${scopeLabel}. Try another scope or a shorter search.`
            : 'Save useful answers from Chat, completed agent runs, indexed files, or research findings here.'}
        />
      )}
      <ul className="memory-list motion-list motion-list-tight">
        {items.map((m) => (
          <li key={m.id} ref={(el) => { itemRefs.current[m.id] = el }} className={`memory-item ${selectedItem?.id === m.id ? 'selected' : ''}`}>
            <button
              type="button"
              className="memory-open"
              data-testid="knowledge-item"
              aria-label={`Inspect knowledge item: ${m.title}`}
              onClick={() => void inspectItem(m)}
            >
              <div className="memory-head">
                <span className={`pill pill-${m.type}`}>{m.type}</span>
                <span className="muted small">
                  {m.source}{m.score !== undefined ? ` - ${(m.score * 100).toFixed(0)}%` : ''}
                  {m.stale_at ? ' - stale' : ''}
                </span>
              </div>
              <div className="memory-title">{m.title}</div>
              <div className="memory-content muted small">{snippetAt(m.content, 200)}</div>
            </button>
            <button
              className="ghost tiny memory-delete"
              title="Delete memory"
              aria-label={`Delete memory: ${m.title}`}
              disabled={deletingId === m.id}
              onClick={() => void deleteItem(m)}
            >
              {deletingId === m.id ? '...' : '×'}
            </button>
          </li>
        ))}
      </ul>
      {selectedItem && createPortal(
        <div className="knowledge-detail-backdrop" onClick={() => setSelectedItem(null)}>
          <section
            key={selectedItem.id}
            className="knowledge-detail motion-detail"
            data-testid="knowledge-detail"
            role="dialog"
            aria-modal="true"
            aria-label="Knowledge item details"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="knowledge-detail-head">
              <div className="knowledge-detail-title-wrap">
                <span className={`pill pill-${selectedItem.type}`}>{selectedItem.type}</span>
                <h2>{selectedItem.title || 'Untitled knowledge item'}</h2>
                <p className="muted small">{selectedItem.source || 'Unknown source'}</p>
              </div>
              <button
                type="button"
                className="ghost tiny"
                data-testid="knowledge-detail-close"
                onClick={() => setSelectedItem(null)}
                aria-label="Close knowledge details"
              >
                Close
              </button>
            </div>
            <div className="knowledge-detail-meta" aria-label="Knowledge item metadata">
              <div><span>Created</span>{formatDate(selectedItem.created_at)}</div>
              <div><span>Updated</span>{formatDate(selectedItem.updated_at)}</div>
              <div><span>Last used</span>{formatDate(selectedItem.last_accessed_at)}</div>
              <div><span>Uses</span>{selectedItem.access_count ?? 0}</div>
              <div><span>Status</span>{selectedItem.stale_at ? `Stale since ${formatDate(selectedItem.stale_at)}` : 'Active'}</div>
              <div><span>Tags</span>{selectedTags}</div>
              <div><span>ID</span>{selectedItem.id}</div>
            </div>
            {(selectedItem.quality_reason || selectedItem.quality_flags?.length) && (
              <div className="knowledge-quality-note" data-testid="knowledge-quality-note">
                {selectedItem.quality_reason ?? 'Review suggested'}
                {selectedItem.quality_flags?.length ? ` (${selectedItem.quality_flags.join(', ')})` : ''}
              </div>
            )}
            {editing?.id === selectedItem.id ? (
              <textarea
                className="knowledge-detail-editor"
                data-testid="knowledge-detail-editor"
                value={editing.value}
                autoFocus
                disabled={editSaving}
                aria-label={`Edit knowledge item: ${selectedItem.title}`}
                onChange={(e) => setEditing({ id: selectedItem.id, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null) }
                }}
              />
            ) : (
              <div className="knowledge-detail-content" data-testid="knowledge-detail-content">
                {selectedItem.content?.trim() ? selectedItem.content : 'No content is stored for this knowledge item.'}
              </div>
            )}
            <div className="knowledge-detail-actions">
              {editing?.id === selectedItem.id ? (
                <>
                  <button
                    type="button"
                    className="ghost tiny"
                    data-testid="knowledge-detail-cancel-edit"
                    onClick={() => setEditing(null)}
                    disabled={editSaving}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary tiny"
                    data-testid="knowledge-detail-save-edit"
                    onClick={() => void commitEdit(selectedItem)}
                    disabled={editSaving}
                  >
                    {editSaving ? 'Saving...' : 'Save'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ghost tiny"
                    data-testid="knowledge-detail-edit"
                    onClick={() => setEditing({ id: selectedItem.id, value: selectedItem.content })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    data-testid="knowledge-detail-copy"
                    onClick={copySelectedContent}
                    disabled={!selectedItem.content?.trim()}
                  >
                    {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    className="ghost tiny"
                    data-testid="knowledge-detail-stale"
                    disabled={staleUpdatingId === selectedItem.id}
                    onClick={() => void toggleStale(selectedItem)}
                  >
                    {staleUpdatingId === selectedItem.id ? 'Updating...' : selectedItem.stale_at ? 'Mark active' : 'Mark stale'}
                  </button>
                  <button
                    type="button"
                    className="ghost tiny settings-danger-link"
                    data-testid="knowledge-detail-delete"
                    disabled={deletingId === selectedItem.id}
                    onClick={() => void deleteItem(selectedItem)}
                  >
                    {deletingId === selectedItem.id ? 'Deleting...' : 'Delete'}
                  </button>
                </>
              )}
            </div>
          </section>
        </div>,
        document.body
      )}
      {!isGlobalWorkspace && (
        <div className="knowledge-related-projects" data-testid="related-projects">
          <div className="related-projects-header">
            <span className="related-projects-title">Related Projects</span>
            <button
              type="button"
              className="related-projects-add-btn"
              data-testid="related-projects-add"
              onClick={openLinkModal}
            >
              + Link project
            </button>
          </div>
          {linkedProjects.length === 0 ? (
            <p className="muted small">
              No linked projects. Link a project to share context across codebases.
            </p>
          ) : (
            <div className="related-projects-list">
              {linkedProjects.map((p) => (
                <div
                  key={p.id}
                  className="related-project-item"
                  data-testid="related-project-item"
                  title={p.path}
                  onClick={() => props.onOpenProject?.(p)}
                >
                  <span>{p.name}</span>
                  <button
                    type="button"
                    className="related-project-remove"
                    title={`Unlink ${p.name}`}
                    aria-label={`Unlink ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeLink(p)
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {showLinkModal && (
        <div className="link-project-modal" onClick={() => setShowLinkModal(false)}>
          <div
            className="link-project-card"
            role="dialog"
            aria-label="Link a project"
            data-testid="link-project-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="link-project-title">Link a project</div>
            {availableProjects.length === 0 ? (
              <p className="muted small">No other projects available to link.</p>
            ) : (
              <select
                className="link-project-select"
                aria-label="Select a project to link"
                value={linkTarget}
                onChange={(e) => setLinkTarget(e.target.value)}
              >
                {availableProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <div className="link-project-actions">
              <button type="button" onClick={() => setShowLinkModal(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!linkTarget}
                onClick={() => void linkProject()}
              >
                Link
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
