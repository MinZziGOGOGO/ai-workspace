import { useEffect, useState } from 'react'
import type { BrowserPreviewDetectionResult, HermesActivity, Project } from '../types'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'

const WEB_FILE_PATTERN = /(?:^|[\\/])(?:package\.json|vite\.config\.[^\\/]+|next\.config\.[^\\/]+|astro\.config\.[^\\/]+|svelte\.config\.[^\\/]+)$|\.(?:html?|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|vue|svelte|astro)$/i

export function isWebRelevantFile(path: string): boolean {
  return WEB_FILE_PATTERN.test(path.trim())
}

export function notifyPreviewFileChanged(projectId: string, path: string): void {
  if (!isWebRelevantFile(path)) return
  window.dispatchEvent(new CustomEvent('preview:webFilesChanged', { detail: { projectId, path } }))
}

function collectPathFields(value: unknown, depth = 0): string[] {
  if (!value || depth > 4) return []
  if (Array.isArray(value)) return value.flatMap((entry) => collectPathFields(entry, depth + 1))
  if (typeof value !== 'object') return []
  const paths: string[] = []
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && /^(?:path|file|filePath|filename|target)$/i.test(key)) paths.push(entry)
    else if (typeof entry === 'object') paths.push(...collectPathFields(entry, depth + 1))
  }
  return paths
}

export function notifyPreviewFromHermesActivity(projectId: string, activity: HermesActivity): void {
  if (activity.status !== 'done' || !/(?:write|edit|patch|create|replace|update)/i.test(activity.toolName ?? activity.message)) return
  const paths = [...collectPathFields(activity.args), ...collectPathFields(activity.details)]
  for (const path of new Set(paths)) notifyPreviewFileChanged(projectId, path)
}

export default function LivePreviewAffordance({ project, agent, active = true }: { project: Project; agent: 'codex' | 'claudecode' | 'hermes'; active?: boolean }) {
  const [detection, setDetection] = useState<BrowserPreviewDetectionResult | null>(null)

  useEffect(() => {
    if (!active || isGlobalProjectId(project.id) || !project.path) {
      setDetection(null)
      return
    }
    let disposed = false
    void window.api.browser.detectPreview(project.id).then((result) => {
      if (!disposed) setDetection(result)
    }).catch(() => {
      if (!disposed) setDetection(null)
    })
    return () => { disposed = true }
  }, [active, project.id, project.path])

  const previewable = Boolean(detection && (detection.urls.length > 0 || detection.suggestions.length > 0 || detection.signals.length > 0))
  if (!previewable) return null

  return (
    <button
      type="button"
      className="live-preview-affordance"
      data-testid={`open-live-preview-${agent}`}
      onClick={() => window.dispatchEvent(new CustomEvent('workspace:openLivePreview', {
        detail: { projectId: project.id, url: detection?.urls[0] }
      }))}
      title={detection?.urls[0]
        ? `Open ${detection.urls[0]} in AI Workspace Browser Preview; agents must not use the system browser`
        : 'Open AI Workspace Browser Preview and detect the project development server; agents must not use the system browser'}
    >
      <span className="live-preview-dot" aria-hidden />
      Open live preview
    </button>
  )
}
