# Window Detach — Design Document

Status: design only, no implementation. Scope: let any panel (Chat, Hermes, Claude
Code, Codex, Kimi, Settings, Knowledge, Research, Navigator, Editor, Terminal,
Activity, Extensions, Browser, Preview) be dragged out of the main window into
its own native OS window, and dragged back to re-dock.

## 0. What the codebase already does today (grounding)

Three facts drive most of the design below.

**Fact 1 — single window, today.** [`src/main/index.ts`](src/main/index.ts:199)
calls `createWindow()` once; a second window is only ever created if all windows
close (`app.on('activate', ...)`). There is currently no code path that opens a
second window while the app is running.

**Fact 2 — agent-tab IPC replies are already per-window-scoped, not
hardcoded.** Every streaming handler for chat/hermes/codex/claudecode/kimi in
[`src/main/ipc.ts`](src/main/ipc.ts) resolves its reply target at call time with
`const win = BrowserWindow.fromWebContents(event.sender)` (13 call sites, e.g.
ipc.ts:1128, 1351, 1591, 1868) and then does `win?.webContents.send(...)`. This
means if a renderer in a *second* `BrowserWindow` invokes `claudecode:send`, the
streamed tokens already come back to *that* window, with zero main-process
changes. This is the single biggest reason a per-panel detached window is
tractable: the request/response and streaming plumbing for agent tabs does not
assume "the main window" — it assumes "whichever window asked."

**Fact 3 — the WebContentsView panels (Browser, Preview) do the opposite: a
module-level singleton.** [`src/main/browserPanel.ts`](src/main/browserPanel.ts:56)
and [`src/main/previewPanel.ts`](src/main/previewPanel.ts:20) each hold one
`let hostWindow: BrowserWindow | null` set once via
`registerBrowserHostWindow`/`registerPreviewHostWindow` (called once from
index.ts), and every `emit()` sends to `hostWindow.webContents` unconditionally.
There is exactly one Browser panel and one Preview panel in the whole app (not
per-window), so this singleton is intentional today — but it means detaching
Browser/Preview requires *retargeting* that one pointer, not multiplying
instances.

**Fact 4 — panels are not literally "always mounted."** In
[`WorkspaceShell.tsx`](src/renderer/src/components/WorkspaceShell.tsx:1448)
`renderContent(panel)` is only called for panel ids present in the *active*
layout tree. Critically, fullscreening a panel
(`WorkspaceShell.tsx:1280`, `activeLayout = fullscreenId ? {root:{pane:fullscreenId}, ...} : layout`)
collapses the render tree to a single node — every other open panel is fully
unmounted from React while fullscreened, then remounted when fullscreen exits.
**The app already tolerates and recovers from full unmount/remount of every
agent tab.** ChatTab/HermesTab/ClaudeCodeTab/etc. must (and do) rehydrate from
`sessions:list` / `messages:list` IPC calls on mount rather than relying on
retained React state. This is the closest existing precedent for what a
detached-window remount needs to do, and it substantially de-risks Option A.

**Fact 5 — the in-window drag/dock system is pointer-position-driven, not
DOM-drag-driven.** `startDrag` (WorkspaceShell.tsx:1261) is a manual
`pointerdown`/`pointermove`/`pointerup` state machine (`DragState`), not the
HTML5 Drag and Drop API. Hit-testing (`resolveDropAt`, WorkspaceShell.tsx:682)
compares `event.clientX/clientY` against `DOMRect`s of open panels and 40px edge
bands. Because it's driven by raw pointer coordinates rather than native
drag-and-drop, it **cannot** naturally detect "pointer left the OS window" —
`pointermove`/`pointerup` are captured by the browser's own window and stop
firing once the cursor crosses into OS space outside it. Tear-off-to-new-window
needs a different signal (see §3).

---

## 1. Option A vs Option B

**Recommendation: Option A (ownership transfer), for every panel.**

### Evidence from this codebase specifically

