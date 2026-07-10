import { getDb } from './db'
import { getHermesConfig } from './hermes'

// Hermes dashboard API client — Skills tab in the Extensions panel.
//
// The Hermes dashboard runs an HTTP server on port 9119 (same host as the ACP
// connection: localhost in local/WSL2 mode, the SSH host in remote mode). It
// uses cookie-session auth: POST /auth/password-login returns a session cookie
// that must accompany every /api/skills* request.
//
// All calls here run in the main process (the renderer's CSP blocks external
// fetches, same as the MCP registry proxy) and fail with readable errors when
// the server is unreachable — never crash the main process.

export interface SkillItem {
  name: string
  description: string
  category: string | null
  enabled: boolean
  usage: number
  provenance: 'agent' | 'hub'
}

export interface HubSkillResult {
  name: string
  description: string
  source: string
  identifier: string
  trust_level: string
  repo: string
  tags: string[]
}

let skillsSessionCookie: string | null = null

function readMeta(key: string): string {
  try {
    const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? ''
  } catch {
    return ''
  }
}

// Dashboard credentials follow the hermes_* app_meta key convention used by
// getHermesConfig(); the username defaults to the dashboard's own default.
function getDashboardCredentials(): { username: string; password: string } {
  return {
    username: readMeta('hermes_dashboard_user') || 'admin',
    password: readMeta('hermes_dashboard_password')
  }
}

function skillsBaseUrl(): string {
  const config = getHermesConfig()
  const host = config.mode === 'remote' && config.sshHost ? config.sshHost : 'localhost'
  return `http://${host}:9119`
}

function unreachableError(err: unknown): Error {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new Error(`Hermes dashboard timed out at ${skillsBaseUrl()}. Is Hermes running?`)
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new Error(`Hermes dashboard unreachable at ${skillsBaseUrl()}: ${msg}`)
}

async function login(): Promise<void> {
  const { username, password } = getDashboardCredentials()
  let res: Response
  try {
    res = await fetch(`${skillsBaseUrl()}/auth/password-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, provider: 'basic' }),
      signal: AbortSignal.timeout(5000)
    })
  } catch (err) {
    throw unreachableError(err)
  }
  // Node's fetch folds multiple Set-Cookie headers into one comma-joined value;
  // getSetCookie() (where available) returns them individually.
  const cookies: string[] =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : ([res.headers.get('set-cookie')].filter(Boolean) as string[])
  const sessionCookie = cookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ')
  if (!res.ok || !sessionCookie) {
    throw new Error(`Hermes dashboard login failed (HTTP ${res.status}). Check the dashboard credentials.`)
  }
  skillsSessionCookie = sessionCookie
}

// Authenticated fetch with a single re-login retry: if the stored cookie is
// missing or the server rejects it (401/403), log in again and retry once.
async function authedFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (!skillsSessionCookie) await login()
  const doFetch = async (): Promise<Response> => {
    try {
      return await fetch(`${skillsBaseUrl()}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Cookie: skillsSessionCookie ?? '' },
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      throw unreachableError(err)
    }
  }
  let res = await doFetch()
  if (res.status === 401 || res.status === 403) {
    skillsSessionCookie = null
    await login()
    res = await doFetch()
  }
  return res
}

export async function listSkills(): Promise<SkillItem[]> {
  const res = await authedFetch('/api/skills', {}, 10000)
  if (!res.ok) throw new Error(`Skills fetch failed: ${res.status}`)
  const data = await res.json()
  return Array.isArray(data) ? (data as SkillItem[]) : []
}

export async function toggleSkill(name: string, enabled: boolean): Promise<void> {
  const res = await authedFetch(
    '/api/skills/toggle',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, enabled })
    },
    5000
  )
  if (!res.ok) throw new Error(`Toggle failed: ${res.status}`)
}

export async function searchSkillsHub(query: string): Promise<HubSkillResult[]> {
  const res = await authedFetch(`/api/skills/hub/search?q=${encodeURIComponent(query)}`, {}, 10000)
  if (!res.ok) throw new Error(`Hub search failed: ${res.status}`)
  const data = (await res.json()) as { results?: HubSkillResult[] }
  return data.results ?? []
}

// Starts an async install job on the server — the response confirms the job
// started, not that it finished. The skill shows up in listSkills() shortly
// after; callers should re-fetch to confirm.
export async function installSkillFromHub(identifier: string): Promise<{ pid: number; name: string }> {
  const res = await authedFetch(
    '/api/skills/hub/install',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier })
    },
    10000
  )
  if (!res.ok) throw new Error(`Install failed: ${res.status}`)
  return (await res.json()) as { pid: number; name: string }
}
