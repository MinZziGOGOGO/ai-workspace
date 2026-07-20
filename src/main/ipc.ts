import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron'
import { showNotification } from './notifications'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { join, extname, basename, dirname, resolve, relative, isAbsolute } from 'path'

const execFileAsync = promisify(execFile)
import type { IPty } from 'node-pty'
import { getDb, getDbPath } from './db'
import * as projects from './projects'
import * as knowledge from './knowledge'
import { startWatcher } from './indexer'
import { extractFromSession, consolidateMemories } from './extractor'
import { listModels, streamChatParts, streamCloudChatParts, cloudChat, chat, defaultChatModel, ollamaStatus, analyzeImage, ChatMessage } from './ollama'
import {
  checkClaudeCode,
  runClaudeCode,
  summarizeRun,
  tryCreateCheckpoint,
  gitResetHard
} from './claudecode'
import { probeLocalSpeed } from './inferenceSpeed'
import { checkCodex, runCodex, summarizeCodexRun } from './codex'
import { listClaudeCodeModels, listCodexModels, listKimiModels } from './agentModels'
import { buildKimiPtyCommand, checkKimi, fakeKimiSessionLines, resolveKimiBin } from './kimi'
import {
  checkKimiAuth,
  connectKimi,
  disconnectKimi,
  getKimiAuthMethod,
  getKimiPermissionMode,
  getKimiPlanMode,
  setKimiPlanMode,
  kimiConnected,
  respondKimiPermission,
  runKimiLogin,
  runKimiPrompt,
  setKimiApiKey,
  setKimiAuthMethod,
  setKimiPermissionMode,
  summarizeKimiRun,
  bumpKimiSessionOverride,
  type KimiActivity,
  type KimiEvent,
  type KimiPermissionMode
} from './kimi'
import {
  checkMcpServer,
  getActiveMcpServers,
  getClaudeConfigPath,
  getEnabledState,
  knowledgeMcpLaunchConfig,
  browserMcpLaunchConfig,
  readMcpServers,
  setEnabledState,
  writeMcpServers
} from './mcp'
import { browserControlPort, browserControlIdentityToken } from './browserControlServer'
import {
  allowedFsRoots,
  attachmentRoots,
  grantPickedFile,
  isPickedFileGranted,
  resolveWithinRoots
} from './pathScope'
import {
  checkHermes,
  connectHermes,
  disconnectHermes,
  hermesConnected,
  runHermesPrompt,
  summarizeHermesRun,
  getHermesConfig,
  testHermesConnection,
  getHermesPermissionMode,
  setHermesPermissionMode,
  respondHermesPermission,
  bumpHermesSessionOverride
} from './hermes'
import { installSkillFromHub, listSkills, searchSkillsHub, toggleSkill } from './hermesSkills'
import { getTodayUsage, recordUsage } from './usage'
import { GLOBAL_PROJECT_ID, isGlobalProjectId } from '../shared/globalWorkspace'
import { APP_FONT_VALUES } from '../shared/appFonts'
import { fallbackTitleFromText, isGenericSessionTitle } from '../shared/sessionTitles'
import {
  configureWebCompanion,
  getWebCompanionStatus,
  regenerateWebCompanionToken,
  type WebCompanionConfig
} from './webCompanion'
import { detectCliTools, markSetupWizardComplete, setupWizardComplete } from './setup'
import {
  createBrowserTab,
  closeBrowserTab,
  setActiveTab as setActiveBrowserTab,
  navigateTab as navigateBrowserTab,
  navigatePreviewTab,
  setPreviewMode as setBrowserPreviewMode,
  goBack as browserGoBack,
  goForward as browserGoForward,
  reloadTab as reloadBrowserTab,
  stopTab as stopBrowserTab,
  setBrowserViewBounds,
  hideAllBrowserViews,
  parkAllForDrag,
  restoreAfterDrag,
  listBrowserTabs,
  inspectPreviewTab,
  agentGetDownloads,
  reloadBrowserSessions
} from './browserPanel'
import { detectProjectPreview } from './browserPreview'
import { browserApprovals } from './browserApproval'
import {
  navigatePreviewUrl,
  reloadPreview,
  stopPreview,
  setPreviewBounds,
  hidePreviewView,
  parkPreviewForDrag,
  restorePreviewAfterDrag,
  getPreviewState,
  getLastDetectedDevServerUrl,
  noteTerminalOutput,
} from './previewPanel'
import type {
  BrowserBounds,
  BrowserTabListResponse,
  BrowserDownloadStatus,
  BrowserPreviewDetectionResult,
  BrowserPreviewInspection,
  PreviewPanelState,
  BrowserApprovalDecision,
  BrowserApprovalRequest,
  BrowserApprovalResult,
  ChatClassifyHandoffRequest,
  ActivityEntry,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatGenerateHandoffPromptRequest,
  ChatModelMessage,
  ChatSendRequest,
  ChatTokenEvent,
  ChatUsageEvent,
  Checkpoint,
  CheckpointEvent,
  CheckpointResult,
  AgentModelInfo,
  ClaudeCodeCheck,
  ClaudeCodeDoneEvent,
  ClaudeCodeIpcEvent,
  ClaudeCodeSendRequest,
  CodexCheck,
  CodexDoneEvent,
  CodexIpcEvent,
  CodexSandboxMode,
  CodexSendRequest,
  DeleteAfterResponse,
  DockPanel,
  FileAttachment,
  FileCopyResponse,
  FsEntry,
  FsReadFileResponse,
  FsWriteFileResponse,
  GitStatusResponse,
  HermesActivity,
  HermesDoneEvent,
  HermesCheck,
  HermesEvent,
  HermesIpcEvent,
  HermesPermissionMode,
  HermesRespondPermissionRequest,
  HermesSendRequest,
  HermesUsageEvent,
  KimiAuthMethod,
  KimiAuthStatus,
  KimiCheck,
  KimiDoneEvent,
  KimiIpcEvent,
  KimiLoginEvent,
  KimiRespondPermissionRequest,
  KimiSendRequest,
  KimiUsageEvent,
  HandoffClassification,
  HermesSkillsInstallResponse,
  HermesSkillsListResponse,
  HermesSkillsSearchResponse,
  HermesSkillsToggleResponse,
  IndexUpdatedEvent,
  InstructionsReadResponse,
  InstructionsWriteResponse,
  LayoutNode,
  LayoutPreset,
  McpCheckResult,
  McpServer,
  McpServerConfig,
  MemoryItem,
  MemorySaveRequest,
  MemorySavedEvent,
  CloudModelsResponse,
  LocalSpeedProbe,
  Message,
  MutationResponse,
  OllamaStatus,
  Project,
  RegistrySearchResponse,
  RemoteHermesConfig,
  RemovedCount,
  ResearchProgress,
  ResearchStartRequest,
  Session,
  SettingsDiagnostics,
  SettingsImportResponse,
  SettingsSummary,
  TerminalCreateResponse,
  TerminalDataEvent,
  TerminalExitEvent,
  TipStats,
  ToolDetection,
  UsageSummaryRow,
  WebCompanionConfigureRequest,
  WebCompanionRegenerateResponse,
  WebCompanionStatus
} from '../shared/ipcTypes'

// ---- PTY lifecycle (Phase F) ----
interface PtyEntry { pty: IPty; win: BrowserWindow | null }
const ptyMap = new Map<string, PtyEntry>()
const fakeKimiSessions = new Set<string>()
const FS_IGNORE = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'workspace.db', '.aiworkspace.json'])
const CHAT_FILE_READ_LIMIT = 200 * 1024
const CHAT_FILE_WRITE_LIMIT = 500 * 1024
const BUILT_IN_PREVIEW_AGENT_INSTRUCTION =
  "AI Workspace browser instruction: Use AI Workspace's built-in Browser Preview for localhost, 127.0.0.1, and [::1] preview URLs. Use the ai-workspace-browser MCP tools; do not open the system browser. If built-in preview navigation fails, report: 'Could not open built-in Browser Preview. Use the Browser panel manually or check Browser control tools.' External browsing requires the human to click Open externally in the Browser panel."
const CHAT_FILE_TOOL_HINT =
  /\b(read|open|inspect|look at|check|scan|find|search|file|folder|directory|code|repo|project|workspace|write|edit|update|change|create|fix|modify|save|replace|implement|add|remove|delete|refactor|tsx?|jsx?|css|json|md|src[\\/]|package\.json)\b/i

type ChatFileToolMode = 'read' | 'write'
type ChatFileToolName = 'none' | 'list_dir' | 'read_file' | 'write_file'

interface ChatFileToolRequest {
  tool: ChatFileToolName
  path?: string
  content?: string
  reason?: string
}

interface ChatFileToolResult {
  ok: boolean
  tool: Exclude<ChatFileToolName, 'none'>
  path: string
  content?: string
  entries?: { name: string; type: 'file' | 'dir'; path: string }[]
  size?: number
  error?: string
}

function isBinaryBuffer(buf: Buffer): boolean {
  const checkLen = Math.min(512, buf.length)
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export function normalizeWorkspacePath(projectPath: string, inputPath: string): { target: string; rel: string } | { error: string } {
  if (!projectPath) return { error: 'File tools need a folder-backed project.' }
  const root = resolve(projectPath)
  const target = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { error: 'Path must stay inside the current project.' }
  return { target, rel: rel.replace(/\\/g, '/') }
}

function listWorkspaceDir(projectPath: string, inputPath: string): ChatFileToolResult {
  const normalized = normalizeWorkspacePath(projectPath, inputPath || '.')
  if ('error' in normalized) return { ok: false, tool: 'list_dir', path: inputPath || '.', error: normalized.error }
  try {
    const entries = readdirSync(normalized.target, { withFileTypes: true })
      .filter((entry) => !FS_IGNORE.has(entry.name) && !entry.name.endsWith('.map'))
      .slice(0, 200)
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' as const : 'file' as const,
        path: `${normalized.rel}/${entry.name}`.replace(/^\.\//, '')
      }))
    return { ok: true, tool: 'list_dir', path: normalized.rel, entries }
  } catch (err: unknown) {
    return { ok: false, tool: 'list_dir', path: normalized.rel, error: errorMessage(err) }
  }
}

function readWorkspaceFile(projectPath: string, inputPath: string): ChatFileToolResult {
  const normalized = normalizeWorkspacePath(projectPath, inputPath)
  if ('error' in normalized) return { ok: false, tool: 'read_file', path: inputPath, error: normalized.error }
  try {
    const stat = statSync(normalized.target)
    if (!stat.isFile()) return { ok: false, tool: 'read_file', path: normalized.rel, error: 'Path is not a file.' }
    if (stat.size > CHAT_FILE_READ_LIMIT) return { ok: false, tool: 'read_file', path: normalized.rel, error: 'File is too large to read in chat.' }
    const buf = readFileSync(normalized.target)
    if (isBinaryBuffer(buf)) return { ok: false, tool: 'read_file', path: normalized.rel, error: 'Binary files are not readable in chat.' }
    return { ok: true, tool: 'read_file', path: normalized.rel, content: buf.toString('utf-8'), size: stat.size }
  } catch (err: unknown) {
    return { ok: false, tool: 'read_file', path: normalized.rel, error: errorMessage(err) }
  }
}

function writeWorkspaceFile(projectPath: string, inputPath: string, content: string): ChatFileToolResult {
  const normalized = normalizeWorkspacePath(projectPath, inputPath)
  if ('error' in normalized) return { ok: false, tool: 'write_file', path: inputPath, error: normalized.error }
  if (content.length > CHAT_FILE_WRITE_LIMIT) {
    return { ok: false, tool: 'write_file', path: normalized.rel, error: 'Content is too large to write from chat.' }
  }
  try {
    mkdirSync(dirname(normalized.target), { recursive: true })
    writeFileSync(normalized.target, content, 'utf-8')
    return { ok: true, tool: 'write_file', path: normalized.rel, size: Buffer.byteLength(content, 'utf-8') }
  } catch (err: unknown) {
    return { ok: false, tool: 'write_file', path: normalized.rel, error: errorMessage(err) }
  }
}

