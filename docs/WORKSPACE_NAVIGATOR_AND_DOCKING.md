# Workspace Navigator and Docking

## Goal

Move the app from a project-picker-first, single-tab shell into a Global-first
workspace where tools can live in a topbar rack or open as dockable workspace
windows.

The direction is a window-manager-style workspace, not a fixed split-screen
layout. Chat, Hermes, Claude Code, Knowledge, Navigator, and future tools should
be showable, hideable, focusable, dockable, and eventually draggable between the
workspace and topbar.

## Current Shape

Today `App.tsx` blocks on `ProjectPicker` until a project is selected. After a
project is open, `WorkspaceShell` shows one active mode at a time:

- Chat
- Hermes
- Claude Code

Knowledge is a side panel, Settings is a modal, and project switching means
returning to the picker.

Global Workspace already exists as a project sentinel:

- `GLOBAL_PROJECT_ID`
- `projects.ensureGlobalProject()`
- empty `project.path`
- no folder watcher or indexer

This is the correct base. The next UX architecture should make Global Workspace
the default startup workspace instead of requiring a picker click.

## UX Principles

- Startup should be useful immediately.
- Chat and shared memory must work without a project folder.
- Folder-bound tools must say clearly when a real folder is required.
- Sessions stay separate; memory stays shared through the existing knowledge
  layer.
- The Navigator replaces the Project Picker as an always-available workspace
  tool, not as a blocking entry screen.
- The topbar becomes a tool rack: tools can remain there, open into the
  workspace, and later move between rack and workspace via drag interactions.
- The first implementation should prove the model with simple open, close, and
  focus behavior before attempting drag-and-drop.

## Startup Model

App startup should open directly into Global Workspace with Chat available.

Expected first screen:

- Workspace shell is visible immediately.
- Current workspace badge reads `Global Workspace`.
- Chat is open or available in the topbar and can start a session.
- Knowledge is available for global/shared memory.
- Navigator is available from the topbar and can be opened into the workspace.
- Project selection is no longer a blocking full-screen prerequisite.

Implementation implication:

- `App.tsx` should eventually call `window.api.projects.global()` during startup
  and render `WorkspaceShell` once the global sentinel is available.
- The old `ProjectPicker` component should not disappear immediately. It should
  be refactored into the Navigator's global-mode content.

## Navigator

Navigator is the evolution of Project Picker into a dockable tool window.

Navigator should have two modes.

### Global Mode

Shown when the current workspace is Global Workspace.

It should include:

- Global Workspace entry and status.
- Recent and known folder-backed projects.
- Create project action.
- Import project action.
- Archived project restore path.
- Workspace search across projects and shared memory.
- Clear affordance for switching into a project workspace.

Global mode should not assume a filesystem root. It is a launcher, recents list,
and search surface.

### Project Mode

Shown when the current workspace is a folder-backed project.

It should include:

- Current project name and path.
- Project files/tree.
- Project file search.
- Project memory/search entry points.
- Workspace switcher to return to Global Workspace or another project.
- Project management actions such as archive or relink where appropriate.

Project mode may depend on the project path. If the path is missing, moved, or no
longer accessible, Navigator should show a repair/relink state rather than an
empty tree.

## Dockable Tools

The main tools should become dockable or torn-off workspace windows:

- Chat
- Hermes
- Claude Code
- Knowledge
- Navigator
- future Editor
- future Terminal
- future Activity

Each tool window should have:

- stable `windowId`
- `toolId`
- title
- workspace id
- focus state
- close/hide behavior
- minimum size
- optional project requirement
- optional busy/dirty state

Tool availability depends on the current workspace:

- Chat: available in Global and project workspaces.
- Knowledge: available in Global and project workspaces.
- Navigator: available in Global and project workspaces.
- Hermes: requires a real project folder.
- Claude Code: requires a real project folder.
- Editor: requires a real project folder for file editing.
- Terminal: requires a real project folder for project terminal sessions.
- Activity: can work globally, but project-specific entries should be scoped
  when a project is open.

Folder-required tools should remain visible but disabled or open into a useful
empty state in Global Workspace. Existing Hermes and Claude Code global notices
are the right pattern.

## Topbar Tool Rack

The topbar should behave like a tab/tool rack rather than a mutually exclusive
mode selector.

