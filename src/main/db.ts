import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync, renameSync } from 'fs'

// One SQLite file holds everything: projects, sessions, vector memory,
// and the knowledge graph (nodes/edges). Local-first, zero servers.
// Vector search starts as brute-force cosine over BLOB embeddings;
// swap in sqlite-vec later if scale ever demands it (it won't for a while).
//
// This module must run in two hosts: the Electron main process AND the
// standalone MCP server (Milestone 2). So it takes the userData directory as a
// parameter instead of importing electron's `app`, and logs only to stderr —
// an stdio MCP server reserves stdout for the JSON-RPC protocol, and a stray
// console.log there corrupts the message stream.
//
// Storage engine: better-sqlite3 (native, synchronous) in WAL mode. Unlike the
// previous sql.js backend — which loaded the whole DB into memory and rewrote
// the entire file on every debounced write batch — writes here go straight to
// disk and are durable the moment the call returns. WAL also gives us real
// single-writer/multi-reader concurrency, which is what lets the Electron app
// and the standalone MCP server safely share one workspace.db (both hosts run
// on the same Electron/Node ABI; see ensureKnowledgeMcp in index.ts).

// Where workspace.db lives. Set by initDb(); read by getDbPath().
let dbPath = ''

// Bind values better-sqlite3 accepts. (Bind params stay loosely typed at the
// call sites — many are `string | null` etc. — so the wrapper keeps `any[]`
// there; the win from real typing is on the RESULT side, below.)
export interface PreparedStatement<Row = any> {
  run(...params: any[]): Database.RunResult
  all(...params: any[]): Row[]
  get(...params: any[]): Row | undefined
}

class DbWrapper {
  constructor(private sqlDb: Database.Database) {}

  prepare<Row = any>(sql: string): PreparedStatement<Row> {
    // better-sqlite3 compiles and caches prepared statements internally, so
    // re-preparing the same SQL string is cheap. We prepare per-call to keep
    // the exact same call shape the rest of the codebase already uses.
    const sqlDb = this.sqlDb
    return {
      run: (...params: any[]) => sqlDb.prepare(sql).run(...params),
      all: (...params: any[]) => sqlDb.prepare(sql).all(...params) as Row[],
      get: (...params: any[]) => sqlDb.prepare(sql).get(...params) as Row | undefined
    }
  }

  exec(sql: string): void {
    this.sqlDb.exec(sql)
  }

  /**
   * Checkpoint the WAL into the main database file. Writes are already durable
   * in WAL mode, so this is not required for correctness — it just folds the
   * -wal sidecar back into workspace.db (called on quit to leave a tidy file).
   */
  flushSync(): void {
    try {
      this.sqlDb.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      // Best-effort: another connection may hold the checkpoint lock. Harmless.
    }
  }

  close(): void {
    this.sqlDb.close()
  }
}

let db: DbWrapper

/**
 * Initialize the shared SQLite database.
 * @param userDataDir directory that holds workspace.db (Electron userData, or
 *   %APPDATA%/ai-workspace when running as the standalone MCP server).
 */
export async function initDb(userDataDir: string): Promise<void> {
  try {
    dbPath = join(userDataDir, 'workspace.db')
    console.error('[DB] Database path:', dbPath)

    const sqlDb = openOrRecover(dbPath)

    // WAL: single-writer/multi-reader concurrency + no whole-file rewrites.
    // synchronous=NORMAL is the recommended companion to WAL (durable across
    // app crashes; only a power loss can lose the last transaction). A busy
    // timeout lets the app and the MCP server wait briefly for each other's
    // write lock instead of failing immediately with SQLITE_BUSY.
    sqlDb.pragma('journal_mode = WAL')
    sqlDb.pragma('synchronous = NORMAL')
    sqlDb.pragma('busy_timeout = 5000')

    // NOTE: foreign_keys is intentionally left OFF (better-sqlite3's default),
    // matching the previous sql.js behavior. The schema declares REFERENCES
    // for documentation, but enforcement was never on; turning it on now could
    // reject existing rows or valid insert orders.

    db = new DbWrapper(sqlDb)
    console.error('[DB] DbWrapper created (better-sqlite3, WAL)')

    console.error('[DB] Running migrations...')
    migrate(db)
    console.error('[DB] Migrations completed')
  } catch (err) {
    console.error('[DB] Initialization failed:', err)
    throw err
  }
}

// Open the existing workspace.db, or create a fresh one. better-sqlite3 reads
// any standard SQLite file — including one written by sql.js — so the common
// case is a clean open. If the file exists but is unreadable (corruption or a
// non-SQLite blob), we don't want to hard-fail startup: back the bad file up to
// workspace.db.sqljs-backup and start fresh, so the app still launches.
function openOrRecover(path: string): Database.Database {
  if (!existsSync(path)) {
    console.error('[DB] No existing database; creating new file')
    return new Database(path)
  }
  try {
    const handle = new Database(path)
    // Touch the schema catalog to force SQLite to actually parse the header
    // and page structure — a lazy open alone won't surface corruption.
    handle.prepare('SELECT count(*) FROM sqlite_master').get()
    console.error('[DB] Opened existing database')
    return handle
  } catch (err) {
    const backup = path + '.sqljs-backup'
    console.error(
      `[DB] Existing database could not be opened (${(err as Error).message}). ` +
        `Backing it up to ${backup} and starting with a fresh database.`
    )
    renameSync(path, backup)
    return new Database(path)
  }
}

export function getDb(): DbWrapper {
  if (!db) throw new Error('Database not initialized. Call initDb() first.')
  return db
}

export function getDbPath(): string {
  return dbPath
}