function parseChatFileToolRequest(raw: string | null): ChatFileToolRequest | null {
  if (!raw) return null
  let text = raw.trim()
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as ChatFileToolRequest
    if (!parsed || typeof parsed.tool !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function buildChatFileToolPrompt(mode: ChatFileToolMode, projectPath: string): string {
  return [
    'Before the visible answer, decide whether one workspace file tool is needed.',
    `Project root: ${projectPath}`,
    'Reply with exactly one JSON object and no markdown.',
    'Use {"tool":"none","reason":"..."} when no file access is needed.',
    'Available read tools:',
    '- {"tool":"list_dir","path":"relative/folder"} lists project files.',
    '- {"tool":"read_file","path":"relative/file"} reads a UTF-8 text file.',
    mode === 'write'
      ? '- {"tool":"write_file","path":"relative/file","content":"full new file content"} creates or replaces a UTF-8 text file.'
      : '- Writing files is not available in this mode.',
    'Rules:',
    '- Paths must be relative to the project root.',
    '- Use read_file before editing an existing file unless the user provided the full content.',
    '- Only use write_file when the user explicitly asked to create or change a file.',
    '- If you need another tool after a result, ask for exactly one next tool.'
  ].join('\n')
}

function shouldConsiderChatFileTools(content: string, projectPath: string | null | undefined): boolean {
  return Boolean(projectPath && CHAT_FILE_TOOL_HINT.test(content))
}

async function runHiddenModelCall(model: string, messages: ChatMessage[], db: ReturnType<typeof getDb>): Promise<string | null> {
  if (!model.startsWith('cloud:')) return chat(model, messages, 45000)
  const cloudModel = model.slice(6)
  const keyRow = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('ollama_cloud_key') as { value: string } | undefined
  return cloudChat(cloudModel, messages, keyRow?.value ?? '', 45000)
}

async function runChatFileTools(opts: {
  db: ReturnType<typeof getDb>
  model: string
  projectPath: string
  mode: ChatFileToolMode
  messages: ChatMessage[]
}): Promise<ChatMessage[]> {
  const toolTranscript: ChatMessage[] = [{ role: 'system', content: buildChatFileToolPrompt(opts.mode, opts.projectPath) }]
  const results: ChatFileToolResult[] = []
  for (let step = 0; step < 4; step++) {
    const raw = await runHiddenModelCall(opts.model, [...opts.messages, ...toolTranscript], opts.db)
    const request = parseChatFileToolRequest(raw)
    if (!request || request.tool === 'none') break
    let result: ChatFileToolResult
    if (request.tool === 'list_dir') {
      result = listWorkspaceDir(opts.projectPath, request.path ?? '.')
    } else if (request.tool === 'read_file') {
      result = readWorkspaceFile(opts.projectPath, request.path ?? '')
    } else if (request.tool === 'write_file') {
      if (opts.mode !== 'write') {
        result = { ok: false, tool: 'write_file', path: request.path ?? '', error: 'Writing is only available in Execute mode.' }
      } else if (typeof request.content !== 'string') {
        result = { ok: false, tool: 'write_file', path: request.path ?? '', error: 'write_file requires content.' }
      } else {
        result = writeWorkspaceFile(opts.projectPath, request.path ?? '', request.content)
      }
    } else {
      break
    }
    results.push(result)
    toolTranscript.push({ role: 'assistant', content: JSON.stringify(request) })
    toolTranscript.push({ role: 'user', content: `Tool result:\n${JSON.stringify(result)}` })
    if (!result.ok || request.tool === 'write_file') break
  }
  if (results.length === 0) return []
  return [{
    role: 'system',
    content:
      'Workspace file tool results for this turn:\n' +
      JSON.stringify(results, null, 2) +
      '\nUse these results in your visible answer. If a write succeeded, say exactly which file changed.'
  }]
}

// ---- Research pipeline helpers -----------------------------------------------

function getSearxngUrl(): string {
  try {
    const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get('searxng_url') as
      | { value: string }
      | undefined
    if (row?.value) return row.value.replace(/\/+$/, '')
  } catch { /* db not ready */ }
  const envUrl = process.env.SEARXNG_URL
  if (envUrl) return envUrl.replace(/\/+$/, '')
  return 'http://localhost:8080'
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function killAllPtys(): void {
  for (const [, entry] of ptyMap) {
    try { entry.pty.kill() } catch {}
  }
  ptyMap.clear()
}

function emitActivity(
  win: BrowserWindow | null,
  source: 'CHAT' | 'HERMES' | 'CODE' | 'INDEXER' | 'MEMORY' | 'RESEARCH' | 'KIMI',
  message: string
) {
  const payload: ActivityEntry = { source, message, timestamp: Date.now() }
  win?.webContents.send('activity:log', payload)
}

type SettingKind = 'string' | 'number' | 'boolean' | 'select' | 'secret'

interface SettingDefinition {
  key: string
  kind: SettingKind
  defaultValue: string
  secret?: boolean
  options?: string[]
}

const SETTING_DEFINITIONS: Record<string, SettingDefinition> = {
  ui_theme: { key: 'ui_theme', kind: 'select', defaultValue: 'system', options: ['system', 'dark', 'light'] },
  ui_density: { key: 'ui_density', kind: 'select', defaultValue: 'comfortable', options: ['comfortable', 'compact'] },
  ui_font_scale: { key: 'ui_font_scale', kind: 'select', defaultValue: '100', options: ['95', '100', '110', '120'] },
  ui_font_family: { key: 'ui_font_family', kind: 'select', defaultValue: 'default', options: APP_FONT_VALUES },
  ui_motion_mode: { key: 'ui_motion_mode', kind: 'select', defaultValue: 'full', options: ['full', 'reduced', 'off'] },
  ui_reduced_motion: { key: 'ui_reduced_motion', kind: 'boolean', defaultValue: 'false' },
  workspace_startup: { key: 'workspace_startup', kind: 'select', defaultValue: 'last', options: ['last', 'global'] },
  workspace_confirm_destructive: { key: 'workspace_confirm_destructive', kind: 'boolean', defaultValue: 'true' },
  workspace_panel_hints: { key: 'workspace_panel_hints', kind: 'boolean', defaultValue: 'true' },
  agent_default: { key: 'agent_default', kind: 'select', defaultValue: 'codex', options: ['codex', 'claudecode', 'hermes', 'kimi'] },
  agent_save_outputs_to_knowledge: { key: 'agent_save_outputs_to_knowledge', kind: 'boolean', defaultValue: 'true' },
  agent_show_advanced_logs: { key: 'agent_show_advanced_logs', kind: 'boolean', defaultValue: 'false' },
  searxng_url: { key: 'searxng_url', kind: 'string', defaultValue: 'http://localhost:8080' },
  research_default_scope: { key: 'research_default_scope', kind: 'select', defaultValue: 'both', options: ['web', 'local', 'both'] },
  research_result_limit: { key: 'research_result_limit', kind: 'number', defaultValue: '8' },
  editor_font_size: { key: 'editor_font_size', kind: 'number', defaultValue: '13' },
  editor_tab_size: { key: 'editor_tab_size', kind: 'number', defaultValue: '2' },
  editor_word_wrap: { key: 'editor_word_wrap', kind: 'boolean', defaultValue: 'true' },
  terminal_start_dir: { key: 'terminal_start_dir', kind: 'select', defaultValue: 'project', options: ['project', 'app'] },
  notify_sound_enabled: { key: 'notify_sound_enabled', kind: 'boolean', defaultValue: 'true' },
  browser_persist_session: { key: 'browser_persist_session', kind: 'boolean', defaultValue: 'false' },
  keyboard_shortcuts: { key: 'keyboard_shortcuts', kind: 'string', defaultValue: '' },
  ollama_cloud_key: { key: 'ollama_cloud_key', kind: 'secret', defaultValue: '', secret: true },
  // Kimi Code API key, stored exactly like ollama_cloud_key above (plaintext
  // app_meta — this app has no encrypted secret storage anywhere). Passed to
  // `kimi acp` as an env var at spawn time when the API-key auth method is
  // selected; see resolveKimiAuthEnv() / kimi.ts getKimiApiKey().
  kimi_api_key: { key: 'kimi_api_key', kind: 'secret', defaultValue: '', secret: true },
  // Set when the user dismisses the wizard's "local looks slow" suggestion, so
  // the nudge never returns for someone who has already said no.
  ollama_slow_hint_dismissed: { key: 'ollama_slow_hint_dismissed', kind: 'boolean', defaultValue: 'false' },
}

function readMeta(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row?.value ?? null
}

function writeMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)')
    .run(key, value)
}

function deleteMeta(key: string): void {
  getDb().prepare('DELETE FROM app_meta WHERE key = ?').run(key)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Translate raw fetch/stream failures from a chat turn into something a user
// can act on. Undici reports everything from "Ollama isn't running" to "the
// model stalled for 5 minutes" as a bare TypeError('fetch failed'); the real
// signal hides in err.cause.code.
function friendlyChatError(err: unknown, opts: { cloud: boolean; model: string }): string {
  const raw = errorMessage(err)
  const cause = (err as { cause?: { code?: string; name?: string } })?.cause
  // The stream's idle-timeout aborts with a bare DOMException('TimeoutError')
  // thrown directly (no .cause wrapper), so consult the top-level name too.
  const topName = (err as { name?: string })?.name ?? ''
  const code = cause?.code ?? cause?.name ?? topName
  const target = opts.cloud ? 'Ollama Cloud' : 'Ollama'

  if (/UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|TimeoutError/i.test(code) || /timed? ?out/i.test(raw)) {
    return `${opts.model} stopped responding before finishing (timed out). Local models running on CPU can take minutes per reply — consider a smaller or cloud model, then retry.`
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|UND_ERR_SOCKET/i.test(code) || /fetch failed/i.test(raw)) {
    return opts.cloud
      ? 'Could not reach Ollama Cloud — check your internet connection, then retry.'
      : 'Lost the connection to Ollama. Make sure the Ollama server is running (`ollama serve`), then retry.'
  }
  const status = raw.match(/error: (\d{3})/)?.[1]
  if (status === '401' || status === '403') {
    return `${target} rejected the request (HTTP ${status}). Check the API key in the model picker.`
  }
  if (status === '404') {
    return `${target} doesn't know the model "${opts.model}" (HTTP 404). Pull it or pick a different model.`
  }
  return raw
}

// Per-project "is this a git repo?" cache. The Navigator polls git status on a
// timer, so without this a non-git project spawns a failing `git` subprocess on
// every tick — spamming "fatal: not a git repository" and blocking on execSync.
// A cheap fs.existsSync(.git) check gates the spawn; the result is memoized for
// the app session (re-checked only when a project path is first seen).
const gitRepoCache = new Map<string, boolean>()
function isGitRepo(projectPath: string): boolean {
  const cached = gitRepoCache.get(projectPath)
  if (cached !== undefined) return cached
  const result = Boolean(projectPath) && existsSync(join(projectPath, '.git'))
  gitRepoCache.set(projectPath, result)
  return result
}

function validateSetting(def: SettingDefinition, rawValue: string): string {
  const value = String(rawValue ?? '')
  if (def.kind === 'boolean') return value === 'true' ? 'true' : 'false'
  if (def.kind === 'select') return def.options?.includes(value) ? value : def.defaultValue
  if (def.kind === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return def.defaultValue
    return String(Math.round(n))
  }
  if (def.key === 'searxng_url') {
    const trimmed = value.trim().replace(/\/+$/, '')
    if (!trimmed) return def.defaultValue
    try {
      const u = new URL(trimmed)
      if (!['http:', 'https:'].includes(u.protocol)) return def.defaultValue
      return trimmed
    } catch {
      return def.defaultValue
    }
  }
  return value
}

function publicSettingValue(key: string): string | null {
  const def = SETTING_DEFINITIONS[key]
  if (!def) return null
  if (def.secret) return null
  return readMeta(key) ?? def.defaultValue
}

function secretStatus(key: string): { configured: boolean; masked: string | null } {
  const value = readMeta(key)
  if (!value) return { configured: false, masked: null }
  const tail = value.slice(-4)
  return { configured: true, masked: `•••• ${tail}` }
}

function buildSettingsSnapshot(): SettingsSummary {
  const values: Record<string, string | null> = {}
  const secrets: Record<string, { configured: boolean; masked: string | null }> = {}
  for (const def of Object.values(SETTING_DEFINITIONS)) {
    if (def.secret) secrets[def.key] = secretStatus(def.key)
    else values[def.key] = publicSettingValue(def.key)
  }
  return { values, secrets }
}

async function buildDiagnosticsReport(): Promise<SettingsDiagnostics> {
  const db = getDb()
  const projectCount = (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number } | undefined)?.n ?? 0
  const sessionCount = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number } | undefined)?.n ?? 0
  const memoryCount = (db.prepare('SELECT COUNT(*) AS n FROM memory_items').get() as { n: number } | undefined)?.n ?? 0
  const knowledgeDiagnostics = knowledge.getKnowledgeDiagnostics(null)
  const [ollama, codex, claude, kimi, hermes] = await Promise.all([
    ollamaStatus().catch((e: unknown) => ({ connected: false, defaultModel: null, error: errorMessage(e) })),
    checkCodex().catch((e: unknown) => ({ installed: false, error: errorMessage(e) })),
    checkClaudeCode().catch((e: unknown) => ({ installed: false, error: errorMessage(e) })),
    checkKimi().catch((e: unknown) => ({ installed: false, error: errorMessage(e) })),
    checkHermes().catch((e: unknown) => ({ wsl2: false, installed: false, connected: false, error: errorMessage(e) })),
  ])
  return {
    app: {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: `${process.platform} ${process.arch}`,
      userData: app.getPath('userData'),
      databasePath: getDbPath(),
    },
    counts: { projects: projectCount, sessions: sessionCount, memories: memoryCount },
    knowledge: knowledgeDiagnostics,
    providers: { ollama, codex, claudeCode: claude, kimi, hermes },
    webCompanion: (() => {
      const status = getWebCompanionStatus()
      return {
        enabled: status.enabled,
        running: status.running,
        hostMode: status.hostMode,
        port: status.port,
        bindHost: status.bindHost,
        tokenConfigured: status.tokenConfigured,
        tokenMasked: status.tokenMasked,
        error: status.error,
      }
    })(),
    settings: buildSettingsSnapshot(),
  }
}


