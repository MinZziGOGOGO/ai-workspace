import { useState, useEffect, useRef } from 'react'
import { StatusBadge, WorkspaceEmptyState, WorkspaceNotice } from './WorkspacePrimitives'

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
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isDirty = !loadError && content !== savedContent

  useEffect(() => {
    if (!selectedFile) {
      setOpenedFile(null)
      setContent('')
      setSavedContent('')
      setLoadError(null)
      setSaveError(null)
      setShowSaved(false)
      return
    }

    setOpenedFile(selectedFile)
    setContent('')
    setSavedContent('')
    setLoadError(null)
    setSaveError(null)
    setShowSaved(false)

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
      const newVal = content.slice(0, start) + '  ' + content.slice(end)
      setContent(newVal)
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = start + 2
          textareaRef.current.selectionEnd = start + 2
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
            wrap="off"
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
