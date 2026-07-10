import { watch, type FSWatcher } from 'chokidar'
import { BrowserWindow } from 'electron'
import { readFileSync, statSync } from 'fs'
import { relative, extname, sep } from 'path'
import { getDb } from './db'
import { saveIndexedFile, removeIndexedFile } from './knowledge'
import { chat, defaultChatModel, type ChatMessage } from './ollama'

// Milestone 3 — file watcher + indexer (hybrid monitoring).
//
// Light real-time layer: chokidar watches the active project folder and drops
// change events into the `index_queue` table. Deeper layer: a debounced batch
// indexer drains the queue, reads each changed file, asks the local Ollama model
// for a one-paragraph summary, and writes that as a `file` memory item plus a
// file node/edge in the knowledge graph. A periodic re-scan catches anything the
// real-time layer missed.
//
// This module runs ONLY in the Electron main process (never the stdio MCP
// server), but to stay consistent with that path it logs to stderr only and
// routes every memory/graph write through the single queue in knowledge.ts.

// Folders we never descend into, and files we never index.
const IGNORED_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build'])
const IGNORED_FILES = new Set(['.aiworkspace.json', 'workspace.db'])

// Only summarize text/source files; skip binaries, images, lockfiles, etc.
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.markdown', '.txt',
  '.css', '.scss', '.less', '.html', '.htm', '.vue', '.svelte', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.ps1',
  '.yml', '.yaml', '.toml', '.ini', '.sql', '.graphql', '.proto'
])

const MAX_BYTES = 256 * 1024 // don't read files larger than this
const MAX_CHARS = 8000       // cap what we send to the model
const DEBOUNCE_MS = 1500     // coalesce bursts of file events
const RESCAN_MS = 5 * 60 * 1000 // deeper scheduled re-index every 5 minutes

interface WatchState {
  watcher: FSWatcher
  root: string
}

const watchers = new Map<string, WatchState>()
let drainTimer: NodeJS.Timeout | null = null
let rescanTimer: NodeJS.Timeout | null = null
let draining = false
let rerun = false

function isIgnored(absPath: string): boolean {
  const parts = absPath.split(/[\\/]/)
  const base = parts[parts.length - 1]
  if (IGNORED_FILES.has(base)) return true
  return parts.some((p) => IGNORED_DIRS.has(p))
}

/**
 * Start watching a project folder. Idempotent per project; opening a different
 * project stops the previous watcher (the app shows one project at a time).
 */
export function startWatcher(projectId: string, root: string): void {
  if (watchers.has(projectId)) return
  for (const id of [...watchers.keys()]) if (id !== projectId) stopWatcher(id)

  const watcher = watch(root, {
    ignored: (p: string) => isIgnored(p),
    ignoreInitial: false, // initial 'add' pass = the deeper first-time index
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }
  })

  const onEvent = (event: 'add' | 'change' | 'unlink') => (absPath: string) => {
    enqueueEvent(projectId, absPath, event)
  }
  watcher
    .on('add', onEvent('add'))
    .on('change', onEvent('change'))
    .on('unlink', onEvent('unlink'))
    .on('error', (err) => console.error('[indexer] watch error:', err))

  watchers.set(projectId, { watcher, root })
  console.error('[indexer] watching', root, 'for project', projectId)

  if (!rescanTimer) rescanTimer = setInterval(rescanAll, RESCAN_MS)
}

export function stopWatcher(projectId: string): void {
  const state = watchers.get(projectId)
  if (!state) return
  void state.watcher.close()
  watchers.delete(projectId)
  console.error('[indexer] stopped watching project', projectId)
}

/** Stop every watcher and timer. Called on app shutdown. */
export function stopAllWatchers(): void {
  for (const id of [...watchers.keys()]) stopWatcher(id)
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null }
  if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null }
}

// ---- queue -----------------------------------------------------------------
// Real-time events land in index_queue (a fast synchronous insert) and schedule
// a debounced drain. Filtering by extension here keeps the queue clean.
function enqueueEvent(projectId: string, absPath: string, event: 'add' | 'change' | 'unlink'): void {
  const ext = extname(absPath).toLowerCase()
  if (!TEXT_EXT.has(ext)) return
  try {
    getDb()
      .prepare(`INSERT INTO index_queue (project_id, path, event, queued_at) VALUES (?, ?, ?, ?)`)
      .run(projectId, absPath, event, Date.now())
  } catch (err) {
    console.error('[indexer] failed to enqueue', absPath, err)
    return
  }
  scheduleDrain()
}

function scheduleDrain(): void {
  if (drainTimer) clearTimeout(drainTimer)
  drainTimer = setTimeout(() => {
    drainTimer = null
    void drainQueue()
  }, DEBOUNCE_MS)
}

// A scheduled deeper pass: re-emit every watched file so changes missed by the
// real-time layer get picked up. Cheap because re-indexing upserts in place.
function rescanAll(): void {
  for (const [projectId, { watcher }] of watchers) {
    const watched = watcher.getWatched()
    for (const dir of Object.keys(watched)) {
      for (const name of watched[dir]) {
        const abs = dir.endsWith(sep) ? dir + name : dir + sep + name
        if (!isIgnored(abs) && TEXT_EXT.has(extname(name).toLowerCase())) {
          enqueueEvent(projectId, abs, 'change')
        }
      }
    }
  }
}