| State category | Where it actually lives today | Implication |
|---|---|---|
| Session/message history (Chat, Hermes, Claude Code, Codex, Kimi) | `better-sqlite3` via `sessions:list`/`messages:list` IPC (main process, WAL-backed per [CLAUDE.md](CLAUDE.md)) | Reload-safe from any window; already the sole source of truth after any unmount (Fact 4). |
| In-flight agent process / PTY / ACP connection | `child_process` in `src/main/hermes.ts`, spawned processes for Claude Code/Codex CLIs in main | Main-process-owned regardless of which window is watching; a detach only needs to redirect where `win.webContents.send` points (Fact 2). |
| Streamed tokens/events mid-turn | Resolved per-call via `BrowserWindow.fromWebContents(event.sender)` | Already "give the reply to whoever asked" — no singleton to fight. |
| Knowledge (memory items) | SQLite via the write queue in `src/main/knowledge.ts` per CLAUDE.md | Main-owned. |
| Browser/Preview page content | `WebContentsView` owned by main, attached to `hostWindow.contentView` | Main-owned natively; the "window" is a detail of which `BrowserWindow` the view is a child of (Fact 3). |
| **Composer draft text (unsent input)** | Renderer `useState` in each tab (e.g. `ChatTab.tsx`), *not* visible in any IPC write path found | **Renderer-local, not persisted.** This is real renderer-only state. |
| Scroll position, "is X dropdown open," drag state, fullscreen flag | Renderer `useState`/refs in `WorkspaceShell.tsx` / tab components | Renderer-local, but genuinely ephemeral — nobody expects scroll position to survive a window move in any app. |
| Pinned sessions (`ChatTab.tsx` `PINNED_KEY`), model choice (`MODEL_CHOICE_KEY`) | `localStorage`, keyed globally (not per-window) | Shared automatically across windows in the same app (Electron renderers backed by the same profile share `localStorage` per origin) — no transfer needed. |

So: the overwhelming majority of state that matters (history, live agent
output, knowledge, approvals) is already main-process-resident, exactly the
precondition the task called out for Option A to be the right call. The one
category that is genuinely renderer-local and *not* persisted anywhere is
**in-progress composer draft text**. That is a small, well-scoped gap — not "a
meaningful amount of state," but it must be handled explicitly (see §4.2)
rather than silently dropped, since losing an unsent draft on a drag gesture
would be a visible regression.

Option B (mirrored/synced) would require duplicating this already-solved
problem: every `win?.webContents.send` call site in ipc.ts would need to become
a broadcast-to-N-windows-with-filtering, every WebContentsView would need N
views kept in sync pixel-for-pixel, and approval-card state
(`browserApproval.ts`, `ApprovalCenter.tsx`) would need a second source of
truth reconciliation that does not exist today. Given Fact 2 (replies are
already scoped to the requesting window) and Fact 3 (only one instance of
Browser/Preview exists conceptually), Option B buys flexibility (show the same
panel twice) nobody has asked for, at a cost of rebuilding synchronization the
app doesn't currently need.

---

## 2. Panel-type mechanics

### 2.1 WebContentsView panels — Browser, Preview (smaller lift)

Today: one `WebContentsView` per tab (Browser) or one singleton view
(Preview), a child of `hostWindow.contentView`, positioned by
`view.setBounds()` to overlay a DOM placeholder rect the renderer streams via
`browser:setBounds` (`browserPanel.ts:548`) / `preview:setBounds`.

Detach mechanic — this is genuinely close to free, because Electron's
`contentView.addChildView`/`removeChildView` operate on the view object, and a
`WebContentsView` is not bound to one window for life:

1. Create a new, minimal `BrowserWindow` ("panel host window") sized/positioned
   per §3.
2. `mainWindow.contentView.removeChildView(view)` then
   `detachedWindow.contentView.addChildView(view)` — the WebContentsView (and
   its live page, scroll position, form state, video playback) moves as-is; no
   navigation, no reload.
