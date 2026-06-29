# Roadmap

## M1 — Foundation (this scaffold) ✅ scaffolded
Project picker (create / import / archive / relink via marker file), three-tab shell,
SQLite schema, Chat tab vs Ollama with retrieval-grounded system prompt,
Knowledge panel (list / search / delete), save-to-memory.

## M2 — Knowledge MCP server ✅ complete
Expose search_memory / save_memory / get_project_context / link_knowledge over MCP
(stdio + streamable HTTP). Test it from Claude Code on the dev machine first —
instant validation with a real MCP client.
**Done:** stdio MCP server (src/main/mcp/server.ts, out/mcp/server.cjs) reuses the single knowledge layer,
tested via real stdio client, registered in Claude Desktop (scripts/install-claude-desktop-mcp.cjs).
**Known issue:** sql.js has no cross-process locking; see CLAUDE.md caveat.

## M3 — File watcher + indexer ✅ complete
chokidar on the project folder → index_queue → batch indexer (debounced) that
summarizes changed source files with the local model and writes file nodes/edges.
Ignore node_modules, .git, build output.
**Done:** chokidar watcher (src/main/indexer.ts) starts on project open (ipc.ts
`projects:open`), stops on app quit (index.ts `will-quit`). Hybrid monitoring:
real-time add/change/unlink events → `index_queue`, plus a 5-min scheduled re-scan.
Debounced drain reads each changed file, summarizes it via the local Ollama model
(`defaultChatModel`/`chat` in ollama.ts, graceful fallback when no chat model),
and upserts a `file` memory_item + file node/edge through the single write queue
(`saveIndexedFile`/`removeIndexedFile` in knowledge.ts). Re-indexing upserts in
place (no duplicates); deletions remove item + node. Knowledge panel auto-refreshes
via the `index:updated` IPC event. Ignores node_modules/.git/out/dist/build and
non-text files. Verified end-to-end (`npm run test:indexer`): add→index,
change→re-index, unlink→remove.
**Fixed in passing:** `upsertNode` in knowledge.ts bound 4 params to a 3-placeholder
query (latent bug in previously-unused code; sql.js rejects extra params).
**Known issue:** the indexer writes from the Electron process; the sql.js
multi-process caveat (CLAUDE.md) still applies if the MCP server writes concurrently.

## M4 — Memory extraction agent ✅ complete
Local-model pass over finished chat sessions: extract decisions, preferences,
research findings into memory_items + graph. Overdue-triggered consolidation job:
dedup, merge, prune. Quality gate: everything it writes is visible in the
Knowledge panel and deletable.
**Done:** `src/main/extractor.ts` — `extractFromSession` reviews a chat with the
local model (`defaultChatModel`/`chat` in ollama.ts), parses a JSON array of
{type, title, content}, and saves decision/preference/research items via the
single write queue (`saveMemory`, source `extractor`). A semantic dedup guard
(embed + cosine ≥ 0.90) skips re-saving facts on repeated clicks.
`consolidateIfOverdue` runs at launch (index.ts) when >24h since the last run
(tracked in the new additive `app_meta` table), collapsing near-duplicate
memories (cosine ≥ 0.95) and keeping the most informative copy; `consolidateMemories`
is also exposed over IPC. UI: an "✦ Extract memories" button in the Chat header
(visible once an assistant message exists) shows what was saved, and pings the
Knowledge panel to refresh via the existing `index:updated` channel.
**Robustness:** `chat()` gained an optional timeout; the extractor budgets 180s so
a wedged model surfaces "no memories" instead of an infinite spinner. Verified
end-to-end (`npm run test:extractor`): live extraction → valid typed items,
re-extraction dedup, consolidation removes duplicates, post-loop convergence (no
near-dup pairs survive), and the 24h overdue gate. Also verified live in the app.
**Schema:** added `app_meta(key, value)` via migration (additive; no existing table touched).
**Env note:** this dev box's Ollama is compiled without a kernel for the RTX 3080's
compute capability 8.6, so chat models fall back to CPU (~50s/call). Embeddings are
fine; extraction works but is slow until Ollama is rebuilt with cc 8.6 support.

## UI polish (with M4) ✅
Renderer-only restyle to a dark, professional, Linear/Raycast-grade feel, keeping
the amber/teal/violet mode-accent token system: pill-style topbar mode tabs with a
glowing active indicator; session list hover + accent active bar; chat message
redesign (right-aligned user bubbles, assistant left-accent line, message fade-in);
a premium composer card (focus-within ring, custom-styled model dropdown); card-style
Knowledge items with per-type colored pills and hover lift; designed empty states for
the Hermes/Claude Code tabs (accent icon, "coming in Mx" badge); panel slide-in. No
backend or architecture changes in the polish pass.

