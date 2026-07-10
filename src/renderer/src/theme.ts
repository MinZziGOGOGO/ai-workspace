// Theme application. The stored `ui_theme` setting is 'system' | 'dark' | 'light';
// what lands on <html data-theme> is always the *resolved* 'dark' or 'light' so
// styles.css only needs a [data-theme="dark"] override block ('light' is the
// default warm light gray palette from the visual overhaul).

export type ThemeSetting = 'system' | 'dark' | 'light'

let currentSetting: ThemeSetting = 'system'

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)')

function resolve(setting: ThemeSetting): 'dark' | 'light' {
  if (setting === 'dark' || setting === 'light') return setting
  return darkMedia.matches ? 'dark' : 'light'
}

/** Apply a theme setting to the document, resolving 'system' via the OS preference. */
export function applyTheme(setting: string | null | undefined): void {
  currentSetting = setting === 'dark' || setting === 'light' ? setting : 'system'
  document.documentElement.dataset.theme = resolve(currentSetting)
}

// Follow live OS preference changes while the setting is 'system'.
darkMedia.addEventListener('change', () => {
  if (currentSetting === 'system') applyTheme('system')
})
