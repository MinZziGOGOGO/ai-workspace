import initSqlJs, { Database as SqlJsDb } from 'sql.js'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

// One SQLite file holds everything: projects, sessions, vector memory,
// and the knowledge graph (nodes/edges). Local-first, zero servers.
// Vector search starts as brute-force cosine over BLOB embeddings;
// swap in sqlite-vec later if scale ever demands it (it won't for a while).
//
// This module must run in two hosts: the Electron main process AND the
// standalone stdio MCP server (Milestone 2). So it takes the userData
// directory as a parameter instead of importing electron's `app`, and logs
// only to stderr — an stdio MCP server reserves stdout for the JSON-RPC
// protocol, and a stray console.log there corrupts the message stream.

// Where workspace.db lives. Set by initDb(); used by persist().
let dbPath = ''

interface PreparedStatement {
  run(...params: any[]): void
  all(...params: any[]): any[]
  get(...params: any[]): any | undefined
}

class DbWrapper {
  private persistTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(private sqlDb: SqlJsDb) {}

  prepare(sql: string): PreparedStatement {
    const sqlDb = this.sqlDb
    return {
      run: (...params: any[]) => {
        const stmt = sqlDb.prepare(sql)
        stmt.bind(params)
        stmt.step()
        stmt.free()
        this.persist()
      },
      all: (...params: any[]) => {
        const stmt = sqlDb.prepare(sql)
        stmt.bind(params)
        const results: any[] = []
        while (stmt.step()) {
          results.push(stmt.getAsObject())
        }
        stmt.free()
        return results
      },
      get: (...params: any[]) => {
        const stmt = sqlDb.prepare(sql)
        stmt.bind(params)
        const result = stmt.step() ? stmt.getAsObject() : undefined
        stmt.free()
        return result
      }
    }
  }

  exec(sql: string): void {
    this.sqlDb.run(sql)
    this.persist()
  }

  private persist(): void {
    if (this.persistTimeout) clearTimeout(this.persistTimeout)
    this.persistTimeout = setTimeout(() => {
      this.persistTimeout = null
      const data = this.sqlDb.export()
      writeFileSync(dbPath, Buffer.from(data))
    }, 500)
  }

  flushSync(): void {
    if (this.persistTimeout) {
      clearTimeout(this.persistTimeout)
      this.persistTimeout = null
    }
    const data = this.sqlDb.export()
    writeFileSync(dbPath, Buffer.from(data))
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
    console.error('[DB] Loading sql.js WASM module...')
    const SQL = await initSqlJs()
    console.error('[DB] sql.js loaded successfully')

    dbPath = join(userDataDir, 'workspace.db')
    console.error('[DB] Database path:', dbPath)

    let sqlDb: SqlJsDb
    if (existsSync(dbPath)) {
      console.error('[DB] Loading existing database from disk...')
      const buffer = readFileSync(dbPath)
      console.error('[DB] Read', buffer.length, 'bytes from disk')
      sqlDb = new SQL.Database(new Uint8Array(buffer))
      console.error('[DB] Database loaded from file')
    } else {
      console.error('[DB] Creating new database...')
      sqlDb = new SQL.Database()
      console.error('[DB] New database created')
    }

    db = new DbWrapper(sqlDb)
    console.error('[DB] DbWrapper created')

    console.error('[DB] Running migrations...')
    migrate(db)
    console.error('[DB] Migrations completed')
  } catch (err) {
    console.error('[DB] Initialization failed:', err)
    throw err
  }
}

export function getDb(): DbWrapper {
  if (!db) throw new Error('Database not initialized. Call initDb() first.')
  return db
}

export function getDbPath(): string {
  return dbPath
}

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
}