## M5 — Claude Code tab ✅ complete
Launch CLI headless (stream-json) under subscription login. Render tool calls,
diffs, permission requests. "Inject memory" button = get_project_context() into
the prompt. Post-task: summary + independent re-index.
**Done:** `src/main/claudecode.ts` — launcher that resolves the CLI binary
(`%APPDATA%\Claude\claude-code\<ver>\claude.exe`, npm shim, or PATH; override via
`AIWORKSPACE_CLAUDE_BIN`), then spawns `claude -p <prompt> --output-format
stream-json --verbose --permission-mode acceptEdits` in the project folder. It
passes **no API key** — the CLI authenticates via the subscription login
(`init.apiKeySource: "none"` confirms it). The newline-delimited JSON stream
(`system/init`, `assistant` text+`tool_use`, `user` `tool_result`, `result`) is
normalized into a small `CCEvent` stream (text / tool / tool-result / system /
error). The exe is spawned directly (no shell) with the prompt as a clean argv
arg; shell fallbacks (npm `.cmd`) feed the prompt over stdin so it never touches
a command line. `checkClaudeCode()` reports install/version; not-logged-in and
not-found are detected and surfaced as clear setup guidance.
**IPC/preload:** `claudecode:check` + `claudecode:send` (ipc.ts), streaming
`claudecode:event` / `claudecode:done` channels, `window.api.claudeCode` bridge.
**UI:** `ClaudeCodeTab.tsx` (violet mode accent) — session list (mode
`claudecode`, saved like chat sessions for review), streaming output panel, an
**activity log** of tool calls with per-call ✓/✕ status, an **"Inject memory"**
toggle (header) that prepends `formatProjectContext(getProjectContext())` to the
next task, and a **setup notice** for the missing/not-logged-in cases. Turns are
persisted as messages: `user` (prompt) + `tool` (activity-log JSON) + `assistant`
(result), so reopening a session replays the work.
**Post-task:** `summarizeRun()` records tools used + files touched + outcome and
saves a `task` memory item (source `claudecode`) through the **single write
queue** (`saveMemory`); the panel is pinged via `index:updated`. Changed files
are picked up **independently** by the existing M3 watcher (chokidar `add`/`change`
on the open project) — no manual re-index needed.
**Shared helper:** `formatProjectContext` added to knowledge.ts (the in-process
renderer behind the Inject-memory button; the MCP server keeps its own copy).
**Verified:** `npm run test:claudecode` (new) runs the REAL CLI against a
throwaway project — asserts the event stream parses (`system/init` seen), and
either (logged in) hello.ts is created + a file-write appears in the activity log
+ a task summary is saved to memory, or (not logged in / not installed) the
launcher detects it and returns a clear setup message without crashing. tsc clean,
`npm run build` green.
**Env note (this dev box):** Claude Code auth here is provided in-process by the
Claude Desktop host (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`, host OAuth refresh);
there is no standalone `~/.claude/.credentials.json`, so a bare `claude -p` spawn
reports "Not logged in". The launcher handles this exactly as specified (setup
message). Actual file-creating runs require a persisted `claude login` (or
launching the app within an authenticated host environment) — verified to the
point of the auth boundary; the create-hello.ts happy path could not be exercised
on this machine because of it.
**Not yet (deferred to M7):** rich diff rendering and interactive permission
prompts — `acceptEdits` auto-approves file edits headlessly; denials are logged.

## M6 — Hermes tab ✅ complete
Hermes Agent in WSL2 via ACP adapter / API server. Chat, task queue, kanban,
activity log. Hermes config: our MCP server + Windows-host Ollama. Queued
(non-blocking) escalation requests to Claude Code.
**Done:** `src/main/hermes.ts` — the Electron-main client mirroring claudecode.ts.
Talks to the Hermes API server on `localhost:7823` (override via `HERMES_URL`).
`checkHermes()` answers the three-state setup question — WSL2 present? Hermes
installed? API up? — by trying `GET /health` first (a reachable server means
installed+running) and only falling back to the slower WSL probes (`wsl -l -q`,
decoded from UTF-16LE; an `~/.ai-workspace-hermes/installed` marker) when it's
down. `runTask()` POSTs `/tasks`, then **polls** `/tasks/:id` to a terminal state,
diffing the server's activity log so the renderer receives a **live stream** of
activity + status events (requirement: stream activity back + poll status); it's
abortable (cancels the server task) and time-bounded. `listTasks()` backs the
queue panel; `cancelTask()`, `startHermes()` (kicks the WSL `start.sh` detached
via `nohup`) round it out. All server JSON is normalized defensively
(`status|state`, `result|output`, seconds-or-ms timestamps).
**IPC/preload:** `hermes:check` / `hermes:tasks` / `hermes:cancel` / `hermes:start`
/ `hermes:abort` / `hermes:send` (ipc.ts), streaming `hermes:event` / `hermes:done`
channels, `window.api.hermes` bridge. `hermes:send` persists the turn (prompt +
activity-log JSON + result) as messages and saves a durable `task` memory item
(source `hermes`) through the **single write queue**; the panel is pinged via
`index:updated`.
**UI:** `HermesTab.tsx` (teal mode accent) — session rail + centred chat like the
other tabs, a right-hand **task-queue panel** grouping the server queue by status
(running/pending/completed/failed/cancelled, with cancel buttons and a pulsing
running dot), a live **activity log**, a **connection-status indicator** in the
header (polls `/health` every 4s), an **"Inject memory"** toggle (prepends
`formatProjectContext(getProjectContext())`), and a **setup notice** that branches
on the missing step — no WSL2 → `wsl --install`; WSL but not installed → run the
setup script; installed but down → a one-click **Start Hermes** button.
**Installer:** `scripts/setup-hermes.ps1` (run once) — ensures the Ubuntu WSL2
distro (installs if missing), installs Python 3.11+ + uv, installs `hermes-agent`
(PyPI, GitHub fallback) into an isolated uv venv, writes a Hermes config that
points the model provider at **Windows-host Ollama** (`http://host.docker.internal:11434`,
OpenAI-compatible `/v1`) and registers this workspace's **knowledge MCP server**,
drops `start.sh` + the `installed` marker, and starts the API on `localhost:7823`
(then polls `/health` to report truthfully).
**Memory integration:** the MCP entry reuses the exact `out/mcp/server.cjs` Claude
Desktop uses — Hermes (Linux) spawns the Windows `node.exe` over WSL interop
against the Windows-side `workspace.db` (`AIWORKSPACE_DB_DIR`). Memory stays
implemented once; no second store. The CLAUDE.md sql.js single-writer caveat
applies (Hermes + app must not write concurrently) — same documented M2 limitation.
**Verified:** `npm run test:hermes` (new) — with `HERMES_TEST_MOCK=1` a built-in
mock server exercises the full submit→poll→stream→summary path (status + activity
events stream, task summary saved to memory); without it, the test asserts
`checkHermes()` reports state accurately and the setup/SKIP path is clean (no
crash). On this box it correctly detects WSL2+Ubuntu present, Hermes not yet
installed. tsc clean, `npm run build` green.
**Env note (this dev box):** WSL2 (with Ubuntu) is present but Hermes itself is not
installed, so the live submit path was validated against the mock; the real
end-to-end run requires running `setup-hermes.ps1` first.
**Not yet (deferred):** kanban drag-between-columns and queued (non-blocking)
escalation-to-Claude-Code requests — the queue panel groups by status but doesn't
yet support reordering or cross-agent handoff.

