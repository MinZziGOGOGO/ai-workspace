# Architecture

A Windows-only, local-first AI workspace. Three modes — **Chat | Hermes | Claude Code** —
with separate sessions and one shared, project-aware knowledge layer.

> Sessions are separate. Memory is shared.

## Process topology

```
┌─────────────────────────── Windows ────────────────────────────┐
│                                                                │
│  Electron app (this repo)                                      │
│  ├─ Renderer: React UI (Chat / Hermes / Claude Code tabs)      │
│  └─ Main process (Node/TS):                                    │
│     ├─ SQLite (workspace.db): projects, sessions,              │
│     │   memory_items (vectors), nodes/edges (graph)            │
│     ├─ Knowledge MCP server  ◄── the keystone                  │
│     ├─ File watcher (chokidar) → index_queue                   │
│     ├─ Claude Code launcher (CLI, stream-json, subscription)   │
│     └─ Ollama client (chat + embeddings)                       │
│                                                                │
│  Ollama (native Windows, GPU): chat models + nomic-embed-text  │
│  Claude Code CLI (native Windows + Git Bash, Pro login)        │
│                                                                │
│  ┌─────────────── WSL2 ───────────────┐                        │
│  │ Hermes Agent (Python, Nous)        │  ← talks to us over    │
│  │  ACP adapter / API server          │    localhost & stdio   │
│  └────────────────────────────────────┘                        │
└────────────────────────────────────────────────────────────────┘
```

## The keystone decision: knowledge as an MCP server

Memory is implemented **once**, in this app, and exposed three ways:

| Consumer    | Access path                                  |
|-------------|----------------------------------------------|
| Chat tab    | direct function calls (same process)          |
| Hermes      | MCP client → our knowledge MCP server         |
| Claude Code | MCP client → our knowledge MCP server         |

Planned MCP tools: `search_memory(query, scope)`, `save_memory(item)`,
`get_project_context()`, `list_decisions()`, `link_knowledge(src, relation, dst)`.
The "Inject memory" button is just `get_project_context()` rendered into the prompt.

Do NOT build a second memory system inside Hermes config — Hermes's own memory stays
for its internal scratch use; durable shared knowledge goes through MCP.

## Shared Browser panel and MCP control

The Browser feature is implemented once and shared by manual use plus compatible
agents:

| Layer | Responsibility |
|-------|----------------|
| Renderer | Draws Browser panel chrome, tabs, address bar, persistence toggle, errors, and measures the viewport host rectangle. |
| Preload / IPC | Exposes typed browser methods; the renderer never receives direct `webContents` or Electron objects. |
| Main process | Owns the native `WebContentsView` instances, tab lifecycle, navigation, security policy, bounds, screenshots, and DOM interaction scripts. |
| Loopback control server | `src/main/browserControlServer.ts` exposes localhost-only HTTP endpoints for the live app-owned browser views. |
| MCP stdio server | `src/main/mcp/browser-server.ts` proxies agent tools such as `browser_get_state`, `browser_navigate`, `browser_get_content`, `browser_get_elements`, `browser_click`, `browser_type`, `browser_scroll`, and `browser_screenshot`. |

Embedded pages run with `nodeIntegration: false`, `contextIsolation: true`,
`sandbox: true`, and `webviewTag: false`. Navigation is limited to `http:`,
`https:`, and `about:blank`; dangerous schemes such as `file:`, `javascript:`,
`data:`, and custom protocols are blocked before load. Popups are denied by
default; safe popup URLs open as another shared Browser tab instead of an OS
window.

Bounds are renderer-measured from the `.browser-viewport` host and sent through
`browser:setBounds`; the main process clamps invalid rectangles before applying
them to the native view. Hidden, inactive, or covered tabs are parked at zero
bounds so the native surface does not paint over panel chrome, menus, modals, or
other workspace panels.

Agent element targeting is DOM/accessibility based. `browser_get_elements`
returns a temporary interaction map for visible or near-visible elements. Each
snapshot mints a generation id; `browser_click` and `browser_type` reject stale
element IDs when the page has navigated, when no snapshot is active, or when the
element no longer carries the latest snapshot marker.

Session persistence follows the `browser_persist_session` app setting. Off by
default uses an in-memory browser partition; on uses `persist:browser-panel` so
cookies and logins survive app restarts. Toggling the setting rebuilds existing
tab views against the selected partition.

### Shared Browser approval service

All non-user Browser control enters through `browserControlServer.ts`, including
the stdio Browser MCP proxy and direct loopback callers. The server validates the
command, assigns one of the explicit categories below, and submits it to the
application-owned `BrowserApprovalService`; it never calls a mutating Browser
controller operation before policy evaluation. Manual renderer chrome uses a
separate, explicit trusted-user IPC path.

Categories are `browser.read`, `browser.navigate.local`,
`browser.navigate.external`, `browser.interact`, `browser.type`,
`browser.sensitive`, `browser.download`, `browser.upload`, and
`browser.privileged`. The existing Hermes mode value remains the single stored
autonomy preference: mode 1 prompts for all Browser actions; modes 2-5 permit
reads and loopback navigation; modes 3-5 permit ordinary interaction and typing;
modes 4-5 permit external navigation. Sensitive, download, upload, and privileged
categories always require explicit approval. Loopback means only `localhost`,
`127.0.0.0/8`, or `[::1]`; private-address DNS resolution is not trusted.

