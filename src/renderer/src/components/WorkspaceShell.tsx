import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import type { Project, LayoutPreset, Session } from '../types'
import ChatTab from './ChatTab'
import HermesTab from './HermesTab'
import ClaudeCodeTab from './ClaudeCodeTab'
import CodexTab from './CodexTab'
import KimiTab from './KimiTab'
import KnowledgePanel from './KnowledgePanel'
import SettingsPanel from './SettingsPanel'
import ProjectPicker from './ProjectPicker'
import ProjectHomePanel from './ProjectHomePanel'
import EditorPanel from './EditorPanel'
import TerminalPanel from './TerminalPanel'
import ResearchPanel from './ResearchPanel'
import ActivityPanel from './ActivityPanel'
import ExtensionsPanel from './ExtensionsPanel'
import BrowserPanel from './BrowserPanel'
import PreviewPanel from './PreviewPanel'
import ApprovalCenter from './ApprovalCenter'
import AgentActivityPopover from './AgentActivityPopover'
import CommandPalette from './CommandPalette'
import { ToastProvider, useToast } from './ToastContext'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import type { AgentPanelId, ScreenPoint, WorkspaceWindowBounds } from '../../../shared/ipcTypes'
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
  | 'hermes' | 'claudecode' | 'codex' | 'kimi' | 'editor' | 'terminal' | 'research' | 'activity' | 'extensions' | 'browser' | 'preview'

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
  id: number
  panel: DockPanel
  startX: number
  startY: number
  x: number
  y: number
  screenX: number
  screenY: number
  hoverZone: LayoutZone | null
  hoverLocal: LocalDrop | null
  detachReady: boolean
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
const DETACH_THRESHOLD_PX = 16
// Step 4 extends the Step 2 drag gesture and the Step 3 button-detach to the
// four remaining agent tabs. Settings/Knowledge/Research stay out until they get
// their own scoping decision (WINDOW_DETACH_DESIGN.md §2.3).
const AGENT_DETACH_PANELS: AgentPanelId[] = ['hermes', 'codex', 'kimi', 'chat']
const DETACHABLE_PANELS = new Set<DockPanel>(['browser', 'preview', 'claudecode', ...AGENT_DETACH_PANELS])

// Panels whose header carries an explicit "Detach" button (Browser and Preview
// have their own in-panel chrome for this). Claude Code's pilot testid is kept
// verbatim; the Step 4 tabs follow the same `<panel>-detach` convention.
const HEADER_DETACH_TESTIDS: Partial<Record<DockPanel, string>> = {
  claudecode: 'claude-code-detach',
  hermes: 'hermes-detach',
  codex: 'codex-detach',
  kimi: 'kimi-detach',
  chat: 'chat-detach',
}

function isPastDetachThreshold(point: ScreenPoint, bounds: WorkspaceWindowBounds | null): boolean {
  if (!bounds) return false
  return (
    point.x < bounds.x - DETACH_THRESHOLD_PX ||
    point.x > bounds.x + bounds.width + DETACH_THRESHOLD_PX ||
    point.y < bounds.y - DETACH_THRESHOLD_PX ||
    point.y > bounds.y + bounds.height + DETACH_THRESHOLD_PX
  )
}

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
  'home', 'navigator', 'chat', 'knowledge', 'hermes', 'claudecode', 'codex', 'kimi', 'editor', 'terminal', 'research', 'activity', 'extensions', 'browser', 'preview'
]

