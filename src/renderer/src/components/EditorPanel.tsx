import { useState, useEffect, useRef } from 'react'
import { StatusBadge, WorkspaceEmptyState, WorkspaceNotice } from './WorkspacePrimitives'
import Markdown from './Markdown'

function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? filePath
}

function EditIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 2l3 3-8 8H3v-3l8-8z" />
    </svg>
  )
}

export default function EditorPanel({
  selectedFile,
  onCloseFile
}: {
  selectedFile: string | null
  onCloseFile: () => void
}) {
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fileSize, setFileSize] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showSaved, setShowSaved] = useState(false)
  const [openedFile, setOpenedFile] = useState<string | null>(null)
  const [previewMode, setPreviewMode] = useState(false)
  // Stored editor preferences (Settings → Editor & Terminal). Values live in
  // app_meta as strings, so parse defensively and fall back to the defaults.
  const [fontSize, setFontSize] = useState(13)
  const [tabSize, setTabSize] = useState(2)
  const [wordWrap, setWordWrap] = useState(true)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isMarkdown = !!openedFile && /\.(md|markdown)$/i.test(openedFile)
  const isDirty = !loadError && content !== savedContent
  // Render-time ref so the file-switch effect can check dirtiness of the
  // file that is *currently* open, before state is reset for the new one.
  const dirtyGuardRef = useRef({ isDirty: false, openedFile: null as string | null })
  dirtyGuardRef.current = { isDirty, openedFile }

  useEffect(() => {
    const guard = dirtyGuardRef.current
    if (guard.openedFile && guard.openedFile !== selectedFile && guard.isDirty) {
      const confirmed = window.confirm('You have unsaved changes. Discard them?')
      if (!confirmed) return // keep the current file open, don't switch
    }
    if (!selectedFile) {
      setOpenedFile(null)
      setContent('')
      setSavedContent('')
      setLoadError(null)
      setSaveError(null)
      setShowSaved(false)
      setPreviewMode(false)
      return
    }

    setOpenedFile(selectedFile)
    setContent('')
    setSavedContent('')
    setLoadError(null)
    setSaveError(null)
    setShowSaved(false)
    setPreviewMode(false)

    window.api.fs.readFile(selectedFile).then(result => {
      if ('error' in result) {
        setLoadError(result.error)
        setFileSize(0)
      } else {
        setContent(result.content)
        setSavedContent(result.content)
        setFileSize(result.size)
      }
    })
  }, [selectedFile])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  // Re-read stored editor preferences whenever a file is opened, so changes
  // made in Settings take effect the next time the Editor is used.
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

  // Ctrl+Shift+P toggles markdown preview while a markdown file is open.
  useEffect(() => {
    if (!isMarkdown) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPreviewMode(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMarkdown])

  async function save() {
    if (!openedFile || loadError || saving) return
    setSaving(true)
    setSaveError(null)
    const result = await window.api.fs.writeFile(openedFile, content)
    setSaving(false)
    if ('error' in result) {
      setSaveError((result as { error: string }).error)
    } else {
      setSavedContent(content)
      setFileSize(new TextEncoder().encode(content).length)
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
      setContent(newVal)
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

  const lineCount = content ? content.split('\n').length : 0
  const charCount = content.length
  const fileSizeKb = (fileSize / 1024).toFixed(1)
  const fileName = openedFile ? basename(openedFile) : null

  if (!openedFile) {
    return (
      <div className="editor-empty" data-testid="editor-empty-state">
        <WorkspaceEmptyState
          icon={<EditIcon />}
          title="No file selected"
          body="Open Navigator and choose a file to inspect or edit it here."
        />
      </div>
    )
  }

  return (
    <div className="editor-panel">
      <div className="editor-header">
        <div className="editor-file-info">
          <span className="editor-filename">
            {isDirty && (
              <span className="editor-dirty-dot" aria-label="Unsaved changes" title="Unsaved changes" />
            )}
            {fileName}
          </span>
          <span className="editor-filepath" title={openedFile}>{openedFile}</span>
        </div>
        <div className="editor-header-actions">
          {isMarkdown && !loadError && (
            <div className="instructions-mode-toggle" role="group" aria-label="Editor mode">
              <button
                className={`instructions-mode-btn${!previewMode ? ' active' : ''}`}
                onClick={() => setPreviewMode(false)}
                title="Edit (Ctrl+Shift+P)"
              >
                Edit
              </button>
              <button
                className={`instructions-mode-btn${previewMode ? ' active' : ''}`}
                onClick={() => setPreviewMode(true)}
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
              disabled={saving || !isDirty}
              title="Save (Ctrl+S)"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          <button
            className="ghost tiny"
            onClick={onCloseFile}
            title="Close file"
            aria-label="Close file"
          >
            ×
          </button>
        </div>
      </div>

      <div className="editor-body">
        {loadError ? (
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
          <textarea
            ref={textareaRef}
            className="editor-textarea"
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            wrap={wordWrap ? 'soft' : 'off'}
            style={{ fontSize: `${fontSize}px`, tabSize }}
          />
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
            <span>UTF-8</span>
          </>
        )}
      </div>
    </div>
  )
}