// ---- drain -----------------------------------------------------------------
async function drainQueue(): Promise<void> {
  if (draining) { rerun = true; return }
  draining = true
  try {
    const db = getDb()
    const rows = db
      .prepare(`SELECT id, project_id, path, event FROM index_queue WHERE processed_at IS NULL ORDER BY id`)
      .all() as { id: number; project_id: string; path: string; event: string }[]
    if (rows.length === 0) return
    console.error('[indexer] draining', rows.length, 'queued event(s)')

    // Coalesce: latest event per (project, path) wins; mark every claimed row done.
    const latest = new Map<string, { project_id: string; path: string; event: string }>()
    const ids: number[] = []
    for (const r of rows) {
      ids.push(r.id)
      latest.set(`${r.project_id}\0${r.path}`, { project_id: r.project_id, path: r.path, event: r.event })
    }

    const projectRoots = new Map<string, string>()
    const rootFor = (projectId: string): string | null => {
      if (projectRoots.has(projectId)) return projectRoots.get(projectId)!
      const live = watchers.get(projectId)
      const root =
        live?.root ??
        (db.prepare(`SELECT path FROM projects WHERE id = ?`).get(projectId) as { path: string } | undefined)?.path
      if (root) projectRoots.set(projectId, root)
      return root ?? null
    }

    let changed = false
    const touchedProjects = new Set<string>()
    for (const entry of latest.values()) {
      const root = rootFor(entry.project_id)
      if (!root) continue
      const relPath = relative(root, entry.path).split(sep).join('/')
      try {
        if (await indexOne(entry.project_id, root, entry.path, relPath, entry.event)) {
          changed = true
          touchedProjects.add(entry.project_id)
          emitIndexActivity(`${entry.event === 'unlink' ? 'Removed' : 'Indexed'}: ${relPath}`)
        }
      } catch (err) {
        console.error('[indexer] failed to index', relPath, err)
      }
    }

    // Mark the rows we claimed as processed, then trim the queue so it
    // doesn't grow unbounded (each rescan re-enqueues every watched file).
    const now = Date.now()
    for (const id of ids) {
      db.prepare(`UPDATE index_queue SET processed_at = ? WHERE id = ?`).run(now, id)
    }
    db.prepare(`DELETE FROM index_queue WHERE processed_at IS NOT NULL`).run()

    if (changed) notifyRenderer(touchedProjects)
  } finally {
    draining = false
    if (rerun) { rerun = false; void drainQueue() }
  }
}

// Index a single file: summarize and upsert, or remove on unlink. Returns true
// if the knowledge base actually changed (so the UI only refreshes when useful).
async function indexOne(
  projectId: string,
  root: string,
  absPath: string,
  relPath: string,
  event: string
): Promise<boolean> {
  if (event === 'unlink') {
    await removeIndexedFile(projectId, relPath)
    return true
  }

  let content: string
  try {
    const stat = statSync(absPath)
    if (stat.size > MAX_BYTES) return false
    // Skip unchanged files: if the stored summary is newer than the file's
    // last modification, re-summarizing would only burn the local model.
    // (The 5-minute rescan re-enqueues every watched file, so without this
    // check every cycle re-runs the LLM over the whole project.)
    const existing = getDb()
      .prepare(`SELECT updated_at FROM memory_items WHERE project_id = ? AND type = 'file' AND title = ?`)
      .get(projectId, relPath) as { updated_at: number } | undefined
    if (existing && existing.updated_at > stat.mtimeMs) return false
    content = readFileSync(absPath, 'utf-8')
  } catch {
    // File vanished between event and drain — treat as a removal.
    await removeIndexedFile(projectId, relPath)
    return true
  }
  if (!content.trim()) return false

  const summary = await summarizeFile(relPath, content)
  await saveIndexedFile({ projectId, relPath, summary, ext: extname(relPath).toLowerCase() })
  return true
}

// Ask the local model for a short summary. Degrades gracefully: if no model is
// installed or Ollama is offline, we still record the file with an honest
// "summary pending" note so it shows in the panel and can be re-indexed later.
async function summarizeFile(relPath: string, content: string): Promise<string> {
  const model = await defaultChatModel()
  if (!model) return `Source file ${relPath}. Summary pending — no local model available.`

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a code indexer for a knowledge base. Summarize what the given file is and does in ' +
        '1-3 plain sentences. Be concrete and factual. Do not include code fences or preamble.'
    },
    { role: 'user', content: `File: ${relPath}\n\n${content.slice(0, MAX_CHARS)}` }
  ]
  const out = await chat(model, messages)
  if (!out || !out.trim()) return `Source file ${relPath}. Summary pending — model returned nothing.`
  return out.trim()
}

// Mirror indexing work into the Activity panel feed (same channel the other
// sources use; see emitActivity in ipc.ts — the indexer has no sender window,
// so it broadcasts to all).
function emitIndexActivity(message: string): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('activity:log', { source: 'INDEXER', message, timestamp: Date.now() })
    }
  } catch {
    // No Electron window context (e.g. tests) — nothing to notify.
  }
}

function notifyRenderer(projectIds: Set<string>): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('index:updated', { projectIds: [...projectIds] })
    }
  } catch (err) {
    // No Electron window context (e.g. tests) — nothing to notify.
    console.error('[indexer] notifyRenderer skipped:', err)
  }
}
