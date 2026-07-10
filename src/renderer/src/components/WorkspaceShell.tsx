import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import type { Project, LayoutPreset } from '../types'
import ChatTab from './ChatTab'
import HermesTab from './HermesTab'
import ClaudeCodeTab from './ClaudeCodeTab'
import CodexTab from './CodexTab'
import KnowledgePanel from './KnowledgePanel'
import SettingsPanel from './SettingsPanel'
import ProjectPicker from './ProjectPicker'
import ProjectHomePanel from './ProjectHomePanel'
import EditorPanel from './EditorPanel'
import TerminalPanel from './TerminalPanel'
import ResearchPanel from './ResearchPanel'
import ActivityPanel from './ActivityPanel'
import ExtensionsPanel from './ExtensionsPanel'
import CommandPalette from './CommandPalette'
import { ToastProvider, useToast } from './ToastContext'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { StatusBadge } from './WorkspacePrimitives'
import { useShortcuts } from '../ShortcutContext'
import { useAgentActivity, type AgentId } from '../AgentActivityContext'
import { formatShortcutKey, type Shortcut } from '../shortcuts'
import {
  BreathingDot,
  cleanupMotion,
  concealPanel,
  pulseElement,
  revealPanel,
  runWorkspaceStartup,
  stopMotion,
  useEntranceMotion,
  type MotionHandle,
} from '../motion'

// ── Types ──────────────────────────────────────────────────────────────────────

type DockPanel =
  | 'home'
  | 'navigator' | 'chat' | 'knowledge'
  | 'hermes' | 'claudecode' | 'codex' | 'editor' | 'terminal' | 'research' | 'activity' | 'extensions'

type SplitDirection = 'horizontal' | 'vertical'

type LayoutNode =
  | { type: 'pane'; id: DockPanel }
  | { type: 'split'; direction: SplitDirection; children: LayoutNode[]; sizes?: number[] }

interface WorkspaceLayout {
  root: LayoutNode | null
  openIds: DockPanel[]
}

interface PersistedLayout {
  version: 3
  workspaceId: string
  layout: WorkspaceLayout
  updatedAt: number
}

interface DragState {
  panel: DockPanel
  startX: number
  startY: number
  x: number
  y: number
  originRect: { left: number; right: number; top: number; bottom: number } | null
  hoverZone: LayoutZone | null
  hoverLocal: LocalDrop | null
  live: boolean
  onClickFallback: (() => void) | null
}

type DropEdge = 'left' | 'right' | 'top' | 'bottom'
type LocalDropSide = 'left' | 'right' | 'top' | 'bottom'

interface LocalDrop {
  target: DockPanel
  side: LocalDropSide
  style: React.CSSProperties
}

// ── Constants ──────────────────────────────────────────────────────────────────

const LAYOUT_VERSION = 3 as const
const BAND_PX = 40
const PANEL_MIN_SIZE = 280

// ── Layout picker zones ────────────────────────────────────────────────────────

type ZoneEntry = {
  id: LayoutZone
  label: string
  thumb: { top: string; left: string; width: string; height: string }
}

type LayoutZone = 'top' | 'left' | 'full' | 'right' | 'bottom'

const ZONES: ZoneEntry[] = [
  { id: 'top',    label: 'Top',    thumb: { top: '0%',  left: '0%',  width: '100%', height: '45%'  } },
  { id: 'left',   label: 'Left',   thumb: { top: '0%',  left: '0%',  width: '45%',  height: '100%' } },
  { id: 'full',   label: 'Full',   thumb: { top: '0%',  left: '0%',  width: '100%', height: '100%' } },
  { id: 'right',  label: 'Right',  thumb: { top: '0%',  left: '55%', width: '45%',  height: '100%' } },
  { id: 'bottom', label: 'Bottom', thumb: { top: '55%', left: '0%',  width: '100%', height: '45%'  } },
]

const PANELS: DockPanel[] = [
  'home', 'navigator', 'chat', 'knowledge', 'hermes', 'claudecode', 'codex', 'editor', 'terminal', 'research', 'activity', 'extensions'
]

const PANEL_TITLES: Record<DockPanel, string> = {
  home: 'Project Home',
  navigator: 'Navigator',
  chat: 'Chat',
  knowledge: 'Knowledge',
  hermes: 'Hermes',
  claudecode: 'Claude Code',
  codex: 'Codex',
  editor: 'Editor',
  terminal: 'Terminal',
  research: 'Research',
  activity: 'Activity',
  extensions: 'Extensions',
}

const PANEL_META: Record<DockPanel, {
  kind: string
  hint: string
  status: string
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error'
}> = {
  home: {
    kind: 'Home',
    hint: 'Project summary, actions, readiness, files, and memory',
    status: 'Start',
    tone: 'info',
  },
  navigator: {
    kind: 'Files',
    hint: 'Projects, file tree, and workspace switching',
    status: 'Browse',
    tone: 'info',
  },
  chat: {
    kind: 'Chat',
    hint: 'General planning, questions, and memory capture',
    status: 'Ready',
    tone: 'success',
  },
  knowledge: {
    kind: 'Memory',
    hint: 'Search, inspect, and delete shared knowledge',
    status: 'Shared',
    tone: 'info',
  },
  hermes: {
    kind: 'Agent',
    hint: 'Autonomous task runs through Hermes',
    status: 'Runs',
    tone: 'success',
  },
  claudecode: {
    kind: 'Agent',
    hint: 'Claude Code tasks in the selected project',
    status: 'Runs',
    tone: 'success',
  },
  codex: {
    kind: 'Agent',
    hint: 'Codex CLI tasks in the selected project',
    status: 'Runs',
    tone: 'success',
  },
  editor: {
    kind: 'File',
    hint: 'Open and edit files from Navigator',
    status: 'Local',
    tone: 'neutral',
  },
  terminal: {
    kind: 'Shell',
    hint: 'Project terminal for command-line work',
    status: 'Local',
    tone: 'neutral',
  },
  research: {
    kind: 'Research',
    hint: 'Research pipeline that saves findings to knowledge',
    status: 'Saves',
    tone: 'info',
  },
  activity: {
    kind: 'Feed',
    hint: 'Live workspace activity and tool messages',
    status: 'Live',
    tone: 'info',
  },
  extensions: {
    kind: 'Extensions',
    hint: 'Manage MCP servers, skills, and agent plugins',
    status: 'Manage',
    tone: 'info',
  },
}

type TopbarPanel = { id: DockPanel; label: string; icon?: ReactNode }

function topbarPanel(id: DockPanel, icon?: ReactNode): TopbarPanel {
  return { id, label: PANEL_TITLES[id], icon }
}

const extensionsIcon = (
  <svg className="topbar-dropdown-item-icon" viewBox="0 0 14 14" width="14" height="14" aria-hidden>
    <path
      d="M5 2h4v2h2l1 1v2h-1v4H3V7H2V5l1-1h2V2z M5 7h4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
)

const TOPBAR_GROUPS: { label: string; panels: TopbarPanel[] }[] = [
  { label: 'Home',      panels: [topbarPanel('home')] },
  { label: 'AI',        panels: ['chat', 'hermes', 'claudecode', 'codex'].map((id) => topbarPanel(id as DockPanel)) },
  { label: 'Tools',     panels: [
    topbarPanel('navigator'),
    topbarPanel('editor'),
    topbarPanel('terminal'),
    topbarPanel('activity'),
    topbarPanel('extensions', extensionsIcon),
  ] },
  { label: 'Knowledge', panels: ['knowledge', 'research'].map((id) => topbarPanel(id as DockPanel)) },
]

