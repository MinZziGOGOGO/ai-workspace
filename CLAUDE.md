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

## ⚠️ sql.js concurrency caveat (M2 onwards)

The swap from `better-sqlite3` to `sql.js` (to avoid native compilation) changed the
concurrency model. `sql.js` loads the entire `workspace.db` into memory and **rewrites
the whole file on every write** (see `persist()` in src/main/db.ts). It has no multi-process
locking.

As of M2, **two processes can open the same `workspace.db`:**
- The Electron app (src/main/index.ts)
- The standalone knowledge MCP server (src/main/mcp/server.ts, run by Claude Desktop / Hermes / Claude Code)

**Do not allow both to write at the same time.** The single-writer queue in `knowledge.ts`
only serializes within one process; concurrent writes from both processes suffer last-writer-wins
and data clobber silently.

**Proper fix (future milestone):** route all DB writes through one owner—e.g. the MCP server
talks to the Electron main process over IPC instead of opening the file directly, or move to
a storage layer with genuine multi-process access (e.g. PostgreSQL for a cloud version).

Current milestone status: see docs/ROADMAP.md.
