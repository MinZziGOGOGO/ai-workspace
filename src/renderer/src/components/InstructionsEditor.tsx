import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown'

interface InstructionsEditorProps {
  agentId: string
  agentLabel: string
  projectPath: string | null
  onClose: () => void
}

const TEMPLATES: Record<string, string> = {
  claudecode: '# Project Instructions for Claude Code\n\n## Project Overview\n[Describe your project here]\n\n## Tech Stack\n[List your technologies]\n\n## Coding Guidelines\n- [Your preferences]\n\n## Important Constraints\n- [Things Claude should never do]\n\n## Current Focus\n[What you\'re working on right now]\n',
  hermes: '# Hermes Agent Instructions\n\n## Role\n[Describe what Hermes should focus on]\n\n## Allowed Actions\n- [What Hermes can do autonomously]\n\n## Constraints\n- [What Hermes should never do without asking]\n\n## Project Context\n[Key things Hermes should know]\n',
  codex: '# Codex Instructions\n\n## Project Overview\n[Describe your project]\n\n## Coding Style\n[Your preferences]\n\n## Key Files\n[Important files Codex should know about]\n\n## Current Task\n[What you want Codex to work on]\n',
  shared: '# Shared AI Instructions\n\n## Project Overview\n[Used by all AI agents]\n\n## Tech Stack\n[Technologies used]\n\n## Architecture\n[Key architectural decisions]\n\n## Important Notes\n[Anything all agents should know]\n',
  app: '# Project Instructions for Claude Code\n\n## Project Overview\n[Describe your project here]\n\n## Tech Stack\n[List your technologies]\n\n## Coding Guidelines\n- [Your preferences]\n\n## Important Constraints\n- [Things Claude should never do]\n\n## Current Focus\n[What you\'re working on right now]\n',
}

export default function InstructionsEditor({ agentId, agentLabel, projectPath, onClose }: InstructionsEditorProps) {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [fileExists, setFileExists] = useState(false)
  const [saved, setSaved] = useState(false)
  const [dirtyWarning, setDirtyWarning] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    async function load() {
      const fp = await window.api.instructions.getPath(agentId, projectPath ?? '')
      if (!fp) return
      setFilePath(fp)
      const result = await window.api.instructions.read(fp)
      if (result.exists) {
        setContent(result.content)
        setSavedContent(result.content)
        setFileExists(true)
      } else {
        const template = TEMPLATES[agentId] ?? ''
        setContent(template)
        setSavedContent('')
        setFileExists(false)
      }
    }
    void load()
  }, [agentId, projectPath])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [filePath])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void save()
      }
      if (e.key === 'p' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setMode(m => {
          const next = m === 'edit' ? 'preview' : 'edit'
          if (next === 'edit') {
            requestAnimationFrame(() => textareaRef.current?.focus())
          }
          return next
        })
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  })

  const isDirty = content !== savedContent

  async function save() {
    if (!filePath) return
    const result = await window.api.instructions.write(filePath, content)
    if (result.success) {
      setSavedContent(content)
      setFileExists(true)
      setDirtyWarning(false)
      setSaved(true)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000)
    }
  }

  function handleClose() {
    if (isDirty) {
      setDirtyWarning(true)
    } else {
      onClose()
    }
  }

  function discard() {
    onClose()
  }

  const fileName = filePath ? filePath.split(/[/\\]/).pop() ?? filePath : '…'
  const charCount = content.length
  const lineCount = content.split('\n').length

  return (
    <div className="instructions-overlay">
      <div className="instructions-header">
        <span className="instructions-filename">📋 {fileName}</span>
        <span style={{ flex: 1, textAlign: 'center', fontSize: '12px', color: 'var(--text-2)' }}>
          {agentLabel} Instructions
        </span>
        <div className="instructions-mode-toggle">
          <button
            className={`instructions-mode-btn${mode === 'edit' ? ' active' : ''}`}
            onClick={() => {
              setMode('edit')
              requestAnimationFrame(() => textareaRef.current?.focus())
            }}
          >Edit</button>
          <button
            className={`instructions-mode-btn${mode === 'preview' ? ' active' : ''}`}
            onClick={() => setMode('preview')}
          >Preview</button>
        </div>
        {dirtyWarning ? (
          <span style={{ fontSize: '12px', color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            Unsaved changes —
            <button className={`instructions-save-btn`} onClick={() => void save()}>Save</button>
            <button className={`instructions-save-btn`} onClick={discard}>Discard</button>
          </span>
        ) : (
          <button
            className={`instructions-save-btn${saved ? ' saved' : ''}`}
            onClick={() => void save()}
          >
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        )}
        <button
          style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: '16px', padding: '0 4px', lineHeight: 1 }}
          onClick={handleClose}
          title="Close"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className={`instructions-filepath${!fileExists ? ' new-file' : ''}`}>
        {filePath
          ? (!fileExists ? `${filePath} — File will be created on save` : filePath)
          : 'Loading…'}
      </div>

      {mode === 'edit' ? (
        <textarea
          ref={textareaRef}
          className="instructions-textarea"
          value={content}
          onChange={e => { setContent(e.target.value); setDirtyWarning(false) }}
          onKeyDown={e => {
            if (e.key === 'Tab') {
              e.preventDefault()
              const el = e.currentTarget
              const start = el.selectionStart
              const end = el.selectionEnd
              const next = content.slice(0, start) + '  ' + content.slice(end)
              setContent(next)
              requestAnimationFrame(() => {
                el.selectionStart = start + 2
                el.selectionEnd = start + 2
              })
            }
          }}
          spellCheck={false}
        />
      ) : (
        <div className="instructions-preview">
          <Markdown>{content}</Markdown>
        </div>
      )}

      <div className="instructions-footer">
        <span>{charCount} chars · {lineCount} lines</span>
        <span>Ctrl+S to save · Ctrl+P to preview</span>
      </div>
    </div>
  )
}
