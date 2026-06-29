# AGENTS.md — AI Workspace project instructions

## Project summary

This is a Windows-first, local-first Electron + TypeScript AI workspace.

The app has three AI modes:

* Chat
* Hermes
* Claude Code

Core principle:

> Sessions are separate. Memory is shared.

Shared knowledge lives in the app’s local database and is exposed through the knowledge layer/MCP server. Do not create a second durable memory system for any individual mode.

## Important architecture files

Read these before structural changes:

* `docs/ARCHITECTURE.md`
* `docs/ROADMAP.md`
* `CLAUDE.md`
* `src/main/db.ts`
* `src/main/knowledge.ts`
* `src/main/ipc.ts`
* `src/preload/index.ts`
* `src/renderer/src/components/WorkspaceShell.tsx`

## Tech stack

* Electron
* TypeScript
* React
* sql.js
* Ollama for local models
* MCP for shared knowledge access
* Claude Code CLI for Claude integration
* Hermes runs externally through WSL2

Do not migrate this project to Tauri, Rust, Python, or another stack unless explicitly asked.

## Run commands

Windows development launcher:

```powershell
npm run start:win
```

Fallback dev command:

```powershell
$env:ELECTRON_DISABLE_GPU=1; npm run dev
```

Build:

```powershell
npm run build
```

Automated UI smoke tests:

```powershell
npm run test:e2e
```

Useful tests:

```powershell
npm run test:indexer
npm run test:extractor
npm run test:claudecode
npm run test:hermes
```

## Rules

* Renderer code must not access Node APIs directly. Use the preload bridge.
* Add IPC handlers in `src/main/ipc.ts`.
* Add preload API methods in `src/preload/index.ts`.
* Update renderer typings in `src/renderer/src/types.d.ts`.
* All memory writes must go through `src/main/knowledge.ts`.
* All model calls must go through `src/main/ollama.ts`.
* Keep the mode accent system:

  * Chat = amber
  * Hermes = teal
  * Claude Code = violet
* Do not add heavy dependencies unless the task clearly needs them.
* Prefer small, verifiable changes over large rewrites.
* Do not claim success until build/typecheck passes and the requested UI behavior is manually testable.
* For UI/UX tasks, add or update Playwright E2E coverage when there is a stable path to test.
* Do not claim "manual verification" unless a human actually clicked through the app.
* If Playwright E2E tests pass, report that as "automated UI verification," not manual verification.

## Current UI/UX direction

We are working on UI/UX upgrades.

Priority order:

1. Add delete buttons for old sessions.
2. Set up Global workspace mode for general chat/agent use without choosing a project.
3. Replace the single-tab-only shell with a real window-manager-style workspace.
4. Add visibility features: context bar, token estimate, permission badge, tool activity strip.
5. Later: deep research UI, escalation handoff, packaging polish.

Important correction:

Do not implement a fixed split-screen layout. The desired feature is a real workspace/window-manager surface where Chat, Hermes, and Claude Code can be shown, hidden, dragged, resized, stacked, or placed side by side.

## Done means

For every change:

* Run the relevant build/test command.
* Verify the app starts on Windows.
* Verify existing Chat, Hermes, Claude Code, and Knowledge Panel behavior still works.
* Explain exactly what files changed.
* Mention anything not implemented or not verified.
