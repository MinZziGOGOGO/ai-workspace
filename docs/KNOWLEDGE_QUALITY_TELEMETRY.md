# Knowledge Quality and Telemetry

## Database path behavior

`workspace.db` is created by `src/main/db.ts` as `<userData>/workspace.db`.
The Electron main process passes `app.getPath('userData')` from `src/main/index.ts`.

- Development: Electron's `userData` path is used, unless `AIWORKSPACE_TEST_USER_DATA`
  is set by automated tests.
- Packaged or installed app: Electron still uses `app.getPath('userData')`, so the
  directory follows the installed app identity on Windows.
- Sandboxed or packaged-container environments: Windows can redirect roaming app data
  into the package container. That is why a live diagnostic can find:
  `C:\Users\marti\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\ai-workspace\workspace.db`.
- MCP server: the app registers it with `AIWORKSPACE_DB_DIR` set to the same
  `userData` directory. If run manually without that variable, it falls back to
  `%APPDATA%\ai-workspace`.

No database migration, deletion, or path move is performed for this behavior.

## Telemetry fields

`memory_items` now has additive fields for retrieval and maintenance:

- `last_accessed_at`
- `access_count`
- `stale_at`
- `quality_flags`
- `quality_reason`

Existing rows remain valid because these fields are nullable or have defaults.