Near-term behavior:

- Tools can live as buttons in the topbar.
- Clicking a tool opens or focuses its workspace window.
- Active/focused tool is visually indicated.
- Busy tools show activity state even when hidden.
- Tools that require a folder show disabled state or an explanatory window in
  Global Workspace.

Later behavior:

- Tool buttons can be dragged out of the topbar like browser tabs.
- Workspace windows can be dragged back into the topbar.
- Multiple instances may be allowed for future tools where useful, such as
  Editor or Terminal.

The first implementation should not attempt full drag-and-drop. It should use
explicit open, close, hide, and focus actions so state and persistence are stable
before interactions become more fluid.

## Recommended Layout Data Model

Persist layout per workspace, with a version number for migrations.

```ts
type WorkspaceLayoutState = {
  version: number
  workspaceId: string
  topbarTools: TopbarToolState[]
  dockedLayout: DockNode | null
  focusedWindowId: string | null
  updatedAt: number
}

type TopbarToolState = {
  toolId: ToolId
  pinned: boolean
  order: number
  badge?: 'busy' | 'error' | 'dirty'
}

type ToolId =
  | 'chat'
  | 'hermes'
  | 'claudecode'
  | 'knowledge'
  | 'navigator'
  | 'editor'
  | 'terminal'
  | 'activity'

type DockNode =
  | DockSplitNode
  | DockStackNode
  | DockWindowNode

type DockSplitNode = {
  type: 'split'
  direction: 'row' | 'column'
  ratio: number
  first: DockNode
  second: DockNode
}

type DockStackNode = {
  type: 'stack'
  activeWindowId: string
  windows: DockWindowNode[]
}

type DockWindowNode = {
  type: 'window'
  windowId: string
  toolId: ToolId
  title: string
  state?: Record<string, unknown>
}
```

Persistence rules:

- Global Workspace has its own layout keyed by `GLOBAL_PROJECT_ID`.
- Each folder-backed project has its own layout keyed by project id.
- Layout restore should be best-effort.
- Unknown tools should be skipped.
- Invalid trees should fall back to a default layout.
- Layout version should be checked before restore so future migrations are
  explicit.

Initial default layouts:

- Global Workspace: Chat primary, Navigator and Knowledge available in topbar.
- Project workspace: Chat primary, Navigator and Knowledge available in topbar;
  Hermes and Claude Code available but not necessarily opened.

## Edge Cases

### Global Workspace Has No Project Folder

Global Workspace has an empty path by design. It must not start file watchers,
index project files, open terminals, or pass its path to folder-required agents.

Chat and Knowledge should use global/shared memory behavior. Memory writes from
Global Chat should stay global, matching the existing `projectId: null` pattern
for global memory where appropriate.

### Folder-Required Tools in Global Workspace

Claude Code, Hermes, Explorer/file tree, Editor, and Terminal may require a real
folder.

Behavior should be consistent:

- Tool can be visible in the rack.
- Opening the tool shows a clear project-required state, or the rack button is
  disabled with a clear tooltip.
- The state should offer a path to open Navigator and switch to a project.

### Unsaved Editor Changes When Switching Projects

Future Editor windows must track dirty state.

When switching workspace:

- If all editor changes are saved, switch immediately.
- If dirty files exist, prompt to save, discard, or cancel.
- Project switch must not silently drop edits.
- Dirty editor windows should show a topbar/window badge.

### Closing or Hiding Busy AI Windows

Busy AI tools include active Chat streams, Hermes runs, and Claude Code runs.

Closing or hiding should distinguish between view visibility and process control:

- Hide/minimize should keep the run alive.
- Close should warn if it would stop or detach from a busy run.
- If the run can continue in the background, the topbar should show a busy badge.
- Stop/cancel should remain explicit.

### Layout Restore Failures

Layout restore can fail because of old versions, missing tools, invalid trees,
small screens, or removed projects.

Fallback behavior:

- Log the restore failure.
- Load a safe default layout.
- Keep the workspace usable.
- Do not block app startup on layout state.

### All Windows Closed

The workspace should never feel broken when all windows are closed.

Options:

- Show an empty workspace surface with a compact tool launcher.
- Keep the topbar rack visible.
- Offer one-click open actions for Chat, Navigator, and Knowledge.

### Small Screens

