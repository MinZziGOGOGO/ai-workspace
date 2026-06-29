import { getDb } from './db'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { GLOBAL_PROJECT_ID, GLOBAL_PROJECT_NAME, isGlobalProjectId } from '../shared/globalWorkspace'

// Projects point at real folders (Option B from the spec). The folder is not
// owned by the app — we wrap intelligence around it. A marker file inside the
// folder gives the project a stable identity that survives renames/moves:
// re-importing a moved folder relinks instead of duplicating.

const MARKER = '.aiworkspace.json'

export interface Project {
  id: string
  name: string
  path: string
  status: 'active' | 'archived'
  created_at: number
  last_opened_at: number | null
}

export function ensureGlobalProject(): Project {
  const db = getDb()
  const existing = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(GLOBAL_PROJECT_ID) as
    | Project
    | undefined
  if (existing) {
    if (
      existing.name !== GLOBAL_PROJECT_NAME ||
      existing.path !== '' ||
      existing.status !== 'active'
    ) {
      db.prepare(`UPDATE projects SET name = ?, path = '', status = 'active' WHERE id = ?`)
        .run(GLOBAL_PROJECT_NAME, GLOBAL_PROJECT_ID)
      return { ...existing, name: GLOBAL_PROJECT_NAME, path: '', status: 'active' }
    }
    return existing
  }

  const project: Project = {
    id: GLOBAL_PROJECT_ID,
    name: GLOBAL_PROJECT_NAME,
    path: '',
    status: 'active',
    created_at: Date.now(),
    last_opened_at: null
  }
  // Sentinel row only: no folder is created and no .aiworkspace.json marker is
  // written. It exists solely to satisfy sessions.project_id NOT NULL.
  db.prepare(
    `INSERT INTO projects (id, name, path, status, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(project.id, project.name, project.path, project.status, project.created_at, project.last_opened_at)
  return project
}

export function listProjects(): Project[] {
  ensureGlobalProject()
  return getDb()
    .prepare(
      `SELECT * FROM projects
       WHERE id != ?
       ORDER BY last_opened_at IS NULL, last_opened_at DESC, created_at DESC`
    )
    .all(GLOBAL_PROJECT_ID) as Project[]
}

export function createProject(name: string, parentDir: string): Project {
  const path = join(parentDir, name)
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
  return importFolder(path, name)
}

export function importFolder(path: string, nameHint?: string): Project {
  if (!existsSync(path)) throw new Error(`Folder does not exist: ${path}`)
  const db = getDb()
  const markerPath = join(path, MARKER)

  // Relink if the folder already carries an identity.
  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8'))
      const existing = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(marker.projectId) as
        | Project
        | undefined
      if (existing) {
        if (existing.path !== path)
          db.prepare(`UPDATE projects SET path = ? WHERE id = ?`).run(path, existing.id)
        return { ...existing, path }
      }
    } catch {
      /* corrupt marker — fall through and recreate */
    }
  }

  const project: Project = {
    id: randomUUID(),
    name: nameHint ?? path.split(/[\\/]/).filter(Boolean).pop()!,
    path,
    status: 'active',
    created_at: Date.now(),
    last_opened_at: null
  }
  db.prepare(
    `INSERT INTO projects (id, name, path, status, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(project.id, project.name, project.path, project.status, project.created_at)
  writeFileSync(markerPath, JSON.stringify({ projectId: project.id, name: project.name }, null, 2))
  return project
}

export function openProject(id: string): Project {
  const db = getDb()
  if (isGlobalProjectId(id)) ensureGlobalProject()
  db.prepare(`UPDATE projects SET last_opened_at = ? WHERE id = ?`).run(Date.now(), id)
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Project
}

export function setArchived(id: string, archived: boolean): void {
  // Archived projects leave the picker's active list but their knowledge
  // stays in the database and remains searchable in global scope.
  getDb()
    .prepare(`UPDATE projects SET status = ? WHERE id = ?`)
    .run(archived ? 'archived' : 'active', id)
}