3. Retarget the module singleton: `hostWindow = detachedWindow` (both files
   already expose `registerBrowserHostWindow`/`registerPreviewHostWindow` for
   exactly this kind of reassignment — reuse them, don't add new plumbing).
4. Load a minimal renderer into `detachedWindow` in "single panel" mode (see
   2.2) that renders just the Browser or Preview chrome (tab bar/URL bar) and
   drives the *same* `browser:setBounds` IPC channel against its own
   `<div>` placeholder — the bounds-sync loop in `BrowserPanel.tsx` is already
   generic over "which window am I in," it just needs to run in the detached
   renderer too.
5. Main window's slot shows a placeholder ("Browser is open in another
   window" + a "Bring back" button that reverses steps 2–3).

Re-dock reverses the same two `contentView` calls. No new Electron API is
needed; this is the "real head start" the task called out.

Caveat specific to this codebase: `browserPanel.ts` parks *all* tabs to
`HIDDEN_BOUNDS` except the active one (`setActiveTab`), and the drag-parking
logic (`parkAllForDrag`/`browser-drag-change` event) currently assumes a
single window's drag gesture. When Browser is detached, its own window's
future in-window drags (if it ever gets its own docking, not in this scope)
would need the same park/restore signal scoped to that window — out of scope
for v1 since a detached Browser window has nothing else to dock against.

### 2.2 React panels — Chat, Hermes, Claude Code, Codex, Kimi, Settings,
Knowledge, Research, Navigator, Editor, Terminal, Activity, Extensions

No native view to reparent — these are plain React trees. Detach mechanic:

1. **Detached-window renderer mode.** Add a query param the renderer bundle
   checks at boot, e.g. `?detachedPanel=claudecode&projectId=...`. When
   present, mount a slim `DetachedPanelShell` instead of the full
   `WorkspaceShell` — same providers (`ToastProvider`, `AgentActivityProvider`
   equivalent, `ShortcutContext`) wrapping a single panel's `renderContent()`
   call, reusing the existing `PANEL_TITLES`/`renderContent` switch instead of
   duplicating it (extract `renderContent` out of `WorkspaceShellInner` into a
   shared function keyed by `DockPanel`, callable from both shells).
2. **Window creation.** Main process: on detach, `new BrowserWindow({...})`
   loading `index.html?detachedPanel=<id>&projectId=<id>` (dev: the Vite dev
   server URL with the same query string — same pattern `createWindow()`
   already uses for prod vs dev loading).
3. **Data.** Unchanged IPC surface. Because of Fact 2, `ClaudeCodeTab` mounted
   in the detached window calling `claudecode:send` gets its streamed tokens
   delivered to *that* window automatically — no new "which window" routing
   code needed in main for the 13 already-scoped call sites. The `activity:log`
   / `memory:saved` / `index:updated` channels that use the same
   `BrowserWindow.fromWebContents(event.sender)` pattern behave identically.
4. **Channels that don't fit this pattern must be audited before
   implementation** — specifically anything that currently assumes "the app
   has one window" implicitly (e.g. any handler that calls
   `BrowserWindow.getAllWindows()[0]` or keeps its own single cached `win`
   reference the way `browserPanel.ts`/`previewPanel.ts` do). The grep in this
   pass found the WebContentsView panels as the only such offenders; a full
   implementation pass should re-grep `ipc.ts`, `mcp.ts`, and `browserControlServer.ts`
   for any additional single-window assumptions (e.g. approval-center toasts,
   `menu-overlay-change`/`browser-drag-change` custom events — these are
   `window.dispatchEvent` in the renderer, i.e. per-window already, no risk).
5. **Main window's slot.** Same placeholder treatment as Browser/Preview: show
   "`<Panel>` is open in another window" with a "Bring back" affordance that
   closes the detached window (see §4) and re-adds the panel id to
   `openIds`/the layout tree.

### 2.3 Settings

