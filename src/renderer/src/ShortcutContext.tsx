import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUTS_STORAGE_KEY,
  matchesShortcut,
  type Shortcut,
} from './shortcuts'

export interface ShortcutContextValue {
  shortcuts: Shortcut[]
  updateShortcut: (id: string, newKey: string) => void
  resetShortcut: (id: string) => void
  resetAll: () => void
  getShortcut: (id: string) => Shortcut | undefined
}

export const ShortcutContext = createContext<ShortcutContextValue | null>(null)

function mergeShortcuts(raw: string | null): Shortcut[] {
  if (!raw) return DEFAULT_SHORTCUTS
  try {
    const parsed = JSON.parse(raw) as Partial<Shortcut>[]
    if (!Array.isArray(parsed)) return DEFAULT_SHORTCUTS
    const byId = new Map(parsed.map((shortcut) => [shortcut.id, shortcut]))
    return DEFAULT_SHORTCUTS.map((shortcut) => {
      const saved = shortcut.id ? byId.get(shortcut.id) : undefined
      return {
        ...shortcut,
        currentKey: typeof saved?.currentKey === 'string' && saved.currentKey.trim()
          ? saved.currentKey
          : shortcut.currentKey,
      }
    })
  } catch {
    return DEFAULT_SHORTCUTS
  }
}

function persistable(shortcuts: Shortcut[]) {
  return shortcuts.map((shortcut) => ({
    id: shortcut.id,
    currentKey: shortcut.currentKey,
  }))
}

function dispatchWorkspaceAction(action: string) {
  if (action.startsWith('open_panel:')) {
    window.dispatchEvent(new CustomEvent('workspace:openPanel', {
      detail: { panel: action.slice('open_panel:'.length) },
    }))
    return
  }

  const events: Record<string, string> = {
    open_settings: 'workspace:openSettings',
    show_shortcuts: 'workspace:showShortcuts',
    new_session: 'workspace:newSession',
    close_panel: 'workspace:closePanel',
    focus_composer: 'workspace:focusComposer',
    command_palette: 'workspace:toggleCommandPalette',
  }
  const eventName = events[action]
  if (eventName) window.dispatchEvent(new CustomEvent(eventName))
}

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const [shortcuts, setShortcuts] = useState<Shortcut[]>(DEFAULT_SHORTCUTS)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get(SHORTCUTS_STORAGE_KEY)
      .then((raw) => {
        if (!cancelled) setShortcuts(mergeShortcuts(raw))
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!loaded) return
    window.api.settings.set(SHORTCUTS_STORAGE_KEY, JSON.stringify(persistable(shortcuts)))
      .catch((err) => console.error('[shortcuts] persist failed:', err))
  }, [loaded, shortcuts])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const shortcut = shortcuts.find((item) => item.scope === 'global' && matchesShortcut(e, item))
      if (!shortcut) return
      e.preventDefault()
      dispatchWorkspaceAction(shortcut.action)
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [shortcuts])

  const value = useMemo<ShortcutContextValue>(() => ({
    shortcuts,
    updateShortcut: (id, newKey) => {
      setShortcuts((current) => current.map((shortcut) =>
        shortcut.id === id ? { ...shortcut, currentKey: newKey } : shortcut
      ))
    },
    resetShortcut: (id) => {
      setShortcuts((current) => current.map((shortcut) =>
        shortcut.id === id ? { ...shortcut, currentKey: shortcut.defaultKey } : shortcut
      ))
    },
    resetAll: () => {
      setShortcuts(DEFAULT_SHORTCUTS)
    },
    getShortcut: (id) => shortcuts.find((shortcut) => shortcut.id === id),
  }), [shortcuts])

  return (
    <ShortcutContext.Provider value={value}>
      {children}
    </ShortcutContext.Provider>
  )
}

export function useShortcuts(): ShortcutContextValue {
  const value = useContext(ShortcutContext)
  if (!value) throw new Error('useShortcuts must be used inside ShortcutProvider')
  return value
}
