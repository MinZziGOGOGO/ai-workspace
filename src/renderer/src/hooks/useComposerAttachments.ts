import { useState } from 'react'
import type { ComposerAttachment } from '../types'
import { attachmentFromImageClipboardItem, electronFilePath } from '../components/ComposerAttachments'
import { useToast } from '../components/ToastContext'

export function useComposerAttachments() {
  const { addToast } = useToast()
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const att = await attachmentFromImageClipboardItem(item)
        if (att) setAttachments(prev => [...prev, att])
        return
      }
    }
    const text = e.clipboardData.getData('text/plain')
    if (text.length > 1500) {
      e.preventDefault()
      const att: ComposerAttachment = {
        id: crypto.randomUUID(),
        file: { type: 'text', name: 'Pasted text', size: text.length, content: text, ext: '.txt' }
      }
      setAttachments(prev => [...prev, att])
    }
  }

  async function pickFile() {
    try {
      const path = await window.api.files.pick()
      if (!path) return
      const file = await window.api.files.read(path)
      const att: ComposerAttachment = { id: crypto.randomUUID(), file }
      setAttachments(prev => [...prev, att])
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to read file')
    }
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragOver(false)
    for (const file of Array.from(e.dataTransfer.files)) {
      const path = electronFilePath(file)
      if (!path) continue
      try {
        const fileAttachment = await window.api.files.read(path)
        setAttachments(prev => [...prev, { id: crypto.randomUUID(), file: fileAttachment }])
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'Failed to read file')
      }
    }
  }

  return {
    attachments,
    setAttachments,
    isDragOver,
    setIsDragOver,
    handlePaste,
    pickFile,
    handleDrop,
  }
}
