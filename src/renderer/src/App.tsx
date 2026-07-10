import { useEffect, useState } from 'react'
import type { Project } from './types'
import WorkspaceShell from './components/WorkspaceShell'
import SetupWizard from './components/SetupWizard'
import { ShortcutProvider } from './ShortcutContext'
import { AgentActivityProvider } from './AgentActivityContext'
import { useMotionPreference } from './hooks/useMotionPreference'
import { applyTheme } from './theme'

export default function App() {
  useMotionPreference()
  const [project, setProject] = useState<Project | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  // null = still checking; the workspace loads concurrently but renders only
  // after the first-run wizard is dismissed (one screen at a time).
  const [showSetupWizard, setShowSetupWizard] = useState<boolean | null>(null)

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

  // Apply the stored theme on startup (Settings re-applies it on change).
  useEffect(() => {
    window.api.settings.get('ui_theme').then(applyTheme).catch(() => applyTheme('system'))
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.setup.isComplete()
      .then((complete) => !cancelled && setShowSetupWizard(!complete))
      .catch(() => !cancelled && setShowSetupWizard(false))
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

  function openSetupWizard() {
    setShowSetupWizard(true)
  }

  if (loading || !project || showSetupWizard === null) {
    return <div className="app-loading" data-testid="app-loading">Opening Global Workspace...</div>
  }

  if (showSetupWizard) {
    return <SetupWizard onComplete={() => setShowSetupWizard(false)} />
  }

  return (
    <div className="app-root">
      <ShortcutProvider>
        <AgentActivityProvider>
          <WorkspaceShell
            project={project}
            projects={projects}
            onRefresh={refresh}
            onOpenGlobal={openGlobal}
            onOpenProject={openProject}
            onOpenSetupWizard={openSetupWizard}
          />
        </AgentActivityProvider>
      </ShortcutProvider>
    </div>
  )
}
