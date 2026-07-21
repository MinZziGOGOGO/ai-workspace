import { useEffect, useState } from 'react'
import type { AgentPanelId, Project } from '../types'
import BrowserPanel from './BrowserPanel'
import PreviewPanel from './PreviewPanel'
import ClaudeCodeTab from './ClaudeCodeTab'
import ChatTab from './ChatTab'
import HermesTab from './HermesTab'
import CodexTab from './CodexTab'
import KimiTab from './KimiTab'
import ApprovalCenter, { type ApprovalScope } from './ApprovalCenter'
import { ToastProvider } from './ToastContext'
import { ShortcutProvider } from '../ShortcutContext'
import { AgentActivityProvider } from '../AgentActivityContext'
import { useMotionPreference } from '../hooks/useMotionPreference'
import { applyFontFamily, applyTheme, readStoredFontFamily } from '../theme'

export type DetachablePanelId = 'browser' | 'preview' | 'claudecode' | AgentPanelId

export const DETACHABLE_REACT_PANELS: DetachablePanelId[] = ['claudecode', 'hermes', 'codex', 'kimi', 'chat']

type ReactPanelId = 'claudecode' | AgentPanelId

/**
 * Per-agent detached-window configuration. `approvalScope` is deliberately the
 * agent's Browser-MCP identity, not the panel id, and is null for Chat — Chat
 * is a direct model conversation with no tool access, so mounting an
 * ApprovalCenter there would create a second surface able to decide *other*
 * agents' cards. See WINDOW_DETACH_DESIGN.md §4.4.
 */
const REACT_PANELS: Record<ReactPanelId, {
  title: string
  accent: string
  approvalScope: ApprovalScope | null
  // Claude Code's pilot testids predate this table and are kept verbatim so the
  // Step 3 e2e coverage keeps asserting the same selectors.
  shellTestId: string
  dockBackTestId: string
  reattach: () => void
}> = {
  claudecode: {
    title: 'Claude Code',
    accent: 'claudecode',
    approvalScope: 'claudecode',
    shellTestId: 'detached-claude-code-shell',
    dockBackTestId: 'claude-code-dock-back',
    reattach: () => void window.api.claudeCode.reattach(),
  },
  hermes: {
    title: 'Hermes',
    accent: 'hermes',
    approvalScope: 'hermes',
    shellTestId: 'detached-hermes-shell',
    dockBackTestId: 'hermes-dock-back',
    reattach: () => void window.api.agentPanel.reattach('hermes'),
  },
  codex: {
    title: 'Codex',
    accent: 'codex',
    approvalScope: 'codex',
    shellTestId: 'detached-codex-shell',
    dockBackTestId: 'codex-dock-back',
    reattach: () => void window.api.agentPanel.reattach('codex'),
  },
  kimi: {
    title: 'Kimi',
    accent: 'kimi',
    approvalScope: 'kimi',
    shellTestId: 'detached-kimi-shell',
    dockBackTestId: 'kimi-dock-back',
    reattach: () => void window.api.agentPanel.reattach('kimi'),
  },
  chat: {
    title: 'Chat',
    accent: 'chat',
    approvalScope: null,
    shellTestId: 'detached-chat-shell',
    dockBackTestId: 'chat-dock-back',
    reattach: () => void window.api.agentPanel.reattach('chat'),
  },
}

function renderTab(panelId: ReactPanelId, project: Project) {
  switch (panelId) {
    case 'claudecode':
      return (
        <ClaudeCodeTab
          project={project}
          active
          onOpenKnowledge={() => void window.api.workspace.openPanelInMain('knowledge')}
        />
      )
    case 'hermes':
      return <HermesTab project={project} active />
    case 'codex':
      return <CodexTab project={project} active />
    case 'kimi':
      return <KimiTab project={project} active />
    case 'chat':
      return <ChatTab project={project} active />
  }
}

function DetachedPanelShell({ panelId, project }: { panelId: ReactPanelId; project: Project }) {
  const meta = REACT_PANELS[panelId]
  return (
    <ToastProvider>
      <ShortcutProvider>
        <AgentActivityProvider>
          <div className={`detached-react-panel mode-${meta.accent}`} data-testid={meta.shellTestId}>
            <header className={`workspace-panel-head panel-${panelId} detached-react-panel-head`}>
              <span className="panel-accent" aria-hidden />
              <div className="workspace-panel-meta">
                <span className="workspace-panel-title">{meta.title}</span>
                <span className="workspace-panel-hint">{project.name}</span>
              </div>
              <button
                type="button"
                className="ghost tiny"
                data-testid={meta.dockBackTestId}
                aria-label={`Bring ${meta.title} back to the main window`}
                title={`Bring ${meta.title} back to the main window`}
                onClick={meta.reattach}
              >
                Bring back
              </button>
            </header>
            <main className={`workspace-panel-body panel-${panelId} detached-react-panel-body`}>
              {renderTab(panelId, project)}
            </main>
            {meta.approvalScope && <ApprovalCenter scope={meta.approvalScope} />}
          </div>
        </AgentActivityProvider>
      </ShortcutProvider>
    </ToastProvider>
  )
}

// Root rendered instead of the full WorkspaceShell in a window opened via
// browser:detach/preview:detach/claudecode:detach/agentPanel:detach (see
// detachedPanelWindow.ts on the main side). This window hosts exactly one panel
// — no topbar, no docking, no other agent tabs — mirroring the panel's own
// chrome plus (for Browser/Preview) the reparented native WebContentsView.
// See WINDOW_DETACH_DESIGN.md §2.1–2.2.
export default function DetachedPanelWindow({ panelId, projectId }: { panelId: DetachablePanelId; projectId: string }) {
  useMotionPreference()
  const [project, setProject] = useState<Project | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.projects.open(projectId).then((p) => { if (!cancelled) setProject(p) })
    return () => { cancelled = true }
  }, [projectId])

  // Appearance preferences are stored globally (settings:getMany), not
  // per-window — apply them here the same way App.tsx does so a detached
  // window doesn't flash unstyled/light before the first render.
  useEffect(() => {
    window.api.settings
      .getMany(['ui_theme', 'ui_font_family'])
      .then((values) => {
        applyTheme(values.ui_theme)
        applyFontFamily(values.ui_font_family ?? readStoredFontFamily())
      })
      .catch(() => {
        applyTheme('system')
        applyFontFamily('default')
      })
  }, [])

  if (!project) {
    return <div className="app-loading" data-testid="detached-panel-loading">Loading…</div>
  }

  return (
    <div className="app-root detached-panel-window" data-testid={`detached-panel-${panelId}`}>
      {panelId === 'browser'
        ? <BrowserPanel active project={project} isDetachedWindow />
        : panelId === 'preview'
          ? <PreviewPanel active project={project} isDetachedWindow />
          : <DetachedPanelShell panelId={panelId} project={project} />}
    </div>
  )
}