Requests have unguessable IDs and move from pending to approval/denial, timeout,
cancellation, execution, and a terminal result in the main process. Pending
requests time out after 60 seconds, are cancelled when their tab is destroyed or
the app exits, and element-bound requests are cancelled on intervening page
loads. A client request ID deduplicates retries and approval resolution is
exactly-once. Mutations are serialized per tab; read operations remain
concurrent. Session grants are in-memory and scoped to agent plus category.

The global renderer approval card shows the requesting agent, action, origin,
local/external scope, element description, risk flags, and only a redacted typing
preview. Password/token/key/card/secret-like fields never put their raw value in
renderer state or normal logs. While any approval card is visible, all native
`WebContentsView` Browser surfaces are parked so Chromium cannot paint above the
card. Closing the Browser panel does not resolve a request.

MCP identity is best effort. App-generated Claude Desktop and Hermes launch
configurations attach an application-owned identity label; other loopback clients
are clearly marked unverified. This is useful attribution, not cryptographic
authentication. Loopback callers cannot bypass policy: labelled and unlabelled
clients use the same approval service.

Browser sessions deny Chromium permission requests and permission checks by
default. Uploads and downloads use the same approval service as all agent
Browser commands. `browser_prepare_upload` opens a native picker only after a
`browser.upload` approval and mints unguessable, client-scoped, five-minute
handles held only in the main process. MCP callers receive filenames, sizes,
MIME hints, expiry, and handles--never local paths or contents. A handle is
one-time, invalidated on use, expiry, client/tab cancellation, or shutdown; it
is assigned with Electron's file-input API rather than typed into the page.

`browser_download` accepts only http/https URLs and always requires
`browser.download` approval. Downloads go to the app-managed `Browser Downloads`
directory below user data, using a centralized Windows-safe filename sanitizer,
path containment, and collision suffixes. `will-download` is intercepted for
every Browser session: unrequested page downloads are cancelled and reissued
only after a visible approval; approved commands are short-lived correlated to
avoid a duplicate prompt. The in-memory registry reports safe metadata and
progress, not internal paths. Executables, archives, and key/certificate files
are flagged but are not scanned; completed files are never auto-opened.

Manual file-input clicks remain a clearly user-initiated Chromium picker path.
Manual page downloads follow the same approval and managed-destination policy,
shown as requested by “You”. Page-created popups are denied rather than
escaping into an operating-system window. Clipboard/media/geolocation commands
remain unsupported.

Known limitations: history destinations cannot always be known before Electron
executes back/forward, so they are conservatively classified as external;
click-side-effect detection is advisory rather than complete; non-app-launched
client identity is not authenticated; and approval state is intentionally
in-memory rather than persisted across restarts.

## Storage: one SQLite file

`better-sqlite3`, WAL mode, in Electron `userData`.
- `memory_items` — vector half. Embeddings via Ollama `nomic-embed-text`, stored as
  float32 BLOBs, brute-force cosine search. Swap to `sqlite-vec` only if item count
  makes brute force slow (tens of thousands+).
- `nodes` / `edges` — graph half. Queries are 1–2 hops; SQL is enough. No graph DB.
- All memory writes go through a single serialized write queue (`knowledge.ts`).
  Multiple AIs write concurrently; interleaved graph mutations are forbidden.

## Search scopes

`project` (current + global items) · `related` (adds `project_links`) · `global` (everything).
Claude Code defaults to `project`. Archived projects stay searchable in `global`.

## Projects

Folder-based. A `.aiworkspace.json` marker inside the folder stores the project id, so
moving/renaming a folder and re-importing relinks instead of duplicating. The app wraps
intelligence around the folder; it never owns the files.

## Model layer

Everything goes through `src/main/ollama.ts`. No code may assume a specific model.
Today: small models (e.g. Gemma-class 12B). Later: Nemotron on the big machine — a
config change, not a refactor. Embeddings degrade gracefully: if the embedder is
offline, items store with NULL embedding and search falls back to keyword match;
a backfill job can embed them later.

## Hermes integration (later milestone)

Hermes Agent (NousResearch, Python) supports Linux/macOS/WSL2 — on Windows it runs in
WSL2. Integration surface, in order of preference:
1. **ACP adapter** (stdio/JSON-RPC, built for embedding into editors/frontends)
2. **API server** entry point
Never scrape its CLI. Hermes gets our knowledge MCP server in its MCP config and
points its model provider at Windows-host Ollama (OpenAI-compatible endpoint).
Escalation to Claude Code = a queued request surfaced in the UI, never a blocking
modal — Hermes parks the task and continues with others until you approve.

## Claude Code integration (later milestone)

Native Windows CLI, **subscription login (Pro), never API billing**.
Drive it headless: `claude -p --output-format stream-json` (or the Agent SDK pointed
at the CLI) to get structured events: tool calls, diffs, permission requests. Render
those in the tab. Chat-tab access to Claude models routes through the same CLI —
subscription integration is solved once.

After Claude Code finishes: (a) ask it to summarize changes, (b) independently index
changed files, (c) memory extraction merges both. Never trust the summary alone.

## Memory hygiene

- Immediate writes: research results, completed tasks, architecture decisions.
- Consolidation job: runs **when overdue** (app launch / idle), not at a fixed
  nighttime — laptops sleep. Dedup, merge, relate, prune.
- The Knowledge panel (inspect + delete) ships with the memory system, not after.
  Memory you can't inspect is memory you can't trust.

## Stack rationale (decided)

Electron + TypeScript over Tauri/Rust: the app is an orchestrator of external
processes plus UI plus SQLite. One language end-to-end, `node-pty` for embedding
CLIs, `chokidar` for watching, `better-sqlite3` for storage. Tauri's size/RAM wins
don't matter for a personal power tool.