`SettingsPanel` is currently a modal overlay (`settingsOpen` boolean state),
not a dock panel in `DockPanel`/`PANELS`. It's out of the `DockPanel` union
today, so "detaching" it means promoting it to a real dock panel first (or
special-casing it as its own single-purpose detached window type, skipping the
dock-tree integration). Recommend treating it as its own minimal case — a
"Settings" detached window is just `DetachedPanelShell` with `detachedPanel=settings`
and no corresponding re-dock slot in the tree (since it was never in the tree).
Flag this as a small scope decision to confirm with the user before building,
not a blocker to the design.

---

## 3. Drag-out gesture design

Fact 5 above is the crux: the existing drag state machine only sees
`pointermove`/`pointerup` events *inside* the OS window that's currently
capturing the pointer. Once the cursor crosses the window's edge, Chromium
still delivers move events only if the pointer is captured
(`setPointerCapture`) — which is exactly the tool for this.

Design:

1. On `pointerdown` on a panel header (`startDrag`, WorkspaceShell.tsx:1261),
   call `(e.target as HTMLElement).setPointerCapture(e.pointerId)` on the
   header element. This guarantees `pointermove`/`pointerup` keep firing even
   once `clientX/clientY` go negative or exceed `window.innerWidth/innerHeight`
   — browsers report *out-of-bounds* coordinates for a captured pointer instead
   of just stopping delivery. This is the one behavioral change needed to make
   "dragged outside the window" observable at all; today it silently isn't.
2. In `onMove` (WorkspaceShell.tsx:892), once `e.clientX/clientY` falls outside
   `[0, window.innerWidth] x [0, window.innerHeight]` by more than a threshold
   (recommend 24–32px, roughly the existing `BAND_PX`-adjacent feel, tunable),
   set a new `drag.hoverZone`-equivalent state: `'detach'`. Render a distinct
   visual affordance (e.g. a translucent "drop to open in new window" ghost,
   reusing the existing `zoneHighlightStyle`/highlight-overlay pattern but
   anchored to the cursor rather than a workspace rect).
3. On `pointerup` (`onUp`, WorkspaceShell.tsx:933): if the drag state is
   `'detach'`, call a new IPC (`workspace:detachPanel`) with the panel id and
   the pointer's **screen** coordinates (`e.screenX/screenY`, not `clientX/Y`
   — need the OS-level position since the panel no longer maps to any DOM rect).
4. Main process: use `electron.screen.getDisplayNearestPoint({x, y})` to pick
   the target monitor, then create the detached `BrowserWindow` positioned at
   (or near) that point, sized to a sane default (reuse the panel's last
   on-screen width/height if available, else a fixed default like 900x650 for
   agent tabs or the Browser panel's last measured bounds).
5. Renderer: on receiving detach confirmation, call `removePanel(panel)` (the
   existing function, WorkspaceShell.tsx:1111) to pull it out of the dock tree,
   same code path `closePanel` already uses — detach is "close from the tree"
   plus "but tell main to open it elsewhere" rather than a new tree operation.

Threshold note: 24–32px outside the window (not "half off-screen" or similar)
matches how most tear-off-tab browsers behave (Chrome/Edge tab tear-off
triggers a short distance past the tab strip) and avoids accidental detach
when a user merely drags near — but not past — the window edge, which today
resolves to the existing `left`/`right`/`top`/`bottom` band zones
(`getBandZone`, WorkspaceShell.tsx:576) and must keep doing so. The two
gestures share the same drag state machine, so precedence is: inside window →
existing band/local resolution (unchanged); outside window past threshold →
detach. No pixel range is claimed by both.

**Re-docking (fast-follow, not required for v1, noted per the task's
explicit allowance):** the detached window's header would need its own
`pointerdown`/`pointermove` capture, and on `pointerup` check whether the
cursor is over the *main* window's bounds (via
`screen.getCursorScreenPoint()` cross-referenced against
`mainWindow.getBounds()`, since a captured pointer in a different
`BrowserWindow` can't directly hit-test another window's DOM). If so, send
`workspace:redockPanel` with the panel id; main closes the detached window
(after handing back ownership per §2) and the main renderer calls `openPanel`.
This requires a small IPC round trip through main because two separate
renderer processes cannot directly observe each other's DOM — worth flagging
as the one piece of re-dock that's structurally different from in-window drag
(which is pure DOM hit-testing) rather than just "the same code running
twice."

