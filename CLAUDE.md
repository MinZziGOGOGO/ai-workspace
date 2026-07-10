# CLAUDE.md — project conventions for Claude Code

This is a local-first Electron + TypeScript AI workspace. Read docs/ARCHITECTURE.md
before changing anything structural; it records decided architecture. Do not revisit
decided choices (Electron over Tauri, single SQLite file, MCP as the knowledge
interface, subscription-only Claude access) unless the user asks.

Rules
- One language: TypeScript everywhere. No Python/Rust in this repo (Hermes is external).
- All DB access lives in src/main. The renderer talks only through the preload bridge.
- All memory writes must go through the write queue in src/main/knowledge.ts.
- Never assume a specific LLM. All model access goes through src/main/ollama.ts.
- Never integrate Anthropic API billing. Claude access = Claude Code CLI, subscription login.
- Keep the mode-accent design system (styles.css tokens): chat=amber, hermes=teal,
  claudecode=violet.
- Schema changes: add migrations in src/main/db.ts; never edit tables destructively.

## Storage engine: better-sqlite3 + WAL (resolves the old sql.js hazard)

`workspace.db` is accessed through **better-sqlite3** (native, synchronous) in **WAL
mode** — see `src/main/db.ts`. WAL gives real single-writer/multi-reader concurrency and
durable-on-return writes; there is no whole-file rewrite and no debounced persist buffer.

This replaced the previous `sql.js` backend, which loaded the entire DB into memory,
**rewrote the whole file on every debounced write**, and had no multi-process locking.
Under sql.js the two hosts that both open `workspace.db` —

- the Electron app (`src/main/index.ts`), and
- the standalone knowledge MCP server (`src/main/mcp/server.ts`)

— could clobber each other with silent last-writer-wins. **WAL fixes this:** concurrent
writes from both processes are serialized safely by SQLite (with `busy_timeout`), verified
with a two-process concurrent-writer test during the migration.

**ABI note — do not launch the MCP server with a bare `node`.** better-sqlite3 is a native
addon compiled for **Electron's ABI**. The standalone server must therefore run on that same
ABI, so it is launched through the app's Electron binary with `ELECTRON_RUN_AS_NODE=1` (one
native build serves both hosts). The single source of truth for this launch config is
`knowledgeMcpLaunchConfig()` in `src/main/mcp.ts`; every registration path (Claude Desktop
config, the Extensions quick-add, the Hermes/WSL wiring) goes through it. A plain-`node`
launch would load a mismatched better-sqlite3 and fail on startup.

The single-writer queue in `knowledge.ts` still serializes writes within a process; it is
complementary to WAL, not replaced by it.

Current milestone status: see docs/ROADMAP.md.
