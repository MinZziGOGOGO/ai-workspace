#!/usr/bin/env node
// Restores a broken Electron install after `npm install` mangles it.
//
// Two things must be true for `require('electron')` / electron-vite to launch:
//   1. node_modules/electron/dist/electron.exe  exists  (the binary)
//   2. node_modules/electron/path.txt           exists  (points index.js at it)
//
// On this machine npm's extract step fails silently, leaving one or both
// missing. The binary lives in an already-downloaded cache zip; path.txt is
// NOT in that zip (Electron's own install.js writes it), so we recreate it
// ourselves. path.txt must be exactly "electron.exe" — no BOM, no newline —
// because index.js joins its raw contents into the binary path. A BOM here
// produces a "﻿electron.exe" ENOENT on spawn.

const { execSync } = require('child_process')
const { existsSync, readdirSync, writeFileSync, readFileSync } = require('fs')
const { join } = require('path')
const os = require('os')

const electronDir = join(__dirname, '..', 'node_modules', 'electron')
const distDir = join(electronDir, 'dist')
const binaryPath = join(distDir, 'electron.exe')
const pathTxt = join(electronDir, 'path.txt')
const PATH_TXT_CONTENT = 'electron.exe' // win32 platform path; raw, no newline/BOM

function ensureBinary() {
  if (existsSync(binaryPath)) {
    console.log('[fix-electron] Binary present.')
    return true
  }
  console.log('[fix-electron] electron.exe missing — searching cache...')

  const cacheDir = join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache')
  let zipPath = null
  if (existsSync(cacheDir)) {
    for (const sub of readdirSync(cacheDir)) {
      try {
        const zip = readdirSync(join(cacheDir, sub)).find(
          (f) => f.startsWith('electron-v') && f.endsWith('.zip')
        )
        if (zip) { zipPath = join(cacheDir, sub, zip); break }
      } catch { /* skip unreadable entries */ }
    }
  }

  if (!zipPath) {
    console.error('[fix-electron] No cache zip found in', cacheDir)
    console.error('[fix-electron] Run: npm install electron@30.5.1  (downloads it)')
    return false
  }

  console.log('[fix-electron] Extracting', zipPath)
  // PowerShell Expand-Archive is always present on Windows; unzip (Git Bash)
  // is the fallback. npm's own extract-zip is what fails, so we avoid it.
  try {
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command ` +
      `"Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${distDir}' -Force"`,
      { stdio: 'inherit' }
    )
  } catch { /* try fallback */ }
  if (!existsSync(binaryPath)) {
    try { execSync(`unzip -qo "${zipPath}" -d "${distDir}"`, { stdio: 'inherit' }) } catch { /* */ }
  }

  if (existsSync(binaryPath)) {
    console.log('[fix-electron] Binary restored.')
    return true
  }
  console.error('[fix-electron] Extraction finished but electron.exe still missing.')
  return false
}

function ensurePathTxt() {
  // Rewrite if missing OR corrupt (wrong content / stray BOM/newline).
  let ok = false
  if (existsSync(pathTxt)) {
    try { ok = readFileSync(pathTxt, 'utf-8') === PATH_TXT_CONTENT } catch { ok = false }
  }
  if (ok) {
    console.log('[fix-electron] path.txt present.')
    return true
  }
  // Node writes UTF-8 with no BOM and no trailing newline — exactly what
  // index.js expects.
  writeFileSync(pathTxt, PATH_TXT_CONTENT)
  console.log('[fix-electron] path.txt written.')
  return true
}

const binaryOk = ensureBinary()
const pathOk = binaryOk && ensurePathTxt()

if (binaryOk && pathOk) {
  // Final proof: resolve electron the same way the app will.
  try {
    delete require.cache[require.resolve('electron')]
    const resolved = require('electron')
    console.log('[fix-electron] OK — electron resolves to:', resolved)
    process.exit(0)
  } catch (err) {
    console.error('[fix-electron] Still broken:', err.message)
    process.exit(1)
  }
} else {
  process.exit(1)
}