export function registerIpc(): void {
  // ---- filesystem (Phase D: Navigator file tree) ----
  // FsEntry[] carries no error channel and this handler already collapses every
  // failure (missing dir, EACCES) to an empty list, so a denial matches its
  // existing contract. Widening the shape would mean changing the IPC type and
  // both callers; the console.warn is what makes a denial diagnosable.
  ipcMain.handle('fs:readDir', (_e, dirPath: string): FsEntry[] => {
    const scoped = resolveWithinRoots(dirPath, allowedFsRoots(), 'folder')
    if ('error' in scoped) {
      console.warn('[fs] readDir denied (outside allowed roots):', dirPath)
      return []
    }
    try {
      return readdirSync(scoped.target, { withFileTypes: true })
        .filter(e => !FS_IGNORE.has(e.name) && !e.name.endsWith('.map'))
        .map(e => ({ name: e.name, isDir: e.isDirectory(), path: join(scoped.target, e.name) }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    } catch {
      return []
    }
  })

  // Phase E: read/write files for the Editor panel
  ipcMain.handle('fs:readFile', (_e, filePath: string): FsReadFileResponse => {
    const scoped = resolveWithinRoots(filePath, allowedFsRoots(), 'file')
    if ('error' in scoped) return { error: scoped.error }
    try {
      const stat = statSync(scoped.target)
      if (stat.size > 500 * 1024) return { error: 'File too large (>500KB)' }
      const buf = readFileSync(scoped.target)
      const checkLen = Math.min(512, buf.length)
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) return { error: 'Binary file' }
      }
      return { content: buf.toString('utf-8'), size: stat.size }
    } catch (e: unknown) {
      return { error: errorMessage(e) }
    }
  })

  ipcMain.handle('fs:writeFile', (_e, filePath: string, content: string): FsWriteFileResponse => {
    const scoped = resolveWithinRoots(filePath, allowedFsRoots(), 'file')
    if ('error' in scoped) return { error: scoped.error }
    try {
      writeFileSync(scoped.target, content, 'utf-8')
      return { success: true }
    } catch (e: unknown) {
      return { error: errorMessage(e) }
    }
  })

  // ---- file picker & reader ----
  ipcMain.handle('files:pick', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    // The user picked this file in a native dialog — a gesture main can trust.
    // Record it so files:read will serve it even from outside a project root.
    grantPickedFile(result.filePaths[0])
    return result.filePaths[0]
  })

  ipcMain.handle('files:read', async (_e, filePath: string): Promise<FileAttachment> => {
    // Attachments come from two gestures: the native picker (granted above) and
    // drag-and-drop, which main cannot corroborate — hence the user content
    // folders. Anything else is refused by throwing: this handler's contract is
    // already reject-by-throw (see the size check), and the renderer surfaces the
    // message as a toast.
    const scoped = isPickedFileGranted(filePath)
      ? { target: resolve(filePath) }
      : resolveWithinRoots(filePath, [...allowedFsRoots(), ...attachmentRoots()], 'file')
    if ('error' in scoped) throw new Error(scoped.error)
    filePath = scoped.target
    const stats = statSync(filePath)
    if (stats.size > 10 * 1024 * 1024) throw new Error('File too large (max 10MB)')
    const ext = extname(filePath).toLowerCase()
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico']
    if (imageExts.includes(ext)) {
      const buffer = readFileSync(filePath)
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp', '.ico': 'image/x-icon'
      }
      return { type: 'image', name: basename(filePath), size: stats.size, mimeType: mimeTypes[ext] ?? 'image/jpeg', base64: buffer.toString('base64'), ext, filePath }
    }
    try {
      const content = readFileSync(filePath, 'utf-8')
      return { type: 'text', name: basename(filePath), size: stats.size, content, ext }
    } catch {
      const buffer = readFileSync(filePath)
      return { type: 'binary', name: basename(filePath), size: stats.size, base64: buffer.toString('base64'), ext }
    }
  })

  ipcMain.handle('files:copyToProject', async (_e, sourcePath: string, projectPath: string): Promise<FileCopyResponse> => {
    try {
      const tmpDir = join(projectPath, '.ai-workspace-tmp')
      mkdirSync(tmpDir, { recursive: true })
      const fileName = basename(sourcePath)
      const destPath = join(tmpDir, fileName)
      copyFileSync(sourcePath, destPath)
      return { success: true as const, path: destPath }
    } catch (err) {
      console.error('[files] copyToProject failed:', err)
      return { success: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('ollama:analyzeImage', (_e, model: string, base64: string, mimeType: string, prompt: string): Promise<string | null> =>
    analyzeImage(model, base64, mimeType, prompt)
  )

  // ---- projects ----
  ipcMain.handle('projects:list', (): Project[] => projects.listProjects())
  ipcMain.handle('projects:global', (): Project => projects.openProject(GLOBAL_PROJECT_ID))
  ipcMain.handle('projects:create', (_e, name: string, parentDir: string): Project =>
    projects.createProject(name, parentDir)
  )
  ipcMain.handle('projects:import', async (): Promise<Project | null> => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return projects.importFolder(result.filePaths[0])
  })
  ipcMain.handle('projects:open', (_e, id: string): Project => {
    const project = projects.openProject(id)
    // The global workspace is a DB sentinel, not a folder-backed project.
    // Never start the file watcher/indexer for it.
    if (!isGlobalProjectId(project.id)) startWatcher(project.id, project.path)
    return project
  })
  ipcMain.handle('projects:archive', (_e, id: string, archived: boolean): void =>
    projects.setArchived(id, archived)
  )
  ipcMain.handle('projects:pickFolder', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // ---- project links (cross-project knowledge web) ----
  // Directed edges in project_links; the "related" memory search scope and the
  // Knowledge panel's Related Projects section both read from this table.
  ipcMain.handle('projects:getLinks', (_e, projectId: string): Project[] =>
    getDb()
      .prepare(
        `SELECT p.* FROM project_links l
         JOIN projects p ON p.id = l.dst_project_id
         WHERE l.src_project_id = ?
         ORDER BY p.name COLLATE NOCASE`
      )
      .all(projectId) as Project[]
  )

  ipcMain.handle('projects:addLink', (_e, srcId: string, dstId: string): MutationResponse => {
    try {
      if (srcId === dstId) return { success: false, error: 'Cannot link a project to itself' }
      getDb()
        .prepare(`INSERT OR IGNORE INTO project_links (src_project_id, dst_project_id) VALUES (?, ?)`)
        .run(srcId, dstId)
      return { success: true }
    } catch (err) {
      console.error('[projects] addLink failed:', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('projects:removeLink', (_e, srcId: string, dstId: string): MutationResponse => {
    try {
      getDb()
        .prepare(`DELETE FROM project_links WHERE src_project_id = ? AND dst_project_id = ?`)
        .run(srcId, dstId)
      return { success: true }
    } catch (err) {
      console.error('[projects] removeLink failed:', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('projects:getAvailableLinkTargets', (_e, projectId: string): Project[] =>
    getDb()
      .prepare(
        `SELECT * FROM projects
         WHERE id != ? AND id != ? AND status = 'active'
         AND id NOT IN (SELECT dst_project_id FROM project_links WHERE src_project_id = ?)
         ORDER BY name COLLATE NOCASE`
      )
      .all(projectId, GLOBAL_PROJECT_ID, projectId) as Project[]
  )

  // ---- models ----
  ipcMain.handle('models:list', (): Promise<string[]> => listModels())
  ipcMain.handle('models:listCloud', async (): Promise<CloudModelsResponse> => {
    try {
      const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get('ollama_cloud_key') as { value: string } | undefined
      const apiKey = row?.value
      if (!apiKey) return { success: true, models: [] }
      const res = await fetch('https://ollama.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) return { success: false, error: `Ollama Cloud returned HTTP ${res.status}` }
      const data = await res.json() as { data?: { id: string }[] }
      const models = (data.data ?? [])
        .map((m) => ({ id: m.id, name: m.id }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      return { success: true, models }
    } catch (err: unknown) {
      return { success: false, error: errorMessage(err) }
    }
  })
  // Evidence-based "is local inference painfully slow here?" — never throws;
  // 'unknown' means stay quiet rather than assume the worst.
  ipcMain.handle('models:speedProbe', (_e, force?: boolean): Promise<LocalSpeedProbe> => probeLocalSpeed(Boolean(force)))
  ipcMain.handle('ollama:status', (): Promise<OllamaStatus> => ollamaStatus())
  // One-shot, non-streaming completion (offline-tolerant; returns null if the
  // host/model is unavailable). Routed through ollama.ts like all model access —
  // used for side calls such as the Chat tab's follow-up suggestions. Read-only:
  // it never touches sessions or the DB.
  ipcMain.handle('ollama:complete', (_e, model: string, messages: ChatModelMessage[], timeoutMs?: number): Promise<string | null> =>
    chat(model, messages, timeoutMs)
  )

  // ---- MCP server registry ----------------------------------------------------
  // Claude Desktop's config remains the source of truth. This app only tracks
  // local UI enabled/disabled state in app_meta.
  ipcMain.handle('mcp:list', async (): Promise<McpServer[]> => {
    const servers = readMcpServers()
    const enabled = getEnabledState()
    return Object.entries(servers).map(([name, config]) => ({
      name,
      config,
      enabled: enabled[name] !== false,
      transport: config.url ? (config.type === 'http' ? 'http' : 'sse') : 'stdio',
      status: 'unknown',
      statusMessage: undefined,
      lastChecked: undefined
    }))
  })

  ipcMain.handle('mcp:add', async (_e, name: string, config: McpServerConfig): Promise<MutationResponse> => {
    const servers = readMcpServers()
    servers[name] = config
    writeMcpServers(servers)
    return { success: true }
  })

  ipcMain.handle('mcp:remove', async (_e, name: string): Promise<MutationResponse> => {
    const servers = readMcpServers()
    delete servers[name]
    writeMcpServers(servers)

    const enabled = getEnabledState()
    delete enabled[name]
    setEnabledState(enabled)
    return { success: true }
  })

  ipcMain.handle('mcp:setEnabled', async (_e, name: string, enabled: boolean): Promise<MutationResponse> => {
    const state = getEnabledState()
    state[name] = enabled
    setEnabledState(state)
    return { success: true }
  })

  ipcMain.handle('mcp:check', async (_e, name: string): Promise<McpCheckResult> => {
    const servers = readMcpServers()
    if (!servers[name]) return { status: 'error', message: 'Server not found' }
    return checkMcpServer(name, servers[name])
  })

  ipcMain.handle('mcp:checkAll', async (): Promise<Record<string, McpCheckResult>> => {
    const servers = readMcpServers()
    const results: Record<string, McpCheckResult> = {}
    await Promise.all(
      Object.entries(servers).map(async ([name, config]) => {
        results[name] = await checkMcpServer(name, config)
      })
    )
    return results
  })

  ipcMain.handle('mcp:getConfigPath', (): string => getClaudeConfigPath())

  // Real on-disk path of the bundled knowledge MCP server, so the Extensions
  // quick-add never inserts a placeholder into the live config.
  ipcMain.handle('mcp:getKnowledgeServerPath', (): string =>
    join(app.getAppPath(), 'out', 'mcp', 'server.cjs')
  )

  // Full launch config for the bundled knowledge server (Electron-as-Node so it
  // loads the Electron-ABI better-sqlite3). The Extensions quick-add uses this
  // instead of hardcoding `node`, which would load a mismatched native binary.
  ipcMain.handle('mcp:getKnowledgeServerConfig', (): McpServerConfig =>
    bundledMcpServers()['ai-workspace-knowledge']
  )

  // On-disk path of the bundled browser-control MCP server (Extensions quick-add).
  ipcMain.handle('mcp:getBrowserServerPath', (): string =>
    join(app.getAppPath(), 'out', 'mcp', 'browser-server.cjs')
  )

  // Full launch config for the bundled browser-control server (plain node; the
  // control server's loopback port baked into the env). The Extensions quick-add
  // uses this instead of hardcoding a config.
  ipcMain.handle('mcp:getBrowserServerConfig', (): McpServerConfig =>
    bundledMcpServers()['ai-workspace-browser']
  )

  // ---- sessions / chat ----
  ipcMain.handle('sessions:list', (_e, projectId: string, mode: string): Session[] =>
    getDb()
      .prepare(`SELECT * FROM sessions WHERE project_id = ? AND mode = ? AND archived = 0 ORDER BY created_at DESC`)
      .all(projectId, mode) as Session[]
  )
  ipcMain.handle('sessions:listArchived', (_e, projectId: string, mode: string): Session[] =>
    getDb()
      .prepare(`SELECT * FROM sessions WHERE project_id = ? AND mode = ? AND archived = 1 ORDER BY created_at DESC`)
      .all(projectId, mode) as Session[]
  )
  ipcMain.handle('sessions:create', (_e, projectId: string, mode: string, title: string): Session => {
    // Callers destructure the returned Session, so keep that contract; on DB
    // failure, reject with a readable message instead of a cryptic SQL error.
    try {
      if (isGlobalProjectId(projectId)) projects.ensureGlobalProject()
      const now = Date.now()
      const session = { id: randomUUID(), project_id: projectId, mode, title, created_at: now, updated_at: now, summary: null as string | null, archived: 0 }
      getDb()
        .prepare(`INSERT INTO sessions (id, project_id, mode, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(session.id, session.project_id, session.mode, session.title, session.created_at, session.updated_at, session.archived)
      return session
    } catch (err) {
      console.error('[sessions] create failed:', err)
      throw new Error(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  // Regenerate the one-line session summary from its last ~10 messages via a
  // local Ollama model. Best-effort and silent: any failure returns null so the
  // renderer keeps showing whatever summary (or none) it already has.
  ipcMain.handle('sessions:generateSummary', async (_e, sessionId: string, model: string): Promise<string | null> => {
    try {
      const db = getDb()
      const rows = db
        .prepare(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 10`)
        .all(sessionId) as { role: string; content: string }[]
      if (rows.length === 0) return null
      const history = rows
        .reverse()
        .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
        .join('\n')
      const prompt =
        `Summarize what this conversation is about in one short phrase (max 8 words). ` +
        `No punctuation at the end.\n\nConversation:\n${history}`
      const raw = await chat(model, [{ role: 'user', content: prompt }], 15000)
      if (!raw) return null
      const summary = raw.trim().split('\n')[0].replace(/[.!?]+$/, '').replace(/^["'`]+|["'`]+$/g, '').slice(0, 100)
      if (!summary) return null
      db.prepare(`UPDATE sessions SET summary = ? WHERE id = ?`).run(summary, sessionId)
      return summary
    } catch (err) {
      console.error('[sessions] generateSummary failed:', err)
      return null
    }
  })
  ipcMain.handle('sessions:rename', (_e, id: string, title: string): MutationResponse => {
    try {
      getDb().prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, id)
      return { success: true }
    } catch (err) {
      console.error('[sessions] rename failed:', err)
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('sessions:archive', (_e, id: string, archived: boolean): MutationResponse => {
    try {
      getDb().prepare(`UPDATE sessions SET archived = ? WHERE id = ?`).run(archived ? 1 : 0, id)
      return { success: true }
    } catch (err) {
      console.error('[sessions] archive failed:', err)
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('sessions:delete', (_e, id: string): MutationResponse => {
    try {
      const db = getDb()
      db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id)
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
      return { success: true }
    } catch (err) {
      console.error('[sessions] delete failed:', err)
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('messages:list', (_e, sessionId: string): Message[] =>
    getDb().prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at`).all(sessionId) as Message[]
  )

  // ---- Message-level interactions (edit-resend, regenerate, reactions) ----
  // Shared across all four agent tabs — they all read/write the same messages table.
  ipcMain.handle('messages:update', (_e, id: string, content: string): MutationResponse => {
    try {
      getDb().prepare(`UPDATE messages SET content = ? WHERE id = ?`).run(content, id)
      return { success: true }
    } catch (err) {
      console.error('[messages] update failed:', err)
      return { success: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  // Used by edit-resend (fork the conversation after an edited message) and by
  // regenerate (drop the last assistant turn, keeping the user message that
  // triggered it, so a resend doesn't insert a duplicate user message).
  ipcMain.handle('messages:deleteAfter', (_e, sessionId: string, messageId: string): DeleteAfterResponse => {
    try {
      const db = getDb()
      const anchor = db.prepare(`SELECT created_at FROM messages WHERE id = ?`).get(messageId) as
        | { created_at: number }
        | undefined
      if (!anchor) return { success: false, error: 'Message not found' }
      const toDelete = db
        .prepare(`SELECT id FROM messages WHERE session_id = ? AND created_at > ?`)
        .all(sessionId, anchor.created_at) as { id: string }[]
      db.prepare(`DELETE FROM messages WHERE session_id = ? AND created_at > ?`).run(sessionId, anchor.created_at)
      return { success: true, deletedCount: toDelete.length }
    } catch (err) {
      console.error('[messages] deleteAfter failed:', err)
      return { success: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  ipcMain.handle('messages:setReaction', (_e, id: string, reaction: 'up' | 'down' | null): MutationResponse => {
    try {
      getDb().prepare(`UPDATE messages SET reaction = ? WHERE id = ?`).run(reaction, id)
      return { success: true }
    } catch (err) {
      console.error('[messages] setReaction failed:', err)
      return { success: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  // Track in-flight chat streams so a Stop can cancel them.
  const chatAborts = new Map<string, AbortController>()
  ipcMain.handle('chat:abort', (_e, sessionId: string): void => {
    chatAborts.get(sessionId)?.abort()
  })

  // Streaming chat: persists the user message, retrieves knowledge context,
  // streams model output to the renderer, persists the assistant message.
  ipcMain.handle(
    'chat:send',
    async (event, args: ChatSendRequest): Promise<string | null> => {
      const db = getDb()
      const win = BrowserWindow.fromWebContents(event.sender)
      const now = Date.now()
      // Regenerate reuses the existing (preceding) user message instead of
      // inserting a duplicate — the caller has already deleted the stale
      // assistant turn that followed it.
      if (!args.regenerateMessageId) {
        db.prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), args.sessionId, 'user', args.content, null, now)
        db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(now, args.sessionId)
      }

      // Retrieval step: ground the model in workspace knowledge before answering.
      // For the __global__ sentinel, "project" scope resolves to shared/global
      // memory (project_id NULL) without mixing in any folder-backed project.
      const memories = await knowledge.searchMemory(args.content, 'project', args.projectId, 5)
      const contextBlock =
        memories.length > 0
          ? `Relevant project knowledge:\n${memories.map((m) => `- [${m.type}] ${m.title}: ${m.content}`).join('\n')}`
          : ''

      const history = db
        .prepare(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at`)
        .all(args.sessionId) as ChatMessage[]
      const messagesRaw: ChatMessage[] = [
        {
          role: 'system',
          content:
            (args.systemPrefix ? `${args.systemPrefix}\n\n` : '') +
            `You are the Chat mode of a local-first AI workspace. You help plan, research and prepare work ` +
            `for the Hermes agent and Claude Code. Be concrete and ask clarifying questions when planning.\n\n` +
            `Whenever you present answer choices that the user is expected to choose from, use structured interactive blocks. ` +
            `This applies to random questions, quizzes, design questions, clarification questions, and surveys. ` +
            `If asking one selectable clarification question, emit one fenced clarification block. If asking one general selectable question, emit one fenced choice_question block. ` +
            `If asking multiple selectable questions, emit one fenced questionnaire block. Do not output plain A) B) C) D) or numbered multiple-choice text when the user is expected to answer interactively. ` +
            `Keep options short. Include freewrite where useful. Do not force interactive blocks for normal explanations. ` +
            `Do not ask too many questions unless the user explicitly asks for lots of questions. Use "single" unless multiple answers are genuinely allowed.\n\n` +
            `Clarification format:\n` +
            '```clarification\n' +
            '{\n' +
            '  "id": "short-stable-id",\n' +
            '  "question": "What should I clarify?",\n' +
            '  "mode": "single",\n' +
            '  "options": ["Option A", "Option B", "Something else"],\n' +
            '  "allowFreewrite": true,\n' +
            '  "freewriteLabel": "Describe your answer"\n' +
            '}\n' +
            '```\n' +
            `General single-question format:\n` +
            '```choice_question\n' +
            '{\n' +
            '  "id": "random-tree-question",\n' +
            '  "question": "What is the largest living species of tree by trunk volume?",\n' +
            '  "mode": "single",\n' +
            '  "options": ["Coast Redwood", "Giant Sequoia", "Amazonian Ceiba", "European Oak"],\n' +
            '  "allowFreewrite": false\n' +
            '}\n' +
            '```\n' +
            `Multi-question format:\n` +
            '```questionnaire\n' +
            '{\n' +
            '  "id": "short-stable-id",\n' +
            '  "title": "A few questions",\n' +
            '  "questions": [\n' +
            '    {\n' +
            '      "id": "tone",\n' +
            '      "question": "What tone should this have?",\n' +
            '      "mode": "single",\n' +
            '      "options": ["Professional", "Friendly", "Playful"],\n' +
            '      "allowFreewrite": true,\n' +
            '      "freewriteLabel": "Other tone"\n' +
            '    }\n' +
            '  ]\n' +
            '}\n' +
            '```\n' +
            `Example: if the user says "give me a random question with 4 possible answers", emit a choice_question block like the tree-volume example above, not plain A/B/C/D markdown. ` +
            `Only ask for clarification when it is needed; otherwise answer normally.\n\n${contextBlock}`
        },
        ...history
      ]
      // Attach native-vision images to the last user message so the model sees them.
      const messages: ChatMessage[] = messagesRaw
      if (args.images && args.images.length > 0) {
        const lastUserIdx = messages.map(m => m.role).lastIndexOf('user')
        if (lastUserIdx !== -1) messages[lastUserIdx] = { ...messages[lastUserIdx], images: args.images }
      }

      emitActivity(win, 'CHAT', `Sending to ${args.model.startsWith('cloud:') ? args.model.slice(6) : args.model}…`)
      const controller = new AbortController()
      chatAborts.set(args.sessionId, controller)
      let full = ''
      const isCloud = args.model.startsWith('cloud:')
      try {
        if (isCloud) {
          const cloudModel = args.model.slice(6)
          const keyRow = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('ollama_cloud_key') as { value: string } | undefined
          const apiKey = keyRow?.value ?? ''
          for await (const part of streamCloudChatParts(cloudModel, messages, apiKey, controller.signal)) {
            if (part.kind === 'answer') full += part.text
            const payload: ChatTokenEvent = { sessionId: args.sessionId, token: part.text, kind: part.kind }
            win?.webContents.send('chat:token', payload)
          }
        } else {
          for await (const part of streamChatParts(args.model, messages, controller.signal)) {
            if (part.kind === 'answer') full += part.text
            const payload: ChatTokenEvent = { sessionId: args.sessionId, token: part.text, kind: part.kind }
            win?.webContents.send('chat:token', payload)
          }
        }
      } catch (err: unknown) {
        // A user-initiated Stop arrives as an abort: keep the partial text
        // (persisted below) and finish cleanly instead of reporting an error.
        if (!controller.signal.aborted) {
          chatAborts.delete(args.sessionId)
          const friendly = friendlyChatError(err, { cloud: isCloud, model: isCloud ? args.model.slice(6) : args.model })
          const payload: ChatErrorEvent = { sessionId: args.sessionId, error: friendly }
          win?.webContents.send('chat:error', payload)
          emitActivity(win, 'CHAT', `Response failed: ${friendly}`)
          return null
        }
      } finally {
        chatAborts.delete(args.sessionId)
      }
      // Persist whatever was produced — the full turn, or the partial up to Stop.
      if (full.trim()) {
        const doneAt = Date.now()
        db.prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), args.sessionId, 'assistant', full, args.model, doneAt)
        db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(doneAt, args.sessionId)
        recordUsage('chat', (args.content.length + full.length) / 4)
      }
      // Estimate total context tokens from all persisted messages in this session.
      const allMsgs = db.prepare('SELECT content FROM messages WHERE session_id = ?').all(args.sessionId) as { content: string }[]
      const estimatedTokens = allMsgs.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0)
      const usagePayload: ChatUsageEvent = { sessionId: args.sessionId, used: estimatedTokens, max: null }
      const donePayload: ChatDoneEvent = { sessionId: args.sessionId }
      win?.webContents.send('chat:usage', usagePayload)
      win?.webContents.send('chat:done', donePayload)
      if (full.trim()) emitActivity(win, 'CHAT', `Response complete (${Math.ceil(full.length / 5)} tokens est.)`)
      return full
    }
  )

  // ---- Chat → agent handoff (Plan/Execute mode) ----
  // Two small non-streaming model calls used only when the Chat tab is in
  // Execute mode and a loose regex suggests the user wants to hand the plan
  // off to a coding agent. Both are offline-tolerant: a null/garbled model
  // reply degrades to "not a handoff" / empty prompt so the UI never wedges.
  ipcMain.handle(
    'chat:classifyHandoff',
    async (_e, opts: ChatClassifyHandoffRequest): Promise<HandoffClassification> => {
      const fallback: HandoffClassification = { handoff: false, agent: null, newSession: false }
      const classifyPrompt = `Does this message request handing off the
current plan/conversation to a coding agent as a new prompt?

Message: "${opts.userMessage}"

Reply with ONLY a JSON object, no other text:
{"handoff": boolean, "agent": "claudecode"|"hermes"|"codex"|null, "newSession": boolean}

Rules:
- agent must be exactly one of: claudecode, hermes, codex (or null if unclear/not a handoff)
- "claude code" or "claude" → claudecode
- "codex" → codex
- "hermes" → hermes
- newSession is true only if the user explicitly asks for a new/fresh session
- If the message does not clearly request a handoff, return {"handoff": false, "agent": null, "newSession": false}`
      const raw = await chat(opts.model, [{ role: 'user', content: classifyPrompt }], 60000)
      if (!raw) return fallback
      try {
        const start = raw.indexOf('{')
        const end = raw.lastIndexOf('}')
        if (start === -1 || end === -1 || end < start) return fallback
        const parsed = JSON.parse(raw.slice(start, end + 1)) as {
          handoff?: unknown
          agent?: unknown
          newSession?: unknown
        }
        const agent = parsed.agent === 'claudecode' || parsed.agent === 'hermes' || parsed.agent === 'codex'
          ? parsed.agent
          : null
        return {
          handoff: Boolean(parsed.handoff) && agent !== null,
          agent,
          newSession: Boolean(parsed.newSession)
        }
      } catch {
        return fallback
      }
    }
  )

  ipcMain.handle(
    'chat:generateHandoffPrompt',
    async (_e, opts: ChatGenerateHandoffPromptRequest): Promise<string> => {
      const agentContext = {
        claudecode: 'Claude Code, an AI coding agent that works directly in a project folder using tools to read/write files and run commands.',
        hermes: 'Hermes, an autonomous local AI agent that works on tasks with configurable permission levels.',
        codex: 'Codex, an AI coding agent (OpenAI) that runs one-shot or session-based coding tasks in a project folder.'
      }[opts.agent]
      const genPrompt = `Based on this planning conversation, write a
clear, complete, well-structured prompt to hand off to ${agentContext}

The prompt should:
- Give necessary context about what's being built
- List specific requirements and steps
- Note any constraints or things to avoid
- Ask for verification/testing where relevant
- Be formatted in clean markdown with headers where useful
- Be ready to send as-is — a complete, actionable task description

Conversation:
${opts.conversationHistory}

Write ONLY the prompt itself, formatted in markdown. No preamble like
"Here's the prompt" - just the prompt content ready to send.`
      const text = await chat(opts.model, [{ role: 'user', content: genPrompt }], 60000)
      return text ?? ''
    }
  )

  // ---- knowledge ----
  ipcMain.handle('memory:list', (_e, projectId: string | null): MemoryItem[] => knowledge.listMemory(projectId))
  ipcMain.handle('memory:save', async (event, input: MemorySaveRequest): Promise<MemoryItem> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    let item: MemoryItem
    try {
      item = await knowledge.saveMemory(input)
    } catch (err) {
      if (err instanceof knowledge.MemoryQualityError) {
        emitActivity(win, 'MEMORY', `Memory skipped: ${err.reason}`)
      }
      throw err
    }
    emitActivity(win, 'MEMORY', `Memory written (${item.type})`)
    const payload: MemorySavedEvent = { title: item.title, type: item.type }
    win?.webContents.send('memory:saved', payload)
    return item
  })
  ipcMain.handle('memory:delete', (_e, id: string): Promise<void> => knowledge.deleteMemory(id))
  ipcMain.handle('memory:touch', (_e, id: string): Promise<void> => knowledge.touchMemory(id))
  ipcMain.handle('memory:markStale', (_e, id: string, stale: boolean): Promise<void> =>
    knowledge.markMemoryStale(id, stale)
  )
  ipcMain.handle('memory:count', (_e, projectId: string): number => knowledge.countMemory(projectId))
  ipcMain.handle('memory:clearProject', (_e, projectId: string): Promise<number> =>
    knowledge.clearProjectMemory(projectId)
  )
  ipcMain.handle(
    'memory:search',
    (_e, query: string, scope: knowledge.SearchScope, projectId: string | null): Promise<MemoryItem[]> =>
      knowledge.searchMemory(query, scope, projectId)
  )
  ipcMain.handle('memory:diagnostics', (_e, projectId: string | null): knowledge.KnowledgeDiagnostics =>
    knowledge.getKnowledgeDiagnostics(projectId)
  )
  ipcMain.handle('memory:deleteLowQualityCandidates', (_e, projectId: string | null): Promise<number> =>
    knowledge.deleteLowQualityCandidates(projectId)
  )

  // M4: extract durable knowledge from a finished chat session. On success,
  // nudge the Knowledge panel to refresh via the same channel the indexer uses.
  ipcMain.handle('memory:extract', async (event, projectId: string | null, sessionId: string): Promise<MemoryItem[]> => {
    const items = await extractFromSession(projectId, sessionId)
    if (items.length > 0) {
      const win = BrowserWindow.fromWebContents(event.sender)
      const payload: IndexUpdatedEvent = { projectIds: [projectId ?? GLOBAL_PROJECT_ID] }
      win?.webContents.send('index:updated', payload)
    }
    return items
  })
  ipcMain.handle('memory:consolidate', (_e, projectId: string | null): Promise<RemovedCount> => consolidateMemories(projectId))

  // ---- Codex panel ----
  // Drives the Codex CLI headless under the user's ChatGPT subscription login.
  // Mirrors the Claude Code launcher: each send is a one-shot `codex exec` run,
  // streamed as structured events and persisted as session messages so past
  // work is reviewable. Command selection and cwd ownership stay in the main
  // process; the renderer provides only project identity, prompt, and sandbox.
  ipcMain.handle('codex:check', (): Promise<CodexCheck> => checkCodex())

  // Model catalog for the Codex picker — from the CLI's own models_cache.json
  // (see agentModels.ts), or a deterministic fake list under E2E_FAKE_CODEX.
  ipcMain.handle('codex:listModels', (): AgentModelInfo[] => listCodexModels())

  ipcMain.handle('codex:messages', (_e, sessionId: string): Message[] =>
    getDb().prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at`).all(sessionId) as Message[]
  )

  // Track in-flight Codex runs so a Stop can kill the child process.
  const codexAborts = new Map<string, AbortController>()
  ipcMain.handle('codex:abort', (_e, sessionId: string): void => {
    codexAborts.get(sessionId)?.abort()
  })

  ipcMain.handle(
    'codex:send',
    async (
      event,
      args: CodexSendRequest
    ): Promise<string | null> => {
      const db = getDb()
      const win = BrowserWindow.fromWebContents(event.sender)
      if (isGlobalProjectId(args.projectId)) {
        const payload: CodexDoneEvent = {
          sessionId: args.sessionId,
          ok: false,
          error: 'Open a project to use Codex.'
        }
        win?.webContents.send('codex:done', payload)
        return null
      }
      const insertMsg = (role: string, content: string, model: string | null) => {
        const id = randomUUID()
        const ts = Date.now()
        db
          .prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, args.sessionId, role, content, model, ts)
        db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(ts, args.sessionId)
        return id
      }

      // Title the session from its first user message, replacing "New task".
      const prior = db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`)
        .get(args.sessionId) as { n: number }
      // Regenerate reuses the existing (preceding) user message instead of
      // inserting a duplicate — the caller has already deleted the stale
      // tool/assistant messages that followed it.
      const userMsgId = args.regenerateMessageId ?? insertMsg('user', args.prompt, null)
      if (prior.n === 0) {
        const current = db.prepare(`SELECT title FROM sessions WHERE id = ?`).get(args.sessionId) as
          | { title: string }
          | undefined
        const title = fallbackTitleFromText(args.prompt) ?? 'New task'
        if (isGenericSessionTitle(current?.title)) {
          db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, args.sessionId)
        }
      }

      const project = db.prepare(`SELECT path FROM projects WHERE id = ?`).get(args.projectId) as
        | { path: string }
        | undefined
      if (!project?.path || !existsSync(project.path)) {
        const payload: CodexDoneEvent = { sessionId: args.sessionId, error: 'Project folder not found.' }
        win?.webContents.send('codex:done', payload)
        return null
      }

      // Resume the session's Codex thread (if a prior turn recorded one) so this
      // turn has real conversational context instead of starting fresh each time.
      const sessionRow = db.prepare(`SELECT codex_thread_id FROM sessions WHERE id = ?`).get(args.sessionId) as
        | { codex_thread_id: string | null }
        | undefined

      const controller = new AbortController()
      codexAborts.set(args.sessionId, controller)
      const run = await runCodex({
        projectPath: project.path,
        prompt: args.prompt,
        systemInstruction: BUILT_IN_PREVIEW_AGENT_INSTRUCTION,
        sandbox: args.sandbox,
        skipGitRepoCheck: args.skipGitRepoCheck,
        model: args.model,
        effort: args.effort,
        speed: args.speed,
        imagePaths: args.imagePaths,
        // Expose the bundled knowledge + browser MCP servers to this session as
        // per-spawn `-c mcp_servers.*` overrides (Codex ignores
        // claude_desktop_config.json).
        mcpServers: bundledMcpServers(),
        signal: controller.signal,
        threadId: sessionRow?.codex_thread_id ?? undefined,
        onEvent: (e) => {
          const payload: CodexIpcEvent = { sessionId: args.sessionId, event: e }
          win?.webContents.send('codex:event', payload)
          if (e.kind === 'tool') emitActivity(win, 'CODE', `Codex ${e.name}: ${e.summary.slice(0, 80)}`)
          else if (e.kind === 'system') emitActivity(win, 'CODE', `Codex: ${e.summary}`)
          else if (e.kind === 'error') emitActivity(win, 'CODE', `Codex error: ${e.message.slice(0, 80)}`)
        }
      })
      codexAborts.delete(args.sessionId)

      if (run.threadId && run.threadId !== sessionRow?.codex_thread_id) {
        db.prepare(`UPDATE sessions SET codex_thread_id = ? WHERE id = ?`).run(run.threadId, args.sessionId)
      }

      // A trust block is a pre-run gate, not real work: drop the turn entirely so
      // the user can enable the trust toggle and resend without cluttered history.
      if (run.trustRequired) {
        if (!args.regenerateMessageId) db.prepare(`DELETE FROM messages WHERE id = ?`).run(userMsgId)
        const payload: CodexDoneEvent = {
          sessionId: args.sessionId,
          ok: false,
          trustRequired: true,
          error: run.error
        }
        win?.webContents.send('codex:done', payload)
        return null
      }

      // Persist the activity log and the result text for review on reload.
      if (run.activity.length > 0) insertMsg('tool', JSON.stringify(run.activity), 'codex')
      insertMsg('assistant', run.result || run.error || '(no output)', 'codex')

      // Save a durable summary to memory after real work. Skip pure setup
      // failures (not found / not logged in / untrusted) — nothing to record.
      let memorySaved = false
      if (!run.loginRequired && !run.trustRequired && (run.ok || run.activity.length > 0)) {
        const { title, content } = summarizeCodexRun(args.prompt, run)
        await knowledge.saveMemory({
          projectId: args.projectId,
          type: 'task',
          title,
          content,
          source: 'codex',
          tags: ['codex']
        })
        memorySaved = true
        const payload: IndexUpdatedEvent = { projectIds: [args.projectId] }
        win?.webContents.send('index:updated', payload)
      }

      recordUsage('codex', (args.prompt.length + (run.result || '').length) / 4)
      emitActivity(win, 'CODE', run.ok ? `Codex task complete: ${args.prompt.slice(0, 60)}` : 'Codex task failed')
      const donePayload: CodexDoneEvent = {
        sessionId: args.sessionId,
        ok: run.ok,
        loginRequired: run.loginRequired ?? false,
        trustRequired: run.trustRequired ?? false,
        memorySaved,
        error: run.ok ? undefined : run.error
      }
      win?.webContents.send('codex:done', donePayload)
      return run.result
    }
  )

  // ---- Claude Code (M5) ----
  // Is the CLI installed/usable? (Login state is only knowable from a real run.)
  ipcMain.handle('claudecode:check', (): Promise<ClaudeCodeCheck> => checkClaudeCode())

  // Model catalog for the Claude Code picker — core verified list plus the
  // CLI's own additionalModelOptionsCache (see agentModels.ts); deterministic
  // fake list under E2E_FAKE_CLAUDE_CODE.
  ipcMain.handle('claudecode:listModels', (): AgentModelInfo[] => listClaudeCodeModels())

  // Track in-flight Claude Code runs so a Stop can kill the child process.
  const ccAborts = new Map<string, AbortController>()
  ipcMain.handle('claudecode:abort', (_e, sessionId: string): void => {
    ccAborts.get(sessionId)?.abort()
  })

  // Run a headless Claude Code task in the project folder, streaming structured
  // events to the renderer. Persists the turn (prompt + activity log + result)
  // as messages so past work is reviewable, and saves a durable task summary to
  // memory through the single write queue.
  ipcMain.handle(
    'claudecode:send',
    async (
      event,
      args: ClaudeCodeSendRequest
    ): Promise<string | null> => {
      const db = getDb()
      const win = BrowserWindow.fromWebContents(event.sender)
      if (isGlobalProjectId(args.projectId)) {
        const payload: ClaudeCodeDoneEvent = {
          sessionId: args.sessionId,
          ok: false,
          error: 'Claude Code needs a project folder. Open a project workspace to use it.'
        }
        win?.webContents.send('claudecode:done', payload)
        return null
      }
      const insertMsg = (role: string, content: string, model: string | null) => {
        const id = randomUUID()
        const ts = Date.now()
        db
          .prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, args.sessionId, role, content, model, ts)
        db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(ts, args.sessionId)
        return id
      }

      // Title the session from its first user message (Claude.ai-style preview),
      // replacing the "New task" placeholder. Detected by the absence of any
      // prior user turn so re-runs in the same session never re-title it.
      const prior = db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`)
        .get(args.sessionId) as { n: number }

      // Regenerate reuses the existing (preceding) user message instead of
      // inserting a duplicate — the caller has already deleted the stale
      // tool/assistant messages that followed it.
      const userMsgId = args.regenerateMessageId ?? insertMsg('user', args.prompt, null)

      if (prior.n === 0) {
        const current = db.prepare(`SELECT title FROM sessions WHERE id = ?`).get(args.sessionId) as { title: string } | undefined
        const title = fallbackTitleFromText(args.prompt) ?? 'New task'
        if (isGenericSessionTitle(current?.title)) {
          db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, args.sessionId)
        }
      }

      const project = db.prepare(`SELECT path FROM projects WHERE id = ?`).get(args.projectId) as
        | { path: string }
        | undefined
      if (!project) {
        const payload: ClaudeCodeDoneEvent = { sessionId: args.sessionId, error: 'Project not found.' }
        win?.webContents.send('claudecode:done', payload)
        return null
      }

      // "Inject memory": prepend the project context snapshot to the task.
      let prompt = args.prompt
      if (args.injectMemory) {
        const block = knowledge.formatProjectContext(knowledge.getProjectContext(args.projectId))
        if (block) prompt = `${block}\n\n---\n\nTask:\n${args.prompt}`
      }

      // Effort → the CLI's native `--effort` levels (low|medium|high|xhigh|max),
      // passed through verbatim. 'default' (and the legacy 'normal') omit the
      // flag to preserve the CLI default.
      const effort = args.effort && args.effort !== 'default' && args.effort !== 'normal' ? args.effort : undefined

      // Checkpoint the project folder before Claude Code can touch it, so the
      // user can roll back this task's file changes. Only recorded against a
      // clean git tree — never against the user's own uncommitted work — and
      // never blocks the task from running either way.
      const checkpointAttempt = await tryCreateCheckpoint(project.path)
      let checkpointPayload: CheckpointEvent
      if (checkpointAttempt.ok) {
        const checkpointId = randomUUID()
        db
          .prepare(
            `INSERT INTO checkpoints (id, session_id, message_id, project_path, commit_hash, created_at, description) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(checkpointId, args.sessionId, userMsgId, project.path, checkpointAttempt.commitHash, Date.now(), args.prompt.slice(0, 200))
        checkpointPayload = { sessionId: args.sessionId, messageId: userMsgId, success: true, checkpointId, commitHash: checkpointAttempt.commitHash }
      } else {
        checkpointPayload = { sessionId: args.sessionId, messageId: userMsgId, success: false, reason: checkpointAttempt.reason, error: checkpointAttempt.error }
      }
      win?.webContents.send('claudecode:checkpoint', checkpointPayload)

      const controller = new AbortController()
      ccAborts.set(args.sessionId, controller)
      const run = await runClaudeCode({
        projectPath: project.path,
        prompt,
        systemInstruction: BUILT_IN_PREVIEW_AGENT_INSTRUCTION,
        model: args.model,
        effort,
        thinking: args.thinking,
        permissionMode: args.permissionMode,
        // Expose the bundled knowledge + browser MCP servers to this session.
        // Without this the CLI runs with no MCP tools at all (it never reads
        // claude_desktop_config.json).
        mcpServers: bundledMcpServers(),
        signal: controller.signal,
        onEvent: (e) => {
          const payload: ClaudeCodeIpcEvent = { sessionId: args.sessionId, event: e }
          win?.webContents.send('claudecode:event', payload)
          if (e.kind === 'tool') emitActivity(win, 'CODE', `${e.name}: ${e.summary.slice(0, 80)}`)
          else if (e.kind === 'system') emitActivity(win, 'CODE', e.summary.slice(0, 80))
          else if (e.kind === 'error') emitActivity(win, 'CODE', `Error: ${e.message.slice(0, 80)}`)
          else if (e.kind === 'file_diff') emitActivity(win, 'CODE', `Diff: ${e.path.slice(0, 80)}`)
        }
      })
      ccAborts.delete(args.sessionId)

      // Persist the activity log (for review on reload) and the result text.
      if (run.activity.length > 0) insertMsg('tool', JSON.stringify(run.activity), 'claude-code')
      insertMsg('assistant', run.result || run.error || '(no output)', 'claude-code')

      // After a real task, save a durable summary to memory. Skip pure setup
      // failures (not logged in / not found) — there's nothing worth recording.
      let memorySaved = false
      if (!run.loginRequired && (run.ok || run.activity.length > 0)) {
        const { title, content } = summarizeRun(args.prompt, run)
        await knowledge.saveMemory({
          projectId: args.projectId,
          type: 'task',
          title,
          content,
          source: 'claudecode',
          tags: ['claudecode']
        })
        memorySaved = true
        const payload: IndexUpdatedEvent = { projectIds: [args.projectId] }
        win?.webContents.send('index:updated', payload)
      }

      recordUsage('claudecode', (args.prompt.length + (run.result || '').length) / 4)
      emitActivity(win, 'CODE', run.ok ? `Task complete: ${args.prompt.slice(0, 60)}` : `Task failed`)
      const donePayload: ClaudeCodeDoneEvent = {
        sessionId: args.sessionId,
        ok: run.ok,
        loginRequired: run.loginRequired ?? false,
        memorySaved,
        error: run.ok ? undefined : run.error
      }
      win?.webContents.send('claudecode:done', donePayload)
      return run.result
    }
  )

  // ---- Claude Code checkpoints (git-based rollback) ----
  // checkpoints:create is also exposed directly for completeness/manual use;
  // the normal path is automatic, inside claudecode:send above.
  ipcMain.handle('checkpoints:create', async (_e, sessionId: string, projectPath: string, description: string): Promise<CheckpointResult> => {
    const attempt = await tryCreateCheckpoint(projectPath)
    if (!attempt.ok) return { success: false, reason: attempt.reason, error: attempt.error }
    const id = randomUUID()
    getDb()
      .prepare(
        `INSERT INTO checkpoints (id, session_id, message_id, project_path, commit_hash, created_at, description) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, sessionId, null, projectPath, attempt.commitHash, Date.now(), description)
    return { success: true, commitHash: attempt.commitHash }
  })

  ipcMain.handle('checkpoints:list', (_e, sessionId: string): Checkpoint[] =>
    getDb()
      .prepare(`SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC`)
      .all(sessionId) as Checkpoint[]
  )

  ipcMain.handle('checkpoints:rollback', async (_e, checkpointId: string): Promise<MutationResponse> => {
    const row = getDb().prepare(`SELECT * FROM checkpoints WHERE id = ?`).get(checkpointId) as
      | { project_path: string; commit_hash: string }
      | undefined
    if (!row) return { success: false, error: 'Checkpoint not found' }
    return gitResetHard(row.project_path, row.commit_hash)
  })

  // ---- Hermes (M6) — ACP stdio ----
  // Hermes runs in WSL2 via `hermes acp --accept-hooks` (stdin/stdout JSON-RPC).
  // No HTTP server or polling; one long-lived process shared across sessions.

  ipcMain.handle('hermes:check', (): Promise<HermesCheck> => checkHermes())

  // Cheap connected-state query for the poll loop — returns immediately without
  // spawning wsl.exe when the ACP process is already alive.
  ipcMain.handle('hermes:health', (): { ok: boolean } => ({ ok: hermesConnected() }))

  // Explicit connect (called by the "Connect" button in the UI).
  ipcMain.handle('hermes:connect', async (_e, distro?: string): Promise<{ connected: boolean; version?: string; error?: string }> => {
    const check = await checkHermes()
    return connectHermes(distro ?? check.distro ?? 'Ubuntu')
  })

  // Read all hermes_* config keys from app_meta.
  ipcMain.handle('hermes:getConfig', (): RemoteHermesConfig => getHermesConfig())

  // Write all hermes_* config keys to app_meta; disconnect any active connection.
  ipcMain.handle('hermes:setConfig', (_e, config: RemoteHermesConfig): void => {
    const db = getDb()
    const set = (key: string, value: string) =>
      db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(key, value)
    set('hermes_mode', config.mode)
    set('hermes_ssh_host', config.sshHost)
    set('hermes_ssh_user', config.sshUser)
    set('hermes_ssh_key', config.sshKeyPath)
    set('hermes_hermes_path', config.hermesPath)
    disconnectHermes()
  })

  // Test SSH reachability using the provided (or stored) config.
  ipcMain.handle('hermes:testConnection', async (_e, config?: RemoteHermesConfig): Promise<{ success: boolean; error?: string }> =>
    testHermesConnection(config)
  )

  // ---- Hermes permission modes ----
  // Global default mode lives in app_meta; "always allow this session" overrides
  // live in-memory inside hermes.ts, scoped to our own session id.
  ipcMain.handle('hermes:getPermissionMode', (): HermesPermissionMode => getHermesPermissionMode())

  ipcMain.handle('hermes:setPermissionMode', (_e, mode: HermesPermissionMode): MutationResponse => {
    setHermesPermissionMode(mode)
    return { success: true }
  })

  ipcMain.handle(
    'hermes:respondPermission',
    (
      _e,
      args: HermesRespondPermissionRequest
    ): MutationResponse => {
      if (args.approved && args.alwaysAllowSession && args.actionKind) {
        bumpHermesSessionOverride(args.sessionId, args.actionKind)
      }
      const handled = respondHermesPermission(args.requestId, args.approved)
      return { success: handled }
    }
  )

  // Track in-flight runs by our session id so abort can cancel them.
  const hermesAborts = new Map<string, AbortController>()
  ipcMain.handle('hermes:abort', (_e, sessionId: string): void => {
    hermesAborts.get(sessionId)?.abort()
  })

  // Send a prompt to Hermes, stream events back, persist the turn, save memory.
  ipcMain.handle(
    'hermes:send',
    async (
      event,
      args: HermesSendRequest
    ): Promise<string | null> => {
      const db = getDb()
      const win = BrowserWindow.fromWebContents(event.sender)
      if (isGlobalProjectId(args.projectId)) {
        const payload: HermesDoneEvent = {
          sessionId: args.sessionId,
          ok: false,
          error: 'Hermes needs a project folder. Open a project workspace to use it.'
        }
        win?.webContents.send('hermes:done', payload)
        return null
      }
      const insertMsg = (role: string, content: string, model: string | null) => {
        const ts = Date.now()
        db
          .prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), args.sessionId, role, content, model, ts)
        db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(ts, args.sessionId)
      }

      // Title the session from its first user message (mirrors Claude Code tab).
      const prior = db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`)
        .get(args.sessionId) as { n: number }
      // Regenerate reuses the existing (preceding) user message instead of
      // inserting a duplicate — the caller has already deleted the stale
      // assistant message that followed it.
      if (!args.regenerateMessageId) insertMsg('user', args.prompt, null)
      if (prior.n === 0) {
        const title = args.prompt.trim().replace(/\s+/g, ' ').slice(0, 50) || 'New task'
        db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, args.sessionId)
      }

      const project = db
        .prepare(`SELECT path FROM projects WHERE id = ?`)
        .get(args.projectId) as { path: string } | undefined

      let prompt = args.prompt
      if (args.injectMemory) {
        const block = knowledge.formatProjectContext(knowledge.getProjectContext(args.projectId))
        if (block) prompt = `${block}\n\n---\n\nTask:\n${args.prompt}`
      }

      // Resolve the knowledge MCP server paths for session/new.
      // Hermes (Linux) will spawn Windows node.exe via WSL interop.
      const mcpServers = await resolveHermesMcpServers()

      const controller = new AbortController()
      hermesAborts.set(args.sessionId, controller)
      const transcript: Array<{ kind: 'text'; text: string } | { kind: 'activity'; activity: HermesActivity }> = []
      const appendTranscriptEvent = (e: HermesEvent) => {
        if (e.kind === 'text') {
          const last = transcript[transcript.length - 1]
          if (last?.kind === 'text') last.text += e.text
          else transcript.push({ kind: 'text', text: e.text })
        } else if (e.kind === 'activity') {
          transcript.push({ kind: 'activity', activity: e.activity })
        }
      }

      const run = await runHermesPrompt({
        sessionId: args.sessionId,
        projectPath: project?.path ?? process.cwd(),
        prompt,
        systemInstruction: BUILT_IN_PREVIEW_AGENT_INSTRUCTION,
        mcpServers,
        signal: controller.signal,
        onEvent: (e) => {
          appendTranscriptEvent(e)
          const payload: HermesIpcEvent = { sessionId: args.sessionId, event: e }
          win?.webContents.send('hermes:event', payload)
          if (e.kind === 'usage') {
            const usagePayload: HermesUsageEvent = { used: e.used, max: e.size }
            win?.webContents.send('hermes:usage', usagePayload)
          }
          else if (e.kind === 'activity') emitActivity(win, 'HERMES', `${e.activity.kind}: ${e.activity.message.slice(0, 80)}`)
          else if (e.kind === 'error') emitActivity(win, 'HERMES', `Error: ${e.message.slice(0, 80)}`)
          else if (e.kind === 'model') emitActivity(win, 'HERMES', `Model: ${e.name}`)
        }
      })
      hermesAborts.delete(args.sessionId)

      // Persist the result in the order Hermes produced it: text, tool cards,
      // more text. Older sessions still render via the legacy single-message path.
      let persistedTranscript = false
      for (const segment of transcript) {
        if (segment.kind === 'text') {
          if (segment.text.trim()) {
            insertMsg('assistant', segment.text, 'hermes')
            persistedTranscript = true
          }
        } else {
          insertMsg('tool', JSON.stringify([segment.activity]), 'hermes')
          persistedTranscript = true
        }
      }
      if (!run.ok && run.error && !run.text) {
        insertMsg('assistant', run.error, 'hermes')
        persistedTranscript = true
      }
      if (!persistedTranscript) insertMsg('assistant', run.text || run.error || '(no output)', 'hermes')

      let memorySaved = false
      if (run.ok || run.text) {
        const { title, content } = summarizeHermesRun(args.prompt, run)
        await knowledge.saveMemory({
          projectId: args.projectId,
          type: 'task',
          title,
          content,
          source: 'hermes',
          tags: ['hermes']
        })
        memorySaved = true
        const payload: IndexUpdatedEvent = { projectIds: [args.projectId] }
        win?.webContents.send('index:updated', payload)
      }

      recordUsage('hermes', (args.prompt.length + (run.text || '').length) / 4)
      const donePayload: HermesDoneEvent = {
        sessionId: args.sessionId,
        ok: run.ok,
        memorySaved,
        error: run.ok ? undefined : run.error
      }
      win?.webContents.send('hermes:done', donePayload)
      return run.text || null
    }
  )

  // ---- Kimi (ACP over local stdio) ----
  // `kimi acp` runs directly on Windows (no WSL/SSH — plain PATH binary), so
  // this is simpler than the Hermes wiring above: no distro/mode plumbing.

  ipcMain.handle('kimi:check', (): Promise<KimiCheck> => checkKimi())
  // Model catalog for the Kimi picker — parsed from ~/.kimi-code/config.toml
  // [models.*] entries (see agentModels.ts); deterministic fake list under
  // E2E_FAKE_KIMI.
  ipcMain.handle('kimi:listModels', (): AgentModelInfo[] => listKimiModels())
  ipcMain.handle('kimi:health', (): { ok: boolean } => ({ ok: kimiConnected() }))
  ipcMain.handle('kimi:connect', async (): Promise<{ connected: boolean; version?: string; error?: string }> => {
    const { env } = await resolveKimiMcpAndAuth()
    return connectKimi([], env)
  })

  ipcMain.handle('kimi:getPermissionMode', (): KimiPermissionMode => getKimiPermissionMode())
  ipcMain.handle('kimi:setPermissionMode', (_e, mode: KimiPermissionMode): MutationResponse => {
    setKimiPermissionMode(mode)
    return { success: true }
  })
  ipcMain.handle('kimi:getPlanMode', (): boolean => getKimiPlanMode())
  ipcMain.handle('kimi:setPlanMode', (_e, on: boolean): MutationResponse => {
    setKimiPlanMode(Boolean(on))
    return { success: true }
  })
  ipcMain.handle('kimi:respondPermission', (_e, args: KimiRespondPermissionRequest): MutationResponse => {
    if (args.approved && args.alwaysAllowSession && args.actionKind) {
      bumpKimiSessionOverride(args.sessionId, args.actionKind)
    }
    const handled = respondKimiPermission(args.requestId, args.approved)
    return { success: handled }
  })

  ipcMain.handle('kimi:getAuthMethod', (): KimiAuthMethod => getKimiAuthMethod())
  ipcMain.handle('kimi:setAuthMethod', (_e, method: KimiAuthMethod): MutationResponse => {
    setKimiAuthMethod(method)
    disconnectKimi() // auth changed; force a fresh ACP process on next send
    return { success: true }
  })
  ipcMain.handle('kimi:getAuthStatus', (): KimiAuthStatus => checkKimiAuth())
  ipcMain.handle('kimi:setApiKey', (_e, key: string): MutationResponse => {
    setKimiApiKey(key)
    return { success: true }
  })
  ipcMain.handle('kimi:login', async (event): Promise<{ success: boolean; error?: string }> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return runKimiLogin((e: KimiLoginEvent) => win?.webContents.send('kimi:loginEvent', e))
  })

  const kimiAborts = new Map<string, AbortController>()
  ipcMain.handle('kimi:abort', (_e, sessionId: string): void => {
    kimiAborts.get(sessionId)?.abort()
  })

  ipcMain.handle(
    'kimi:send',
    async (event, args: KimiSendRequest): Promise<string | null> => {
      const db = getDb()
      const win = BrowserWindow.fromWebContents(event.sender)
      if (isGlobalProjectId(args.projectId)) {
        const payload: KimiDoneEvent = {
          sessionId: args.sessionId,
          ok: false,
          error: 'Kimi needs a project folder. Open a project workspace to use it.'
        }
        win?.webContents.send('kimi:done', payload)
        return null
      }
      const insertMsg = (role: string, content: string, model: string | null) => {
        const ts = Date.now()
        db
          .prepare(`INSERT INTO messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), args.sessionId, role, content, model, ts)
        db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(ts, args.sessionId)
      }

      const prior = db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`)
        .get(args.sessionId) as { n: number }
      if (!args.regenerateMessageId) insertMsg('user', args.prompt, null)
      if (prior.n === 0) {
        const title = args.prompt.trim().replace(/\s+/g, ' ').slice(0, 50) || 'New task'
        db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, args.sessionId)
      }

      const project = db
        .prepare(`SELECT path FROM projects WHERE id = ?`)
        .get(args.projectId) as { path: string } | undefined

      let prompt = args.prompt
      if (args.injectMemory) {
        const block = knowledge.formatProjectContext(knowledge.getProjectContext(args.projectId))
        if (block) prompt = `${block}\n\n---\n\nTask:\n${args.prompt}`
      }

      const { mcpServers, env } = await resolveKimiMcpAndAuth()

      const controller = new AbortController()
      kimiAborts.set(args.sessionId, controller)
      const transcript: Array<{ kind: 'text'; text: string } | { kind: 'activity'; activity: KimiActivity }> = []
      const appendTranscriptEvent = (e: KimiEvent) => {
        if (e.kind === 'text') {
          const last = transcript[transcript.length - 1]
          if (last?.kind === 'text') last.text += e.text
          else transcript.push({ kind: 'text', text: e.text })
        } else if (e.kind === 'activity') {
          transcript.push({ kind: 'activity', activity: e.activity })
        }
      }

      const run = await runKimiPrompt({
        sessionId: args.sessionId,
        projectPath: project?.path ?? process.cwd(),
        prompt,
        systemInstruction: BUILT_IN_PREVIEW_AGENT_INSTRUCTION,
        model: args.model,
        configValues: args.configValues,
        mcpServers,
        authEnv: env,
        signal: controller.signal,
        onEvent: (e) => {
          appendTranscriptEvent(e)
          const payload: KimiIpcEvent = { sessionId: args.sessionId, event: e }
          win?.webContents.send('kimi:event', payload)
          if (e.kind === 'usage') {
            const usagePayload: KimiUsageEvent = { used: e.used, max: e.size }
            win?.webContents.send('kimi:usage', usagePayload)
          }
          else if (e.kind === 'activity') emitActivity(win, 'KIMI', `${e.activity.kind}: ${e.activity.message.slice(0, 80)}`)
          else if (e.kind === 'error') emitActivity(win, 'KIMI', `Kimi error: ${e.message.slice(0, 80)}`)
          else if (e.kind === 'model') emitActivity(win, 'KIMI', `Kimi model: ${e.name}`)
        }
      })
      kimiAborts.delete(args.sessionId)

      let persistedTranscript = false
      for (const segment of transcript) {
        if (segment.kind === 'text') {
          if (segment.text.trim()) {
            insertMsg('assistant', segment.text, 'kimi')
            persistedTranscript = true
          }
        } else {
          insertMsg('tool', JSON.stringify([segment.activity]), 'kimi')
          persistedTranscript = true
        }
      }
      if (!run.ok && run.error && !run.text) {
        insertMsg('assistant', run.error, 'kimi')
        persistedTranscript = true
      }
      if (!persistedTranscript) insertMsg('assistant', run.text || run.error || '(no output)', 'kimi')

      let memorySaved = false
      if (run.ok || run.text) {
        const { title, content } = summarizeKimiRun(args.prompt, run)
        await knowledge.saveMemory({
          projectId: args.projectId,
          type: 'task',
          title,
          content,
          source: 'kimi',
          tags: ['kimi']
        })
        memorySaved = true
        const payload: IndexUpdatedEvent = { projectIds: [args.projectId] }
        win?.webContents.send('index:updated', payload)
      }

      recordUsage('kimi', (args.prompt.length + (run.text || '').length) / 4)
      const donePayload: KimiDoneEvent = {
        sessionId: args.sessionId,
        ok: run.ok,
        memorySaved,
        error: run.ok ? undefined : run.error
      }
      win?.webContents.send('kimi:done', donePayload)
      return run.text || null
    }
  )

  // ---- Hermes skills (Extensions panel Skills tab) ----
  // Talks to the Hermes dashboard HTTP API (port 9119) from the main process;
  // the renderer's CSP blocks direct fetches, same as the MCP registry proxy.
  ipcMain.handle('hermesSkills:list', async (): Promise<HermesSkillsListResponse> => {
    try {
      const skills = await listSkills()
      return { success: true, skills }
    } catch (err) {
      return { success: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  ipcMain.handle('hermesSkills:toggle', async (_e, name: string, enabled: boolean): Promise<HermesSkillsToggleResponse> => {
    try {
      await toggleSkill(name, enabled)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  ipcMain.handle('hermesSkills:search', async (_e, query: string): Promise<HermesSkillsSearchResponse> => {
    try {
      const results = await searchSkillsHub(query)
      return { success: true, results }
    } catch (err) {
      return { success: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  ipcMain.handle('hermesSkills:install', async (_e, identifier: string): Promise<HermesSkillsInstallResponse> => {
    try {
      const result = await installSkillFromHub(identifier)
      return { success: true, ...result }
    } catch (err) {
      return { success: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  // ---- Terminal (Phase F) ----
  // node-pty is a native module — use require() so Electron-vite doesn't try to
  // bundle it. It must only be loaded in the main process.
  ipcMain.handle('terminal:create', (event, projectPath: string | null): TerminalCreateResponse => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePty = require('node-pty') as typeof import('node-pty')
    const id = randomUUID()
    const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
    const cwd = projectPath && existsSync(projectPath) ? projectPath : process.cwd()
    const win = BrowserWindow.fromWebContents(event.sender)
    const pty = nodePty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as Record<string, string>
    })
    pty.onData((data: string) => {
      const payload: TerminalDataEvent = { id, data }
      win?.webContents.send('terminal:data', payload)
      noteTerminalOutput(cwd, data)
    })
    pty.onExit(() => {
      ptyMap.delete(id)
      const payload: TerminalExitEvent = { id }
      win?.webContents.send('terminal:exit', payload)
    })
    ptyMap.set(id, { pty, win })
    return { id }
  })

  ipcMain.handle('terminal:write', (_e, id: string, data: string): void => {
    ptyMap.get(id)?.pty.write(data)
  })

  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number): void => {
    const entry = ptyMap.get(id)
    if (entry) {
      try { entry.pty.resize(Math.max(1, cols), Math.max(1, rows)) } catch {}
    }
  })

  ipcMain.handle('terminal:close', (_e, id: string): void => {
    const entry = ptyMap.get(id)
    if (entry) {
      try { entry.pty.kill() } catch {}
      ptyMap.delete(id)
    }
  })

  // ---- Usage (informational message/task counts, no cost estimates) ----
  ipcMain.handle('usage:today', (): UsageSummaryRow[] => getTodayUsage())

  // ---- Contextual tips (see src/renderer/src/tips.ts for the trigger rules) ----
  ipcMain.handle('tips:stats', (): TipStats => {
    const db = getDb()
    const byMode = db.prepare('SELECT mode, COUNT(*) as cnt FROM sessions GROUP BY mode').all() as { mode: string; cnt: number }[]
    const chatSessions = byMode.find((r) => r.mode === 'chat')?.cnt ?? 0
    const hermesSessions = byMode.find((r) => r.mode === 'hermes')?.cnt ?? 0
    const totalSessions = byMode.reduce((sum, r) => sum + r.cnt, 0)
    const usedHandoff = readMeta('used_handoff') === 'true'
    return { chatSessions, hermesSessions, totalSessions, usedHandoff }
  })

  ipcMain.handle('tips:shownIds', (): string[] =>
    (getDb().prepare('SELECT tip_id FROM shown_tips').all() as { tip_id: string }[]).map((r) => r.tip_id)
  )

  ipcMain.handle('tips:markShown', (_e, tipId: string): void => {
    getDb().prepare('INSERT OR IGNORE INTO shown_tips (tip_id, shown_at, dismissed) VALUES (?, ?, 0)').run(tipId, Date.now())
  })

  ipcMain.handle('tips:dismiss', (_e, tipId: string): void => {
    const db = getDb()
    db.prepare('INSERT OR IGNORE INTO shown_tips (tip_id, shown_at, dismissed) VALUES (?, ?, 0)').run(tipId, Date.now())
    db.prepare('UPDATE shown_tips SET dismissed = 1 WHERE tip_id = ?').run(tipId)
  })

  ipcMain.handle('tips:markHandoffUsed', (): void => writeMeta('used_handoff', 'true'))

  // ---- Settings (typed app_meta wrapper; secrets are write-only to renderer) ---
  ipcMain.handle('settings:get', (_e, key: string): string | null => publicSettingValue(key))

  ipcMain.handle('settings:getMany', (_e, keys: string[]): Record<string, string | null> => {
    const out: Record<string, string | null> = {}
    for (const key of keys) out[key] = publicSettingValue(key)
    return out
  })

  ipcMain.handle('settings:set', (_e, key: string, value: string): void => {
    const def = SETTING_DEFINITIONS[key]
    if (!def) throw new Error(`Unsupported setting: ${key}`)
    const clean = validateSetting(def, value)
    if (def.secret && !clean) deleteMeta(key)
    else writeMeta(key, clean)
  })

  ipcMain.handle('settings:setMany', (_e, values: Record<string, string>): void => {
    for (const [key, value] of Object.entries(values)) {
      const def = SETTING_DEFINITIONS[key]
      if (!def) throw new Error(`Unsupported setting: ${key}`)
      const clean = validateSetting(def, value)
      if (def.secret && !clean) deleteMeta(key)
      else writeMeta(key, clean)
    }
  })

  ipcMain.handle('settings:delete', (_e, key: string): void => {
    if (!SETTING_DEFINITIONS[key]) throw new Error(`Unsupported setting: ${key}`)
    deleteMeta(key)
  })

  ipcMain.handle('settings:summary', (): SettingsSummary => buildSettingsSnapshot())
  ipcMain.handle('settings:diagnostics', (): Promise<SettingsDiagnostics> => buildDiagnosticsReport())

  // Import settings from an exported JSON file. Only known, non-secret setting
  // keys are accepted, and every value passes through the same validation as
  // settings:set. Secrets (keys/tokens/passwords) are never imported.
  ipcMain.handle('settings:import', (_e, jsonString: string): SettingsImportResponse => {
    try {
      const data = JSON.parse(jsonString)
      if (!data || typeof data !== 'object' || !data.settings || typeof data.settings !== 'object') {
        return { success: false, error: 'Invalid settings file format' }
      }
      // Accept both a flat key/value map and the exported summary shape
      // ({ settings: { values: {...}, secrets: {...} } }) so round-tripping
      // the existing "Export settings summary" output works.
      const source: Record<string, unknown> =
        data.settings.values && typeof data.settings.values === 'object'
          ? data.settings.values
          : data.settings
      let imported = 0
      for (const [key, value] of Object.entries(source)) {
        if (/key|token|password|secret/i.test(key)) continue
        if (typeof value !== 'string') continue
        const def = SETTING_DEFINITIONS[key]
        if (!def || def.secret) continue
        writeMeta(key, validateSetting(def, value))
        imported++
      }
      return { success: true, imported }
    } catch (err) {
      return { success: false, error: String(err instanceof Error ? err.message : err) }
    }
  })

  // ---- Browser panel (manual WebContentsView browsing) -------------------------
  // Native Chromium views managed in browserPanel.ts, positioned over a renderer
  // placeholder via browser:setBounds. Phase 1 is manual browsing only.
  ipcMain.handle('browser:createTab', (e, url?: string): string => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('No host window for browser panel')
    return createBrowserTab(win, url)
  })
  ipcMain.handle('browser:closeTab', (_e, tabId: string): void => closeBrowserTab(tabId))
  ipcMain.handle('browser:setActiveTab', (_e, tabId: string): void => setActiveBrowserTab(tabId))
  ipcMain.handle('browser:navigate', (_e, tabId: string, url: string): void => navigateBrowserTab(tabId, url))
  ipcMain.handle('browser:navigatePreview', (_e, tabId: string, url: string): void => navigatePreviewTab(tabId, url))
  ipcMain.handle('browser:setPreviewMode', (_e, tabId: string, enabled: boolean): void =>
    setBrowserPreviewMode(tabId, Boolean(enabled))
  )
  ipcMain.handle('browser:detectPreview', async (_e, projectId: string): Promise<BrowserPreviewDetectionResult> => {
    if (!projectId || isGlobalProjectId(projectId)) {
      return { urls: [], suggestions: [], signals: [], probedPorts: [], timeoutMs: 450, error: 'Select a project workspace first.' }
    }
    const project = getDb().prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string } | undefined
    if (!project?.path || !existsSync(project.path)) {
      return { urls: [], suggestions: [], signals: [], probedPorts: [], timeoutMs: 450, error: 'Project folder is unavailable.' }
    }
    try {
      return await detectProjectPreview(project.path)
    } catch (err) {
      return { urls: [], suggestions: [], signals: [], probedPorts: [], timeoutMs: 450, error: errorMessage(err) }
    }
  })
  ipcMain.handle('browser:inspectPreview', (_e, tabId: string): Promise<BrowserPreviewInspection> => inspectPreviewTab(tabId))
  ipcMain.handle('browser:goBack', (_e, tabId: string): void => browserGoBack(tabId))
  ipcMain.handle('browser:goForward', (_e, tabId: string): void => browserGoForward(tabId))
  ipcMain.handle('browser:reload', (_e, tabId: string): void => reloadBrowserTab(tabId))
  ipcMain.handle('browser:stop', (_e, tabId: string): void => stopBrowserTab(tabId))
  ipcMain.handle('browser:setBounds', (_e, tabId: string, bounds: BrowserBounds): void =>
    setBrowserViewBounds(tabId, bounds)
  )
  ipcMain.handle('browser:hideAll', (): void => hideAllBrowserViews())
  ipcMain.handle('browser:parkForDrag', (): void => parkAllForDrag())
  ipcMain.handle('browser:restoreAfterDrag', (): void => restoreAfterDrag())
  ipcMain.handle('browser:listTabs', (): BrowserTabListResponse => listBrowserTabs())
  ipcMain.handle('browser:getDownloads', (): BrowserDownloadStatus[] => agentGetDownloads())
  ipcMain.handle('browser:reloadSessions', (e): void => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) reloadBrowserSessions(win)
  })

  // ---- Preview panel (read-only, user-only live viewer) -----------------------
  // A second, isolated WebContentsView surface — see previewPanel.ts. It has no
  // MCP exposure and is not registered with the browser-control server.
  ipcMain.handle('preview:navigate', (_e, url: string): void => navigatePreviewUrl(url))
  ipcMain.handle('preview:reload', (): void => reloadPreview())
  ipcMain.handle('preview:stop', (): void => stopPreview())
  ipcMain.handle('preview:setBounds', (_e, bounds: BrowserBounds): void => setPreviewBounds(bounds))
  ipcMain.handle('preview:hideAll', (): void => hidePreviewView())
  ipcMain.handle('preview:parkForDrag', (): void => parkPreviewForDrag())
  ipcMain.handle('preview:restoreAfterDrag', (): void => restorePreviewAfterDrag())
  ipcMain.handle('preview:getState', (): PreviewPanelState => getPreviewState())
  ipcMain.handle('preview:getDetectedUrl', (_e, projectId: string): string | null => {
    if (!projectId || isGlobalProjectId(projectId)) return null
    const project = getDb().prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string } | undefined
    if (!project?.path) return null
    return getLastDetectedDevServerUrl(project.path)
  })

  // Application-level approval queue. This is deliberately outside Hermes so
  // Browser requests from every MCP client share one renderer surface.
  ipcMain.handle('approvals:list', (): BrowserApprovalRequest[] => browserApprovals.listPending())
  ipcMain.handle(
    'approvals:respond',
    (_e, decision: BrowserApprovalDecision): Promise<BrowserApprovalResult> => browserApprovals.respond(decision)
  )

  // ---- Git status (Navigator file tree indicators) -----------------------------
  // Returns porcelain status keyed by repo-relative path (forward slashes).
  // Not a git repo / git missing is a normal state, not an error.
  ipcMain.handle('git:status', async (_e, projectPath: string): Promise<GitStatusResponse> => {
    // Short-circuit non-repos so we never spawn git for a folder without .git.
    if (!isGitRepo(projectPath)) return { isGitRepo: false, files: {} }
    try {
      // Async (execFile, not execSync) so a slow git never blocks the main
      // process event loop / other IPC while it runs.
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: projectPath,
        timeout: 5000,
        windowsHide: true
      })
      const files: Record<string, string> = {}
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const status = line.substring(0, 2).trim()
        let filePath = line.substring(3).trim()
        // Renames are reported as "R  old -> new"; the new path is what exists.
        const arrow = filePath.indexOf(' -> ')
        if (arrow !== -1) filePath = filePath.slice(arrow + 4)
        // Paths with spaces/special chars come back quoted.
        if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1)
        files[filePath] = status
      }
      return { isGitRepo: true, files }
    } catch {
      return { isGitRepo: false, files: {} }
    }
  })

  // ---- Setup wizard (first-run experience) ------------------------------------
  ipcMain.handle('setup:detectTools', async (): Promise<ToolDetection> => {
    return await detectCliTools()
  })

  ipcMain.handle('setup:isComplete', async (): Promise<boolean> => {
    return await setupWizardComplete()
  })

  ipcMain.handle('setup:markComplete', async (_e, complete?: boolean): Promise<void> => {
    return await markSetupWizardComplete(complete !== false)
  })

  // ---- Web Companion ---------------------------------------------------------
  // Optional mobile Chat surface. This intentionally exposes only its own
  // lifecycle/config controls to the desktop renderer; browser clients get a
  // separate, authenticated, narrow HTTP API in webCompanion.ts.
  ipcMain.handle('webCompanion:status', (): WebCompanionStatus => getWebCompanionStatus())
  ipcMain.handle('webCompanion:configure', (_e, config: WebCompanionConfigureRequest): Promise<WebCompanionStatus> =>
    configureWebCompanion(config)
  )
  ipcMain.handle('webCompanion:regenerateToken', (): WebCompanionRegenerateResponse => regenerateWebCompanionToken())

  // ---- Research pipeline ------------------------------------------------------
  let researchController: AbortController | null = null

  ipcMain.handle('research:cancel', (): void => {
    researchController?.abort()
    researchController = null
  })

  ipcMain.handle(
    'research:start',
    async (
      event,
      args: ResearchStartRequest
    ): Promise<void> => {
      researchController?.abort()
      researchController = new AbortController()
      const signal = researchController.signal
      const researchWin = BrowserWindow.fromWebContents(event.sender)

      const emit = (stage: ResearchProgress['stage'], status: ResearchProgress['status'], detail: string) => {
        if (event.sender.isDestroyed()) return
        const payload: ResearchProgress = { stage, status, detail }
        event.sender.send('research:progress', payload)
        // Mirror stage transitions into the Activity feed (skip 'done'/'error'
        // meta-stages whose detail is the full report / error body).
        if (status === 'running') emitActivity(researchWin, 'RESEARCH', `Stage: ${stage}`)
        else if (status === 'error') {
          const where = stage === 'error' ? 'Research error' : `Error in ${stage}`
          emitActivity(researchWin, 'RESEARCH', `${where}: ${detail.slice(0, 80)}`)
        }
      }

      // Honor the configurable source cap (Settings → Research).
      // Quick mode is hard-capped at 3 sources and skips the deep-read stage.
      const quick = args.quick === true
      const rawLimit = Number(readMeta('research_result_limit') ?? '8')
      const configuredLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(50, Math.round(rawLimit)) : 8
      const resultLimit = quick ? 3 : configuredLimit

      try {
        // Stage 1: Plan
        emit('plan', 'running', 'Planning search queries...')

        const model = await defaultChatModel()
        if (!model) {
          emit('plan', 'error', 'No local model available. Start Ollama and pull a model.')
          return
        }
        if (signal.aborted) return

        let queries: string[] = [args.topic]
        if (args.scope !== 'local') {
          const planResult = await chat(
            model,
            [
              {
                role: 'system',
                content:
                  "You are a research assistant. Break down the user's research topic into 3-5 specific search queries that together would give comprehensive coverage. Return ONLY a JSON array of strings, no other text."
              },
              { role: 'user', content: `Topic: ${args.topic}` }
            ],
            30000
          )
          if (signal.aborted) return
          if (planResult) {
            try {
              const s = planResult.indexOf('[')
              const e = planResult.lastIndexOf(']')
              if (s !== -1 && e !== -1) {
                const parsed = JSON.parse(planResult.slice(s, e + 1))
                if (Array.isArray(parsed) && parsed.length > 0) {
                  queries = parsed.filter((q): q is string => typeof q === 'string').slice(0, 5)
                }
              }
            } catch { /* use topic as single query */ }
          }
        }

        emit('plan', 'done', `${queries.length} ${queries.length === 1 ? 'query' : 'queries'} ready`)
        if (signal.aborted) return

        // Stage 2: Search
        emit('search', 'running', 'Searching...')

        interface SearchResult { title: string; url: string; content: string; isLocal?: boolean }
        const allResults: SearchResult[] = []
        const seenUrls = new Set<string>()
        let webOk = true

        if (args.scope === 'web' || args.scope === 'both') {
          const searxngUrl = getSearxngUrl()
          for (const query of queries) {
            if (signal.aborted) return
            try {
              const searchUrl = `${searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&engines=google,duckduckgo&language=en`
              const res = await fetch(searchUrl, { signal: AbortSignal.timeout(10000) })
              if (!res.ok) throw new Error(`HTTP ${res.status}`)
              const data = await res.json() as {
                results?: Array<{ title?: string; url?: string; content?: string }>
              }
              for (const r of (data.results ?? []).slice(0, 5)) {
                const rUrl = r.url ?? ''
                if (!rUrl || seenUrls.has(rUrl)) continue
                seenUrls.add(rUrl)
                allResults.push({ title: r.title ?? rUrl, url: rUrl, content: r.content ?? '' })
              }
            } catch (e: unknown) {
              if (signal.aborted) return
              webOk = false
              emit(
                'search',
                'error',
                `SearXNG unreachable: ${errorMessage(e)}. Falling back to local knowledge.`
              )
              break
            }
          }
        }

        // Local knowledge — always include if scope includes it, or if web failed
        if (args.scope === 'local' || args.scope === 'both' || !webOk) {
          const localItems = await knowledge.searchMemory(args.topic, 'project', args.projectId, 8)
          for (const item of localItems) {
            const kUrl = `knowledge://${item.id}`
            if (seenUrls.has(kUrl)) continue
            seenUrls.add(kUrl)
            allResults.push({
              title: item.title,
              url: kUrl,
              content: item.content,
              isLocal: true
            })
          }
        }

        if (signal.aborted) return

        if (allResults.length === 0) {
          emit('search', 'error', 'No results found. Check SearXNG or add local knowledge.')
          return
        }

        // Cap how many sources the Read stage fetches + summarizes.
        if (allResults.length > resultLimit) allResults.length = resultLimit

        emit('search', 'done', `Found ${allResults.length} ${allResults.length === 1 ? 'result' : 'results'}`)

        // Stage 3: Read
        emit('read', 'running', `Reading sources (0/${allResults.length})...`)

        interface ProcessedSource { title: string; url: string; bullets: string }
        const processed: ProcessedSource[] = []

        if (quick) {
          // Quick mode: no page fetches, no per-source model pass — the search
          // snippets go straight to synthesis.
          for (const src of allResults) {
            processed.push({
              title: src.title,
              url: src.url,
              bullets: src.content ? `- ${src.content}` : `- Source: ${src.title}`
            })
          }
        } else {
          // Full read of one source: fetch the page (falling back to the search
          // snippet) and distill it to bullet points with the local model.
          const readSource = async (src: SearchResult): Promise<ProcessedSource> => {
            let content = src.content
            if (!src.isLocal) {
              try {
                const pageRes = await fetch(src.url, {
                  signal: AbortSignal.timeout(5000),
                  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai-workspace-research/1.0)' }
                })
                if (pageRes.ok) content = stripHtml(await pageRes.text())
              } catch { /* use SearXNG snippet */ }
            }
            const bullets = await chat(
              model,
              [
                {
                  role: 'system',
                  content: `Extract the most important facts, data points, and insights from this source relevant to: ${args.topic}. Be concise. Return 3-5 bullet points maximum.`
                },
                { role: 'user', content: `${src.title}\n${content.slice(0, 2000)}` }
              ],
              30000
            )
            return { title: src.title, url: src.url, bullets: bullets ?? `- Source: ${src.title}` }
          }

          // Read in parallel batches of 3 so fetches overlap instead of
          // running one at a time.
          const batchSize = 3
          for (let i = 0; i < allResults.length; i += batchSize) {
            if (signal.aborted) return
            const batch = allResults.slice(i, i + batchSize)
            const batchResults = await Promise.allSettled(batch.map(readSource))
            for (let j = 0; j < batchResults.length; j++) {
              const r = batchResults[j]
              if (r.status === 'fulfilled') processed.push(r.value)
              else processed.push({ title: batch[j].title, url: batch[j].url, bullets: `- Source: ${batch[j].title}` })
            }
            const done = Math.min(i + batch.length, allResults.length)
            emit('read', 'running', `Reading sources (${done}/${allResults.length})...`)
            emitActivity(researchWin, 'RESEARCH', `Read ${done}/${allResults.length} sources`)
          }
        }

        emit('read', 'done', `Analyzed ${processed.length} sources`)
        if (signal.aborted) return

        // Stage 4: Synthesize
        emit('synthesize', 'running', 'Synthesizing findings...')

        // Guard against prompts that exceed what small local models can handle.
        const MAX_FINDINGS_LEN = 6000
        let sourcesText = processed
          .map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.bullets}`)
          .join('\n\n')
        if (sourcesText.length > MAX_FINDINGS_LEN) {
          sourcesText = sourcesText.slice(0, MAX_FINDINGS_LEN) + '\n... [truncated for length]'
        }

        let reportBody: string | null = null
        try {
          reportBody = await chat(
            model,
            [
              {
                role: 'system',
                content: quick
                  ? 'You are a research analyst. Write a concise research brief in markdown format, around 300 words: a short summary followed by the key findings with source citations by number. No deeper analysis section.'
                  : 'You are a research analyst. Write a comprehensive research report in markdown format. Include: a summary section, key findings with source citations, and a deeper analysis section. Use the sources provided. Be factual and cite sources by number.'
              },
              {
                role: 'user',
                content: `Topic: ${args.topic}\n\nSources and findings:\n${sourcesText}`
              }
            ],
            120000
          )
          if (reportBody === null) {
            console.error('[research] synthesis returned null — model may be unavailable or timed out')
          }
        } catch (err) {
          console.error('[research] synthesis error:', err)
        }
        if (signal.aborted) return

        const dateStr = new Date().toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })
        const sourcesList = processed.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n')

        // Fallback: structured bullet points grouped by source when the model didn't respond.
        const bodySection = reportBody ?? [
          '### Findings from Sources',
          '',
          processed.map(s => `**${s.title}**\n${s.bullets}`).join('\n\n'),
        ].join('\n')

        const fullReport = [
          `## ${args.topic}`,
          '',
          `*Researched ${dateStr} · ${processed.length} sources*`,
          '',
          bodySection,
          '',
          '### Sources',
          sourcesList,
        ].join('\n')

        emit('synthesize', 'done', 'Report ready')
        if (signal.aborted) return

        // Stage 5: Save
        emit('save', 'running', 'Saving to knowledge base...')

        let savedCount = 0
        try {
          await knowledge.saveMemory({
            projectId: args.saveToProject ? args.projectId : null,
            type: 'research',
            title: args.topic,
            content: fullReport,
            source: 'research',
            tags: ['research', 'deep-research']
          })
          savedCount++

          for (const src of processed.slice(0, 5)) {
            if (signal.aborted) break
            await knowledge.saveMemory({
              projectId: args.saveToProject ? args.projectId : null,
              type: 'research-finding',
              title: `${args.topic}: ${src.title}`.slice(0, 120),
              content: src.bullets,
              source: 'research',
              tags: ['research', 'finding']
            })
            savedCount++
          }
        } catch (e: unknown) {
          emit('save', 'error', `Save failed: ${errorMessage(e)}`)
        }

        if (signal.aborted) return
        emit('save', 'done', `Saved ${savedCount} items to knowledge base`)
        emit('done', 'done', fullReport)
      } catch (e: unknown) {
        if (!signal.aborted) emit('error', 'error', errorMessage(e))
      } finally {
        researchController = null
      }
    }
  )

  // ---- Layout presets ----
  type StoredPreset = LayoutPreset

  function getStoredPresets(): StoredPreset[] {
    try {
      const raw = readMeta('layout_presets')
      if (!raw) return []
      return JSON.parse(raw) as StoredPreset[]
    } catch {
      return []
    }
  }

  ipcMain.handle('presets:list', (): LayoutPreset[] => getStoredPresets())

  ipcMain.handle('presets:save', (_e, name: string, layout: LayoutNode | null, openIds: DockPanel[], workspaceId: string): LayoutPreset => {
    const all = getStoredPresets()
    const preset: StoredPreset = { id: randomUUID(), name, created_at: Date.now(), layout, openIds, workspaceId }
    all.push(preset)
    writeMeta('layout_presets', JSON.stringify(all))
    return preset
  })

  ipcMain.handle('presets:load', (_e, id: string): LayoutPreset | null => {
    return getStoredPresets().find(p => p.id === id) ?? null
  })

  ipcMain.handle('presets:delete', (_e, id: string): void => {
    const filtered = getStoredPresets().filter(p => p.id !== id)
    writeMeta('layout_presets', JSON.stringify(filtered))
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string): Promise<void> => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  // ---- Instruction file editor ----
  // Instruction files live either in a project (CLAUDE.md/HERMES.md/CODEX.md/AI.md)
  // or next to the app (the 'app' agent's own CLAUDE.md) — exactly the roots
  // instructions:getPath below can produce, so scoping to them costs nothing.
  ipcMain.handle('instructions:read', async (_e, filePath: string): Promise<InstructionsReadResponse> => {
    const scoped = resolveWithinRoots(filePath, allowedFsRoots(), 'instruction file')
    if ('error' in scoped) return { exists: false, content: '', error: scoped.error }
    try {
      if (!existsSync(scoped.target)) return { exists: false, content: '' }
      const content = readFileSync(scoped.target, 'utf-8')
      return { exists: true, content }
    } catch (err) {
      return { exists: false, content: '', error: String(err) }
    }
  })

  ipcMain.handle('instructions:write', async (_e, filePath: string, content: string): Promise<InstructionsWriteResponse> => {
    const scoped = resolveWithinRoots(filePath, allowedFsRoots(), 'instruction file')
    if ('error' in scoped) return { success: false, error: scoped.error }
    try {
      mkdirSync(dirname(scoped.target), { recursive: true })
      writeFileSync(scoped.target, content, 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('instructions:getPath', async (_e, agentId: string, projectPath: string): Promise<string | null> => {
    // The app's own CLAUDE.md lives next to the app, wherever it runs from —
    // never a hardcoded absolute path.
    if (agentId === 'app') return join(app.getAppPath(), 'CLAUDE.md')
    const fileNames: Record<string, string> = {
      'claudecode': 'CLAUDE.md',
      'hermes':     'HERMES.md',
      'codex':      'CODEX.md',
      'shared':     'AI.md'
    }
    const fileName = fileNames[agentId]
    if (!fileName) return null
    return join(projectPath, fileName)
  })

  // ---- MCP Registry proxy (renderer cannot fetch external URLs due to CSP) ----
  ipcMain.handle('registry:search', async (_e, query: string, cursor: string): Promise<RegistrySearchResponse> => {
    const base = 'https://registry.modelcontextprotocol.io/v0'
    const cleanQuery = String(query ?? '').trim()
    const cleanCursor = String(cursor ?? '').trim()
    let url = `${base}/servers?limit=20`
    if (cleanQuery) url += `&search=${encodeURIComponent(cleanQuery)}`
    if (cleanCursor) url += `&cursor=${encodeURIComponent(cleanCursor)}`

    if (process.env.E2E_FAKE_REGISTRY === '1') {
      const fakeQuery = cleanQuery || 'github'
      const fakeResponse: RegistrySearchResponse = {
        servers: [{
          server: {
            id: `mock-${fakeQuery}-${cleanCursor || 'first'}`,
            name: `@modelcontextprotocol/server-${fakeQuery}`,
            title: `${fakeQuery} MCP Server`,
            description: `Mock registry result for ${fakeQuery}.`,
            packages: [{ registry_name: 'npm', name: `@modelcontextprotocol/server-${fakeQuery}`, version: '1.0.0' }],
            repository: { url: 'https://example.com/mcp' },
            updated_at: '2026-01-02T00:00:00.000Z'
          }
        }],
        metadata: { nextCursor: cleanCursor ? null : 'cursor-2' }
      }
      return fakeResponse
    }

    let res: Response
    try {
      res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      })
    } catch (err: unknown) {
      if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error('Registry request timed out. Try again in a moment.')
      }
      throw new Error(`Registry network failure: ${errorMessage(err)}`)
    }

    if (!res.ok) throw new Error(`Registry returned HTTP ${res.status}`)

    let data: unknown
    try {
      data = await res.json()
    } catch {
      throw new Error('Registry returned invalid JSON.')
    }

    if (!data || typeof data !== 'object') {
      throw new Error('Registry returned an unexpected response shape.')
    }
    const response = data as { servers?: unknown; metadata?: unknown }
    if (!Array.isArray(response.servers)) {
      throw new Error('Registry returned an unexpected response shape.')
    }
    if (response.metadata !== undefined && (response.metadata === null || typeof response.metadata !== 'object')) {
      throw new Error('Registry returned invalid pagination metadata.')
    }
    return data as RegistrySearchResponse
  })

  // A background agent finished while the window wasn't focused — surface a
  // taskbar attention cue. No-op if the window is already focused (the
  // renderer only calls this for background completions, but re-check here
  // in case focus changed between the check and the IPC round-trip).
  ipcMain.handle('window:notifyActivity', (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isFocused()) return
    if (process.platform === 'win32') win.flashFrame(true)
    else app.setBadgeCount(1)
  })

  ipcMain.handle('window:notifyApproval', (event, payload: { source: 'browser' | 'hermes' | 'kimi'; summary: string; panelActive?: boolean }): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isFocused() && payload.panelActive) return
    showNotification(win, {
      title: payload.source === 'hermes' ? 'Hermes needs approval' : payload.source === 'kimi' ? 'Kimi needs approval' : 'Browser approval needed',
      body: payload.summary
    })
  })
}

// ---- MCP server path resolution --------------------------------------------
// Builds the mcpServers array for session/new so Hermes can reach the knowledge
// MCP server. Resolves paths lazily (once per send that needs them); errors are
// non-fatal (Hermes still works without MCP, just without shared memory).
/**
 * The two bundled MCP servers this app ships, keyed by name, built from the
 * single source-of-truth launch configs in mcp.ts. This is the config handed to
 * a Claude Code / Codex spawn so the session actually has knowledge_* and
 * browser_* tools (neither CLI reads claude_desktop_config.json). The Hermes ACP
 * path builds its own variant — see resolveHermesMcpServers — because it must
 * run the servers Windows-side via WSL interop.
 */
function bundledMcpServers(): Record<string, McpServerConfig> {
  return {
    'ai-workspace-knowledge': knowledgeMcpLaunchConfig(
      join(app.getAppPath(), 'out', 'mcp', 'server.cjs'),
      app.getPath('userData')
    ),
    'ai-workspace-browser': browserMcpLaunchConfig(
      join(app.getAppPath(), 'out', 'mcp', 'browser-server.cjs'),
      browserControlPort(),
      browserControlIdentityToken
    )
  }
}

// Kimi runs Windows-side directly (plain PATH binary, no WSL/SSH). Verified
// against the real installed binary (kimi-code CLI 0.27.0, confirmed via
// `kimi acp --help` / `kimi --version`): `kimi acp` takes only `--login`/`-h`
// — there is no `--mcp-config-file` (or any other) flag, and no fixed-path
// mcp.json that `kimi doctor` recognizes (it only checks config.toml and
// tui.toml). The real, protocol-native mechanism is the ACP `session/new`
// request's `mcpServers` array param — already wired through
// runKimiPrompt()/newSession() in kimi.ts.
//
// CAVEAT (also verified against the real binary): `initialize`'s
// `agentCapabilities.mcpCapabilities` on this build reports only
// `{ http: true, sse: true }` — no `stdio` key. A live test (spawning
// `kimi acp` directly and passing our stdio ai-workspace-knowledge server via
// `session/new.mcpServers`) confirmed this is not just an advertisement gap:
// the session started without error, but the server's tools never appeared
// in Kimi's tool list — only Kimi's own built-ins did. Our bundled servers
// (server.cjs / browser-server.cjs) only implement StdioServerTransport, so
// there is currently no working transport between them and this Kimi build.
// We still pass the array (correct per-protocol, harmless, and forward
// compatible if a future Kimi build adds stdio support) but tool calls
// through Kimi should not be expected to work until either Kimi adds stdio
// support or our servers grow an http/sse transport.
function kimiMcpServersArray(): object[] {
  const active = getActiveMcpServers()
  const all = bundledMcpServers()
  const names = Object.keys(all).filter((name) => active[name])
  return names.map((name) => {
    const cfg = all[name]
    return {
      name,
      command: cfg.command,
      args: cfg.args ?? [],
      env: Object.entries(cfg.env ?? {}).map(([k, v]) => ({ name: k, value: v }))
    }
  })
}

/**
 * Resolves per-send Kimi extras: the ACP-native mcpServers array (see above)
 * plus the API-key auth env var when the API-key auth method is selected.
 * The API-key env-var fallback remains best-effort/unverified — Kimi's docs
 * describe config-file-based alternative providers but don't confirm an
 * env-var override works against a real `kimi acp` process.
 */
async function resolveKimiMcpAndAuth(): Promise<{ mcpServers: object[]; env?: Record<string, string> }> {
  const mcpServers = kimiMcpServersArray()

  let env: Record<string, string> | undefined
  if (getKimiAuthMethod() === 'apikey') {
    const row = getDb().prepare('SELECT value FROM app_meta WHERE key = ?').get('kimi_api_key') as
      | { value: string }
      | undefined
    if (row?.value) env = { MOONSHOT_API_KEY: row.value, KIMI_API_KEY: row.value }
  }
  return { mcpServers, env }
}

async function resolveHermesMcpServers(): Promise<object[]> {
  if (process.platform !== 'win32') return []
  // Remote mode: Hermes runs on a native Linux machine over SSH, not WSL2.
  // It cannot reach the Windows-side node process for stdio MCP, and WSL interop
  // is unavailable on remote machines. The renderer handles memory injection
  // client-side instead (fetch + prepend context as a system message).
  if (getHermesConfig().mode === 'remote') return []
  // Honor the Extensions panel's enable/disable state per server.
  const active = getActiveMcpServers()
  const knowledgeActive = Boolean(active['ai-workspace-knowledge'])
  const browserActive = Boolean(active['ai-workspace-browser'])
  if (!knowledgeActive && !browserActive) return []
  try {
    const { execSync } = require('child_process') as typeof import('child_process')
    const { app } = require('electron') as typeof import('electron')
    const path = require('path') as typeof import('path')

    // Both bundled servers run on the Windows side, launched through the app's
    // own Electron binary in run-as-node mode (ELECTRON_RUN_AS_NODE=1) via WSL
    // interop. For the knowledge server this is required for the Electron-ABI
    // better-sqlite3 build. For the browser server it is required for a
    // different reason: its HTTP calls target 127.0.0.1, which from *inside* a
    // WSL Linux process would hit the WSL VM, not the Windows host running the
    // control server — running Windows-side keeps loopback pointing at the app.
    const electronExe = process.execPath
    if (!electronExe) throw new Error('electron executable path unavailable')

    // checkHermes() is already statically imported; use it to find the active distro.
    const check = await checkHermes()
    const distro = check.distro ?? 'Ubuntu'

    const electronWsl = execSync(`wsl.exe -d ${distro} wslpath -a "${electronExe}"`, { encoding: 'utf8' }).trim()
    const dbDir = app.getPath('userData').replace(/\\/g, '/')
    const toWin = (p: string) => p.replace(/\\/g, '/')

    const servers: object[] = []
    if (knowledgeActive) {
      servers.push({
        name: 'ai-workspace-knowledge',
        command: electronWsl,
        args: [toWin(path.join(__dirname, '../mcp/server.cjs'))],
        env: [
          { name: 'AIWORKSPACE_DB_DIR', value: dbDir },
          { name: 'ELECTRON_RUN_AS_NODE', value: '1' }
        ]
      })
    }
    if (browserActive) {
      servers.push({
        name: 'ai-workspace-browser',
        command: electronWsl,
        args: [toWin(path.join(__dirname, '../mcp/browser-server.cjs'))],
        env: [
          { name: 'AIWORKSPACE_BROWSER_PORT', value: String(browserControlPort()) },
          { name: 'AIWORKSPACE_BROWSER_AGENT_ID', value: 'hermes' },
          { name: 'AIWORKSPACE_BROWSER_AGENT_NAME', value: 'Hermes' },
          { name: 'AIWORKSPACE_BROWSER_IDENTITY_SOURCE', value: 'app-launch' },
          { name: 'AIWORKSPACE_BROWSER_CONTROL_TOKEN', value: browserControlIdentityToken },
          { name: 'ELECTRON_RUN_AS_NODE', value: '1' }
        ]
      })
    }
    return servers
  } catch (e) {
    console.warn('[hermes] resolveHermesMcpServers failed:', e)
    return []
  }
}