---

## 4. Multi-window state and lifecycle

### 4.1 Main window closes while a panel is detached

Recommend: closing the main window prompts
("This will also close 2 detached windows (Claude Code, Browser). Continue?")
rather than leaving orphans with no way back to the app chrome — a detached
window has no menu/topbar of its own in this design (it's a single panel, not
a second full `WorkspaceShell`), so an orphaned detached window would be
inert. Implementation: `mainWindow.on('close', ...)` checks a registry of open
detached windows (main process needs to track panel→`BrowserWindow` mappings
regardless, for the retarget-on-detach mechanism in §2), and either closes
them together or (better default) re-docks them into the closing main window's
state before it's torn down, so relaunching restores the full layout including
what was detached — consistent with how `layout` already persists to
`localStorage` per workspace (`layoutKey`, WorkspaceShell.tsx:398). Simplest
correct behavior: on main window close, synthesize a "redock" for every
detached panel first (updates the persisted layout tree), then close the
detached windows, then proceed with normal close.

### 4.2 Closing a detached panel's window directly (its own titlebar close
button)

Should behave like closing the panel in-window does today
(`closePanel`/`removePanel`, WorkspaceShell.tsx:1125) — i.e. the panel's
*session* is not destroyed (sessions/messages live in SQLite regardless), but
the panel is no longer open anywhere. On next `workspace:openPanel` for that
id (from the topbar), it reopens in the main window and rehydrates from IPC as
normal (Fact 4 already proves this path works). This means: **no special
"reattach on close" behavior is needed** — closing a detached window is just
"close the panel," full stop, exactly like the existing close button. The only
new piece is clearing the panel→window registry entry so a stale pointer isn't
left in main.

The composer-draft gap from §1 applies here: if draft text should survive a
detach→close cycle, it needs to move from renderer `useState` to
`localStorage` (keyed by session id, mirroring `PINNED_KEY`'s existing
pattern) — a small, targeted fix, not a redesign, and arguably worth doing
independent of this feature since it'd also fix draft loss on today's
fullscreen-driven unmount (Fact 4).

### 4.3 Interaction with "always mounted" / background resource usage

Given Fact 4, panels were never guaranteed to stay mounted, so detach doesn't
introduce a new failure mode here — it's the same unmount/remount contract
that fullscreen already exercises. Process-level resources (Hermes ACP
connection, spawned CLI child processes, MCP connections) are owned in main
independent of any renderer's mount state already (they're keyed by session
id, not by webContents), so a detached panel's background agent run continues
uninterrupted whether the panel is docked, detached, or briefly unmounted
mid-transition. No change needed to `hermes.ts`/process-management code for
this feature.

### 4.4 Approvals

`ApprovalCenter.tsx` and `browserApproval.ts` must keep working identically
whether the requesting panel is docked or detached — per the task's explicit
constraint not to weaken approval gating. Because approval requests already
flow through main-process IPC keyed by agent/tab identity (not by window),
and Fact 2 shows replies already route to whichever window is asking, this
should require **no logic changes** — only verification that the Approval
Center's own display surface (wherever it currently renders — main window
topbar?) is reachable/visible regardless of which window originated the
request. If `ApprovalCenter` only renders inside `WorkspaceShell` (main
window), a pending approval for a detached Browser/agent action must still be
visible to the user — recommend keeping Approval Center exclusively in the
main window (single source of truth for "things needing your attention") and
having the main window flash/focus itself when a new approval arrives for a
detached panel's action, rather than duplicating Approval Center into every
detached window.

### 4.5 Taskbar / OS window management

Yes — each detached `BrowserWindow` should appear as its own taskbar entry
(default Electron/OS behavior for any `new BrowserWindow`, nothing to
configure) since that's the entire point of multi-monitor use. Give each
detached window a real `title` (`Claude Code — <project name>`) via
`BrowserWindow`'s `title` option so the taskbar entry is identifiable, and set
a distinct-enough size default per panel type (Browser/Preview probably want
larger defaults than, say, Extensions).

