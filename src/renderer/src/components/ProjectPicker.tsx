import { useEffect, useRef, useState } from 'react'
import type { Project } from '../types'
import {
  GLOBAL_PROJECT_NAME,
  GLOBAL_PROJECT_SUBTITLE,
  isGlobalProjectId
} from '../../../shared/globalWorkspace'
import NavigatorFileTree from './NavigatorFileTree'
import anime, { prefersReducedMotion, stopMotion, type MotionHandle } from '../motion'

export default function ProjectPicker(props: {
  projects: Project[]
  onRefresh: () => void
  onOpen: (p: Project) => void
  onOpenGlobal: () => void
  currentProject?: Project
  onClose?: () => void
  variant?: 'picker' | 'navigator' | 'panel'
  active?: boolean
  selectedFile?: string | null
  onFileSelect?: (path: string) => void
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const introAnimRef = useRef<MotionHandle>(null)

  const isNavigator = props.variant === 'navigator'
  const isPanel = props.variant === 'panel'
  const isGlobal = props.currentProject ? isGlobalProjectId(props.currentProject.id) : false
  const folderProjects = props.projects.filter((p) => !isGlobalProjectId(p.id))
  const active = folderProjects.filter((p) => p.status === 'active')
  const archived = folderProjects.filter((p) => p.status === 'archived')

  async function createProject() {
    if (!name.trim()) return
    const parent = await window.api.projects.pickFolder()
    if (!parent) return
    await window.api.projects.create(name.trim(), parent)
    setName('')
    setCreating(false)
    props.onRefresh()
  }

  async function importFolder() {
    const p = await window.api.projects.import()
    if (p) props.onRefresh()
  }

  const rootClass = isPanel ? 'navigator-panel' : isNavigator ? 'navigator-overlay' : 'picker'
  const cardClass = isPanel ? 'navigator-card navigator-card-inline' : isNavigator ? 'navigator-card picker-card' : 'picker-card'

  useEffect(() => {
    const card = cardRef.current
    if (!card || prefersReducedMotion()) return
    const rows = card.querySelectorAll('.project-row, .picker-actions button')
    stopMotion(introAnimRef.current)
    introAnimRef.current = anime(rows, {
      opacity: [0, 1],
      translateY: [8, 0],
      duration: 220,
      delay: (_: unknown, i: number) => i * 28,
      ease: 'outExpo',
    })
    return () => stopMotion(introAnimRef.current)
  }, [props.projects.length, isPanel, isNavigator])

  return (
    <div
      className={rootClass}
      data-testid={isNavigator || isPanel ? 'workspace-navigator' : 'project-picker'}
      role={isNavigator ? 'dialog' : undefined}
      aria-modal={isNavigator ? 'true' : undefined}
      aria-label={isNavigator || isPanel ? 'Workspace Navigator' : undefined}
    >
      <div className={cardClass} ref={cardRef}>
        <div className="navigator-head">
          <div>
            <h1>{isNavigator || isPanel ? 'Navigator' : 'Projects'}</h1>
            <p className="muted">
              {isNavigator || isPanel
                ? 'Switch workspaces, create projects, or import an existing folder.'
                : 'A project wraps a real folder on disk. Knowledge stays even when a project is archived.'}
            </p>
          </div>
          {props.onClose && (
            <button className="ghost" data-testid="workspace-navigator-close" onClick={props.onClose}>
              Close
            </button>
          )}
        </div>

        {(isNavigator || isPanel) && props.currentProject && (
          <section className="navigator-current" data-testid="navigator-current-workspace">
            <h3>Current Workspace</h3>
            <div className="project-row navigator-current-row">
              <span className="project-name">{props.currentProject.name}</span>
              <span className="project-path">
                {isGlobal ? GLOBAL_PROJECT_SUBTITLE : props.currentProject.path}
              </span>
            </div>
          </section>
        )}

        <button
          className={`project-row global-project-row ${isGlobal ? 'current' : ''}`}
          data-testid="global-workspace-button"
          onClick={props.onOpenGlobal}
          disabled={isGlobal && isNavigator}
          title={isGlobal && isNavigator ? 'Already in Global Workspace' : 'Open Global Workspace'}
        >
          <span className="project-name">{GLOBAL_PROJECT_NAME}</span>
          <span className="project-path">{GLOBAL_PROJECT_SUBTITLE}</span>
        </button>

        {active.length === 0 && <div className="empty">No projects yet. Create one or import an existing folder.</div>}

        <ul className="project-list" data-testid="navigator-project-list">
          {active.map((p) => (
            <li key={p.id}>
              <button
                className={`project-row ${props.currentProject?.id === p.id ? 'current' : ''}`}
                onClick={() => props.onOpen(p)}
                disabled={isNavigator && props.currentProject?.id === p.id}
                title={props.currentProject?.id === p.id ? 'Already in this project' : p.path}
              >
                <span className="project-name">{p.name}</span>
                <span className="project-path">{p.path}</span>
              </button>
              <button
                className="ghost"
                title="Archive project"
                onClick={async () => { await window.api.projects.archive(p.id, true); props.onRefresh() }}
              >
                Archive
              </button>
            </li>
          ))}
        </ul>

        <div className="picker-actions">
          {creating ? (
            <div className="create-row">
              <input
                autoFocus
                placeholder="Project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createProject()}
              />
              <button className="primary" onClick={createProject}>Choose parent folder...</button>
              <button className="ghost" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          ) : (
            <>
              <button className="primary" data-testid="navigator-new-project" onClick={() => setCreating(true)}>
                New project
              </button>
              <button data-testid="navigator-import-project" onClick={importFolder}>Import existing folder</button>
            </>
          )}
        </div>

        {archived.length > 0 && (
          <div className="archived-block">
            <button className="ghost" onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
            </button>
            {showArchived && (
              <ul className="project-list">
                {archived.map((p) => (
                  <li key={p.id}>
                    <button className="project-row" onClick={() => props.onOpen(p)}>
                      <span className="project-name">{p.name}</span>
                      <span className="project-path">{p.path}</span>
                    </button>
                    <button
                      className="ghost"
                      onClick={async () => { await window.api.projects.archive(p.id, false); props.onRefresh() }}
                    >
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {isPanel && !isGlobal && props.currentProject?.path && (
          <NavigatorFileTree
            projectPath={props.currentProject.path}
            active={props.active !== false}
            selectedFile={props.selectedFile}
            onFileSelect={props.onFileSelect}
          />
        )}
      </div>
    </div>
  )
}
