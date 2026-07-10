import type { ComposerAttachment, FileAttachment } from '../types'

// Electron sets a real filesystem `.path` on File objects that come from an OS drag,
// but the DOM lib's File type doesn't declare it.
export function electronFilePath(file: File): string | undefined {
  return (file as unknown as { path?: string }).path
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

// Builds a ComposerAttachment from a clipboard image item (e.g. Ctrl+V of a
// screenshot). Returns null if the item has no readable file data.
export async function attachmentFromImageClipboardItem(item: DataTransferItem): Promise<ComposerAttachment | null> {
  const blob = item.getAsFile()
  if (!blob) return null
  const buffer = await blob.arrayBuffer()
  return {
    id: crypto.randomUUID(),
    file: {
      type: 'image',
      name: `pasted-image-${Date.now()}.png`,
      size: buffer.byteLength,
      mimeType: item.type,
      base64: arrayBufferToBase64(buffer),
      ext: '.png'
    }
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileIcon(file: FileAttachment): string {
  if (file.type === 'image') return '🖼'
  const ext = file.ext.toLowerCase()
  const codeExts = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.cpp', '.c', '.h', '.cs', '.rb', '.php', '.swift', '.kt']
  const dataExts = ['.json', '.csv', '.xml', '.yaml', '.yml', '.toml']
  const docExts = ['.txt', '.md', '.pdf']
  if (codeExts.includes(ext)) return '📝'
  if (dataExts.includes(ext)) return '📊'
  if (docExts.includes(ext)) return '📄'
  return '📎'
}

export function modelSupportsVision(model: string): boolean {
  const visionModels = [
    // OpenAI / Codex models with vision
    'gpt-5.5', 'gpt-5', 'gpt-4o', 'gpt-4-turbo', 'gpt-4-vision',
    'o3', 'o4-mini', 'o3-mini',
    // Claude Code models can inspect image paths with their file-reading tools.
    'claude', 'sonnet', 'opus', 'haiku',
    // Ollama multimodal models
    'llava', 'llava-llama3', 'bakllava', 'moondream',
    'gemma4', 'gemma3', 'llama3.2-vision', 'minicpm-v',
    'qwen2-vl', 'qwen-vl', 'cogvlm', 'internvl',
  ]
  const lowerModel = model.toLowerCase()
  return visionModels.some(vm => lowerModel.includes(vm))
}

interface AttachmentChipsProps {
  attachments: ComposerAttachment[]
  models: string[]
  activeModel?: string
  onRemove(id: string): void
  onVisionModelChange(id: string, model: string): void
}

export function AttachmentChips({ attachments, models, activeModel, onRemove, onVisionModelChange }: AttachmentChipsProps) {
  if (attachments.length === 0) return null
  const nativeVision = Boolean(activeModel && modelSupportsVision(activeModel))
  return (
    <div className="composer-attachments">
      {attachments.map(a => {
        const isPaste = a.file.name === 'Pasted text'
        const sizeLabel = isPaste
          ? `${a.file.size.toLocaleString()} chars`
          : formatFileSize(a.file.size)
        return (
          <div key={a.id} className="attachment-chip">
            <span className="attachment-chip-icon">{fileIcon(a.file)}</span>
            <span className="attachment-chip-name" title={a.file.name}>{a.file.name}</span>
            <span className="attachment-chip-size">· {sizeLabel}</span>
            {a.file.type === 'image' && (
              nativeVision && !a.visionModel ? (
                <span className="attachment-vision-native" title="Main model handles vision natively">👁 Native</span>
              ) : (
                <div className="attachment-vision-picker">
                  <span>👁</span>
                  <select
                    value={a.visionModel ?? ''}
                    onChange={e => onVisionModelChange(a.id, e.target.value)}
                    title="Vision model for image analysis"
                  >
                    <option value="">Select vision model</option>
                    {models.filter(m => !m.includes('embed')).map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              )
            )}
            <button
              className="attachment-chip-remove"
              onClick={() => onRemove(a.id)}
              title="Remove attachment"
              aria-label={`Remove ${a.file.name}`}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}

export interface NativeImage {
  base64: string
  filePath?: string
}

// Resolves attachments to a text prefix. Returns { content } on success or { content, error } on validation failure.
// For image attachments, calls the vision model synchronously before sending, unless the active model
// supports vision natively — in that case images are returned in nativeImages for direct model delivery.
export async function resolveAttachments(
  attachments: ComposerAttachment[],
  opts?: { activeModel?: string; imageMode?: 'native' | 'file-path' }
): Promise<{ content: string; nativeImages?: NativeImage[]; error?: string }> {
  if (attachments.length === 0) return { content: '' }
  const parts: string[] = []
  const nativeImages: NativeImage[] = []
  const nativeVision = Boolean(opts?.activeModel && modelSupportsVision(opts.activeModel))

  for (const attachment of attachments) {
    const { file } = attachment
    if (file.type === 'image') {
      if (opts?.imageMode === 'file-path') {
        if (!file.filePath) return { content: '', error: `Image "${file.name}" does not have a readable file path.` }
        parts.push(`[Image file: ${file.filePath}]`)
        continue
      }
      if (!attachment.visionModel) {
        if (nativeVision) {
          // Main model handles vision — queue image for direct delivery, skip pre-analysis.
          nativeImages.push({ base64: file.base64 ?? '', filePath: file.filePath })
          continue
        }
        return { content: '', error: `Select a vision model for "${file.name}" before sending.` }
      }
      const prompt = 'Describe this image in detail. Include all text, UI elements, code, diagrams, or other content visible.'
      const description = await window.api.ollama.analyzeImage(
        attachment.visionModel,
        file.base64 ?? '',
        file.mimeType ?? 'image/jpeg',
        prompt
      )
      parts.push(`=== Image analysis of ${file.name} ===\n${description ?? '(no description)'}\n===`)
    } else if (file.type === 'text') {
      parts.push(`=== ${file.name} ===\n${file.content ?? ''}\n===`)
    } else {
      const preview = (file.base64 ?? '').slice(0, 500)
      const truncated = (file.base64?.length ?? 0) > 500 ? '\n...[truncated]' : ''
      parts.push(`=== ${file.name} (binary file, base64 encoded) ===\n${preview}${truncated}\n===`)
    }
  }

  const content = parts.length > 0 ? parts.join('\n\n') + '\n\n' : ''
  return nativeImages.length > 0 ? { content, nativeImages } : { content }
}
