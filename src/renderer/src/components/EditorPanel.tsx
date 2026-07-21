import { useEffect, useRef, useState } from 'react'
import { SyntaxHighlighter, oneDark, oneLight } from '../syntax'
import { StatusBadge, WorkspaceEmptyState, WorkspaceNotice } from './WorkspacePrimitives'
import Markdown from './Markdown'

function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? filePath
}

function shortPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length <= 2) return filePath
  return parts.slice(-2, -1).join('/')
}

function extension(filePath: string): string {
  const name = basename(filePath)
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  bat: 'batch',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cxx: 'cpp',
  diff: 'diff',
  dockerfile: 'docker',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'markup',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  log: 'text',
  lua: 'lua',
  md: 'markdown',
  markdown: 'markdown',
  mjs: 'javascript',
  patch: 'diff',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'tsx',
  txt: 'text',
  xml: 'markup',
  yaml: 'yaml',
  yml: 'yaml',
}

function languageForPath(filePath: string | null): string | null {
  if (!filePath) return null
  const name = basename(filePath).toLowerCase()
  if (name === 'dockerfile') return 'docker'
  return LANGUAGE_BY_EXT[extension(filePath)] ?? null
}

function fileTone(filePath: string): string {
  const ext = extension(filePath)
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'json'].includes(ext)) return 'script'
  if (['py', 'rb', 'sh', 'ps1', 'bat', 'lua'].includes(ext)) return 'runtime'
  if (['java', 'kt', 'cs', 'go', 'rs', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp'].includes(ext)) return 'compiled'
  if (['md', 'markdown', 'txt', 'log'].includes(ext)) return 'doc'
  if (['css', 'html', 'xml', 'yaml', 'yml', 'ini'].includes(ext)) return 'markup'
  if (['jar', 'zip', '7z', 'gz', 'tar', 'rar'].includes(ext)) return 'archive'
  return 'plain'
}

function tabWidthForPath(filePath: string): number {
  const name = basename(filePath)
  const hint = shortPath(filePath)
  const hintWidth = hint && hint !== filePath ? 34 : 0
  return Math.max(92, Math.min(184, 54 + name.length * 7 + hintWidth))
}

function EditIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 2l3 3-8 8H3v-3l8-8z" />
    </svg>
  )
}

type EditorTab = {
  path: string
  content: string
  savedContent: string
  loadError: string | null
  fileSize: number
  saveError: string | null
  previewMode: boolean
  loading: boolean
}

type PersistedEditorTab = {
  path: string
  draftContent?: string
  savedContent?: string
}

type PersistedEditorState = {
  version: 1
  workspaceId: string
  activePath: string | null
  tabBarCollapsed: boolean
  tabs: PersistedEditorTab[]
}

function createLoadingTab(path: string): EditorTab {
  return {
    path,
    content: '',
    savedContent: '',
    loadError: null,
    fileSize: 0,
    saveError: null,
    previewMode: false,
    loading: true,
  }
}

function createRestoredTab(tab: PersistedEditorTab): EditorTab {
  const hasDraft = typeof tab.draftContent === 'string'
  return {
    path: tab.path,
    content: tab.draftContent ?? '',
    savedContent: tab.savedContent ?? '',
    loadError: null,
    fileSize: 0,
    saveError: null,
    previewMode: false,
    loading: !hasDraft,
  }
}

function storageKey(workspaceId: string) {
  return `aiworkspace.editorTabs.${workspaceId}`
}

function loadPersistedState(workspaceId: string): PersistedEditorState | null {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedEditorState>
    if (parsed.version !== 1 || parsed.workspaceId !== workspaceId || !Array.isArray(parsed.tabs)) return null
    const seen = new Set<string>()
    const tabs = parsed.tabs
      .filter((tab): tab is PersistedEditorTab => typeof tab.path === 'string' && tab.path.length > 0)
      .filter(tab => {
        if (seen.has(tab.path)) return false
        seen.add(tab.path)
        return true
      })
      .slice(0, 24)
    return {
      version: 1,
      workspaceId,
      activePath: typeof parsed.activePath === 'string' ? parsed.activePath : null,
      tabBarCollapsed: parsed.tabBarCollapsed === true,
      tabs,
    }
  } catch {
    return null
  }
}