const PANEL_TITLES: Record<DockPanel, string> = {
  home: 'Project Home',
  navigator: 'Navigator',
  chat: 'Chat',
  knowledge: 'Knowledge',
  hermes: 'Hermes',
  claudecode: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi',
  editor: 'Editor',
  terminal: 'Terminal',
  research: 'Research',
  activity: 'Activity',
  extensions: 'Extensions',
  browser: 'Browser',
  preview: 'Preview',
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
  kimi: {
    kind: 'Agent',
    hint: 'Kimi Code (Moonshot AI) tasks in the selected project',
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
  browser: {
    kind: 'Browser',
    hint: 'Browse the web in an embedded Chromium tab',
    status: 'Manual',
    tone: 'neutral',
  },
  preview: {
    kind: 'Preview',
    hint: 'Watch your project\'s own dev server update live',
    status: 'Live',
    tone: 'neutral',
  },
}

type TopbarPanel = { id: DockPanel; label: string; icon?: ReactNode }

function topbarPanel(id: DockPanel, icon?: ReactNode): TopbarPanel {
  return { id, label: PANEL_TITLES[id], icon }
}

function tablerIcon(paths: string[]) {
  return (
    <svg
      className="topbar-dropdown-item-icon"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  )
}

const homeIcon = tablerIcon([
  'M5 12l-2 0l9 -9l9 9l-2 0',
  'M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7',
  'M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6',
])

const chatIcon = tablerIcon([
  'M8 9h8',
  'M8 13h6',
  'M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z',
])

const hermesIcon = tablerIcon([
  'M7 7h10a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2z',
  'M10 16h.01',
  'M14 16h.01',
  'M9 7l-1 -4',
  'M15 7l1 -4',
  'M8 11l0 2',
  'M16 11l0 2',
])

const claudeCodeIcon = tablerIcon(['M7 8l-4 4l4 4', 'M17 8l4 4l-4 4', 'M14 4l-4 16'])

const kimiIcon = tablerIcon([
  'M4 19v-14',
  'M4 12l9 -7',
  'M4 12l9 7',
  'M13 5l7 7l-7 7',
])

const codexIcon = tablerIcon([
  'M21 16.008v-8.018a1.98 1.98 0 0 0 -1 -1.717l-7 -4.008a2.016 2.016 0 0 0 -2 0l-7 4.008c-.619 .359 -1 1.02 -1 1.718v8.018c0 .698 .381 1.359 1 1.718l7 4.008a2.016 2.016 0 0 0 2 0l7 -4.008c.619 -.359 1 -1.02 1 -1.718z',
  'M12 22v-10',
  'M12 12l8.73 -5.04',
  'M3.27 6.96l8.73 5.04',
])

const navigatorIcon = tablerIcon(['M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2'])

const editorIcon = tablerIcon([
  'M14 3v4a1 1 0 0 0 1 1h4',
  'M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z',
  'M9 9l1 0',
  'M9 13l6 0',
  'M9 17l6 0',
])

const terminalIcon = tablerIcon(['M6 8l4 4l-4 4', 'M12 16l6 0'])

const activityIcon = tablerIcon(['M3 12h4l3 8l4 -16l3 8h4'])

const extensionsIcon = tablerIcon([
  'M4 7h3a1 1 0 0 0 1 -1v-1a2 2 0 0 1 4 0v1a1 1 0 0 0 1 1h3a1 1 0 0 1 1 1v3a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0 -1 1v3a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-1a2 2 0 0 0 -4 0v1a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h1a2 2 0 0 0 0 -4h-1a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1',
])

const knowledgeIcon = tablerIcon([
  'M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0',
  'M4 6v6a8 3 0 0 0 16 0v-6',
  'M4 12v6a8 3 0 0 0 16 0v-6',
])

const researchIcon = tablerIcon(['M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M21 21l-6 -6'])

const browserIcon = tablerIcon([
  'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0',
  'M3.6 9h16.8',
  'M3.6 15h16.8',
  'M11.5 3a17 17 0 0 0 0 18',
  'M12.5 3a17 17 0 0 1 0 18',
])

const previewIcon = tablerIcon([
  'M3 12c2.5 -5 6 -7.5 9 -7.5s6.5 2.5 9 7.5c-2.5 5 -6 7.5 -9 7.5s-6.5 -2.5 -9 -7.5',
  'M12 15m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
])

const TOPBAR_GROUPS: { label: string; panels: TopbarPanel[] }[] = [
  { label: 'Home',      panels: [topbarPanel('home', homeIcon)] },
  { label: 'AI',        panels: [
    topbarPanel('chat', chatIcon),
    topbarPanel('hermes', hermesIcon),
    topbarPanel('claudecode', claudeCodeIcon),
    topbarPanel('codex', codexIcon),
    topbarPanel('kimi', kimiIcon),
  ] },
  { label: 'Tools',     panels: [
    topbarPanel('navigator', navigatorIcon),
    topbarPanel('editor', editorIcon),
    topbarPanel('terminal', terminalIcon),
    topbarPanel('browser', browserIcon),
    topbarPanel('preview', previewIcon),
    topbarPanel('activity', activityIcon),
    topbarPanel('extensions', extensionsIcon),
  ] },
  { label: 'Knowledge', panels: [
    topbarPanel('knowledge', knowledgeIcon),
    topbarPanel('research', researchIcon),
  ] },
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
      role="menu"
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

// ── Window-half hit-testing (shared by live drag + debug overlay) ────────────
// A single resolver so the overlay can never disagree with the real drop logic.

type PanelRect = { target: DockPanel; rect: DOMRect }

// Proportional nearest-edge for a point relative to a panel rect. Distances are
// normalized by width/height so a wide (or tall) panel isn't biased toward its
// short axis. Every point resolves to exactly one side, so the four sides tile
// the WHOLE panel as diagonal quadrants — there is no inert center.
function nearestSide(x: number, y: number, rect: DOMRect): LocalDropSide {
  const left = rect.width ? (x - rect.left) / rect.width : 1
  const right = rect.width ? (rect.right - x) / rect.width : 1
  const top = rect.height ? (y - rect.top) / rect.height : 1
  const bottom = rect.height ? (rect.bottom - y) / rect.height : 1
  const min = Math.min(left, right, top, bottom)
  if (min === top) return 'top'
  if (min === bottom) return 'bottom'
  if (min === left) return 'left'
  return 'right'
}

// Map any workspace point to a target panel: the panel it is inside, or — when
// it lands in a gap between floating cards — the nearest panel by squared
// distance to that panel's rect. This puts the boundary between two panels'
// drop zones in the middle of the visible gap, so no pixel range is dead.
function nearestPanel(x: number, y: number, panels: PanelRect[]): PanelRect | null {
  let nearest: PanelRect | null = null
  let best = Infinity
  for (const p of panels) {
    const { rect } = p
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return p
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
    const dist = dx * dx + dy * dy
    if (dist < best) { best = dist; nearest = p }
  }
  return nearest
}

// The open panels' on-screen rects (optionally excluding the dragged one, which
// is hidden while dragging). Rect-based lookup, so pointer-events:none on the
// wrap during drag doesn't hide panels the way elementsFromPoint would.
function collectPanelRects(workspaceEl: HTMLElement, exclude: DockPanel | null): PanelRect[] {
  const out: PanelRect[] = []
  for (const el of workspaceEl.querySelectorAll<HTMLElement>('[data-dock-panel-id]')) {
    const raw = el.dataset.dockPanelId
    if (!raw || !PANELS.includes(raw as DockPanel)) continue
    const target = raw as DockPanel
    if (target === exclude) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    out.push({ target, rect })
  }
  return out
}

type Resolved =
  | { kind: 'band'; zone: LayoutZone }
  | { kind: 'local'; target: DockPanel; side: LocalDropSide; rect: DOMRect }
  | { kind: 'full' }
  | { kind: 'none' }

// Single source of truth for "what does a drop at (x,y) resolve to?" Priority:
//   1. outer screen-half edge band (unchanged),
//   2. window-half — nearest panel, then nearest edge across its FULL bounds
//      (gaps included via nearestPanel),
//   3. full — only when there is no candidate panel at all,
//   4. none — outside the workspace rect.
function resolveDropAt(x: number, y: number, workspaceRect: DOMRect, panels: PanelRect[]): Resolved {
  if (x < workspaceRect.left || x > workspaceRect.right || y < workspaceRect.top || y > workspaceRect.bottom) {
    return { kind: 'none' }
  }
  const band = getBandZone(x, y, workspaceRect)
  if (band) return { kind: 'band', zone: band }
  const panel = nearestPanel(x, y, panels)
  if (!panel) return { kind: 'full' }
  const cx = Math.min(panel.rect.right, Math.max(panel.rect.left, x))
  const cy = Math.min(panel.rect.bottom, Math.max(panel.rect.top, y))
  return { kind: 'local', target: panel.target, side: nearestSide(cx, cy, panel.rect), rect: panel.rect }
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
  const { active: agentActive, tasks: agentTasks } = useAgentActivity()
  const [activityPopoverRect, setActivityPopoverRect] = useState<DOMRect | null>(null)
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
  // Which detachable panels currently live in their own OS window. A detached
  // panel gives up its dock slot entirely — nothing is left behind — so this
  // set exists only to drive the topbar rack's "detached" badge and to route a
  // rack click to "bring the window home" instead of "open a new slot".
  const [detachedPanels, setDetachedPanels] = useState<Set<DockPanel>>(() => new Set())
  const isPanelDetached = (panel: DockPanel) => detachedPanels.has(panel)

  /**
   * Collapse-and-reflow, the browser-tab-strip way: detaching *closes* the
   * panel's dock slot and reattaching *opens* it again, reusing the exact
   * closePanel/openPanel the header's Close button and the rack already use.
   * Allotment therefore reflows the remaining panes with no bespoke logic and
   * no placeholder card. Called from every panel's detachedChanged event, so
   * button-detach, drag-out, "Bring back" and closing the detached window all
   * converge here. See WINDOW_DETACH_DESIGN.md §4.6.
   */
  const applyDetachedLayout = useCallback((panel: DockPanel, detached: boolean) => {
    setDetachedPanels((prev) => {
      if (prev.has(panel) === detached) return prev
      const next = new Set(prev)
      if (detached) next.add(panel); else next.delete(panel)
      return next
    })
    if (detached) handlersRef.current.closePanel(panel)
    else handlersRef.current.openPanel(panel)
  }, [])

  useEffect(() => {
    let disposed = false
    // On mount only `true` acts: a renderer that reloaded while a panel was
    // detached must collapse that slot, but `false` must not conjure a slot for
    // a panel the user never opened.
    void window.api.claudeCode.isDetached().then((detached) => {
      if (!disposed && detached) applyDetachedLayout('claudecode', true)
    })
    const off = window.api.claudeCode.onDetachedChanged(({ detached }) => applyDetachedLayout('claudecode', detached))
    return () => { disposed = true; off() }
  }, [applyDetachedLayout])

  useEffect(() => {
    let disposed = false
    void window.api.agentPanel.listDetached().then((panels) => {
      if (disposed) return
      for (const panel of panels) applyDetachedLayout(panel, true)
    })
    const off = window.api.agentPanel.onDetachedChanged(({ panel, detached }) => applyDetachedLayout(panel, detached))
    return () => { disposed = true; off() }
  }, [applyDetachedLayout])

  useEffect(() => {
    let disposed = false
    void window.api.browser.isDetached().then((detached) => {
      if (!disposed && detached) applyDetachedLayout('browser', true)
    })
    const off = window.api.browser.onDetachedChanged(({ detached }) => applyDetachedLayout('browser', detached))
    return () => { disposed = true; off() }
  }, [applyDetachedLayout])

  useEffect(() => {
    let disposed = false
    void window.api.preview.isDetached().then((detached) => {
      if (!disposed && detached) applyDetachedLayout('preview', true)
    })
    const off = window.api.preview.onDetachedChanged(({ detached }) => applyDetachedLayout('preview', detached))
    return () => { disposed = true; off() }
  }, [applyDetachedLayout])

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

  // Close the activity popover on outside click (its own mousedown stops
  // propagation, and the badge toggle stops it too, so a bubble listener is safe).
  useEffect(() => {
    if (!activityPopoverRect) return
    function handleOutside() { setActivityPopoverRect(null) }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [activityPopoverRect])

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

  useEffect(() => {
    if (!groupDropdown && !presetsDropdown && !layoutPickerState && !activityPopoverRect) return
    function handleMenuEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setGroupDropdown(null)
      setPresetsDropdown(null)
      setLayoutPickerState(null)
      setSavingPreset(false)
      setActivityPopoverRect(null)
    }
    document.addEventListener('keydown', handleMenuEscape)
    return () => document.removeEventListener('keydown', handleMenuEscape)
  }, [groupDropdown, presetsDropdown, layoutPickerState, activityPopoverRect])

  // Topbar overlays (group dropdowns, layout presets, layout picker, save-preset
  // modal) are plain DOM and cannot paint over the browser's native
  // WebContentsView, which always renders above the DOM. Broadcast whenever any
  // of them is open so BrowserPanel parks the native view and the menu shows.
  const menuOverlayOpen = Boolean(groupDropdown || presetsDropdown || layoutPickerState || savingPreset || activityPopoverRect)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('menu-overlay-change', { detail: { covered: menuOverlayOpen } }))
  }, [menuOverlayOpen])

  function applyZone(panelId: DockPanel, zone: LayoutZone) {
    setLayoutPickerState(null)
    placePanelInZone(panelId, zone)
  }

  // ── Drag state ─────────────────────────────────────────────────────────────
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  const dragSequenceRef = useRef(0)
  const dragCaptureRef = useRef<{ element: HTMLElement; pointerId: number } | null>(null)
  const dragWindowBoundsRef = useRef<WorkspaceWindowBounds | null>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const topbarRef = useRef<HTMLElement>(null)

  const handlersRef = useRef({ openPanel, focusPanel, closePanel, dropPanel, dropPanelOnTarget, placePanelInZone, detachPanel, activePanelFromFocus, resetLayout } as {
    openPanel: (p: DockPanel) => void
    focusPanel: (p: DockPanel) => void
    closePanel: (p: DockPanel) => void
    dropPanel: (p: DockPanel, edge: DropEdge) => void
    dropPanelOnTarget: (p: DockPanel, target: DockPanel, side: LocalDropSide) => void
    placePanelInZone: (p: DockPanel, zone: LayoutZone) => void
    detachPanel: (p: DockPanel, point?: ScreenPoint) => void
    activePanelFromFocus: () => DockPanel | null
    resetLayout: () => void
  })

  const dragActive = drag !== null
  useEffect(() => {
    if (!dragActive) return

    function onMove(e: PointerEvent) {
      setDrag(prev => {
        if (!prev) return null
        const dx = e.clientX - prev.startX
        const dy = e.clientY - prev.startY
        const live = prev.live || Math.sqrt(dx * dx + dy * dy) > 5
        const point = { x: e.screenX, y: e.screenY }
        const detachReady = live && DETACHABLE_PANELS.has(prev.panel) &&
          isPastDetachThreshold(point, dragWindowBoundsRef.current)
        const coordinates = {
          x: e.clientX,
          y: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
          detachReady,
        }

        if (!live) {
          return { ...prev, ...coordinates, live, hoverZone: null, hoverLocal: null }
        }

        // Once a detachable panel is clearly beyond the native window bounds,
        // suppress every in-window snap target. Moving back inside immediately
        // returns to the unchanged docking resolver below.
        if (detachReady) {
          return { ...prev, ...coordinates, live, hoverZone: null, hoverLocal: null }
        }

        const workspaceEl = workspaceRef.current
        const r = workspaceEl?.getBoundingClientRect() ?? null
        if (!workspaceEl || !r) {
          return { ...prev, ...coordinates, live, hoverZone: null, hoverLocal: null }
        }

        // One resolver drives everything (bands → window-half → full). Excluding
        // the dragged panel means every remaining pixel of the workspace maps to
        // a real target — panel interiors AND the gaps between cards.
        const panels = collectPanelRects(workspaceEl, prev.panel)
        const resolved = resolveDropAt(e.clientX, e.clientY, r, panels)

        if (resolved.kind === 'band') {
          return { ...prev, ...coordinates, live, hoverZone: resolved.zone, hoverLocal: null }
        }
        if (resolved.kind === 'local') {
          const hoverLocal: LocalDrop = {
            target: resolved.target,
            side: resolved.side,
            style: localHighlightStyle(resolved.side, resolved.rect, r),
          }
          return { ...prev, ...coordinates, live, hoverZone: null, hoverLocal }
        }
        // 'full' (no candidate panels — e.g. dragging the only open panel) or
        // 'none' (outside the workspace).
        const hoverZone: LayoutZone | null = resolved.kind === 'full' ? 'full' : null
        return { ...prev, ...coordinates, live, hoverZone, hoverLocal: null }
      })
    }

    function onUp(e: PointerEvent) {
      const d = dragRef.current
      if (!d) return
      if (d.live) {
        const releasePoint = { x: e.screenX, y: e.screenY }
        const detachOnRelease = DETACHABLE_PANELS.has(d.panel) &&
          isPastDetachThreshold(releasePoint, dragWindowBoundsRef.current)
        const topbarEl = topbarRef.current
        const topbarBottom = topbarEl ? topbarEl.getBoundingClientRect().bottom : 0
        if (detachOnRelease) {
          handlersRef.current.detachPanel(d.panel, releasePoint)
        } else if (e.clientY <= topbarBottom) {
          handlersRef.current.closePanel(d.panel)
        } else if (d.hoverLocal) {
          handlersRef.current.dropPanelOnTarget(d.panel, d.hoverLocal.target, d.hoverLocal.side)
        } else if (d.hoverZone && d.hoverZone !== 'full') {
          handlersRef.current.placePanelInZone(d.panel, d.hoverZone)
        }
      } else {
        d.onClickFallback?.()
      }
      const capture = dragCaptureRef.current
      if (capture?.element.hasPointerCapture(capture.pointerId)) {
        capture.element.releasePointerCapture(capture.pointerId)
      }
      dragCaptureRef.current = null
      setDrag(null)
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      const capture = dragCaptureRef.current
      if (capture?.element.hasPointerCapture(capture.pointerId)) {
        capture.element.releasePointerCapture(capture.pointerId)
      }
      dragCaptureRef.current = null
      setDrag(null)
    }

    function onCancel() {
      dragCaptureRef.current = null
      setDrag(null)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [dragActive])

  // ── TEMP DEBUG — dock-zone bounding-box overlay (remove after diagnosis) ─────
  // Toggle with Ctrl+Shift+D. Visualizes the ACTUAL resolved drop zone for every
  // pixel of the workspace by grid-sampling resolveDropAt() — the exact resolver
  // the live drag uses. Screen-half bands are drawn as their exact rects; the
  // rest of the area is sampled and painted per window-half side (with the run
  // cells merged per row). Any interior cell that resolves to full/none is
  // painted DEAD red — after the Fix-1 gap coverage there should be none.
  type DebugRect = {
    kind: 'screen-half' | 'window-half' | 'window-target' | 'dead'
    side?: LocalDropSide
    label?: string
    style: React.CSSProperties
  }
  const [debugZones, setDebugZones] = useState(false)
  const [debugRects, setDebugRects] = useState<DebugRect[]>([])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        setDebugZones(v => !v)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!debugZones) { setDebugRects([]); return }
    function recompute() {
      const workspaceEl = workspaceRef.current
      if (!workspaceEl) { setDebugRects([]); return }
      const wr = workspaceEl.getBoundingClientRect()
      const panels = collectPanelRects(workspaceEl, null)
      const rects: DebugRect[] = []

      // Screen-half — the 4 global 40px edge bands (unchanged by this fix). Exact.
      const bands: Array<{ side: LayoutZone; style: React.CSSProperties }> = [
        { side: 'left',   style: { left: 0, top: 0, width: BAND_PX, height: wr.height } },
        { side: 'right',  style: { left: wr.width - BAND_PX, top: 0, width: BAND_PX, height: wr.height } },
        { side: 'top',    style: { left: 0, top: 0, width: wr.width, height: BAND_PX } },
        { side: 'bottom', style: { left: 0, top: wr.height - BAND_PX, width: wr.width, height: BAND_PX } },
      ]
      for (const b of bands) rects.push({ kind: 'screen-half', label: `screen-half: ${b.side}`, style: b.style })

      // Panel outlines, for orientation only.
      for (const p of panels) {
        rects.push({
          kind: 'window-target',
          label: `target: ${p.target}`,
          style: { left: p.rect.left - wr.left, top: p.rect.top - wr.top, width: p.rect.width, height: p.rect.height },
        })
      }

      // Window-half coverage — sample the SAME resolver the drag uses on a grid,
      // run-length-merging same-zone cells per row. This shows every pixel's
      // resolved side (including the gaps, now mapped to the nearest panel) and
      // surfaces any dead space as red. exclude=null so all panels are candidates
      // (this is a rest-state map of where each side would resolve).
      const STEP = 14
      const labelled = new Set<string>()
      for (let sy = 0; sy < wr.height; sy += STEP) {
        const rowTop = sy
        const rowH = Math.min(STEP, wr.height - sy)
        const cy = wr.top + Math.min(wr.height - 1, sy + rowH / 2)
        let runStart = 0
        let runKey: string | null = null
        let runSide: LocalDropSide | undefined
        let runKind: 'window-half' | 'dead' = 'window-half'
        const flush = (endPx: number) => {
          if (runKey === null) return
          const showLabel = !labelled.has(runKey)
          if (showLabel) labelled.add(runKey)
          rects.push({
            kind: runKind,
            side: runSide,
            label: showLabel ? (runKind === 'dead' ? 'DEAD' : `window-half: ${runSide}`) : undefined,
            style: { left: runStart, top: rowTop, width: Math.max(0, endPx - runStart), height: rowH },
          })
          runKey = null
        }
        for (let sx = 0; sx < wr.width; sx += STEP) {
          const cx = wr.left + Math.min(wr.width - 1, sx + STEP / 2)
          const res = resolveDropAt(cx, cy, wr, panels)
          if (res.kind === 'band') { flush(sx); continue } // bands drawn separately
          let key: string
          let side: LocalDropSide | undefined
          let kind: 'window-half' | 'dead'
          if (res.kind === 'local') { kind = 'window-half'; side = res.side; key = `${res.target}:${res.side}` }
          else { kind = 'dead'; side = undefined; key = 'dead' }
          if (runKey !== key) {
            flush(sx)
            runStart = sx; runKey = key; runSide = side; runKind = kind
          }
        }
        flush(wr.width)
      }

      setDebugRects(rects)
    }
    recompute()
    const raf = requestAnimationFrame(recompute)
    window.addEventListener('resize', recompute)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', recompute) }
  }, [debugZones, layout, fullscreenId])

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

  // Jump from an activity-popover row to the agent's tab + session. AgentId
  // values are a subset of DockPanel, so the agent id doubles as the panel id.
  // Reuses the panel:selectSession contract the command palette already uses;
  // the small delay lets the panel mount its listener before we dispatch.
  function jumpToAgentSession(agent: AgentId, session: Session) {
    setActivityPopoverRect(null)
    openPanel(agent)
    focusPanel(agent)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('panel:selectSession', { detail: { panel: agent, session } }))
    }, 60)
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

  // Every detached window carries its own "Bring back" control in its header
  // (browser-dock-back / preview-dock-back / <panel>-dock-back) — that is the
  // primary way home. This is the main window's secondary route, reached from
  // the rack badge, so a user who has lost track of which window holds which
  // panel can still recall it from where panels are opened.
  function reattachPanel(panel: DockPanel) {
    if (panel === 'browser') void window.api.browser.reattach()
    else if (panel === 'preview') void window.api.preview.reattach()
    else if (panel === 'claudecode') void window.api.claudeCode.reattach()
    else void window.api.agentPanel.reattach(panel as AgentPanelId)
  }

  function handleRackClick(panel: DockPanel) {
    // Detached panels hold no dock slot to focus or re-open; clicking the rack
    // entry brings the window home, and the reattach event re-opens the slot.
    if (isPanelDetached(panel)) {
      reattachPanel(panel)
      return
    }
    if (layout.openIds.includes(panel)) {
      focusPanel(panel)
      return
    }
    openPanel(panel)
  }

  // ── Drag start ──────────────────────────────────────────────────────────────

  function detachPanel(panel: DockPanel, point?: ScreenPoint) {
    if (!DETACHABLE_PANELS.has(panel)) return
    // The detached renderer can load before React unmounts this owner. Flush
    // the shared draft hook synchronously so the new window reads the latest
    // text rather than racing the unmount cleanup.
    window.dispatchEvent(new Event('composer:flushDrafts'))
    void (async () => {
      try {
        if (panel === 'browser') await window.api.browser.detach(props.project.id, point)
        else if (panel === 'preview') await window.api.preview.detach(props.project.id, point)
        else if (panel === 'claudecode') await window.api.claudeCode.detach(props.project.id, point)
        else await window.api.agentPanel.detach(panel as AgentPanelId, props.project.id, point)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        addToast(`Could not detach ${PANEL_TITLES[panel]}: ${message}`)
      }
    })()
  }

  function startDrag(
    e: React.PointerEvent,
    panel: DockPanel,
    onClickFallback: (() => void) | null = null,
  ) {
    if (e.button !== 0) return
    e.preventDefault()
    // The dragged source is intentionally hidden once the gesture is live.
    // Capture on the persistent shell so React can hide/unmount that header
    // without Chromium releasing capture at the window boundary.
    const captureTarget = shellRef.current ?? (e.currentTarget as HTMLElement)
    try {
      captureTarget.setPointerCapture(e.pointerId)
      dragCaptureRef.current = { element: captureTarget, pointerId: e.pointerId }
    } catch {
      dragCaptureRef.current = null
    }

    const id = ++dragSequenceRef.current
    dragWindowBoundsRef.current = {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
    }
    void window.api.workspace.getWindowBounds().then(bounds => {
      if (dragRef.current?.id === id) dragWindowBoundsRef.current = bounds
    }).catch(() => {
      // Keep the renderer-derived fallback; the gesture still degrades safely.
    })

    setDrag({
      id,
      panel,
      startX: e.clientX, startY: e.clientY,
      x: e.clientX, y: e.clientY,
      screenX: e.screenX, screenY: e.screenY,
      hoverZone: null, live: false,
      hoverLocal: null,
      detachReady: false,
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

  // FIX 2 — the Browser panel's native WebContentsView paints above the DOM and
  // swallows pointer events, so while a panel drag is live it would break
  // drop-zone hit-testing over its area and hide the snap/debug overlays. Park
  // every native browser view for the duration of a drag (and while the dock-zone
  // debug overlay is on, so zones can be inspected over the Browser panel too),
  // then restore. The dispatched event tells BrowserPanel to also stop its
  // bounds-sync loop so the park isn't undone on the next frame.
  const browserParked = isDragging || debugZones
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('browser-drag-change', { detail: { covered: browserParked } }))
    if (browserParked) void window.api.browser.parkForDrag()
    else void window.api.browser.restoreAfterDrag()
  }, [browserParked])

  // The Preview panel's native view has the same above-DOM painting problem as
  // Browser during a panel drag — park it too (see FIX 2 above).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('preview-drag-change', { detail: { covered: browserParked } }))
    if (browserParked) void window.api.preview.parkForDrag()
    else void window.api.preview.restoreAfterDrag()
  }, [browserParked])

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
    const unsubscribePreviewRequest = window.api.browser.onPreviewRequested(() => {
      handlersRef.current.openPanel('browser')
      window.setTimeout(() => handlersRef.current.focusPanel('browser'), 60)
    })
    const unsubscribeMainPanelRequest = window.api.workspace.onOpenPanelRequested((panel) => {
      if (PANELS.includes(panel)) handlersRef.current.openPanel(panel)
    })

    function onOpenPanel(event: Event) {
      const panel = (event as CustomEvent<{ panel?: string }>).detail?.panel
      if (panel && PANELS.includes(panel as DockPanel)) handlersRef.current.openPanel(panel as DockPanel)
    }

    function onOpenLivePreview(event: Event) {
      const detail = (event as CustomEvent<{ projectId?: string; url?: string }>).detail
      handlersRef.current.openPanel('browser')
      window.setTimeout(() => {
        handlersRef.current.focusPanel('browser')
        window.dispatchEvent(new CustomEvent('browser:openLivePreview', { detail }))
      }, 60)
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
    window.addEventListener('workspace:openLivePreview', onOpenLivePreview)
    window.addEventListener('workspace:openSettings', onOpenSettings)
    window.addEventListener('workspace:showShortcuts', onShowShortcuts)
    window.addEventListener('workspace:toggleCommandPalette', onToggleCommandPalette)
    window.addEventListener('workspace:newSession', onNewSession)
    window.addEventListener('workspace:closePanel', onClosePanel)
    window.addEventListener('workspace:focusComposer', onFocusComposer)
    window.addEventListener('workspace:resetLayout', onResetLayout)
    return () => {
      unsubscribePreviewRequest()
      unsubscribeMainPanelRequest()
      window.removeEventListener('workspace:openPanel', onOpenPanel)
      window.removeEventListener('workspace:openLivePreview', onOpenLivePreview)
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
    : firstOpen === 'kimi' ? 'kimi'
    : 'chat'

  // ── Panel content renderer ──────────────────────────────────────────────────

  // A detached panel has no dock slot at all (applyDetachedLayout closes it), so
  // there is no "open in another window" placeholder branch here — every case
  // below renders the real panel or nothing.
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
            active={openIds.includes('navigator')}
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
      case 'kimi':
        return <KimiTab project={props.project} active={openIds.includes('kimi')} />
      case 'editor':
        return (
          <EditorPanel
            selectedFile={selectedFile}
            workspaceId={props.project.id}
            onActiveFileChange={setSelectedFile}
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
      case 'browser':
        return <BrowserPanel active={openIds.includes('browser')} project={props.project} />
      case 'preview':
        return <PreviewPanel active={openIds.includes('preview')} project={props.project} />
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
              {HEADER_DETACH_TESTIDS[panel] && !isPanelDetached(panel) && (
                <button
                  type="button"
                  className="ghost tiny"
                  data-testid={HEADER_DETACH_TESTIDS[panel]}
                  onClick={() => detachPanel(panel)}
                  title={`Open ${PANEL_TITLES[panel]} in a separate window`}
                  aria-label={`Open ${PANEL_TITLES[panel]} in a separate window`}
                >
                  Detach
                </button>
              )}
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
            {HEADER_DETACH_TESTIDS[panel] && !isPanelDetached(panel) && (
              <button
                type="button"
                className="ghost tiny"
                data-testid={HEADER_DETACH_TESTIDS[panel]}
                onClick={() => detachPanel(panel)}
                title={`Open ${PANEL_TITLES[panel]} in a separate window`}
                aria-label={`Open ${PANEL_TITLES[panel]} in a separate window`}
              >
                Detach
              </button>
            )}
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

  handlersRef.current = { openPanel, focusPanel, closePanel, dropPanel, dropPanelOnTarget, placePanelInZone, detachPanel, activePanelFromFocus, resetLayout }

  return (
    <div ref={shellRef} className={`shell mode-${shellAccent}${drag?.detachReady ? ' workspace-detach-ready' : ''}`} data-testid="workspace-shell">
      <header className="topbar" ref={topbarRef}>
        <span className="project-badge">{props.project.name}</span>
        <div className="topbar-sep" aria-hidden />

        <nav className="topbar-groups" aria-label="Workspace tools">
          {TOPBAR_GROUPS.map((group, gi) => {
            const hasOpen = group.panels.some(p => openIds.includes(p.id))
            // The inline rack tabs collapse into this button on narrow windows,
            // so the detached marker has to surface here too — otherwise a
            // detached panel would have no visible trace at all at that width.
            const hasDetached = group.panels.some(p => isPanelDetached(p.id))
            const isDropOpen = groupDropdown?.label === group.label
            return (
              <div key={group.label} className="topbar-group">
                <button
                  ref={group.label === 'Knowledge' ? knowledgeButtonRef : undefined}
                  className={`topbar-group-btn${hasOpen ? ' has-open' : ''}${hasDetached ? ' has-detached' : ''}`}
                  data-testid={`workspace-group-${group.label.toLowerCase()}`}
                  title={hasDetached ? `A ${group.label} panel is open in another window` : undefined}
                  aria-haspopup="menu"
                  aria-expanded={isDropOpen}
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
                  {hasDetached && (
                    <span
                      className="topbar-tab-detached-dot"
                      data-testid={`workspace-group-${group.label.toLowerCase()}-detached`}
                      aria-label={`A ${group.label} panel is open in another window`}
                    />
                  )}
                </button>
                {group.label === 'AI' && activeAgentIds.length > 0 && (
                  <button
                    type="button"
                    className={`topbar-activity-badge${activityPopoverRect ? ' is-open' : ''}`}
                    data-testid="topbar-activity-badge"
                    aria-haspopup="menu"
                    aria-expanded={Boolean(activityPopoverRect)}
                    title={`Active: ${activeAgentIds.map((id) => PANEL_TITLES[id]).join(', ')} — click to view all agent activity`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (activityPopoverRect) { setActivityPopoverRect(null); return }
                      setActivityPopoverRect((e.currentTarget as HTMLElement).getBoundingClientRect())
                    }}
                  >
                    <BreathingDot />
                    {activeAgentIds.length} active
                  </button>
                )}
                {group.panels.map(item => {
                  const panel = item.id
                  const isOpen = openIds.includes(panel)
                  const detached = isPanelDetached(panel)
                  if (isDragging && drag?.panel === panel) return null
                  return (
                    <button
                      key={panel}
                      className={`topbar-tab${isOpen ? ' active' : ''}${detached ? ' is-detached' : ''}`}
                      data-testid={`workspace-tool-${panel}`}
                      title={
                        detached ? `${PANEL_TITLES[panel]} is open in another window — click to bring it back`
                        : isOpen ? `Focus ${PANEL_TITLES[panel]}`
                        : `Open ${PANEL_TITLES[panel]}`
                      }
                      onPointerDown={e => startDrag(e, panel, () => handleRackClick(panel))}
                    >
                      {item.label}
                      {/* No placeholder card is left in the dock, so this dot is
                          the main window's only trace of a detached panel. */}
                      {detached && (
                        <span
                          className="topbar-tab-detached-dot"
                          data-testid={`workspace-tool-${panel}-detached`}
                          aria-label={`${PANEL_TITLES[panel]} is open in another window`}
                        />
                      )}
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
              className={`workspace-area${isDragging ? ' workspace-dragging' : ''}${drag?.detachReady ? ' workspace-detach-ready' : ''}`}
              ref={workspaceRef}
              style={{ width: '100%', height: '100%', flex: 1, minWidth: 0, minHeight: 0, position: 'relative', overflow: 'auto' }}
            >
              {activeLayout.root && renderRoot(activeLayout.root)}

              {/* Always-mounted closed panels so state is preserved — except a
                  detached one, whose state now lives in its own window. Keeping
                  a hidden second instance here would double-subscribe the panel
                  and let it park native views the other window owns. */}
              {PANELS.filter(p => !openIds.includes(p) && !isPanelDetached(p)).map(p => (
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

              {/* TEMP DEBUG — dock-zone overlay (remove after diagnosis). Grid-
                  sampled from the real resolver, so it shows every pixel's
                  resolved zone with no dead space. */}
              {debugZones && debugRects.map((rect, i) => {
                const SIDE_COLORS: Record<LocalDropSide, string> = {
                  left: '#39ff5a', right: '#22e0ff', top: '#ffd23f', bottom: '#c77dff',
                }
                const color =
                  rect.kind === 'screen-half' ? '#ff2fd0'
                  : rect.kind === 'dead' ? '#ff0033'
                  : rect.kind === 'window-target' ? '#ffffff'
                  : (rect.side ? SIDE_COLORS[rect.side] : '#39ff5a')
                const isFilled = rect.kind !== 'window-target'
                const fillPct = rect.kind === 'dead' ? 60 : rect.kind === 'window-half' ? 24 : 14
                const z = rect.kind === 'screen-half' ? 499 : rect.kind === 'window-target' ? 498 : 497
                return (
                  <div
                    key={`debug-${i}`}
                    aria-hidden
                    style={{
                      position: 'absolute',
                      zIndex: z,
                      pointerEvents: 'none',
                      boxSizing: 'border-box',
                      border: rect.kind === 'window-half' ? 'none' : `1.5px dashed ${color}`,
                      background: isFilled ? `color-mix(in srgb, ${color} ${fillPct}%, transparent)` : 'transparent',
                      ...rect.style,
                    }}
                  >
                    {rect.label && (
                      <span
                        style={{
                          position: 'absolute',
                          top: 1,
                          left: 2,
                          font: '9px/1.2 ui-monospace, "Cascadia Code", monospace',
                          color: '#000',
                          background: color,
                          padding: '0 3px',
                          borderRadius: 2,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {rect.label}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </main>
      </div>

      {/* TEMP DEBUG — active-mode banner (remove after diagnosis) */}
      {debugZones && createPortal(
        <div
          style={{
            position: 'fixed',
            bottom: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10000,
            pointerEvents: 'none',
            background: '#ff2fd0',
            color: '#000',
            font: '600 12px/1 ui-monospace, "Cascadia Code", monospace',
            padding: '7px 12px',
            borderRadius: 6,
            boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
            letterSpacing: '0.02em',
          }}
        >
          DEBUG: Dock zones visible — Ctrl+Shift+D to exit
        </div>,
        document.body
      )}

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
          className={`drag-ghost${drag.detachReady ? ' detach-ready' : ''}`}
          data-testid={drag.detachReady ? 'workspace-drag-detach-indicator' : 'workspace-drag-ghost'}
          data-screen-x={drag.screenX}
          data-screen-y={drag.screenY}
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            left: drag.detachReady
              ? Math.min(Math.max(12, drag.x - 40), Math.max(12, window.innerWidth - 250))
              : drag.x - 40,
            top: drag.detachReady
              ? Math.min(Math.max(12, drag.y - 12), Math.max(12, window.innerHeight - 44))
              : drag.y - 12,
            pointerEvents: 'none',
            opacity: drag.detachReady ? 0.98 : 0.85,
          }}
        >
          <span className={`drag-ghost-dot panel-${drag.panel}`} aria-hidden />
          {drag.detachReady ? `Release to open ${PANEL_TITLES[drag.panel]} in a new window` : PANEL_TITLES[drag.panel]}
        </div>,
        document.body
      )}

      {/* Unified agent-activity popover, anchored under the "N active" badge. */}
      {activityPopoverRect && createPortal(
        <AnimatedDropdown
          className="topbar-dropdown activity-pop-shell"
          style={{
            position: 'fixed',
            top: activityPopoverRect.bottom + 4,
            left: activityPopoverRect.left,
            zIndex: 9999,
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          <AgentActivityPopover tasks={agentTasks} onJump={jumpToAgentSession} />
        </AnimatedDropdown>,
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
          {(TOPBAR_GROUPS.find(g => g.label === groupDropdown.label)?.panels ?? []).map((item, index) => {
            const panel = item.id
            const isOpen = openIds.includes(panel)
            const detached = isPanelDetached(panel)
            return (
              <button
                key={panel}
                className={`topbar-dropdown-item${isOpen ? ' is-open' : ''}${detached ? ' is-detached' : ''}`}
                role="menuitem"
                autoFocus={index === 0}
                title={detached ? `${PANEL_TITLES[panel]} is open in another window — click to bring it back` : undefined}
                onClick={() => {
                  handleRackClick(panel)
                  setGroupDropdown(null)
                }}
              >
                {item.icon}
                <span className="topbar-dropdown-item-label">{item.label}</span>
                {detached && (
                  <span
                    className="topbar-tab-detached-dot"
                    data-testid={`workspace-tool-${panel}-detached-menu`}
                    aria-label={`${PANEL_TITLES[panel]} is open in another window`}
                  />
                )}
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
              role="menuitem"
              autoFocus
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
      <ApprovalCenter />
    </ToastProvider>
  )
}
