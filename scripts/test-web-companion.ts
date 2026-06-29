import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initDb } from '../src/main/db'
import * as projects from '../src/main/projects'
import {
  configureWebCompanion,
  getWebCompanionStatus,
  regenerateWebCompanionToken,
  stopWebCompanion,
} from '../src/main/webCompanion'

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'aiw-web-companion-'))
  const userData = join(root, 'user-data')
  const projectParent = join(root, 'projects')
  mkdirSync(userData, { recursive: true })
  mkdirSync(projectParent, { recursive: true })

  try {
    await initDb(userData)
    projects.ensureGlobalProject()
    const project = projects.createProject('Safe Project', projectParent)

    const initial = getWebCompanionStatus()
    if (initial.enabled || initial.running) {
      throw new Error('Web Companion must be disabled by default')
    }

    const port = 18765 + Math.floor(Math.random() * 1000)
    const enabled = await configureWebCompanion({ enabled: true, hostMode: 'local', port })
    if (!enabled.running) throw new Error(`Web Companion did not start: ${enabled.error ?? 'unknown error'}`)
    if (enabled.bindHost !== '127.0.0.1') throw new Error(`Expected localhost bind, got ${enabled.bindHost}`)

    const base = enabled.localUrl
    const unauth = await fetch(`${base}/api/projects`)
    if (unauth.status !== 401) throw new Error(`Unauthenticated project list returned ${unauth.status}`)

    const { token } = regenerateWebCompanionToken()
    const badLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' }),
    })
    if (badLogin.status !== 401) throw new Error('Bad login token was accepted')

    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!login.ok) throw new Error(`Valid login failed with ${login.status}`)

    const projectsRes = await fetch(`${base}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!projectsRes.ok) throw new Error(`Authenticated project list failed with ${projectsRes.status}`)
    const projectsJson = await projectsRes.json() as { projects: Array<Record<string, unknown>> }
    const safeProject = projectsJson.projects.find((p) => p.id === project.id)
    if (!safeProject) throw new Error('Trusted project missing from project list')
    if ('path' in safeProject) throw new Error('Project list exposed a filesystem path')

    const disabled = await configureWebCompanion({ enabled: false })
    if (disabled.running) throw new Error('Web Companion did not stop after disabling')

    console.log('web companion smoke passed')
  } finally {
    await stopWebCompanion()
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