## M7 — Polish ✅ complete (done before M6 as a stability pass)
**Done:** full UI redesign to the Claude Code desktop aesthetic — deep warm dark
(#1a1a18 range), tight dense spacing, semi-monospace for tool output/paths/hints,
2px accent underline on active mode tabs, accent only on primary buttons, no
gradients/glows, subtle elevation only on floating cards (renderer-only; the
amber/teal/violet token system stays). Fixes shipped with it:
- ClaudeCodeTab `/memory` now opens the Knowledge panel via a proper
  `onOpenKnowledge` prop wired through WorkspaceShell (DOM reach-across removed).
- Knowledge panel scope selector (This project / Related / All projects) driving
  the existing `searchMemory` scopes.
- Chat sessions auto-title from the first user message (40 chars) after the
  first assistant reply, via a new `sessions:rename` IPC (no schema change).
- `start:win` (scripts/start.ps1) now starts `ollama serve` in the background if
  it isn't reachable — one click starts everything.
- Settings panel (topbar gear): project path, memory-item count, clear-project-
  memories (two-step confirm, through the single write queue), Ollama connection
  dot, and the default chat model. New read-only IPC: `memory:count`,
  `memory:clearProject`, `ollama:status`.
**Deferred** (from the original M7 list, unscheduled): permission modes, project
inheritance/import of knowledge, deep research pipeline, Chat→Claude via Claude
Code CLI routing, notes, packaging (electron-builder NSIS).
