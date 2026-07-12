# Windows Packaging

AI Workspace uses `electron-builder` to create Windows builds.

## Commands

```powershell
npm run pack
```

Builds the app and creates an unpacked Windows app under `release/win-unpacked`.

```powershell
npm run dist
```

Builds the app and creates an NSIS installer under `release/`.

Both commands run the Electron/Vite build and the MCP server bundle first.

Packaging uses the locally installed Electron runtime at `node_modules/electron/dist`, which avoids a network download during `electron-builder` on restricted Windows machines.

The current Windows config produces unsigned builds and skips executable resource editing. That keeps packaging offline-friendly in restricted environments; add signing/icon metadata later when code-signing assets are available.

## GPU Startup Note

The packaged app uses Electron GPU acceleration by default for smoother rendering. If a driver issue causes blank windows, flicker, or launch failures, start with `AIWORKSPACE_DISABLE_GPU=1` or `ELECTRON_DISABLE_GPU=1` to force the software-rendering fallback.

## Native Modules

`node-pty` is a runtime dependency for the Terminal panel. The package ships Windows prebuilds, and packaging unpacks `node-pty` from ASAR so its native binary can load at runtime.

If a future native dependency needs rebuilding, use the existing standard path:

```powershell
npx electron-builder install-app-deps
```

If native rebuilds fail on a clean Windows machine, install the usual Node native build prerequisites:

- Visual Studio Build Tools with the Desktop C++ workload
- Python available to `node-gyp`

`sql.js` is included as a runtime dependency, and its WASM file is unpacked from ASAR for reliable loading.

## Codex CLI

The Codex panel does not bundle Codex or credentials. Install the Codex CLI separately, log in outside AI Workspace, and make sure `codex` is available on PATH for the packaged app. If AI Workspace was already open when Codex was installed, restart AI Workspace so the Electron main process sees the updated Windows environment.

On Windows, verify the CLI from a new PowerShell:

```powershell
where.exe codex
codex --version
```

If the packaged app still cannot find Codex, set `AI_WORKSPACE_CODEX_PATH` to the full path returned by `where.exe codex`. `CODEX_PATH` is also honored.

This native panel currently uses the controlled `codex exec` fallback from the Electron main process. The renderer never receives arbitrary shell access. This is a one-shot task runner rather than full Codex session mode. A later improvement can switch the same manager to `codex app-server` when the local CLI can be inspected and its stable app-server protocol is available to the app.

The Codex panel exposes two controlled safety settings:

- Sandbox: `read-only` can inspect files but cannot modify them; `workspace-write` allows edits in the selected project workspace.
- Approval: `never` runs non-interactively; `on-request` maps to Codex's request-approval mode when supported by the installed CLI.

The renderer sends only these enum values. The Electron main process maps them to known Codex CLI flags.

Codex may require the selected project folder to be a trusted Git repository. For non-Git or untrusted folders, AI Workspace can pass `--skip-git-repo-check` only after the user explicitly enables "Allow Codex in this folder without Git trust check" in the Codex panel. Only enable that for folders you trust, because Codex may read and modify files in the selected project.

## Data Exclusions

Packaged builds do not include local workspace databases, user project folders, Ollama models, or Claude/Hermes/Codex credentials. Runtime data is created under Electron's normal app user-data directory.
