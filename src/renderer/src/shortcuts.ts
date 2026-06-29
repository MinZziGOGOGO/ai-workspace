export interface Shortcut {
  id: string
  label: string
  description: string
  defaultKey: string
  currentKey: string
  scope: 'global' | 'composer' | 'panel'
  action: string
}

export const DEFAULT_SHORTCUTS: Shortcut[] = [
  {
    id: 'nav_chat',
    label: 'Switch to Chat',
    description: 'Open the Chat panel',
    defaultKey: 'ctrl+1',
    currentKey: 'ctrl+1',
    scope: 'global',
    action: 'open_panel:chat',
  },
  {
    id: 'nav_hermes',
    label: 'Switch to Hermes',
    description: 'Open the Hermes panel',
    defaultKey: 'ctrl+2',
    currentKey: 'ctrl+2',
    scope: 'global',
    action: 'open_panel:hermes',
  },
  {
    id: 'nav_claudecode',
    label: 'Switch to Claude Code',
    description: 'Open the Claude Code panel',
    defaultKey: 'ctrl+3',
    currentKey: 'ctrl+3',
    scope: 'global',
    action: 'open_panel:claudecode',
  },
  {
    id: 'nav_codex',
    label: 'Switch to Codex',
    description: 'Open the Codex panel',
    defaultKey: 'ctrl+4',
    currentKey: 'ctrl+4',
    scope: 'global',
    action: 'open_panel:codex',
  },
  {
    id: 'new_session',
    label: 'New Session',
    description: 'Start a new session in the current panel',
    defaultKey: 'ctrl+n',
    currentKey: 'ctrl+n',
    scope: 'global',
    action: 'new_session',
  },
  {
    id: 'close_panel',
    label: 'Close Panel',
    description: 'Close the currently focused panel',
    defaultKey: 'ctrl+w',
    currentKey: 'ctrl+w',
    scope: 'global',
    action: 'close_panel',
  },
  {
    id: 'open_settings',
    label: 'Open Settings',
    description: 'Open the settings panel',
    defaultKey: 'ctrl+,',
    currentKey: 'ctrl+,',
    scope: 'global',
    action: 'open_settings',
  },
  {
    id: 'open_extensions',
    label: 'Open Extensions',
    description: 'Open the Extensions panel',
    defaultKey: 'ctrl+shift+e',
    currentKey: 'ctrl+shift+e',
    scope: 'global',
    action: 'open_panel:extensions',
  },
  {
    id: 'focus_composer',
    label: 'Focus Composer',
    description: 'Focus the message input of the active panel',
    defaultKey: 'ctrl+l',
    currentKey: 'ctrl+l',
    scope: 'global',
    action: 'focus_composer',
  },
  {
    id: 'open_terminal',
    label: 'Open Terminal',
    description: 'Open the Terminal panel',
    defaultKey: 'ctrl+shift+t',
    currentKey: 'ctrl+shift+t',
    scope: 'global',
    action: 'open_panel:terminal',
  },
  {
    id: 'open_navigator',
    label: 'Open Navigator',
    description: 'Open the Navigator panel',
    defaultKey: 'ctrl+shift+n',
    currentKey: 'ctrl+shift+n',
    scope: 'global',
    action: 'open_panel:navigator',
  },
  {
    id: 'open_activity',
    label: 'Open Activity',
    description: 'Open the Activity panel',
    defaultKey: 'ctrl+shift+a',
    currentKey: 'ctrl+shift+a',
    scope: 'global',
    action: 'open_panel:activity',
  },
  {
    id: 'show_shortcuts',
    label: 'Show Shortcuts',
    description: 'Show keyboard shortcut help overlay',
    defaultKey: 'ctrl+/',
    currentKey: 'ctrl+/',
    scope: 'global',
    action: 'show_shortcuts',
  },
  {
    id: 'send_message',
    label: 'Send Message',
    description: 'Send the current message',
    defaultKey: 'enter',
    currentKey: 'enter',
    scope: 'composer',
    action: 'send',
  },
  {
    id: 'send_message_alt',
    label: 'Send Message (Alt)',
    description: 'Alternative send shortcut',
    defaultKey: 'ctrl+enter',
    currentKey: 'ctrl+enter',
    scope: 'composer',
    action: 'send',
  },
  {
    id: 'newline',
    label: 'New Line',
    description: 'Insert a new line in the composer',
    defaultKey: 'shift+enter',
    currentKey: 'shift+enter',
    scope: 'composer',
    action: 'newline',
  },
  {
    id: 'cancel_generation',
    label: 'Cancel Generation',
    description: 'Stop the current AI response',
    defaultKey: 'escape',
    currentKey: 'escape',
    scope: 'composer',
    action: 'cancel',
  },
  {
    id: 'clear_composer',
    label: 'Clear Composer',
    description: 'Clear the message input',
    defaultKey: 'ctrl+k',
    currentKey: 'ctrl+k',
    scope: 'composer',
    action: 'clear',
  },
]

export const SHORTCUTS_STORAGE_KEY = 'keyboard_shortcuts'

export function parseKey(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.shiftKey) parts.push('shift')
  if (e.altKey) parts.push('alt')

  const key = e.key.toLowerCase()
  const keyMap: Record<string, string> = {
    ' ': 'space',
    escape: 'escape',
    enter: 'enter',
    ',': ',',
    '/': '/',
    '.': '.',
  }
  parts.push(keyMap[key] || key)
  return parts.join('+')
}

export function matchesShortcut(e: KeyboardEvent, shortcut: Shortcut): boolean {
  return parseKey(e) === shortcut.currentKey
}

export function isModifierOnlyKey(key: string): boolean {
  return ['control', 'shift', 'alt', 'meta'].includes(key.toLowerCase())
}

export function formatShortcutKey(key: string): string {
  return key
    .split('+')
    .map((part) => {
      if (part === 'ctrl') return 'Ctrl'
      if (part === 'shift') return 'Shift'
      if (part === 'alt') return 'Alt'
      if (part === 'escape') return 'Esc'
      if (part === 'enter') return 'Enter'
      if (part === 'space') return 'Space'
      return part.length === 1 ? part.toUpperCase() : part
    })
    .join('+')
}
