import { useEffect, useRef, useState } from 'react'
import type { Project } from '../types'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { WorkspaceEmptyState } from './WorkspacePrimitives'

function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

export default function TerminalPanel({ project }: { project: Project }) {
  const isGlobal = isGlobalProjectId(project.id)
  const containerRef = useRef<HTMLDivElement>(null)
  const [exitState, setExitState] = useState(false)

  useEffect(() => {
    if (isGlobal || !containerRef.current) return

    const term = new Terminal({
      theme: {
        background: '#1a1918',
        foreground: '#e8e6e0',
        cursor: '#d9a05b',
        cursorAccent: '#1a1918',
        selectionBackground: 'rgba(217, 160, 91, 0.25)',
        black: '#151413',
        brightBlack: '#7f7c73',
        red: '#d9695f',
        brightRed: '#f08080',
        green: '#5fbf77',
        brightGreen: '#80d990',
        yellow: '#d9a05b',
        brightYellow: '#f0c060',
        blue: '#8fb3de',
        brightBlue: '#b0d0f0',
        magenta: '#9d8cff',
        brightMagenta: '#c0b0ff',
        cyan: '#4fb8a8',
        brightCyan: '#80d9c9',
        white: '#e8e6e0',
        brightWhite: '#ffffff'
      },
      fontFamily: "'Cascadia Code', Consolas, 'SF Mono', ui-monospace, Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: false
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    let terminalId: string | null = null
    let removeData: (() => void) | null = null
    let removeExit: (() => void) | null = null
    let observer: ResizeObserver | null = null
    let disposed = false

    window.api.terminal.create(project.path || null).then(({ id }) => {
      if (disposed) {
        window.api.terminal.close(id)
        return
      }
      terminalId = id

      removeData = window.api.terminal.onData((d) => {
        if (d.id === id) term.write(d.data)
      })
      removeExit = window.api.terminal.onExit((d) => {
        if (d.id === id) {
          setExitState(true)
          term.write('\r\n\r\n\x1b[2m[Process exited]\x1b[0m\r\n')
        }
      })

      term.onData((data) => window.api.terminal.write(id, data))

      if (containerRef.current) {
        observer = new ResizeObserver(() => {
          fitAddon.fit()
          window.api.terminal.resize(id, term.cols, term.rows)
        })
        observer.observe(containerRef.current)
      }

      fitAddon.fit()
      window.api.terminal.resize(id, term.cols, term.rows)
    })

    return () => {
      disposed = true
      removeData?.()
      removeExit?.()
      observer?.disconnect()
      term.dispose()
      if (terminalId) {
        window.api.terminal.close(terminalId)
        terminalId = null
      }
    }
  }, [project.path, isGlobal])

  if (isGlobal) {
    return (
      <div className="placeholder" data-testid="terminal-global-unavailable">
        <WorkspaceEmptyState
          icon={<TerminalIcon />}
          title="Terminal needs a project folder."
          body="Open a project workspace to start a shell in that folder."
        />
      </div>
    )
  }

  return (
    <div className="terminal-panel" data-testid="terminal-panel-content">
      {exitState && (
        <div className="terminal-exited-bar">
          Process exited — close the panel to dismiss.
        </div>
      )}
      <div ref={containerRef} className="terminal-xterm" />
    </div>
  )
}