### 4.6 The vacated dock slot — collapse and reflow (implemented)

Steps 1/3/4 shipped an interim placeholder card in the vacated slot ("<Panel>
is open in another window" + Bring back). That is **replaced**: a detached
panel now gives up its dock slot entirely, the way dragging a tab out of a
browser closes the gap in the tab strip.

- **Mechanism.** `WorkspaceShell.applyDetachedLayout` funnels every
  `detachedChanged` event (button-detach, drag-out, dock-back, window close)
  into the panel-close/panel-open functions the header's Close button and the
  topbar rack already use. Allotment reflows the surviving panes on its own —
  no bespoke pane-sizing code was added.
- **No hidden second instance.** The workspace also keeps *closed* panels
  mounted behind `display:none` to preserve their state (Fact 4's escape
  hatch). Detached panels are excluded from that list: their state lives in
  the other window now, and a hidden duplicate would double-subscribe the tab
  and let it park native views the detached window owns.
- **Way back.** Primary: the detached window's own header button
  (`browser-dock-back` / `preview-dock-back` / `<panel>-dock-back`) — the
  window is a real window, so the action belongs in it. Secondary, for a user
  who has lost track of which window holds what: the panel's topbar rack entry
  keeps a small accent dot (`workspace-tool-<panel>-detached`, plus
  `workspace-group-<group>-detached` on the group button, which is all that
  remains visible on narrow windows) and clicking it reattaches instead of
  opening a new slot.

---

## 5. Build order

1. **Browser and Preview panels first.** Smallest lift (Fact 3 + §2.1),
   highest immediate value (the multi-monitor "browser on second screen" use
   case named in the task), and validates the window-creation/screen-placement
   machinery (§3 steps 3–4) end to end without touching the larger React-panel
   surface.
2. **Drag-out gesture generalized** (§3) — build it against Browser/Preview
   first since there's only one instance of each, then confirm it works
   unmodified for the agent tabs once step 3 lands (the gesture code lives in
   `WorkspaceShell.tsx` and is panel-agnostic by construction).
3. **One React agent tab end-to-end** (recommend Claude Code, since it's the
   most exercised tab per the M5 memory note and its IPC pattern
   (`BrowserWindow.fromWebContents(event.sender)`, Fact 2) is representative
   of Hermes/Codex/Kimi/Chat). Extract `renderContent`/`DetachedPanelShell`
   here.
4. **Remaining React panels** (Hermes, Codex, Kimi, Chat, Knowledge, Research,
   Navigator, Editor, Terminal, Activity, Extensions) — mechanically identical
   once step 3's shell exists; mainly a per-panel audit for anything that
   assumes single-window (per the note in §2.2 point 4).
5. **Settings** — small special case (§2.3), do last since it needs a scope
   decision first.
6. **Re-docking by drag** — explicitly a fast-follow per the task; ship
   "close detached window to release the panel back to the topbar" (§4.2) as
   the v1 return path, since it requires no new gesture code.

## 6. Biggest open technical risk

Not the WebContentsView reparenting (Electron supports it natively) and not
the agent-tab IPC (already per-window-scoped per Fact 2) — the actual risk is
**cross-window pointer-capture behavior for the detach gesture itself**
(§3 step 1). `setPointerCapture` continuing to deliver out-of-window
coordinates is standard DOM behavior, but Electron's multi-`BrowserWindow`
compositor/input routing has historically had platform-specific quirks around
drag gestures that cross OS window boundaries (this is exactly the kind of
thing the existing `browser-drag-change`/native-view-parking workaround in
`WorkspaceShell.tsx:1295` had to be built for — WebContentsView already breaks
naive assumptions about pointer/paint layering *within* one window). This
needs an early, cheap spike (a throwaway `pointerdown`→`setPointerCapture`→drag-to-edge
test) before committing to the gesture design in §3, rather than discovering
a platform limitation after the React-panel work in step 3–4 is built on top
of it.
