import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Project, Session } from '../types'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { useEntranceMotion } from '../motion'

type PalettePanel = 'chat' | 'hermes' | 'claudecode' | 'codex' | 'navigator' | 'knowledge' | 'extensions' | 'terminal'

const PANEL_LABELS: Record<PalettePanel, string> = {
  chat: 'Chat',
  hermes: 'Hermes',
  claudecode: 'Claude Code',
  codex: 'Codex',
  navigator: 'Navigator',
  knowledge: 'Knowledge',
  extensions: 'Extensions',
  terminal: 'Terminal',
}

const SESSION_MODES: { mode: string; panel: PalettePanel }[] = [
  { mode: 'chat', panel: 'chat' },
  { mode: 'hermes', panel: 'hermes' },
  { mode: 'claudecode', panel: 'claudecode' },
  { mode: 'codex', panel: 'codex' },
]

interface PaletteItem {
  id: string
  label: string
  sublabel?: string
  run: () => void
}

interface PaletteGroup {
  label: string
  items: PaletteItem[]
}

function fuzzyScore(label: string, query: string): number {
  if (!query) return 1
  const l = label.toLowerCase()
  const q = query.toLowerCase()
  if (l === q) return 100
  if (l.startsWith(q)) return 80
  if (l.split(/\s+/).some((word) => word.startsWith(q))) return 60
  if (l.includes(q)) return 30
  // Fuzzy character-order subsequence match (lowest-priority tier)
  let qi = 0
  for (let i = 0; i < l.length && qi < q.length; i++) {
    if (l[i] === q[qi]) qi++
  }
  return qi === q.length ? 10 : 0
}

function filterAndSort(items: PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return items
  return items
    .map((item) => ({ item, score: fuzzyScore(item.label, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
}

export default function CommandPalette(props: {
  project: Project
  projects: Project[]
  onOpenProject: (project: Project) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [sessionEntries, setSessionEntries] = useState<{ session: Session; panel: PalettePanel }[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const cardRef = useEntranceMotion<HTMLDivElement>('dropdown', [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    const modes = isGlobalProjectId(props.project.id) ? SESSION_MODES.slice(0, 1) : SESSION_MODES
    Promise.all(
      modes.map(({ mode }) =>
        window.api.sessions.list(props.project.id, mode).catch(() => [] as Session[])
      )
    ).then((groups) => {
      if (cancelled) return
      const combined = groups.flatMap((sessions, i) =>
        sessions.map((session) => ({ session, panel: modes[i].panel }))
      )
      combined.sort((a, b) => b.session.created_at - a.session.created_at)
      setSessionEntries(combined.slice(0, 30))
    })
    return () => { cancelled = true }
  }, [props.project.id])

  function runOpenPanel(panel: PalettePanel) {
    window.dispatchEvent(new CustomEvent('workspace:openPanel', { detail: { panel } }))
    props.onClose()
  }

  function runSelectSession(panel: PalettePanel, session: Session) {
    window.dispatchEvent(new CustomEvent('workspace:openPanel', { detail: { panel } }))
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('panel:selectSession', { detail: { panel, session } }))
    }, 60)
    props.onClose()
  }

  const groups = useMemo<PaletteGroup[]>(() => {
    const navItems: PaletteItem[] = [
      { id: 'nav-chat', label: 'Switch to Chat', run: () => runOpenPanel('chat') },
      { id: 'nav-hermes', label: 'Switch to Hermes', run: () => runOpenPanel('hermes') },
      { id: 'nav-claudecode', label: 'Switch to Claude Code', run: () => runOpenPanel('claudecode') },
      { id: 'nav-codex', label: 'Switch to Codex', run: () => runOpenPanel('codex') },
      { id: 'nav-terminal', label: 'Open Terminal', run: () => runOpenPanel('terminal') },
      { id: 'nav-navigator', label: 'Open Navigator', run: () => runOpenPanel('navigator') },
      { id: 'nav-knowledge', label: 'Open Knowledge', run: () => runOpenPanel('knowledge') },
      { id: 'nav-extensions', label: 'Open Extensions', run: () => runOpenPanel('extensions') },
      {
        id: 'nav-settings',
        label: 'Open Settings',
        run: () => {
          window.dispatchEvent(new CustomEvent('workspace:openSettings'))
          props.onClose()
        },
      },
      {
        id: 'nav-shortcuts',
        label: 'Show keyboard shortcuts',
        run: () => {
          window.dispatchEvent(new CustomEvent('workspace:showShortcuts'))
          props.onClose()
        },
      },
    ]

    const actionItems: PaletteItem[] = [
      {
        id: 'action-new-session',
        label: 'New session (in current panel)',
        run: () => {
          window.dispatchEvent(new CustomEvent('workspace:newSession'))
          props.onClose()
        },
      },
      {
        id: 'action-close-panel',
        label: 'Close current panel',
        run: () => {
          window.dispatchEvent(new CustomEvent('workspace:closePanel'))
          props.onClose()
        },
      },
      {
        id: 'action-reset-layout',
        label: 'Reset layout',
        run: () => {
          window.dispatchEvent(new CustomEvent('workspace:resetLayout'))
          props.onClose()
        },
      },
    ]

    const sessionItems: PaletteItem[] = sessionEntries.map(({ session, panel }) => ({
      id: `session-${session.id}`,
      label: session.title || 'Untitled session',
      sublabel: PANEL_LABELS[panel],
      run: () => runSelectSession(panel, session),
    }))

    const projectItems: PaletteItem[] = props.projects
      .filter((p) => p.status === 'active' && p.id !== props.project.id)
      .map((p) => ({
        id: `project-${p.id}`,
        label: `Switch to ${p.name}`,
        run: () => {
          props.onOpenProject(p)
          props.onClose()
        },
      }))

    return [
      { label: 'Navigation', items: filterAndSort(navItems, query) },
      { label: 'Actions', items: filterAndSort(actionItems, query) },
      { label: 'Sessions', items: filterAndSort(sessionItems, query) },
      { label: 'Projects', items: filterAndSort(projectItems, query) },
    ].filter((group) => group.items.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sessionEntries, props.projects, props.project.id])

  const flatItems = useMemo(() => groups.flatMap((group) => group.items), [groups])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => (flatItems.length ? (i + 1) % flatItems.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => (flatItems.length ? (i - 1 + flatItems.length) % flatItems.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flatItems[selectedIndex]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
    }
  }

  return createPortal(
    <div className="cmdk-overlay" data-testid="command-palette" onMouseDown={props.onClose}>
      <div className="cmdk-card" ref={cardRef} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Type a command or search..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="cmdk-results">
          {flatItems.length === 0 && <div className="cmdk-empty muted small">No matches</div>}
          {groups.map((group) => (
            <div key={group.label}>
              <div className="cmdk-group-label">{group.label}</div>
              {group.items.map((item) => {
                const index = flatItems.indexOf(item)
                return (
                  <div
                    key={item.id}
                    className={`cmdk-item${index === selectedIndex ? ' selected' : ''}`}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => item.run()}
                    data-testid={`command-palette-item-${item.id}`}
                  >
                    <span className="cmdk-item-label">{item.label}</span>
                    {item.sublabel && <span className="cmdk-item-sub muted small">{item.sublabel}</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
