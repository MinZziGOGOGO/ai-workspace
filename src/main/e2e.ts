// Shared guard for automated E2E fakes. A fake flag alone is not enough:
// Playwright launches the app with an isolated test user-data directory, while
// normal packaged production use does not. Packaged Electron builds are denied
// explicitly so inherited environment variables cannot switch agents to fakes.

function isPackagedElectronRuntime(): boolean {
  try {
    const electron = require('electron') as { app?: { isPackaged?: boolean } }
    return electron.app?.isPackaged === true
  } catch {
    return false
  }
}

export function isE2EFakeEnabled(flag: string): boolean {
  return process.env[flag] === '1' &&
    Boolean(process.env.AIWORKSPACE_TEST_USER_DATA) &&
    !isPackagedElectronRuntime()
}