Small screens should prefer stacks over side-by-side splits.

Behavior:

- Collapse complex split layouts into tab stacks below a width threshold.
- Enforce minimum window sizes.
- Keep topbar tools accessible, possibly behind an overflow menu.
- Avoid layouts where panels become too narrow to operate.

## Phase Plan

### Phase A: Global-First Startup and Navigator Window Shell

- Start the app directly in Global Workspace.
- Keep Chat immediately available.
- Introduce Navigator as a dockable-window-shaped component shell.
- Move current Project Picker content into Navigator global mode.
- Keep project open/create/import/archive behavior intact.
- Update smoke tests so startup expects the workspace shell, not the picker.

This phase should avoid a full docking engine. A simple shell area with one
Navigator panel/window is enough.

### Phase B: Docking Workspace Core with Chat, Knowledge, Navigator

- Introduce the first layout state model.
- Support opening, closing/hiding, and focusing Chat, Knowledge, and Navigator.
- Replace the single active mode body with a workspace surface.
- Persist per-workspace layout state with a version.
- Add safe default layouts and restore fallback.

This phase proves the core interaction model with tools that already work in
Global Workspace.

### Phase C: Add Hermes and Claude Code as Dockable Windows

- Move Hermes and Claude Code from single-tab modes into dockable tool windows.
- Preserve their project-required Global Workspace notices.
- Preserve their session rails, streaming behavior, stop controls, setup states,
  and memory injection behavior.
- Show busy/error state in the topbar rack.

### Phase D: File Tree in Navigator

- Add project-mode file tree and project file search to Navigator.
- Keep Global mode focused on workspace switching, recents, create/import, and
  workspace search.
- Handle missing or moved project folders with a repair/relink state.

### Phase E: Editor Window with File Preview/Edit/Save

- Add Editor as a dockable window.
- Support opening files from Navigator.
- Add preview, edit, save, dirty state, and project-switch protection.
- Keep renderer file access behind preload/main IPC.

### Phase F: Terminal Window

- Add Terminal as a dockable project-required window.
- Use a safe main-process integration for shell/process access.
- Do not expose Node APIs directly to renderer code.
- Define lifecycle behavior for running terminal processes during close,
  project switch, and app quit.

### Phase G: Drag-to-Dock Interactions

- Add drag handles for topbar tools and docked windows.
- Support dragging tools from topbar into workspace.
- Support rearranging dock splits/stacks.
- Support returning windows to the topbar.
- Keep keyboard and explicit-menu alternatives for accessibility.

### Phase H: Layout Presets and Polish

- Add layout presets such as Global Chat, Research, Coding, Review, and Agent
  Monitor.
- Improve small-screen behavior.
- Add visual activity strip, permission badge, context bar, and token estimates
  as window-manager-aware surfaces.
- Polish restore, overflow, focus, and empty-workspace states.

## E2E Testing Strategy

Playwright coverage should evolve with each feature. Tests should assert stable
user-visible behavior rather than implementation details.

Initial tests:

- Global startup test: app opens directly to `workspace-shell`, shows Global
  Workspace, and Chat is available without clicking Project Picker.
- Navigator open/switch workspace test: open Navigator from topbar, verify Global
  mode content, switch to a project if a test project is available, then switch
  back to Global Workspace.
- Docked window open/close/focus test: open Chat, Knowledge, and Navigator;
  focus each; close or hide one; verify the remaining windows still work.

As phases land:

- Update existing Global Workspace smoke coverage instead of preserving the old
  picker-first expectation.
- Add Hermes and Claude Code docked-window tests for Global project-required
  states.
- Add file-tree tests once Navigator has project-mode file browsing.
- Add Editor dirty-state tests before project switching is enabled from an
  editor-bearing layout.
- Add layout restore tests for valid layout, invalid layout, unknown tool, and
  small-screen fallback.

Automated UI verification should be reported as Playwright verification. Manual
verification should only be claimed when a human has actually clicked through
the app.

## Non-Goals for the First Implementation

- No full drag-and-drop docking in Phase A.
- No fixed split-screen replacement.
- No second memory system.
- No direct renderer filesystem or process access.
- No migration away from Electron, TypeScript, React, sql.js, Ollama, MCP,
  Claude Code CLI, or WSL2 Hermes.