// ── Layout helpers ─────────────────────────────────────────────────────────────

function AnimatedDropdown(props: {
  className: string
  style: React.CSSProperties
  children: ReactNode
  onMouseDown?: (event: React.MouseEvent<HTMLDivElement>) => void
  onPointerEnter?: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerLeave?: (event: React.PointerEvent<HTMLDivElement>) => void
}) {
  const ref = useEntranceMotion<HTMLDivElement>('dropdown', [])
  return (
    <div
      ref={ref}
      className={props.className}
      style={{ ...props.style, transformOrigin: 'top center' }}
      onMouseDown={props.onMouseDown}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
    >
      {props.children}
    </div>
  )
}

function defaultLayout(isGlobal: boolean): WorkspaceLayout {
  if (isGlobal) {
    return {
      root: { type: 'pane', id: 'home' },
      openIds: ['home'],
    }
  }
  return {
    root: { type: 'pane', id: 'home' },
    openIds: ['home'],
  }
}

function layoutKey(workspaceId: string) {
  return `aiworkspace.layout3.${workspaceId}`
}

function loadLayout(workspaceId: string, isGlobal: boolean): WorkspaceLayout {
  try {
    const raw = localStorage.getItem(layoutKey(workspaceId))
    if (!raw) throw new Error('no saved layout')
    const parsed = JSON.parse(raw) as Partial<PersistedLayout>
    if (
      parsed.version !== LAYOUT_VERSION ||
      parsed.workspaceId !== workspaceId ||
      !parsed.layout
    ) throw new Error('stale layout')
    // Validate openIds are known panels
    const openIds = (parsed.layout.openIds ?? []).filter(
      (id): id is DockPanel => PANELS.includes(id as DockPanel)
    )
    return normalizeLayout({ root: parsed.layout.root ?? null, openIds })
  } catch {
    return defaultLayout(isGlobal)
  }
}

function collectPanelIds(node: LayoutNode | null): DockPanel[] {
  if (!node) return []
  if (node.type === 'pane') return [node.id]
  return node.children.flatMap(collectPanelIds)
}

function dedupeTree(node: LayoutNode, seen: Set<DockPanel>): LayoutNode | null {
  if (node.type === 'pane') {
    if (seen.has(node.id)) return null
    seen.add(node.id)
    return node
  }

  const children = node.children
    .map(child => dedupeTree(child, seen))
    .filter((child): child is LayoutNode => child !== null)

  if (children.length === 0) return null
  if (children.length === 1) return children[0]

  const sizes = node.sizes?.length === children.length ? node.sizes : undefined
  return sizes
    ? { type: 'split', direction: node.direction, children, sizes }
    : { type: 'split', direction: node.direction, children }
}

function normalizeLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const root = layout.root ? dedupeTree(layout.root, new Set()) : null
  return { root, openIds: collectPanelIds(root) }
}

/** Remove a panel id from the tree, collapsing single-child splits */
function removeFromTree(node: LayoutNode, id: DockPanel): LayoutNode | null {
  if (node.type === 'pane') {
    return node.id === id ? null : node
  }
  const newChildren = node.children
    .map(c => removeFromTree(c, id))
    .filter((c): c is LayoutNode => c !== null)
  if (newChildren.length === 0) return null
  if (newChildren.length === 1) return newChildren[0]
  return { type: 'split', direction: node.direction, children: newChildren }
}

/** Add a panel to root split in a given edge direction */
function addToRoot(root: LayoutNode, newId: DockPanel, edge: DropEdge): LayoutNode {
  if (edge === 'left') {
    return {
      type: 'split', direction: 'horizontal',
      children: [{ type: 'pane', id: newId }, root],
    }
  }
  if (edge === 'right') {
    if (root.type === 'split' && root.direction === 'horizontal') {
      return {
        type: 'split',
        direction: 'horizontal',
        children: [...root.children, { type: 'pane', id: newId }],
      }
    }
    return {
      type: 'split', direction: 'horizontal',
      children: [root, { type: 'pane', id: newId }],
    }
  }
  if (edge === 'top') {
    return {
      type: 'split', direction: 'vertical',
      children: [{ type: 'pane', id: newId }, root],
    }
  }
  // bottom
  if (root.type === 'split' && root.direction === 'vertical') {
    return {
      type: 'split',
      direction: 'vertical',
      children: [...root.children, { type: 'pane', id: newId }],
    }
  }
  return {
    type: 'split', direction: 'vertical',
    children: [root, { type: 'pane', id: newId }],
  }
}

function zoneEdges(zone: LayoutZone): DropEdge[] {
  switch (zone) {
    case 'top': return ['top']
    case 'bottom': return ['bottom']
    case 'left': return ['left']
    case 'right': return ['right']
    case 'full': return []
  }
}

function addToZone(root: LayoutNode, newId: DockPanel, zone: LayoutZone): LayoutNode {
  const edges = zoneEdges(zone)
  return edges.reduce<LayoutNode>((nextRoot, edge) => {
    const withoutPanel = removeFromTree(nextRoot, newId) ?? root
    return addToRoot(withoutPanel, newId, edge)
  }, root)
}

function localSplitDirection(side: LocalDropSide): SplitDirection {
  return side === 'left' || side === 'right' ? 'horizontal' : 'vertical'
}

function makeLocalSplit(targetId: DockPanel, draggedId: DockPanel, side: LocalDropSide): LayoutNode {
  const targetPane: LayoutNode = { type: 'pane', id: targetId }
  const draggedPane: LayoutNode = { type: 'pane', id: draggedId }
  const draggedFirst = side === 'left' || side === 'top'

  return {
    type: 'split',
    direction: localSplitDirection(side),
    children: draggedFirst ? [draggedPane, targetPane] : [targetPane, draggedPane],
    sizes: [50, 50],
  }
}

function splitTargetPane(
  node: LayoutNode,
  targetId: DockPanel,
  draggedId: DockPanel,
  side: LocalDropSide,
): LayoutNode {
  if (node.type === 'pane') {
    return node.id === targetId ? makeLocalSplit(targetId, draggedId, side) : node
  }

  return {
    ...node,
    children: node.children.map(child => splitTargetPane(child, targetId, draggedId, side)),
  }
}

function containsPanel(node: LayoutNode, panelId: DockPanel): boolean {
  if (node.type === 'pane') return node.id === panelId
  return node.children.some(child => containsPanel(child, panelId))
}

function movePanelToTargetSplit(
  root: LayoutNode | null,
  draggedId: DockPanel,
  targetId: DockPanel,
  side: LocalDropSide,
): LayoutNode | null {
  if (!root || draggedId === targetId) return root
  const withoutDragged = removeFromTree(root, draggedId)
  if (!withoutDragged || !containsPanel(withoutDragged, targetId)) return root
  return splitTargetPane(withoutDragged, targetId, draggedId, side)
}

