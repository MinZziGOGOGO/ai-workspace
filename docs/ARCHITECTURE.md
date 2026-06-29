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
