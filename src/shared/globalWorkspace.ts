// Built-in workspace sentinel.
//
// This is deliberately not a normal folder-backed project: it exists so tables
// with a NOT NULL project_id (notably sessions) can store global chat sessions
// without making project_id nullable or creating a fake directory/marker file.
export const GLOBAL_PROJECT_ID = '__global__'
export const GLOBAL_PROJECT_NAME = 'Global Workspace'
export const GLOBAL_PROJECT_SUBTITLE = 'General chat and shared memory not tied to a project'

export function isGlobalProjectId(id: string): boolean {
  return id === GLOBAL_PROJECT_ID
}
