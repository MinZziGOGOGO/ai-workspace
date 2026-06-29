import { useEffect, useRef, useState } from 'react'
import type { Project, MemoryItem, ResearchProgress } from '../types'
import Markdown from './Markdown'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { StatusBadge, WorkspaceNotice } from './WorkspacePrimitives'

interface StageState {
  key: string
  label: string
  status: 'pending' | 'running' | 'done' | 'error'
  detail: string
}

const STAGES: { key: string; label: string }[] = [
  { key: 'plan',       label: 'Planning search queries' },
  { key: 'search',     label: 'Searching' },
  { key: 'read',       label: 'Reading sources' },
  { key: 'synthesize', label: 'Synthesizing findings' },
  { key: 'save',       label: 'Saving to knowledge base' },
]

type PanelState = 'launcher' | 'running' | 'report'

export default function ResearchPanel({
  project,
  onOpenKnowledge,
}: {
  project: Project
  onOpenKnowledge: () => void
}) {
  const isGlobal = isGlobalProjectId(project.id)
  const memoryProjectId = isGlobal ? null : project.id

  const [panelState, setPanelState] = useState<PanelState>('launcher')
  const [topic, setTopic] = useState('')
  const [scope, setScope] = useState<'web' | 'local' | 'both'>('both')
  const [saveToProject, setSaveToProject] = useState(!isGlobal)
  const [stages, setStages] = useState<StageState[]>(
    STAGES.map(s => ({ ...s, status: 'pending', detail: '' }))
  )
  const [report, setReport] = useState('')
  const [pipelineError, setPipelineError] = useState<string | null>(null)
  const [pastResearch, setPastResearch] = useState<MemoryItem[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searxngInput, setSearxngInput] = useState('http://localhost:8080')
  const [searxngSaved, setSearxngSaved] = useState('http://localhost:8080')
  const settingsWrapRef = useRef<HTMLDivElement>(null)

  // Reload past research whenever the launcher is shown
  useEffect(() => {
    if (panelState !== 'launcher') return
    window.api.memory
      .list(memoryProjectId)
      .then(items => setPastResearch(items.filter(it => it.type === 'research')))
      .catch(() => {})
  }, [panelState, memoryProjectId])

  // Load stored SearXNG URL on mount
  useEffect(() => {
    window.api.settings.get('searxng_url').then(val => {
      const url = val ?? 'http://localhost:8080'
      setSearxngInput(url)
      setSearxngSaved(url)
    }).catch(() => {})
  }, [])

  // Subscribe to pipeline progress events for the lifetime of the panel
  useEffect(() => {
    const off = window.api.research.onProgress((d: ResearchProgress) => {
      if (d.stage === 'done') {
        setReport(d.detail)
        setPanelState('report')
        return
      }
      if (d.stage === 'error') {
        setPipelineError(d.detail)
        setStages(prev =>
          prev.map(s => s.status === 'running' ? { ...s, status: 'error', detail: d.detail } : s)
        )
        return
      }
      setStages(prev =>
        prev.map(s =>
          s.key === d.stage ? { ...s, status: d.status as StageState['status'], detail: d.detail } : s
        )
      )
    })
    return off
  }, [])

  // Close settings popover when clicking outside
  useEffect(() => {
    if (!settingsOpen) return
    const handler = (e: MouseEvent) => {
      if (settingsWrapRef.current && !settingsWrapRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [settingsOpen])

  async function startResearch() {
    if (!topic.trim()) return
    setStages(STAGES.map(s => ({ ...s, status: 'pending', detail: '' })))
    setPipelineError(null)
    setPanelState('running')
    await window.api.research.start({
      topic: topic.trim(),
      scope,
      projectId: memoryProjectId,
      saveToProject,
    })
  }

  async function cancelResearch() {
    await window.api.research.cancel()
    setPanelState('launcher')
  }

  async function saveSettings() {
    const url = searxngInput.trim() || 'http://localhost:8080'
    await window.api.settings.set('searxng_url', url)
    setSearxngSaved(url)
    setSearxngInput(url)
    setSettingsOpen(false)
  }

  // ── Running (State B) ──────────────────────────────────────────────────────

  if (panelState === 'running') {
    const runningStage = stages.find(s => s.status === 'running')
    const activeDetail = runningStage?.detail || ''
    return (
      <div className="research-panel">
        <div className="research-running">
          <div className="research-running-title">Researching: {topic}</div>
          <div className="research-timeline motion-list motion-list-tight">
            {stages.map((s) => (
              <div key={s.key} className={`research-timeline-step ${s.status}`}>
                <div className="research-timeline-dot" aria-label={`${s.label}: ${s.status}`}>
                  {s.status === 'done' && (
                    <svg viewBox="0 0 12 12" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                      <polyline points="2,6 5,9 10,3" />
                    </svg>
                  )}
                  {s.status === 'error' && (
                    <svg viewBox="0 0 12 12" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                      <line x1="3" y1="3" x2="9" y2="9" /><line x1="9" y1="3" x2="3" y2="9" />
                    </svg>
                  )}
                </div>
                <div className="research-timeline-label">
                  {s.label.split(' ')[0]}
                </div>
              </div>
            ))}
          </div>
          {activeDetail && (
            <div className="research-running-detail">{activeDetail}</div>
          )}
          {pipelineError && (
            <WorkspaceNotice title="Research failed" tone="error">
              {pipelineError}
            </WorkspaceNotice>
          )}
          <div>
            <button className="danger" onClick={cancelResearch}>Cancel</button>
          </div>
        </div>
      </div>
    )
  }

  // ── Report (State C) ───────────────────────────────────────────────────────

  if (panelState === 'report') {
    return (
      <div className="research-panel">
        <div className="research-report-view motion-section">
          <div className="research-report-actions">
            <button className="ghost" onClick={() => setPanelState('launcher')}>
              New research
            </button>
            <button className="ghost" onClick={onOpenKnowledge}>
              Open Knowledge
            </button>
          </div>
          <div className="research-report-scroll">
            <div className="msg assistant">
              <div className="msg-body md-body">
                <Markdown>{report}</Markdown>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Launcher (State A) ─────────────────────────────────────────────────────

  return (
    <div className="research-panel">
      <div className="research-launcher motion-section">
        <div className="research-launcher-head">
          <div>
            <h2 className="research-title">Deep Research</h2>
            <p className="muted small research-subtitle">Turn a question into a saved workspace finding.</p>
          </div>
          <StatusBadge tone="info">{saveToProject ? 'Project' : 'Global'}</StatusBadge>
          <div ref={settingsWrapRef} className="research-settings-wrap">
            <button
              className={`ghost icon-btn research-settings-btn ${settingsOpen ? 'on' : ''}`}
              title={`SearXNG URL: ${searxngSaved}`}
              aria-label="Configure SearXNG URL"
              onClick={() => setSettingsOpen(v => !v)}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            {settingsOpen && (
              <div className="research-settings-popover">
                <div className="research-settings-popover-row">
                  <span>SearXNG URL</span>
                  <span className="muted small">{searxngSaved}</span>
                </div>
                <input
                  type="url"
                  value={searxngInput}
                  onChange={e => setSearxngInput(e.target.value)}
                  placeholder="http://localhost:8080"
                  onKeyDown={e => { if (e.key === 'Enter') saveSettings() }}
                />
                <button className="primary tiny" onClick={saveSettings}>Save</button>
              </div>
            )}
          </div>
        </div>

        <div className="research-form">
          <label className="research-label" htmlFor="research-topic">Topic</label>
          <input
            id="research-topic"
            type="text"
            className="research-topic-input"
            placeholder="What do you want to research?"
            value={topic}
            onChange={e => setTopic(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && topic.trim()) startResearch() }}
          />

          <fieldset className="research-fieldset">
            <legend className="research-legend">Search</legend>
            {([
              ['web',   'Web only'],
              ['local', 'Local knowledge only'],
              ['both',  'Web + local knowledge'],
            ] as const).map(([val, label]) => (
              <label key={val} className="research-radio-row">
                <input
                  type="radio"
                  name="research-scope"
                  value={val}
                  checked={scope === val}
                  onChange={() => setScope(val)}
                />
                {label}
              </label>
            ))}
          </fieldset>

          <fieldset className="research-fieldset">
            <legend className="research-legend">Save to</legend>
            <label className="research-radio-row">
              <input
                type="radio"
                name="research-save"
                value="project"
                checked={saveToProject}
                onChange={() => setSaveToProject(true)}
                disabled={isGlobal}
              />
              {isGlobal ? 'This project (unavailable in Global Workspace)' : 'This project'}
            </label>
            <label className="research-radio-row">
              <input
                type="radio"
                name="research-save"
                value="global"
                checked={!saveToProject}
                onChange={() => setSaveToProject(false)}
              />
              Global knowledge
            </label>
          </fieldset>

          <button
            className="primary"
            onClick={startResearch}
            disabled={!topic.trim()}
          >
            Run research
          </button>
        </div>

        {pastResearch.length > 0 && (
          <div className="research-past">
            <h3>Past research</h3>
            <ul className="research-past-list motion-list motion-list-tight">
              {pastResearch.slice(0, 10).map(item => (
                <li key={item.id} className="research-past-item">
                  <button
                    className="session-item"
                    onClick={() => {
                      setReport(item.content)
                      setPanelState('report')
                    }}
                  >
                    <span className="session-item-title">{item.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