export default function EditorPanel({
  selectedFile,
  workspaceId,
  onActiveFileChange,
}: {
  selectedFile: string | null
  workspaceId: string
  onActiveFileChange: (path: string | null) => void
}) {
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [tabBarCollapsed, setTabBarCollapsed] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [tabBarWidth, setTabBarWidth] = useState(0)
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>('light')
  const [saving, setSaving] = useState(false)
  const [showSaved, setShowSaved] = useState(false)
  const [fontSize, setFontSize] = useState(13)
  const [tabSize, setTabSize] = useState(2)
  const [wordWrap, setWordWrap] = useState(true)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const tabsWrapRef = useRef<HTMLDivElement>(null)
  const openPathsRef = useRef<Set<string>>(new Set())

  const activeTab = tabs.find(tab => tab.path === activePath) ?? null
  const openedFile = activeTab?.path ?? null
  const content = activeTab?.content ?? ''
  const savedContent = activeTab?.savedContent ?? ''
  const loadError = activeTab?.loadError ?? null
  const saveError = activeTab?.saveError ?? null
  const fileSize = activeTab?.fileSize ?? 0
  const previewMode = activeTab?.previewMode ?? false
  const isMarkdown = !!openedFile && /\.(md|markdown)$/i.test(openedFile)
  const syntaxLanguage = languageForPath(openedFile)
  const syntaxEnabled = !!syntaxLanguage && syntaxLanguage !== 'text'
  const isDirty = !!activeTab && !activeTab.loadError && !activeTab.loading && content !== savedContent
  const dirtyCount = tabs.filter(tab => !tab.loadError && !tab.loading && tab.content !== tab.savedContent).length

  const measuredTabBarWidth = tabBarWidth > 0 ? tabBarWidth : 10_000
  const totalTabWidth = tabs.reduce((sum, tab, index) => sum + tabWidthForPath(tab.path) + (index > 0 ? 3 : 0), 0)
  const needsOverflow = totalTabWidth > measuredTabBarWidth
  const overflowButtonWidth = 76
  const tabFitWidth = Math.max(96, measuredTabBarWidth - (needsOverflow ? overflowButtonWidth : 0))
  const visiblePaths = new Set<string>()
  const visibleTabs: EditorTab[] = []
  let usedTabWidth = 0
  for (const tab of tabs) {
    const nextWidth = tabWidthForPath(tab.path) + (visibleTabs.length > 0 ? 3 : 0)
    if (needsOverflow && visibleTabs.length > 0 && usedTabWidth + nextWidth > tabFitWidth) break
    visibleTabs.push(tab)
    usedTabWidth += nextWidth
  }
  if (visibleTabs.length === 0 && tabs[0]) visibleTabs.push(tabs[0])
  if (needsOverflow && activeTab && !visibleTabs.some(tab => tab.path === activeTab.path)) {
    visibleTabs[Math.max(0, visibleTabs.length - 1)] = activeTab
  }
  visibleTabs.forEach(tab => visiblePaths.add(tab.path))
  const hiddenTabs = tabs.filter(tab => !visiblePaths.has(tab.path))
  const lineNumbers = content.split('\n').map((_, index) => index + 1)

  useEffect(() => {
    const persisted = loadPersistedState(workspaceId)
    if (!persisted || persisted.tabs.length === 0) {
      setTabs([])
      setActivePath(null)
      setTabBarCollapsed(false)
      setShowSaved(false)
      openPathsRef.current = new Set()
      return
    }

    const restoredTabs = persisted.tabs.map(createRestoredTab)
    const nextActive = restoredTabs.some(tab => tab.path === persisted.activePath)
      ? persisted.activePath
      : restoredTabs[0]?.path ?? null
    setTabs(restoredTabs)
    setActivePath(nextActive)
    setTabBarCollapsed(persisted.tabBarCollapsed)
    setShowSaved(false)
    openPathsRef.current = new Set(restoredTabs.map(tab => tab.path))
    restoredTabs.forEach(tab => loadFileIntoTab(tab.path, true))
  }, [workspaceId])

  useEffect(() => {
    openPathsRef.current = new Set(tabs.map(tab => tab.path))
  }, [tabs])

  useEffect(() => {
    if (!selectedFile) return

    if (openPathsRef.current.has(selectedFile)) {
      setActivePath(selectedFile)
      setShowSaved(false)
      setOverflowOpen(false)
      return
    }

    setTabs(prev => prev.some(tab => tab.path === selectedFile)
      ? prev
      : [...prev, createLoadingTab(selectedFile)]
    )
    setActivePath(selectedFile)
    setShowSaved(false)
    setOverflowOpen(false)
    loadFileIntoTab(selectedFile, false)
  }, [selectedFile])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      const persisted: PersistedEditorState = {
        version: 1,
        workspaceId,
        activePath,
        tabBarCollapsed,
        tabs: tabs.map(tab => {
          const dirty = !tab.loadError && !tab.loading && tab.content !== tab.savedContent
          const draftOk = dirty && tab.content.length <= 220_000
          return {
            path: tab.path,
            draftContent: draftOk ? tab.content : undefined,
            savedContent: draftOk ? tab.savedContent : undefined,
          }
        }),
      }
      try {
        localStorage.setItem(storageKey(workspaceId), JSON.stringify(persisted))
      } catch {
        localStorage.setItem(storageKey(workspaceId), JSON.stringify({
          ...persisted,
          tabs: persisted.tabs.map(tab => ({ path: tab.path })),
        }))
      }
    }, 250)
  }, [workspaceId, tabs, activePath, tabBarCollapsed])

  useEffect(() => {
    let cancelled = false
    window.api.settings
      .getMany(['editor_font_size', 'editor_tab_size', 'editor_word_wrap'])
      .then(values => {
        if (cancelled) return
        const size = parseInt(values.editor_font_size ?? '', 10)
        setFontSize(Number.isFinite(size) && size >= 8 && size <= 32 ? size : 13)
        const tab = parseInt(values.editor_tab_size ?? '', 10)
        setTabSize(Number.isFinite(tab) && tab >= 1 && tab <= 8 ? tab : 2)
        setWordWrap((values.editor_word_wrap ?? 'true') !== 'false')
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedFile])

  useEffect(() => {
    if (!isMarkdown) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setActiveTabPatch(tab => ({ ...tab, previewMode: !tab.previewMode }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMarkdown, activePath])

  useEffect(() => {
    const el = tabsWrapRef.current
    if (!el) return
    const update = () => setTabBarWidth(Math.round(el.getBoundingClientRect().width))
    update()
    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(el)
    return () => resizeObserver.disconnect()
  }, [])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const width = tabsWrapRef.current?.getBoundingClientRect().width ?? 0
      setTabBarWidth(Math.round(width))
    })
    return () => cancelAnimationFrame(frame)
  }, [tabs.length, openedFile, tabBarCollapsed])

  useEffect(() => {
    const readTheme = () => {
      setThemeMode(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
    }
    readTheme()
    const observer = new MutationObserver(readTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setOverflowOpen(false)
  }, [activePath, tabBarCollapsed])

  function loadFileIntoTab(path: string, preserveDraft: boolean) {
    window.api.fs.readFile(path).then(result => {
      if ('error' in result) {
        setTabs(prev => prev.map(tab => tab.path === path
          ? { ...tab, loadError: result.error, fileSize: 0, loading: false }
          : tab
        ))
      } else {
        setTabs(prev => prev.map(tab => {
          if (tab.path !== path) return tab
          const keepDraft = preserveDraft && tab.content !== '' && tab.content !== tab.savedContent
          return {
            ...tab,
            content: keepDraft ? tab.content : result.content,
            savedContent: result.content,
            loadError: null,
            saveError: null,
            fileSize: result.size,
            loading: false,
          }
        }))
      }
    })
  }

  function setActiveTabPatch(updater: (tab: EditorTab) => EditorTab) {
    if (!activePath) return
    setTabs(prev => prev.map(tab => tab.path === activePath ? updater(tab) : tab))
  }

  async function save() {
    if (!activeTab || !openedFile || loadError || activeTab.loading || saving) return
    setSaving(true)
    setActiveTabPatch(tab => ({ ...tab, saveError: null }))
    const result = await window.api.fs.writeFile(openedFile, content)
    setSaving(false)
    if ('error' in result) {
      setActiveTabPatch(tab => ({ ...tab, saveError: (result as { error: string }).error }))
    } else {
      setActiveTabPatch(tab => ({
        ...tab,
        savedContent: tab.content,
        fileSize: new TextEncoder().encode(tab.content).length,
        saveError: null,
      }))
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      setShowSaved(true)
      toastTimerRef.current = setTimeout(() => setShowSaved(false), 2000)
    }
  }

  function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab') {
      e.preventDefault()
      const el = e.currentTarget
      const start = el.selectionStart
      const end = el.selectionEnd
      const indent = ' '.repeat(tabSize)
      const newVal = content.slice(0, start) + indent + content.slice(end)
      setActiveTabPatch(tab => ({ ...tab, content: newVal, saveError: null }))
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = start + indent.length
          textareaRef.current.selectionEnd = start + indent.length
        }
      })
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      save()
    }
  }

  function handleTextareaScroll(e: React.UIEvent<HTMLTextAreaElement>) {
    const target = e.currentTarget
    if (gutterRef.current) gutterRef.current.scrollTop = target.scrollTop
    if (highlightRef.current) {
      highlightRef.current.scrollTop = target.scrollTop
      highlightRef.current.scrollLeft = target.scrollLeft
    }
  }

  function switchTab(path: string) {
    setActivePath(path)
    onActiveFileChange(path)
    setShowSaved(false)
    setOverflowOpen(false)
  }

  function closeTab(path: string) {
    const closingIndex = tabs.findIndex(tab => tab.path === path)
    const tab = tabs[closingIndex]
    if (!tab) return
    const dirty = !tab.loadError && !tab.loading && tab.content !== tab.savedContent
    if (dirty && !window.confirm('This file has unsaved changes. Close it anyway?')) return

    const nextTabs = tabs.filter(t => t.path !== path)
    setTabs(nextTabs)
    setOverflowOpen(false)
    if (activePath === path) {
      const fallback = nextTabs[Math.min(closingIndex, nextTabs.length - 1)] ?? nextTabs[closingIndex - 1] ?? null
      const nextPath = fallback?.path ?? null
      setActivePath(nextPath)
      onActiveFileChange(nextPath)
    }
  }

  function closeActiveTab() {
    if (activePath) closeTab(activePath)
  }

  function handleTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    if (tabs.length === 0) return
    e.preventDefault()
    const currentIndex = tabs.findIndex(tab => tab.path === visibleTabs[index]?.path)
    const safeIndex = currentIndex >= 0 ? currentIndex : index
    const nextIndex = e.key === 'ArrowLeft'
      ? (safeIndex - 1 + tabs.length) % tabs.length
      : (safeIndex + 1) % tabs.length
    switchTab(tabs[nextIndex].path)
  }

  function renderTab(tab: EditorTab, index: number) {
    const tabDirty = !tab.loadError && !tab.loading && tab.content !== tab.savedContent
    const tabActive = tab.path === activePath
    const name = basename(tab.path)
    return (
      <div
        key={tab.path}
        className={`editor-file-tab tone-${fileTone(tab.path)}${tabActive ? ' active' : ''}${tabDirty ? ' dirty' : ''}`}
        style={{ width: `${tabWidthForPath(tab.path)}px` }}
        data-testid="editor-file-tab"
        data-active={tabActive ? 'true' : 'false'}
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault()
            closeTab(tab.path)
          }
        }}
      >
        <button
          className="editor-file-tab-main"
          role="tab"
          aria-selected={tabActive}
          aria-controls="editor-content-region"
          title={tab.path}
          onClick={() => switchTab(tab.path)}
          onKeyDown={(e) => handleTabKeyDown(e, index)}
          data-testid={`editor-tab-${name}`}
                  >
                    {tabDirty && <span className="editor-tab-dirty-dot" aria-label="Unsaved changes" />}
                    <span className="editor-tab-name">{name}</span>
                    <span className="editor-tab-path">{shortPath(tab.path)}</span>
                  </button>
        <button
          className="editor-tab-close"
          onClick={() => closeTab(tab.path)}
          aria-label={`Close ${name}`}
          title={`Close ${name}`}
          data-testid={`editor-tab-close-${name}`}
        >
          x
        </button>
      </div>
    )
  }

  const lineCount = content ? content.split('\n').length : 0
  const charCount = content.length
  const fileSizeKb = (fileSize / 1024).toFixed(1)
  const fileName = openedFile ? basename(openedFile) : null

  if (!openedFile) {
    return (
      <div className="editor-panel">
        <div className="editor-empty" data-testid="editor-empty-state">
          <WorkspaceEmptyState
            icon={<EditIcon />}
            title="No file selected"
            body="Open Navigator and choose a file to inspect or edit it here."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="editor-panel">
      {tabBarCollapsed ? (
        <div className="editor-tabbar-collapsed" data-testid="editor-tabbar-collapsed">
          <button
            className="editor-tabbar-toggle"
            onClick={() => setTabBarCollapsed(false)}
            aria-label="Expand file tabs"
            title="Expand file tabs"
            data-testid="editor-tabbar-expand"
          >
            v
          </button>
          <button className="editor-collapsed-active" onClick={() => setTabBarCollapsed(false)} title="Expand file tabs">
            <span className="editor-collapsed-name">{fileName}</span>
            <span className="editor-collapsed-count">{tabs.length} open{dirtyCount > 0 ? `, ${dirtyCount} unsaved` : ''}</span>
          </button>
        </div>
      ) : (
        <div className="editor-tabbar" data-testid="editor-tabbar">
          <button
            className="editor-tabbar-toggle"
            onClick={() => setTabBarCollapsed(true)}
            aria-label="Collapse file tabs"
            title="Collapse file tabs"
            data-testid="editor-tabbar-collapse"
          >
            ^
          </button>
          <div className="editor-tabs" role="tablist" aria-label="Open files" data-testid="editor-tabs" ref={tabsWrapRef}>
            {visibleTabs.map(renderTab)}
          </div>
          {hiddenTabs.length > 0 && (
            <div className="editor-overflow-wrap">
              <button
                className="editor-overflow-btn"
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                onClick={() => setOverflowOpen(open => !open)}
                title="Show hidden file tabs"
                data-testid="editor-tabs-overflow"
              >
                More {hiddenTabs.length}
              </button>
              {overflowOpen && (
                <div className="editor-overflow-menu" role="menu" data-testid="editor-tabs-overflow-menu">
                  {hiddenTabs.map(tab => {
                    const dirty = !tab.loadError && !tab.loading && tab.content !== tab.savedContent
                    const name = basename(tab.path)
                    return (
                      <div key={tab.path} className={`editor-overflow-item tone-${fileTone(tab.path)}`}>
                        <button className="editor-overflow-open" role="menuitem" title={tab.path} onClick={() => switchTab(tab.path)}>
                          <span className="editor-overflow-file-dot" aria-hidden />
                          <span className="editor-overflow-name">{name}</span>
                          {dirty && <span className="editor-overflow-dirty">Unsaved</span>}
                        </button>
                        <button className="editor-overflow-close" onClick={() => closeTab(tab.path)} aria-label={`Close ${name}`}>
                          x
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="editor-header">
        <div className="editor-file-info">
          <span className={`editor-filename tone-${openedFile ? fileTone(openedFile) : 'plain'}`}>
            {isDirty && (
              <span className="editor-dirty-dot" aria-label="Unsaved changes" title="Unsaved changes" />
            )}
            <span className="editor-filetype-dot" aria-hidden />
            {fileName}
          </span>
          <span className="editor-filepath" title={openedFile}>{openedFile}</span>
        </div>
        <div className="editor-header-actions">
          {isMarkdown && !loadError && (
            <div className="instructions-mode-toggle" role="group" aria-label="Editor mode">
              <button
                className={`instructions-mode-btn${!previewMode ? ' active' : ''}`}
                onClick={() => setActiveTabPatch(tab => ({ ...tab, previewMode: false }))}
                title="Edit (Ctrl+Shift+P)"
              >
                Edit
              </button>
              <button
                className={`instructions-mode-btn${previewMode ? ' active' : ''}`}
                onClick={() => setActiveTabPatch(tab => ({ ...tab, previewMode: true }))}
                title="Preview (Ctrl+Shift+P)"
              >
                Preview
              </button>
            </div>
          )}
          <StatusBadge tone={isDirty ? 'warning' : 'success'}>{isDirty ? 'Unsaved' : 'Saved'}</StatusBadge>
          {!loadError && (
            <button
              className={`editor-save-btn ${isDirty ? 'primary' : 'ghost'}`}
              onClick={save}
              disabled={saving || !isDirty || activeTab?.loading}
              title="Save (Ctrl+S)"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          <button
            className="ghost tiny"
            onClick={closeActiveTab}
            title="Close file"
            aria-label="Close file"
          >
            x
          </button>
        </div>
      </div>

      <div className="editor-body" id="editor-content-region">
        {activeTab?.loading ? (
          <div className="editor-error">Loading file...</div>
        ) : loadError ? (
          <div className="editor-error">
            <WorkspaceNotice title="Cannot display this file" tone="warning">
              It may be binary, too large, or outside the readable workspace.
            </WorkspaceNotice>
          </div>
        ) : isMarkdown && previewMode ? (
          <div className="editor-md-preview" style={{ fontSize: `${fontSize + 1}px` }}>
            <Markdown>{content}</Markdown>
          </div>
        ) : (
          <div className="editor-code-surface" data-testid="editor-code-surface">
            <div
              className="editor-line-gutter"
              ref={gutterRef}
              aria-hidden
              style={{ fontSize: `${fontSize}px` }}
              data-testid="editor-line-gutter"
            >
              {lineNumbers.map(line => <span key={line}>{line}</span>)}
            </div>
            <div className={`editor-code-stack${syntaxEnabled ? ' syntax-on' : ''}`}>
              {syntaxEnabled && (
                <div
                  className="editor-highlight-layer"
                  ref={highlightRef}
                  aria-hidden
                  style={{ fontSize: `${fontSize}px`, tabSize }}
                  data-testid="editor-highlight-layer"
                >
                  <SyntaxHighlighter
                    language={syntaxLanguage}
                    style={themeMode === 'dark' ? oneDark : oneLight}
                    PreTag="div"
                    customStyle={{
                      margin: 0,
                      padding: '12px 14px',
                      background: 'transparent',
                      fontSize: `${fontSize}px`,
                      lineHeight: 1.6,
                      minHeight: '100%',
                      overflow: 'visible',
                      whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
                      wordBreak: wordWrap ? 'break-word' : 'normal',
                    }}
                    codeTagProps={{
                      style: {
                        fontFamily: 'var(--font-mono)',
                        fontSize: `${fontSize}px`,
                        lineHeight: 1.6,
                        whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
                      },
                    }}
                  >
                    {content || ' '}
                  </SyntaxHighlighter>
                </div>
              )}
              <textarea
                ref={textareaRef}
                className={`editor-textarea${syntaxEnabled ? ' syntax-on has-highlight-fallback' : ''}`}
                value={content}
                onChange={e => setActiveTabPatch(tab => ({ ...tab, content: e.target.value, saveError: null }))}
                onKeyDown={handleTextareaKeyDown}
                onScroll={handleTextareaScroll}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                wrap={wordWrap ? 'soft' : 'off'}
                style={{ fontSize: `${fontSize}px`, tabSize }}
                data-testid="editor-textarea"
              />
            </div>
          </div>
        )}
        {showSaved && <div className="editor-saved-toast">Saved</div>}
      </div>

      <div className="editor-footer">
        {saveError ? (
          <span className="editor-save-error">{saveError}</span>
        ) : (
          <>
            <span>{lineCount} lines</span>
            <span>{charCount} chars</span>
            <span>{fileSizeKb} KB</span>
            <span>{syntaxLanguage ? syntaxLanguage.toUpperCase() : 'TEXT'}</span>
            <span>UTF-8</span>
          </>
        )}
      </div>
    </div>
  )
}
