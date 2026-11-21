# AI Workspace

A local-first desktop app that brings several AI tools into one workspace: a chat with local
models, the [Hermes](https://github.com/NousResearch/hermes-agent) agent and Claude Code,
each in its own tab. They all share **one project-aware knowledge base**.

> Sessions are separate. Memory is shared.

Built with Electron, React and TypeScript. All data stays on your machine in a local
SQLite database.

## Features

- **Three AI modes in one window**
  - **Chat**: conversations with local models through [Ollama](https://ollama.com)
  - **Hermes**: an autonomous agent running in WSL2 (or on another machine via SSH)
  - **Claude Code**: drives the Claude Code CLI and shows its tool calls, file edits and diffs live
- **Shared knowledge base**: notes, decisions and file summaries stored per project in SQLite
  with vector embeddings and a small knowledge graph. Every mode reads and writes the same
  memory, Hermes and Claude Code through an **MCP server** the app provides
- **Project indexer**: watches the project folder (chokidar) and keeps a summary of every
  source file up to date with a local model
- **Built-in browser panel** that agents can control through a second MCP server (navigate,
  read, click, type, screenshot), with an **approval system**. Risky actions such as typing,
  external navigation and downloads have to be approved by the user, and secrets never appear
  in logs
- **Workspace UI**: dockable panels, file tree, code editor, integrated terminal (xterm.js +
  node-pty), command palette and keyboard shortcuts
- Setup wizard that checks for Ollama, Claude Code and WSL/Hermes

## Architecture

```
Electron app
├─ Renderer (React)      Chat · Hermes · Claude Code · Browser · Knowledge · Editor · Terminal
├─ Preload               typed IPC bridge (the renderer never gets Node or Electron objects)
└─ Main process (Node)
   ├─ SQLite             projects, sessions, memory items + embeddings, nodes/edges
   ├─ Knowledge MCP      search_memory, save_memory, get_project_context, ...
   ├─ Browser MCP        proxies agent browser actions → approval service → WebContentsView
   ├─ Indexer            file watcher → queue → local model summaries
   ├─ Claude Code        CLI launcher (stream-json) with live event parsing
   ├─ Hermes             ACP over stdio, locally via WSL2 or remote via SSH
   └─ Ollama client      chat + embeddings
```

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the
[roadmap](docs/ROADMAP.md).

## Getting started

The app targets **Windows** (Hermes runs in WSL2). Requirements: Node.js 18+, plus
[Ollama](https://ollama.com) for the chat mode and the indexer, and the
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) for the Claude Code tab.

```powershell
git clone https://github.com/MinZziGOGOGO/ai-workspace.git
cd ai-workspace
npm install
npm run start:win        # or: npm run dev
```

Hermes can be installed into WSL2 with `scripts/setup-hermes.ps1`. A Windows installer
is built with `npm run dist` (see [PACKAGING.md](PACKAGING.md)).

## Tests

```bash
npm run test:indexer          # file watcher → index → upsert → removal
npm run test:browser          # browser control server + approval rules
npm run test:browser-transfers
npm run test:webcompanion
npm run test:claudecode       # needs the Claude Code CLI
npm run test:e2e              # Playwright end-to-end tests against the built app
```

## Tech stack

Electron · React · TypeScript · Vite (electron-vite) · SQLite (better-sqlite3) ·
Model Context Protocol SDK · xterm.js / node-pty · Playwright