/**
 * Flush pending writes to the main DB file. With better-sqlite3 in WAL mode,
 * every write is already durable on disk the moment it returns — there is no
 * debounced in-memory buffer to lose. This now just checkpoints the WAL on
 * quit, and is kept exported so callers (index.ts) need no changes.
 */
export function flushDb(): void {
  if (db) db.flushSync()
}

function migrate(db: DbWrapper): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', -- active | archived
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    mode TEXT NOT NULL, -- chat | hermes | claudecode
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,    -- user | assistant | system
    content TEXT NOT NULL,
    model TEXT,
    created_at INTEGER NOT NULL
  );

  -- Memory items: the vector half of the knowledge layer.
  -- project_id NULL means global knowledge (e.g. user preferences).
  CREATE TABLE IF NOT EXISTS memory_items (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    type TEXT NOT NULL,    -- decision | research | preference | file | task | note
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL,  -- chat | hermes | claudecode | indexer | user
    tags TEXT NOT NULL DEFAULT '[]', -- JSON array
    embedding BLOB,        -- float32 array; NULL if embedder unavailable
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Knowledge graph: the relationship half of the knowledge layer.
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    type TEXT NOT NULL,    -- system | file | tech | concept | person
    name TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    src_id TEXT NOT NULL REFERENCES nodes(id),
    dst_id TEXT NOT NULL REFERENCES nodes(id),
    relation TEXT NOT NULL -- has_system | implemented_in | depends_on | uses_tech | relates_to ...
  );

  -- Projects can declare relationships (sequel, shared library) for "related" search scope.
  CREATE TABLE IF NOT EXISTS project_links (
    src_project_id TEXT NOT NULL REFERENCES projects(id),
    dst_project_id TEXT NOT NULL REFERENCES projects(id),
    PRIMARY KEY (src_project_id, dst_project_id)
  );

  -- Small key/value store for app-level bookkeeping (e.g. last consolidation run).
  -- Additive only; never holds knowledge — that lives in memory_items/nodes/edges.
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- File watcher drops change events here; the indexer drains it later (hybrid monitoring).
  CREATE TABLE IF NOT EXISTS index_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    path TEXT NOT NULL,
    event TEXT NOT NULL,   -- add | change | unlink
    queued_at INTEGER NOT NULL,
    processed_at INTEGER
  );

  -- Claude Code checkpoints: recorded HEAD commit before a task runs, so the
  -- user can roll back a project folder to its pre-task state. Only written
  -- when the repo is a clean git working tree at task start (see claudecode.ts
  -- tryCreateCheckpoint) — never created against uncommitted work.
  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    message_id TEXT,
    project_path TEXT NOT NULL,
    commit_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    description TEXT NOT NULL
  );

  -- Daily per-agent usage counters (message/task counts + a rough token
  -- estimate). Informational only — no pricing, since model pricing changes
  -- too often to hardcode reliably. One row per (agent, date), upserted after
  -- each completed exchange.
  CREATE TABLE IF NOT EXISTS usage_log (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    date TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    estimated_tokens INTEGER NOT NULL DEFAULT 0
  );

  -- Contextual tips (see tips.ts): each tip is recorded here the moment it is
  -- shown, so it never displays again — regardless of whether the user
  -- dismissed it, clicked its CTA, or just moved on.
  CREATE TABLE IF NOT EXISTS shown_tips (
    tip_id TEXT PRIMARY KEY,
    shown_at INTEGER,
    dismissed INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_items(project_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, mode);
  CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_log_agent_date ON usage_log(agent, date);
  `)

  // Session auto-summary + last-activity tracking (additive, nullable — safe for
  // existing rows). SQLite has no "ADD COLUMN IF NOT EXISTS", so check first.
  const sessionCols = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name)
  )
  if (!sessionCols.has('summary')) {
    db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT')
  }
  if (!sessionCols.has('updated_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN updated_at INTEGER')
    db.exec('UPDATE sessions SET updated_at = created_at WHERE updated_at IS NULL')
  }
  if (!sessionCols.has('archived')) {
    db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
  }
  // Codex `exec` sessions are resumable via a server-side thread id (returned
  // as `thread_id` on the `thread.started` event). Persisted per session so
  // later turns can resume the same Codex conversation instead of starting a
  // fresh, context-less one-shot run each time. See codex.ts runCodex().
  if (!sessionCols.has('codex_thread_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN codex_thread_id TEXT')
  }

  // Quick-reaction capture (thumbs up/down) on assistant messages, for future
  // prompt-tuning reference. No analytics UI reads this yet.
  const messageCols = new Set(
    (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name)
  )
  if (!messageCols.has('reaction')) {
    db.exec("ALTER TABLE messages ADD COLUMN reaction TEXT")
  }

  const memoryCols = new Set(
    (db.prepare('PRAGMA table_info(memory_items)').all() as { name: string }[]).map((c) => c.name)
  )
  if (!memoryCols.has('last_accessed_at')) {
    db.exec('ALTER TABLE memory_items ADD COLUMN last_accessed_at INTEGER')
  }
  if (!memoryCols.has('access_count')) {
    db.exec('ALTER TABLE memory_items ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0')
  }
  if (!memoryCols.has('stale_at')) {
    db.exec('ALTER TABLE memory_items ADD COLUMN stale_at INTEGER')
  }
  if (!memoryCols.has('quality_flags')) {
    db.exec("ALTER TABLE memory_items ADD COLUMN quality_flags TEXT NOT NULL DEFAULT '[]'")
  }
  if (!memoryCols.has('quality_reason')) {
    db.exec('ALTER TABLE memory_items ADD COLUMN quality_reason TEXT')
  }
}
