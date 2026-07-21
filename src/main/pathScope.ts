// Path scoping for the filesystem IPC bridges.
//
// The renderer can ask main to read/write an arbitrary absolute path. Nothing
// about the Navigator, the Editor, or the instruction-file editor needs that
// reach: they operate on known projects and on the app's own data. This module
// pins those handlers to an explicit set of roots so a compromised or
// agent-driven renderer cannot turn `fs:readFile` into "read ~/.ssh/id_rsa".
//
// The containment check is the same algorithm already used by
// normalizeWorkspacePath() in ipc.ts and HermesAcpClient.confineToProject() —
// resolve both sides, then require the relative path to not escape upward. That
// collapses `..`, mixed separators, and redundant segments before comparison,
// which is why the check is done on `relative()` output rather than by string
// prefix. Kept in its own module so main-side callers can share it without the
// circular imports that forced those two copies apart.
//
// Not covered here by design: terminal:create. It spawns a real PTY and is meant
// to run arbitrary commands in the user's shell, so a path allowlist would be
// security theatre — a shell can `cd` anywhere the user can. Its protection is
// that it is a user-driven surface, not a path filter.

import { app } from 'electron'
import { isAbsolute, relative, resolve } from 'path'
import { listProjects } from './projects'

export interface ScopedPath {
  target: string
}
export interface ScopeError {
  error: string
}

/** True when `target` resolves to `root` itself or something beneath it. */
function contains(root: string, target: string): boolean {
  const rel = relative(resolve(root), target)
  // '' means target === root (allowed); '..' prefix or an absolute result means
  // the path escaped the root (on Windows, a different drive yields absolute).
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Absolute roots the filesystem bridges may touch:
 *  - every known project folder (Navigator tree, Editor, per-project AI.md etc.)
 *  - userData (app-owned state the UI legitimately reads/writes)
 *  - the app directory (instructions:getPath maps agent 'app' to its CLAUDE.md)
 *
 * The global project is a DB sentinel with path '' — resolve('') would silently
 * become the process cwd and hand back a very wide root, so non-absolute project
 * paths are filtered out rather than trusted.
 */
export function allowedFsRoots(): string[] {
  const roots: string[] = []
  try {
    for (const project of listProjects()) {
      if (project.path && isAbsolute(project.path)) roots.push(resolve(project.path))
    }
  } catch {
    // DB unavailable: fall through to the app-owned roots below rather than
    // failing open with an empty allowlist that some caller might ignore.
  }
  try {
    roots.push(resolve(app.getPath('userData')))
    roots.push(resolve(app.getAppPath()))
  } catch {
    // app paths are unavailable only outside a running Electron app (unit tests).
  }
  return roots
}

/**
 * Files the user explicitly chose this session via the native picker. The picker
 * is a real user gesture on a main-process dialog, so its result is trusted for
 * later reads even when it lands outside a project. In-memory only — a grant
 * never outlives the app session.
 */
const pickedFileGrants = new Set<string>()

export function grantPickedFile(filePath: string): void {
  if (filePath) pickedFileGrants.add(resolve(filePath))
}

export function isPickedFileGranted(filePath: string): boolean {
  return pickedFileGrants.has(resolve(filePath))
}

/**
 * Roots that composer attachments may be read from, beyond the project/app
 * roots. Drag-and-drop hands main a path the renderer reports, with no dialog to
 * corroborate it, so it cannot be verified the way a picked file can. Rejecting
 * drops outright would break dragging in a screenshot or a download — the common
 * case — so these well-known user content folders stay readable while the
 * genuinely sensitive neighbours (~/.ssh, credential stores, system dirs) do not.
 */
export function attachmentRoots(): string[] {
  const roots: string[] = []
  for (const name of ['downloads', 'desktop', 'documents', 'pictures', 'videos', 'music'] as const) {
    try {
      roots.push(resolve(app.getPath(name)))
    } catch {
      // Not every path is defined on every platform; skip the ones that aren't.
    }
  }
  return roots
}

/**
 * Resolves `inputPath` and confirms it stays inside one of `roots`.
 * Returns a descriptive error rather than throwing or silently no-opping, so
 * each caller can surface it in its own response shape.
 */
export function resolveWithinRoots(inputPath: string, roots: string[], label = 'path'): ScopedPath | ScopeError {
  if (!inputPath || typeof inputPath !== 'string') return { error: `A ${label} is required.` }
  if (inputPath.includes('\0')) return { error: `The ${label} contains an invalid character.` }
  const target = resolve(inputPath)
  if (!roots.some((root) => contains(root, target))) {
    return { error: `Access denied: ${label} is outside this workspace's allowed folders (projects, app data).` }
  }
  return { target }
}
