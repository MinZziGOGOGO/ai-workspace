import { useEffect, useState } from 'react'
import type { Project, MemoryItem } from '../types'
import { GLOBAL_PROJECT_ID, isGlobalProjectId } from '../../../shared/globalWorkspace'
import { StatusBadge, WorkspaceEmptyState } from './WorkspacePrimitives'

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

export default function KnowledgePanel(props: { project: Project }) {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [selectedItem, setSelectedItem] = useState<MemoryItem | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('project')
  const isGlobalWorkspace = isGlobalProjectId(props.project.id)
  // Use the sentinel for global-panel "project" scope. The backend's project
  // scope returns sentinel-scoped items plus project_id NULL shared memories,
  // without pulling in folder-specific memory from normal projects.
  const scopedProjectId = isGlobalWorkspace ? GLOBAL_PROJECT_ID : props.project.id
  const scopes = isGlobalWorkspace ? GLOBAL_SCOPES : SCOPES

  // The unfiltered list only distinguishes project vs everything; the finer
  // "related" scope matters when searching (it widens the candidate set).
  const refresh = (s: Scope = scope) =>
    window.api.memory.list(s === 'global' ? null : scopedProjectId).then(setItems)

  useEffect(() => {
    setScope('project')
    setSelectedItem(null)
    window.api.memory.list(scopedProjectId).then(setItems)
  }, [props.project.id, scopedProjectId])

  useEffect(() => {
    setSelectedItem((current) => {
      if (!current) return null
      return items.find((item) => item.id === current.id) ?? null
    })
  }, [items])

  useEffect(() => {
    if (!selectedItem) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedItem(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedItem])

  useEffect(() => {
    setCopyState('idle')
  }, [selectedItem?.id])

  // Live-refresh when the background indexer writes memory for this project,
  // but only while showing the unfiltered list (don't clobber active searches).
  useEffect(() => {
    return window.api.memory.onIndexed((d) => {
      if (!query.trim() && (scope === 'global' || d.projectIds.includes(scopedProjectId))) refresh()
    })
  }, [query, scope, scopedProjectId])

  async function search(s: Scope = scope) {
    if (!query.trim()) return refresh(s)
    setItems(await window.api.memory.search(query, s, scopedProjectId))
  }

  function changeScope(s: Scope) {
    setScope(s)
    // Re-run the current view (search or list) under the new scope.
    void search(s)
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
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <button className="ghost tiny" onClick={() => search()} disabled={!query.trim()}>
          Search
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
          <li key={m.id} className={`memory-item ${selectedItem?.id === m.id ? 'selected' : ''}`}>
            <button
              type="button"
              className="memory-open"
              data-testid="knowledge-item"
              aria-label={`Inspect knowledge item: ${m.title}`}
              onClick={() => setSelectedItem(m)}
            >
              <div className="memory-head">
                <span className={`pill pill-${m.type}`}>{m.type}</span>
                <span className="muted small">
                  {m.source}{m.score !== undefined ? ` - ${(m.score * 100).toFixed(0)}%` : ''}
                </span>
              </div>
              <div className="memory-title">{m.title}</div>
              <div className="memory-content muted small">{snippetAt(m.content, 200)}</div>
            </button>
            <button
              className="ghost tiny memory-delete"
              title="Delete memory"
              aria-label={`Delete memory: ${m.title}`}
              onClick={async () => {
                await window.api.memory.delete(m.id)
                if (selectedItem?.id === m.id) setSelectedItem(null)
                refresh()
              }}
            >
              x
            </button>
          </li>
        ))}
      </ul>
      {selectedItem && (
        <section
          key={selectedItem.id}
          className="knowledge-detail motion-detail"
          data-testid="knowledge-detail"
          role="dialog"
          aria-label="Knowledge item details"
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
            <div><span>Tags</span>{selectedTags}</div>
            <div><span>ID</span>{selectedItem.id}</div>
          </div>
          <div className="knowledge-detail-content" data-testid="knowledge-detail-content">
            {selectedItem.content?.trim() ? selectedItem.content : 'No content is stored for this knowledge item.'}
          </div>
          <div className="knowledge-detail-actions">
            <button
              type="button"
              className="ghost tiny"
              data-testid="knowledge-detail-copy"
              onClick={copySelectedContent}
              disabled={!selectedItem.content?.trim()}
            >
              {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy'}
            </button>
          </div>
        </section>
      )}
    </aside>
  )
}
