import { Notification, type BrowserWindow } from 'electron'

export function showNotification(win: BrowserWindow | null, opts: { title: string; body: string }): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: opts.title, body: opts.body, silent: false })
  n.on('click', () => { win?.show(); win?.focus() })
  n.show()
}
