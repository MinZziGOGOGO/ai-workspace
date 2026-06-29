import { useEffect, useState } from 'react'
import type { Project } from './types'
import WorkspaceShell from './components/WorkspaceShell'
import { ShortcutProvider } from './ShortcutContext'
import { useMotionPreference } from './hooks/useMotionPreference'

export default function App() {
  useMotionPreference()
  const [project, setProject] = useState<Project | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = () => window.api.projects.list().then(setProjects)
  useEffect(() => {
    let cancelled = false
    async function openGlobalWorkspace() {
      const [globalProject] = await Promise.all([
        window.api.projects.global(),
        refresh()
      ])
      if (!cancelled) {
        setProject(globalProject)
        setLoading(false)
      }
    }
    openGlobalWorkspace()
    return () => { cancelled = true }
  }, [])

  async function openGlobal() {
    setProject(await window.api.projects.global())
    await refresh()
  }

  async function openProject(p: Project) {
    setProject(await window.api.projects.open(p.id))
    await refresh()
  }

  if (loading || !project) {
    return <div className="app-loading" data-testid="app-loading">Opening Global Workspace...</div>
  }

  return (
    <div className="app-root">
      <ShortcutProvider>
        <WorkspaceShell
          project={project}
          projects={projects}
          onRefresh={refresh}
          onOpenGlobal={openGlobal}
          onOpenProject={openProject}
        />
      </ShortcutProvider>
    </div>
  )
}