// Global 40px edge band detection — returns one of 4 cardinal zones or null.
function getBandZone(x: number, y: number, r: DOMRect): LayoutZone | null {
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null
  if (x - r.left  < BAND_PX) return 'left'
  if (r.right  - x < BAND_PX) return 'right'
  if (y - r.top   < BAND_PX) return 'top'
  if (r.bottom - y < BAND_PX) return 'bottom'
  return null
}

// Zone → snap highlight style (absolute within workspace-area)
function zoneHighlightStyle(zone: LayoutZone): React.CSSProperties {
  switch (zone) {
    case 'left':   return { top: 4, left: 4, bottom: 4, right: 'calc(50% + 2px)' }
    case 'right':  return { top: 4, right: 4, bottom: 4, left: 'calc(50% + 2px)' }
    case 'top':    return { top: 4, left: 4, right: 4, bottom: 'calc(50% + 2px)' }
    case 'bottom': return { top: 'calc(50% + 2px)', left: 4, right: 4, bottom: 4 }
    case 'full':   return { top: 4, left: 4, right: 4, bottom: 4 }
  }
}

function localHighlightStyle(side: LocalDropSide, target: DOMRect, workspace: DOMRect): React.CSSProperties {
  const x = target.left - workspace.left
  const y = target.top - workspace.top
  const halfWidth = target.width / 2
  const halfHeight = target.height / 2

  switch (side) {
    case 'left':
      return { left: x + 4, top: y + 4, width: Math.max(0, halfWidth - 6), height: Math.max(0, target.height - 8) }
    case 'right':
      return { left: x + halfWidth + 2, top: y + 4, width: Math.max(0, halfWidth - 6), height: Math.max(0, target.height - 8) }
    case 'top':
      return { left: x + 4, top: y + 4, width: Math.max(0, target.width - 8), height: Math.max(0, halfHeight - 6) }
    case 'bottom':
      return { left: x + 4, top: y + halfHeight + 2, width: Math.max(0, target.width - 8), height: Math.max(0, halfHeight - 6) }
  }
}

// ── Update sizes in tree ──────────────────────────────────────────────────────

function updateSizes(node: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (path.length === 0) {
    if (node.type === 'split') return { ...node, sizes }
    return node
  }
  if (node.type === 'split') {
    const [head, ...rest] = path
    const newChildren = node.children.map((c, i) =>
      i === head ? updateSizes(c, rest, sizes) : c
    )
    return { ...node, children: newChildren }
  }
  return node
}

// ── Main component ─────────────────────────────────────────────────────────────

