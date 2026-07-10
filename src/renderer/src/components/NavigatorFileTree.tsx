import { useState, useEffect } from 'react'
import type { FsEntry } from '../types'

// Folders at depth >= MAX_DEPTH cannot be expanded (0-indexed, so 4 visible levels: 0,1,2,3).
const MAX_DEPTH = 3

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 8 8" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="2,1 6,4 2,7" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 14 12" width="13" height="11" fill="currentColor" aria-hidden>
      <path d="M1 3a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3z" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg viewBox="0 0 12 14" width="11" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 1h6l3 3v9H2V1z" />
      <path d="M8 1v3h3" />
    </svg>
  )
}

export default function NavigatorFileTree({
  projectPath,
  active = true,
  selectedFile,
  onFileSelect
}: {
  projectPath: string
  active?: boolean
  selectedFile?: string | null
  onFileSelect?: (path: string) => void
}) {
  const [rootEntries, setRootEntries] = useState<FsEntry[] | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [dirContents, setDirContents] = useState<Map<string, FsEntry[]>>(new Map())
  const [searchQuery, setSearchQuery] = useState('')
  const [gitFiles, setGitFiles] = useState<Record<string, string> | null>(null)

  useEffect(() => {
    setRootEntries(null)
    setExpandedDirs(new Set())
    setDirContents(new Map())
    setSearchQuery('')
    window.api.fs.readDir(projectPath).then(entries => {
      setRootEntries(entries)
    })
  }, [projectPath])

  // Git status indicators: load on mount and refresh every 10 seconds.
  // A non-repo project simply shows no indicators (gitFiles stays null).
  // Only poll while the Navigator panel is actually open — otherwise a hidden
  // panel keeps hammering git in the main process for nothing.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setGitFiles(null)
    const load = () => {
      window.api.git.status(projectPath).then(result => {
        if (!cancelled) setGitFiles(result.isGitRepo ? result.files : null)
      }).catch(() => {})
    }
    load()
    const timer = setInterval(load, 10000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [projectPath, active])

  // Map an absolute entry path to its git status dot class, if any.
  function gitDotFor(absPath: string): string | null {
    if (!gitFiles) return null
    const normalizedRoot = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const normalized = absPath.replace(/\\/g, '/')
    if (!normalized.toLowerCase().startsWith(normalizedRoot.toLowerCase() + '/')) return null
    const rel = normalized.slice(normalizedRoot.length + 1)
    const status = gitFiles[rel]
    if (!status) return null
    if (status === '??') return 'untracked'
    if (status.includes('D')) return 'deleted'
    if (status.includes('A')) return 'added'
    return 'modified' // M, R, C, U and mixed states
  }

  async function toggleDir(path: string, depth: number) {
    if (depth >= MAX_DEPTH) return
    if (expandedDirs.has(path)) {
      setExpandedDirs(prev => { const n = new Set(prev); n.delete(path); return n })
    } else {
      if (!dirContents.has(path)) {
        const entries = await window.api.fs.readDir(path)
        setDirContents(prev => { const n = new Map(prev); n.set(path, entries); return n })
      }
      setExpandedDirs(prev => new Set(prev).add(path))
    }
  }

  function selectFile(path: string) {
    onFileSelect?.(path)
  }

  // Collect all loaded files (for search — only already-expanded dirs are searched).
  function getAllLoadedFiles(): Array<{ entry: FsEntry; relativePath: string }> {
    const result: Array<{ entry: FsEntry; relativePath: string }> = []
    function traverse(entries: FsEntry[], prefix: string) {
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name
        if (!e.isDir) {
          result.push({ entry: e, relativePath: rel })
        } else if (dirContents.has(e.path)) {
          traverse(dirContents.get(e.path)!, rel)
        }
      }
    }
    if (rootEntries) traverse(rootEntries, '')
    return result
  }

  function renderEntries(entries: FsEntry[], depth: number): React.ReactNode {
    return entries.map(entry => {
      if (entry.isDir) {
        const canExpand = depth < MAX_DEPTH
        const expanded = canExpand && expandedDirs.has(entry.path)
        const children = expanded ? (dirContents.get(entry.path) ?? []) : []
        return (
          <div key={entry.path}>
            <button
              className="file-tree-row"
              style={{ paddingLeft: `${depth * 16 + 6}px`, paddingRight: '8px' }}
              onClick={canExpand ? () => toggleDir(entry.path, depth) : undefined}
              title={entry.path}
            >
              <span className={`file-tree-chevron ${expanded ? 'expanded' : ''}`}>
                {canExpand && <ChevronRightIcon />}
              </span>
              <span className="file-tree-icon dir-icon"><FolderIcon /></span>
              <span className="file-tree-name">{entry.name}</span>
            </button>
            {expanded && renderEntries(children, depth + 1)}
          </div>
        )
      } else {
        const gitDot = gitDotFor(entry.path)
        return (
          <button
            key={entry.path}
            className={`file-tree-row ${selectedFile === entry.path ? 'selected' : ''}`}
            style={{ paddingLeft: `${depth * 16 + 22}px`, paddingRight: '8px' }}
            onClick={() => selectFile(entry.path)}
            title={entry.path}
          >
            <span className="file-tree-icon"><FileIcon /></span>
            <span className="file-tree-name">{entry.name}</span>
            {gitDot && <span className={`git-status-dot ${gitDot}`} title={`Git: ${gitDot}`} />}
          </button>
        )
      }
    })
  }

  const searchTerm = searchQuery.trim().toLowerCase()
  const matchedFiles = searchTerm
    ? getAllLoadedFiles().filter(f => f.entry.name.toLowerCase().includes(searchTerm))
    : null

  return (
    <div className="nav-files-section" data-testid="navigator-project-files">
      <h3>Project Files</h3>
      <div className="nav-search">
        <input
          placeholder="Search files..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="file-tree">
        {rootEntries === null ? (
          <div className="muted small" style={{ padding: '4px 6px' }}>Loading…</div>
        ) : searchTerm ? (
          matchedFiles!.length === 0 ? (
            <div className="muted small" style={{ padding: '4px 6px' }}>No matches</div>
          ) : (
            matchedFiles!.map(({ entry, relativePath }) => {
              const dir = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : ''
              const gitDot = gitDotFor(entry.path)
              return (
                <button
                  key={entry.path}
                  className={`file-tree-row flat-file-row ${selectedFile === entry.path ? 'selected' : ''}`}
                  style={{ paddingLeft: '6px', paddingRight: '8px' }}
                  onClick={() => selectFile(entry.path)}
                  title={entry.path}
                >
                  <span className="file-tree-icon"><FileIcon /></span>
                  <span className="flat-file-name">{entry.name}</span>
                  {dir && <span className="flat-file-path">{dir}</span>}
                  {gitDot && <span className={`git-status-dot ${gitDot}`} title={`Git: ${gitDot}`} />}
                </button>
              )
            })
          )
        ) : rootEntries.length === 0 ? (
          <div className="muted small" style={{ padding: '4px 6px' }}>No files</div>
        ) : (
          renderEntries(rootEntries, 0)
        )}
      </div>
    </div>
  )
}