function WorkspaceShellInner(props: {
  project: Project
  projects: Project[]
  onRefresh: () => void
  onOpenGlobal: () => void
  onOpenProject: (p: Project) => void
  onOpenSetupWizard: () => void
}) {
  const isGlobal = isGlobalProjectId(props.project.id)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showShortcutsOverlay, setShowShortcutsOverlay] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [groupDropdown, setGroupDropdown] = useState<{ label: string; rect: DOMRect } | null>(null)
  const { addToast } = useToast()
  const { shortcuts } = useShortcuts()
  const { active: agentActive } = useAgentActivity()
  const focusedPanelRef = useRef<DockPanel | null>(null)
  const knowledgeButtonRef = useRef<HTMLButtonElement | null>(null)
  const knowledgePulseRef = useRef<MotionHandle>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const startupMotionRef = useRef<MotionHandle>(null)
  const panelRevealRef = useRef<MotionHandle[]>([])
  const previousOpenIdsRef = useRef<DockPanel[]>([])

  // Fullscreen: temporarily show only one panel; store previous layout to restore
  const [fullscreenId, setFullscreenId] = useState<DockPanel | null>(null)
  const prevLayoutForFullscreen = useRef<WorkspaceLayout | null>(null)

  const [presetsDropdown, setPresetsDropdown] = useState<DOMRect | null>(null)
  const [presets, setPresets] = useState<LayoutPreset[]>([])
  const [savingPreset, setSavingPreset] = useState(false)
  const [presetName, setPresetName] = useState('')

  useEffect(() => {
    function handleKnowledgePulse() {
      stopMotion(knowledgePulseRef.current)
      knowledgePulseRef.current = pulseElement(knowledgeButtonRef.current)
    }
    window.addEventListener('knowledge:pulse', handleKnowledgePulse)
    return () => {
      window.removeEventListener('knowledge:pulse', handleKnowledgePulse)
      stopMotion(knowledgePulseRef.current)
    }
  }, [])

  const [layout, setLayout] = useState<WorkspaceLayout>(() =>
    loadLayout(props.project.id, isGlobal)
  )

  useEffect(() => {
    setLayout(loadLayout(props.project.id, isGlobal))
    setSelectedFile(null)
    setFullscreenId(null)
    prevLayoutForFullscreen.current = null
  }, [props.project.id, isGlobal])

  // Persist layout
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      const persisted: PersistedLayout = {
        version: LAYOUT_VERSION,
        workspaceId: props.project.id,
        layout,
        updatedAt: Date.now(),
      }
      localStorage.setItem(layoutKey(props.project.id), JSON.stringify(persisted))
    }, 500)
    return () => { if (persistTimer.current) clearTimeout(persistTimer.current) }
  }, [layout, props.project.id])

  // ── memory:saved → toast ───────────────────────────────────────────────────
  useEffect(() => {
    if (!window.api.memory?.onSaved) return
    return window.api.memory.onSaved(() => {
      addToast('💾 Memory saved')
    })
  }, [addToast])

  // Close group dropdown on outside click (mousedown bubble so inner stopPropagation works)
  useEffect(() => {
    if (!groupDropdown) return
    function handleOutsideMouseDown() { setGroupDropdown(null) }
    document.addEventListener('mousedown', handleOutsideMouseDown)
    return () => document.removeEventListener('mousedown', handleOutsideMouseDown)
  }, [groupDropdown])

  useEffect(() => {
    if (!presetsDropdown) return
    function handleOutside() { setPresetsDropdown(null) }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [presetsDropdown])

  // ── Layout picker state ────────────────────────────────────────────────────
  const [layoutPickerState, setLayoutPickerState] = useState<{ rect: DOMRect; panelId: DockPanel } | null>(null)
  const layoutPickerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function openLayoutPicker(e: React.PointerEvent, panel: DockPanel) {
    if (layoutPickerTimer.current) clearTimeout(layoutPickerTimer.current)
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setLayoutPickerState({ rect, panelId: panel })
  }

  function scheduleCloseLayoutPicker() {
    layoutPickerTimer.current = setTimeout(() => {
      setLayoutPickerState(null)
    }, 150)
  }

  function cancelCloseLayoutPicker() {
    if (layoutPickerTimer.current) clearTimeout(layoutPickerTimer.current)
  }

  function applyZone(panelId: DockPanel, zone: LayoutZone) {
    setLayoutPickerState(null)
    placePanelInZone(panelId, zone)
  }

  // ── Drag state ─────────────────────────────────────────────────────────────
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  const workspaceRef = useRef<HTMLDivElement>(null)
  const topbarRef = useRef<HTMLElement>(null)

  const handlersRef = useRef({ openPanel, closePanel, dropPanel, dropPanelOnTarget, placePanelInZone, activePanelFromFocus, resetLayout } as {
    openPanel: (p: DockPanel) => void
    closePanel: (p: DockPanel) => void
    dropPanel: (p: DockPanel, edge: DropEdge) => void
    dropPanelOnTarget: (p: DockPanel, target: DockPanel, side: LocalDropSide) => void
    placePanelInZone: (p: DockPanel, zone: LayoutZone) => void
    activePanelFromFocus: () => DockPanel | null
    resetLayout: () => void
  })

  const dragActive = drag !== null
  useEffect(() => {
    if (!dragActive) return

    function getLocalDrop(x: number, y: number, draggedPanel: DockPanel, originRect: DragState['originRect']): LocalDrop | null {
      const workspaceEl = workspaceRef.current
      if (!workspaceEl) return null
      const workspaceRect = workspaceEl.getBoundingClientRect()
      if (x < workspaceRect.left || x > workspaceRect.right || y < workspaceRect.top || y > workspaceRect.bottom) {
        return null
      }
      if (
        originRect &&
        x >= originRect.left && x <= originRect.right &&
        y >= originRect.top && y <= originRect.bottom
      ) {
        return null
      }

      // Use rect-based lookup instead of elementsFromPoint so that pointer-events:none
      // on .workspace-panel-wrap (applied during drag) doesn't cause panels to be skipped.
      for (const panelEl of workspaceEl.querySelectorAll<HTMLElement>('[data-dock-panel-id]')) {
        const rawPanelId = panelEl.dataset.dockPanelId
        if (!rawPanelId || !PANELS.includes(rawPanelId as DockPanel)) continue
        const target = rawPanelId as DockPanel
        if (target === draggedPanel) continue

        const targetRect = panelEl.getBoundingClientRect()
        if (targetRect.width === 0 || targetRect.height === 0) continue
        if (x < targetRect.left || x > targetRect.right || y < targetRect.top || y > targetRect.bottom) continue

        const distances: Array<{ side: LocalDropSide; value: number }> = [
          { side: 'left', value: x - targetRect.left },
          { side: 'right', value: targetRect.right - x },
          { side: 'top', value: y - targetRect.top },
          { side: 'bottom', value: targetRect.bottom - y },
        ]
        distances.sort((a, b) => a.value - b.value)

        const closest = distances[0]
        return {
          target,
          side: closest.side,
          style: localHighlightStyle(closest.side, targetRect, workspaceRect),
        }
      }

      return null
    }

    function onMove(e: PointerEvent) {
      setDrag(prev => {
        if (!prev) return null
        const dx = e.clientX - prev.startX
        const dy = e.clientY - prev.startY
        const live = prev.live || Math.sqrt(dx * dx + dy * dy) > 5

        if (!live) {
          return { ...prev, x: e.clientX, y: e.clientY, live, hoverZone: null, hoverLocal: null }
        }

        const workspaceEl = workspaceRef.current
        const r = workspaceEl?.getBoundingClientRect() ?? null
        const inWorkspace = r !== null
          && e.clientX >= r.left && e.clientX <= r.right
          && e.clientY >= r.top  && e.clientY <= r.bottom

        // Priority 1: global 40px edge bands — always take precedence
        const bandZone = r ? getBandZone(e.clientX, e.clientY, r) : null
        if (bandZone) {
          return { ...prev, x: e.clientX, y: e.clientY, live, hoverZone: bandZone, hoverLocal: null }
        }

        // Priority 2: panel-local nearest-edge split
        const hoverLocal = getLocalDrop(e.clientX, e.clientY, prev.panel, prev.originRect)
        if (hoverLocal) {
          return { ...prev, x: e.clientX, y: e.clientY, live, hoverZone: null, hoverLocal }
        }

        // Priority 3: in workspace but no band/panel hit → full
        const hoverZone: LayoutZone | null = inWorkspace ? 'full' : null
        return { ...prev, x: e.clientX, y: e.clientY, live, hoverZone, hoverLocal: null }
      })
    }

    function onUp(e: PointerEvent) {
      const d = dragRef.current
      if (!d) return
      if (d.live) {
        const topbarEl = topbarRef.current
        const topbarBottom = topbarEl ? topbarEl.getBoundingClientRect().bottom : 0
        if (e.clientY <= topbarBottom) {
          handlersRef.current.closePanel(d.panel)
        } else if (d.hoverLocal) {
          handlersRef.current.dropPanelOnTarget(d.panel, d.hoverLocal.target, d.hoverLocal.side)
        } else if (d.hoverZone && d.hoverZone !== 'full') {
          handlersRef.current.placePanelInZone(d.panel, d.hoverZone)
        }
      } else {
        d.onClickFallback?.()
      }
      setDrag(null)
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setDrag(null)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [dragActive])

  // ── Layout mutations ───────────────────────────────────────────────────────

  function openPanel(panel: DockPanel) {
    setLayout(cur => {
      if (cur.openIds.includes(panel)) return cur
      const newOpenIds = [...cur.openIds, panel]
      if (cur.root === null) {
        return normalizeLayout({ root: { type: 'pane', id: panel }, openIds: newOpenIds })
      }
      if (cur.openIds.length === 1 && cur.root.type === 'pane') {
        return normalizeLayout({
          root: {
            type: 'split', direction: 'horizontal',
            children: [cur.root, { type: 'pane', id: panel }],
          },
          openIds: newOpenIds,
        })
      }
      // 2+ open: append at the root so newly opened panels do not split an
      // already-small pane into unusable slivers. Precise placement still uses
      // drag/drop or the layout picker.
      const newRoot = addToRoot(cur.root, panel, 'right')
      return normalizeLayout({ root: newRoot, openIds: newOpenIds })
    })
  }

  function removePanel(panel: DockPanel) {
    setLayout(cur => {
      if (!cur.openIds.includes(panel)) return cur
      const newOpenIds = cur.openIds.filter(id => id !== panel)
      const newRoot = cur.root ? removeFromTree(cur.root, panel) : null
      return normalizeLayout({ root: newRoot, openIds: newOpenIds })
    })
    // Exit fullscreen if that panel was fullscreened
    if (fullscreenId === panel) {
      setFullscreenId(null)
      prevLayoutForFullscreen.current = null
    }
  }

  function closePanel(panel: DockPanel) {
    const panelEl = shellRef.current?.querySelector<HTMLElement>(`[data-dock-panel-id="${panel}"]`) ?? null
    const closeAfterMotion = concealPanel(panelEl)
    if (closeAfterMotion) {
      void closeAfterMotion.then(() => removePanel(panel))
      return
    }
    removePanel(panel)
  }

  function dropPanel(panel: DockPanel, edge: DropEdge) {
    setLayout(cur => {
      const withoutPanel = cur.root ? removeFromTree(cur.root, panel) : null
      const openIds = cur.openIds.includes(panel) ? cur.openIds : [...cur.openIds, panel]
      if (withoutPanel === null) {
        return normalizeLayout({ root: { type: 'pane', id: panel }, openIds })
      }
      const newRoot = addToRoot(withoutPanel, panel, edge)
      return normalizeLayout({ root: newRoot, openIds })
    })
  }

  function dropPanelOnTarget(panel: DockPanel, target: DockPanel, side: LocalDropSide) {
    if (panel === target) return
    setFullscreenId(null)
    prevLayoutForFullscreen.current = null
    setLayout(cur => {
      const openIds = cur.openIds.includes(panel) ? cur.openIds : [...cur.openIds, panel]
      const newRoot = movePanelToTargetSplit(cur.root, panel, target, side)
      return normalizeLayout({ root: newRoot, openIds })
    })
  }

  function placePanelInZone(panel: DockPanel, zone: LayoutZone) {
    setFullscreenId(null)
    prevLayoutForFullscreen.current = null
    setLayout(cur => {
      const withoutPanel = cur.root ? removeFromTree(cur.root, panel) : null
      const openIds = cur.openIds.includes(panel) ? cur.openIds : [...cur.openIds, panel]
      if (zone === 'full' || withoutPanel === null) {
        return normalizeLayout({ root: { type: 'pane', id: panel }, openIds })
      }
      const newRoot = addToZone(withoutPanel, panel, zone)
      return normalizeLayout({ root: newRoot, openIds })
    })
  }

  function resetLayout() {
    setFullscreenId(null)
    prevLayoutForFullscreen.current = null
    setLayout(defaultLayout(isGlobal))
  }

  async function openPresetsDropdown(e: React.MouseEvent) {
    e.stopPropagation()
    if (presetsDropdown) { setPresetsDropdown(null); return }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const list = await window.api.presets.list()
    setPresets(list)
    setSavingPreset(false)
    setPresetName('')
    setPresetsDropdown(rect)
  }

  async function savePreset() {
    const name = presetName.trim()
    if (!name) return
    const saved = await window.api.presets.save(name, layout.root, layout.openIds, props.project.id)
    const updated = await window.api.presets.list()
    setPresets(updated)
    setSavingPreset(false)
    setPresetName('')
    addToast(`Layout saved as '${saved.name}'`)
  }

  async function loadPreset(id: string) {
    const preset = await window.api.presets.load(id)
    if (!preset) return
    const presetIsGlobal = isGlobalProjectId(preset.workspaceId)
    if (presetIsGlobal !== isGlobal) {
      addToast('Warning: preset was saved in a different workspace type')
    }
    const safeOpenIds = (preset.openIds as string[]).filter((p): p is DockPanel => PANELS.includes(p as DockPanel))
    setLayout(normalizeLayout({ root: preset.layout as LayoutNode | null, openIds: safeOpenIds }))
    setPresetsDropdown(null)
    addToast('Layout loaded')
  }

  async function deletePreset(id: string) {
    await window.api.presets.delete(id)
    setPresets(prev => prev.filter(p => p.id !== id))
    addToast('Preset deleted')
  }

  function toggleFullscreen(panel: DockPanel) {
    if (fullscreenId === panel) {
      // Restore
      if (prevLayoutForFullscreen.current) {
        setLayout(prevLayoutForFullscreen.current)
      }
      setFullscreenId(null)
      prevLayoutForFullscreen.current = null
    } else {
      prevLayoutForFullscreen.current = layout
      setFullscreenId(panel)
    }
  }

  function handleFileSelect(path: string) {
    setSelectedFile(path)
    if (!layout.openIds.includes('editor')) openPanel('editor')
  }

  function focusPanel(panel: DockPanel) {
    if (!layout.openIds.includes(panel)) return
    if (fullscreenId && fullscreenId !== panel) setFullscreenId(panel)
    rememberFocusedPanel(panel)
    window.requestAnimationFrame(() => {
      shellRef.current
        ?.querySelector<HTMLElement>(`[data-dock-panel-id="${panel}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }

  // ── Rack click: auto-layout ─────────────────────────────────────────────────

  function handleRackClick(panel: DockPanel) {
    if (layout.openIds.includes(panel)) {
      focusPanel(panel)
      return
    }
    openPanel(panel)
  }

  // ── Drag start ──────────────────────────────────────────────────────────────

  function startDrag(
    e: React.PointerEvent,
    panel: DockPanel,
    onClickFallback: (() => void) | null = null,
  ) {
    if (e.button !== 0) return
    e.preventDefault()
    const originEl = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-dock-panel-id]')
    const originDomRect = originEl?.getBoundingClientRect() ?? null
    const originRect = originDomRect
      ? { left: originDomRect.left, right: originDomRect.right, top: originDomRect.top, bottom: originDomRect.bottom }
      : null
    setDrag({
      panel,
      startX: e.clientX, startY: e.clientY,
      x: e.clientX, y: e.clientY,
      originRect,
      hoverZone: null, live: false,
      hoverLocal: null,
      onClickFallback,
    })
  }

  // ── Active check ────────────────────────────────────────────────────────────

  const activeLayout = fullscreenId
    ? { root: { type: 'pane' as const, id: fullscreenId }, openIds: [fullscreenId] }
    : layout

  const openIds = activeLayout.openIds
  const isDragging = drag?.live ?? false
  const activeAgentIds = (Object.keys(agentActive) as AgentId[]).filter((id) => agentActive[id])

  function rememberFocusedPanel(panel: DockPanel) {
    focusedPanelRef.current = panel
  }

  useEffect(() => {
    previousOpenIdsRef.current = openIds
    stopMotion(startupMotionRef.current)
    startupMotionRef.current = runWorkspaceStartup(shellRef.current)
    return () => {
      cleanupMotion(startupMotionRef.current)
      panelRevealRef.current.forEach(cleanupMotion)
      panelRevealRef.current = []
    }
  }, [props.project.id])

  useEffect(() => {
    const previous = previousOpenIdsRef.current
    const added = openIds.filter((id) => !previous.includes(id))
    previousOpenIdsRef.current = openIds
    if (added.length === 0) return

    window.requestAnimationFrame(() => {
      panelRevealRef.current.forEach(cleanupMotion)
      panelRevealRef.current = added
        .map((panel) => shellRef.current?.querySelector<HTMLElement>(`[data-dock-panel-id="${panel}"]`) ?? null)
        .map(revealPanel)
        .filter((handle): handle is NonNullable<MotionHandle> => Boolean(handle))
    })
  }, [openIds.join('|')])

  function activePanelFromFocus(): DockPanel | null {
    const activeElement = document.activeElement as HTMLElement | null
    const focusedPanel = activeElement?.closest<HTMLElement>('[data-dock-panel-id]')?.dataset.dockPanelId
    if (focusedPanel && PANELS.includes(focusedPanel as DockPanel)) return focusedPanel as DockPanel
    if (focusedPanelRef.current && openIds.includes(focusedPanelRef.current)) return focusedPanelRef.current
    return fullscreenId ?? openIds[0] ?? null
  }

  // Registered once. Handlers dispatch through handlersRef (updated every
  // render) so they always see the current layout state without tearing down
  // and re-adding six window listeners on every render.
  useEffect(() => {
    function onOpenPanel(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel && PANELS.includes(panel as DockPanel)) handlersRef.current.openPanel(panel as DockPanel)
    }

    function onOpenSettings() {
      setSettingsOpen(true)
    }

    function onShowShortcuts() {
      setShowShortcutsOverlay((visible) => !visible)
    }

    function onToggleCommandPalette() {
      setCommandPaletteOpen((open) => !open)
    }

    function onNewSession() {
      const panel = handlersRef.current.activePanelFromFocus()
      if (panel) window.dispatchEvent(new CustomEvent('panel:newSession', { detail: { panel } }))
    }

    function onClosePanel() {
      const panel = handlersRef.current.activePanelFromFocus()
      if (panel) handlersRef.current.closePanel(panel)
    }

    function onFocusComposer() {
      const panel = handlersRef.current.activePanelFromFocus()
      if (!panel) return
      window.dispatchEvent(new CustomEvent('panel:focusComposer', { detail: { panel } }))
    }

    function onResetLayout() {
      handlersRef.current.resetLayout()
    }

    window.addEventListener('workspace:openPanel', onOpenPanel)
    window.addEventListener('workspace:openSettings', onOpenSettings)
    window.addEventListener('workspace:showShortcuts', onShowShortcuts)
    window.addEventListener('workspace:toggleCommandPalette', onToggleCommandPalette)
    window.addEventListener('workspace:newSession', onNewSession)
    window.addEventListener('workspace:closePanel', onClosePanel)
    window.addEventListener('workspace:focusComposer', onFocusComposer)
    window.addEventListener('workspace:resetLayout', onResetLayout)
    return () => {
      window.removeEventListener('workspace:openPanel', onOpenPanel)
      window.removeEventListener('workspace:openSettings', onOpenSettings)
      window.removeEventListener('workspace:showShortcuts', onShowShortcuts)
      window.removeEventListener('workspace:toggleCommandPalette', onToggleCommandPalette)
      window.removeEventListener('workspace:newSession', onNewSession)
      window.removeEventListener('workspace:closePanel', onClosePanel)
      window.removeEventListener('workspace:focusComposer', onFocusComposer)
      window.removeEventListener('workspace:resetLayout', onResetLayout)
    }
  }, [])

  useEffect(() => {
    if (!showShortcutsOverlay) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowShortcutsOverlay(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [showShortcutsOverlay])

  // Derive shell accent from first open panel
  const firstOpen = openIds[0] ?? null
  const shellAccent =
    firstOpen === 'hermes' ? 'hermes'
    : firstOpen === 'claudecode' || firstOpen === 'codex' ? 'claudecode'
    : 'chat'

  // ── Panel content renderer ──────────────────────────────────────────────────

  function renderContent(panel: DockPanel): ReactNode {
    switch (panel) {
      case 'home':
        return (
          <ProjectHomePanel
            project={props.project}
            projects={props.projects}
            onOpenPanel={openPanel}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenSetupWizard={props.onOpenSetupWizard}
            onRefreshProjects={props.onRefresh}
          />
        )
      case 'navigator':
        return (
          <ProjectPicker
            variant="panel"
            currentProject={props.project}
            projects={props.projects}
            onRefresh={props.onRefresh}
            onOpenGlobal={props.onOpenGlobal}
            onOpen={props.onOpenProject}
            selectedFile={selectedFile}
            onFileSelect={handleFileSelect}
          />
        )
      case 'chat':
        return <ChatTab project={props.project} active={openIds.includes('chat')} />
      case 'knowledge':
        return <KnowledgePanel project={props.project} onOpenProject={props.onOpenProject} />
      case 'hermes':
        return <HermesTab project={props.project} active={openIds.includes('hermes')} />
      case 'claudecode':
        return (
          <ClaudeCodeTab
            project={props.project}
            active={openIds.includes('claudecode')}
            onOpenKnowledge={() => openPanel('knowledge')}
          />
        )
      case 'codex':
        return <CodexTab project={props.project} active={openIds.includes('codex')} />
      case 'editor':
        return (
          <EditorPanel
            selectedFile={selectedFile}
            onCloseFile={() => setSelectedFile(null)}
          />
        )
      case 'terminal':
        return <TerminalPanel project={props.project} />
      case 'research':
        return (
          <ResearchPanel
            project={props.project}
            onOpenKnowledge={() => openPanel('knowledge')}
          />
        )
      case 'activity':
        return <ActivityPanel />
      case 'extensions':
        return <ExtensionsPanel active={openIds.includes('extensions')} />
    }
  }

  function shortcutsByScope(scope: Shortcut['scope']) {
    return shortcuts.filter((shortcut) => shortcut.scope === scope)
  }

  function renderShortcutOverlay() {
    if (!showShortcutsOverlay) return null
    const sections: { title: string; items: Shortcut[] }[] = [
      { title: 'Navigation', items: shortcutsByScope('global') },
      { title: 'Composer', items: shortcutsByScope('composer') },
    ]

    return createPortal(
      <div
        className="shortcuts-overlay-backdrop"
        data-testid="shortcuts-overlay"
        onMouseDown={() => setShowShortcutsOverlay(false)}
      >
        <div
          className="shortcuts-overlay-card"
          onMouseDown={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Keyboard Shortcuts"
        >
          <header className="shortcuts-overlay-header">
            <span>Keyboard Shortcuts</span>
            <button className="ghost tiny" onClick={() => setShowShortcutsOverlay(false)} aria-label="Close keyboard shortcuts">×</button>
          </header>
          {sections.map((section) => (
            <section key={section.title}>
              <div className="shortcuts-section-title">{section.title}</div>
              {section.items.map((shortcut) => (
                <div className="shortcuts-row" key={shortcut.id}>
                  <div>
                    <div className="shortcuts-row-label">{shortcut.label}</div>
                    <div className="shortcuts-row-desc">{shortcut.description}</div>
                  </div>
                  <span className="shortcut-key-badge">{formatShortcutKey(shortcut.currentKey)}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>,
      document.body
    )
  }

  // ── Allotment tree renderer ─────────────────────────────────────────────────

  // We track path into the tree for size updates (not strictly needed but keeps sizes)
  function renderNode(node: LayoutNode, path: number[] = []): ReactNode {
    if (node.type === 'pane') {
      const panel = node.id
      const meta = PANEL_META[panel]
      const title = PANEL_TITLES[panel]
      const showKind = meta.kind.trim().toLowerCase() !== title.trim().toLowerCase()
      // Hide panel being dragged (topbar drag only)
      const hidden = isDragging && drag?.panel === panel
      return (
        <Allotment.Pane key={panel} minSize={PANEL_MIN_SIZE} visible={!hidden}>
          <div
            className="split-pane-cell"
            data-dock-panel-id={panel}
            onPointerDownCapture={() => rememberFocusedPanel(panel)}
            onFocusCapture={() => rememberFocusedPanel(panel)}
          >
            <header
              className={`workspace-panel-head panel-${panel}`}
              onPointerDown={e => {
                if ((e.target as HTMLElement).closest('button')) return
                startDrag(e, panel)
              }}
              style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
            >
              <span className="panel-accent" aria-hidden />
              <div className="workspace-panel-meta" title={meta.hint}>
                <span className="workspace-panel-title">{title}</span>
                {showKind && <span className="workspace-panel-kind">{meta.kind}</span>}
                <span className="workspace-panel-hint">{meta.hint}</span>
              </div>
              <StatusBadge tone={meta.tone}>{meta.status}</StatusBadge>
              <button
                className="ghost tiny"
                data-testid={`workspace-panel-layout-${panel}`}
                onClick={() => toggleFullscreen(panel)}
                onPointerEnter={(e) => openLayoutPicker(e, panel)}
                onPointerLeave={scheduleCloseLayoutPicker}
                title={fullscreenId === panel ? 'Restore panel size' : 'Change panel layout'}
                aria-label={fullscreenId === panel ? 'Restore panel size' : 'Change panel layout'}
              >
                {fullscreenId === panel ? '⊡' : '⛶'}
              </button>
              <button
                className="ghost tiny"
                data-testid={`workspace-panel-close-${panel}`}
                onClick={() => closePanel(panel)}
                title={`Close ${PANEL_TITLES[panel]}`}
                aria-label={`Close ${PANEL_TITLES[panel]}`}
              >
                Close
              </button>
            </header>
            <div
              className={`workspace-panel-body panel-${panel}`}
              data-testid={`workspace-panel-${panel}`}
              style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex' }}
            >
              {renderContent(panel)}
            </div>
          </div>
        </Allotment.Pane>
      )
    }

    // Split node
    return (
      <Allotment.Pane key={`split-${path.join('-')}`} minSize={PANEL_MIN_SIZE}>
        <div className="split-pane-cell">
          <Allotment
            key={`split-${path.join('-')}-${node.direction}`}
            vertical={node.direction === 'vertical'}
            defaultSizes={node.sizes}
            onChange={sizes => {
              setLayout(cur => ({
                ...cur,
                root: cur.root ? updateSizes(cur.root, path, sizes) : cur.root,
              }))
            }}
          >
            {node.children.map((child, i) => renderNode(child, [...path, i]))}
          </Allotment>
        </div>
      </Allotment.Pane>
    )
  }

  // Root-level: if root is a split, render Allotment directly (no outer Pane wrapper)
  function renderRoot(node: LayoutNode): ReactNode {
    if (node.type === 'pane') {
      const panel = node.id
      const meta = PANEL_META[panel]
      const title = PANEL_TITLES[panel]
      const showKind = meta.kind.trim().toLowerCase() !== title.trim().toLowerCase()
      const hidden = isDragging && drag?.panel === panel
      if (hidden) return null
      return (
        <div
          className="split-pane-cell workspace-panel-wrap motion-panel"
          data-dock-panel-id={panel}
          onPointerDownCapture={() => rememberFocusedPanel(panel)}
          onFocusCapture={() => rememberFocusedPanel(panel)}
        >
          <header
            className={`workspace-panel-head panel-${panel}`}
            onPointerDown={e => {
              if ((e.target as HTMLElement).closest('button')) return
              startDrag(e, panel)
            }}
            style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
          >
            <span className="panel-accent" aria-hidden />
            <div className="workspace-panel-meta" title={meta.hint}>
              <span className="workspace-panel-title">{title}</span>
              {showKind && <span className="workspace-panel-kind">{meta.kind}</span>}
              <span className="workspace-panel-hint">{meta.hint}</span>
            </div>
            <StatusBadge tone={meta.tone}>{meta.status}</StatusBadge>
            <button
              className="ghost tiny"
              data-testid={`workspace-panel-layout-${panel}`}
              onClick={() => toggleFullscreen(panel)}
              onPointerEnter={(e) => openLayoutPicker(e, panel)}
              onPointerLeave={scheduleCloseLayoutPicker}
              title={fullscreenId === panel ? 'Restore panel size' : 'Change panel layout'}
              aria-label={fullscreenId === panel ? 'Restore panel size' : 'Change panel layout'}
            >
              {fullscreenId === panel ? '⊡' : '⛶'}
            </button>
            <button
              className="ghost tiny"
              data-testid={`workspace-panel-close-${panel}`}
              onClick={() => closePanel(panel)}
              title={`Close ${PANEL_TITLES[panel]}`}
              aria-label={`Close ${PANEL_TITLES[panel]}`}
            >
              Close
            </button>
          </header>
          <div
            className={`workspace-panel-body panel-${panel}`}
            data-testid={`workspace-panel-${panel}`}
            style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex' }}
          >
            {renderContent(panel)}
          </div>
        </div>
      )
    }

    // It's a split
    return (
      <div className="split-pane-cell workspace-panel-wrap motion-panel">
        <Allotment
          key={`root-${node.direction}`}
          vertical={node.direction === 'vertical'}
          defaultSizes={node.sizes}
          onChange={sizes => {
            setLayout(cur => ({
              ...cur,
              root: cur.root ? updateSizes(cur.root, [], sizes) : cur.root,
            }))
          }}
        >
          {node.children.map((child, i) => renderNode(child, [i]))}
        </Allotment>
      </div>
    )
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  handlersRef.current = { openPanel, closePanel, dropPanel, dropPanelOnTarget, placePanelInZone, activePanelFromFocus, resetLayout }

  return (
    <div ref={shellRef} className={`shell mode-${shellAccent}`} data-testid="workspace-shell">
      <header className="topbar" ref={topbarRef}>
        <span className="project-badge">{props.project.name}</span>
        <div className="topbar-sep" aria-hidden />

        <nav className="topbar-groups" aria-label="Workspace tools">
          {TOPBAR_GROUPS.map((group, gi) => {
            const hasOpen = group.panels.some(p => openIds.includes(p.id))
            const isDropOpen = groupDropdown?.label === group.label
            return (
              <div key={group.label} className="topbar-group">
                <button
                  ref={group.label === 'Knowledge' ? knowledgeButtonRef : undefined}
                  className={`topbar-group-btn${hasOpen ? ' has-open' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (isDropOpen) { setGroupDropdown(null); return }
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setGroupDropdown({ label: group.label, rect })
                  }}
                >
                  {group.label}
                  <span className="topbar-group-chevron" aria-hidden>▾</span>
                  {hasOpen && <span className="topbar-group-dot" aria-hidden />}
                </button>
                {group.label === 'AI' && activeAgentIds.length > 0 && (
                  <span
                    className="topbar-activity-badge"
                    data-testid="topbar-activity-badge"
                    title={`Active: ${activeAgentIds.map((id) => PANEL_TITLES[id]).join(', ')}`}
                  >
                    <BreathingDot />
                    {activeAgentIds.length} active
                  </span>
                )}
                {group.panels.map(item => {
                  const panel = item.id
                  const isOpen = openIds.includes(panel)
                  if (isDragging && drag?.panel === panel) return null
                  return (
                    <button
                      key={panel}
                      className={`topbar-tab${isOpen ? ' active' : ''}`}
                      data-testid={`workspace-tool-${panel}`}
                      title={isOpen ? `Focus ${PANEL_TITLES[panel]}` : `Open ${PANEL_TITLES[panel]}`}
                      onPointerDown={e => startDrag(e, panel, () => handleRackClick(panel))}
                    >
                      {item.label}
                      {isOpen && (
                        <span
                          className="topbar-tab-close"
                          role="button"
                          tabIndex={-1}
                          aria-label={`Close ${PANEL_TITLES[panel]}`}
                          onPointerDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); closePanel(panel) }}
                        >
                          ×
                        </span>
                      )}
                    </button>
                  )
                })}
                {gi < TOPBAR_GROUPS.length - 1 && (
                  <div className="topbar-group-sep" aria-hidden />
                )}
              </div>
            )
          })}
        </nav>

        <div className="topbar-right">
          <button
            className="ghost"
            data-testid="workspace-reset-layout"
            onClick={resetLayout}
            title="Reset workspace layout"
          >
            Reset layout
          </button>
          <button
            className="ghost"
            data-testid="workspace-presets"
            onClick={(e) => { void openPresetsDropdown(e) }}
            title="Layout presets"
          >
            Presets
          </button>
          <button
            className={`ghost icon-btn ${settingsOpen ? 'on' : ''}`}
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
            data-testid="open-settings"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      <div className="shell-body">
        <main className="workspace-surface">
          {openIds.length === 0 && (
            <div className="workspace-empty-launcher" data-testid="workspace-empty-launcher">
              <h2>No tools open</h2>
              <p className="muted">Open a tool from the rack above.</p>
              <div className="workspace-empty-actions">
                {PANELS.map(panel => (
                  <button key={panel} onClick={() => openPanel(panel)}>
                    {PANEL_TITLES[panel]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {openIds.length > 0 && (
            <div
              className={`workspace-area${isDragging ? ' workspace-dragging' : ''}`}
              ref={workspaceRef}
              style={{ width: '100%', height: '100%', flex: 1, minWidth: 0, minHeight: 0, position: 'relative', overflow: 'auto' }}
            >
              {activeLayout.root && renderRoot(activeLayout.root)}

              {/* Always-mounted closed panels so state is preserved */}
              {PANELS.filter(p => !openIds.includes(p)).map(p => (
                <div
                  key={p}
                  data-testid={`workspace-panel-hidden-${p}`}
                  aria-hidden="true"
                  style={{ display: 'none' }}
                >
                  {renderContent(p)}
                </div>
              ))}

              {/* Snap highlight during drag — 'full' zone shows no hint */}
              {isDragging && drag?.hoverZone && drag.hoverZone !== 'full' && (
                <div
                  className="snap-highlight"
                  aria-hidden
                  style={{
                    ...zoneHighlightStyle(drag.hoverZone),
                    position: 'absolute',
                  }}
                />
              )}

              {isDragging && drag?.hoverLocal && (
                <div
                  className="local-drop-highlight"
                  aria-hidden
                  style={{
                    ...drag.hoverLocal.style,
                    position: 'absolute',
                  }}
                />
              )}

              {/* Global edge band overlays — rendered last so they sit above panels.
                  pointer-events: all during drag so cursor is never blocked by allotment sashes. */}
              {(['left', 'right', 'top', 'bottom'] as const).map(side => (
                <div
                  key={side}
                  aria-hidden
                  style={{
                    position: 'absolute',
                    zIndex: 100,
                    pointerEvents: isDragging ? 'all' : 'none',
                    background: 'transparent',
                    ...(side === 'left'   ? { top: 0, left: 0, width: BAND_PX, height: '100%' } :
                        side === 'right'  ? { top: 0, right: 0, width: BAND_PX, height: '100%' } :
                        side === 'top'    ? { top: 0, left: 0, width: '100%', height: BAND_PX } :
                                            { bottom: 0, left: 0, width: '100%', height: BAND_PX }),
                  }}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {settingsOpen && (
        <SettingsPanel
          project={props.project}
          onClose={() => setSettingsOpen(false)}
          onResetLayout={() => { resetLayout(); setSettingsOpen(false) }}
        />
      )}

      {renderShortcutOverlay()}

      {commandPaletteOpen && (
        <CommandPalette
          project={props.project}
          projects={props.projects}
          onOpenProject={props.onOpenProject}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}

      {/* Ghost tab portal */}
      {isDragging && drag && createPortal(
        <div
          className="drag-ghost"
          style={{
            position: 'fixed',
            left: drag.x - 40,
            top: drag.y - 12,
            pointerEvents: 'none',
            opacity: 0.85,
          }}
        >
          <span className={`drag-ghost-dot panel-${drag.panel}`} aria-hidden />
          {PANEL_TITLES[drag.panel]}
        </div>,
        document.body
      )}

      {/* Group dropdown portal */}
      {groupDropdown && createPortal(
        <AnimatedDropdown
          className="topbar-dropdown"
          style={{
            position: 'fixed',
            top: groupDropdown.rect.bottom + 4,
            left: groupDropdown.rect.left,
            zIndex: 9999,
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          {(TOPBAR_GROUPS.find(g => g.label === groupDropdown.label)?.panels ?? []).map(item => {
            const panel = item.id
            const isOpen = openIds.includes(panel)
            return (
              <button
                key={panel}
                className={`topbar-dropdown-item${isOpen ? ' is-open' : ''}`}
                onClick={() => {
                  handleRackClick(panel)
                  setGroupDropdown(null)
                }}
              >
                {item.icon}
                <span className="topbar-dropdown-item-label">{item.label}</span>
                {isOpen && <span className="topbar-dropdown-check">✓</span>}
              </button>
            )
          })}
        </AnimatedDropdown>,
        document.body
      )}

      {/* Presets dropdown portal */}
      {presetsDropdown && createPortal(
        <AnimatedDropdown
          className="topbar-dropdown"
          style={{
            position: 'fixed',
            top: presetsDropdown.bottom + 4,
            right: window.innerWidth - presetsDropdown.right,
            zIndex: 9999,
            minWidth: 220,
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="presets-dropdown-header">LAYOUT PRESETS</div>
          {savingPreset ? (
            <div className="presets-save-row">
              <input
                autoFocus
                className="presets-name-input"
                value={presetName}
                onChange={e => setPresetName(e.target.value)}
                placeholder="Enter preset name..."
                onKeyDown={e => {
                  if (e.key === 'Enter') { void savePreset() }
                  if (e.key === 'Escape') setSavingPreset(false)
                }}
              />
              <button
                className="primary tiny"
                onClick={() => void savePreset()}
                disabled={!presetName.trim()}
              >
                Save
              </button>
            </div>
          ) : (
            <button
              className="topbar-dropdown-item"
              onClick={() => setSavingPreset(true)}
            >
              <span className="topbar-dropdown-item-label">Save current layout...</span>
            </button>
          )}
          {presets.length > 0 && <div className="presets-divider" />}
          {presets.length === 0 && !savingPreset && (
            <div className="presets-empty">No saved presets yet</div>
          )}
          {presets.map(preset => (
            <div key={preset.id} className="preset-row">
              <span className="preset-name">{preset.name}</span>
              <button className="ghost tiny" onClick={() => void loadPreset(preset.id)}>Load</button>
              <button className="ghost tiny" onClick={() => void deletePreset(preset.id)} title="Delete preset">×</button>
            </div>
          ))}
        </AnimatedDropdown>,
        document.body
      )}

      {/* Layout picker portal */}
      {layoutPickerState && createPortal(
        <div
          className="layout-picker-popup"
          style={{
            position: 'fixed',
            top: layoutPickerState.rect.bottom + 4,
            left: Math.max(4, layoutPickerState.rect.left - 48),
            zIndex: 9999,
          }}
          onPointerEnter={cancelCloseLayoutPicker}
          onPointerLeave={scheduleCloseLayoutPicker}
        >
          {ZONES.map((zone) => (
            <button
              key={zone.id}
              className="layout-picker-cell"
              data-testid={`layout-picker-zone-${zone.id}`}
              title={zone.label}
              onClick={() => applyZone(layoutPickerState.panelId, zone.id)}
            >
              <div className="layout-picker-icon">
                <div className="layout-picker-zone" style={zone.thumb} />
              </div>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

export default function WorkspaceShell(props: {
  project: Project
  projects: Project[]
  onRefresh: () => void
  onOpenGlobal: () => void
  onOpenProject: (p: Project) => void
  onOpenSetupWizard: () => void
}) {
  return (
    <ToastProvider>
      <WorkspaceShellInner {...props} />
    </ToastProvider>
  )
}
