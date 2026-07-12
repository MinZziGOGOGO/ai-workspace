export type AgentMode = 'chat' | 'hermes' | 'claudecode' | 'codex'
export type SearchScope = 'project' | 'related' | 'global'

export interface FsEntry { name: string; isDir: boolean; path: string }

export interface FileAttachment {
  type: 'image' | 'text' | 'binary'
  name: string
  size: number
  mimeType?: string
  base64?: string
  content?: string
  ext: string
  filePath?: string
}

export interface ComposerAttachment {
  id: string
  file: FileAttachment
  visionModel?: string
  visionDescription?: string
}

export interface ActivityEntry {
  source: 'CHAT' | 'HERMES' | 'CODE' | 'INDEXER' | 'MEMORY' | 'RESEARCH'
  message: string
  timestamp: number
}

export interface ChatModelMessage {
  role: 'system' | 'assistant' | 'user'
  content: string
}

export interface OllamaStatus {
  connected: boolean
  defaultModel: string | null
  error?: string
}

export interface ChatSendRequest {
  sessionId: string
  projectId: string
  model: string
  content: string
  images?: string[]
  systemPrefix?: string
  regenerateMessageId?: string
}

export interface ChatClassifyHandoffRequest {
  model: string
  conversationContext: string
  userMessage: string
}

export interface HandoffClassification {
  handoff: boolean
  agent: 'claudecode' | 'hermes' | 'codex' | null
  newSession: boolean
}

export interface ChatGenerateHandoffPromptRequest {
  model: string
  agent: 'claudecode' | 'hermes' | 'codex'
  conversationHistory: string
}

export interface ChatTokenEvent { sessionId: string; token: string; kind?: 'answer' | 'thinking' }
export interface ChatDoneEvent { sessionId: string }
export interface ChatErrorEvent { sessionId: string; error: string }
export interface ChatUsageEvent { sessionId: string; used: number; max: number | null }

export interface Project {
  id: string
  name: string
  path: string
  status: 'active' | 'archived'
  created_at: number
  last_opened_at: number | null
}

export interface Session {
  id: string
  project_id: string
  mode: string
  title: string
  created_at: number
  updated_at?: number
  summary?: string | null
  archived?: number
}

export interface Message {
  id: string
  session_id: string
  role: string
  content: string
  model: string | null
  created_at: number
  reaction?: 'up' | 'down' | null
}

export interface Checkpoint {
  id: string
  session_id: string
  message_id: string | null
  project_path: string
  commit_hash: string
  created_at: number
  description: string
}

export interface CheckpointResult {
  success: boolean
  commitHash?: string
  reason?: 'not-git' | 'dirty' | 'error'
  error?: string
}

export interface CheckpointInfo extends Checkpoint {}

export interface CheckpointEvent extends CheckpointResult {
  sessionId: string
  messageId: string
  checkpointId?: string
}

export interface MemorySaveRequest {
  projectId: string | null
  type: string
  title: string
  content: string
  source: string
  tags?: string[]
}

export interface MemoryItem {
  id: string
  project_id: string | null
  type: string
  title: string
  content: string
  source: string
  tags: string[]
  created_at: number
  updated_at: number
  last_accessed_at?: number | null
  access_count?: number
  stale_at?: number | null
  quality_flags?: string[]
  quality_reason?: string | null
  score?: number
}

export interface MemorySavedEvent { title: string; type: string }
export interface IndexUpdatedEvent { projectIds: string[] }
export interface RemovedCount { removed: number }

export interface KnowledgeDiagnostics {
  total: number
  byType: Record<string, number>
  bySource: Record<string, number>
  embeddingsPresent: number
  embeddingsMissing: number
  staleCount: number
  unusedCount: number
  recentlyAccessedCount: number
  lowQualityCount: number
  lastConsolidationAt: number | null
  lowQualityCandidates: MemoryItem[]
}

export interface UsageSummaryRow {
  agent: string
  date: string
  message_count: number
  estimated_tokens: number
}

export interface TipStats {
  chatSessions: number
  hermesSessions: number
  totalSessions: number
  usedHandoff: boolean
}

export type DockPanel =
  | 'home'
  | 'navigator'
  | 'chat'
  | 'knowledge'
  | 'hermes'
  | 'claudecode'
  | 'codex'
  | 'editor'
  | 'terminal'
  | 'research'
  | 'activity'
  | 'extensions'
  | 'browser'

// ── Browser panel (manual WebContentsView browsing) ──────────────────────────
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserTabState {
  id: string
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  navigationError?: string | null
}

export interface BrowserTabListResponse {
  tabs: BrowserTabState[]
  activeTabId: string | null
}

export interface BrowserTabCreatedEvent {
  tabId: string
}

export interface BrowserTabClosedEvent {
  tabId: string
}

export interface BrowserDownloadStatus {
  downloadId: string
  filename: string
  origin: string
  state: 'pending' | 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  startedAt: number
  completedAt?: number
  cancelled: boolean
  failureReason?: string
  destinationType: 'managed'
  displayLocation: string
  tabId: string
}

export type BrowserPermissionCategory =
  | 'browser.read'
  | 'browser.navigate.local'
  | 'browser.navigate.external'
  | 'browser.interact'
  | 'browser.type'
  | 'browser.sensitive'
  | 'browser.download'
  | 'browser.upload'
  | 'browser.privileged'

export type BrowserApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'timed_out'
  | 'cancelled'
  | 'executing'
  | 'completed'
  | 'failed'

export interface BrowserApprovalRequest {
  requestId: string
  createdAt: number
  expiresAt: number
  status: BrowserApprovalStatus
  agentId: string
  agentName: string
  identityVerified: boolean
  transport: string
  tabId?: string
  category: BrowserPermissionCategory
  toolName: string
  currentUrl?: string
  currentOrigin?: string
  targetUrl?: string
  targetOrigin?: string
  leavesLocalhost?: boolean
  elementId?: string
  elementRole?: string
  elementName?: string
  actionSummary: string
  redactedInputPreview?: string
  characterCount?: number
  sensitive: boolean
  riskFlags: string[]
}

export interface BrowserApprovalDecision {
  requestId: string
  approved: boolean
  allowForSession?: boolean
}

export interface BrowserApprovalResult {
  success: boolean
  error?: string
}

export type LayoutNode =
  | { type: 'pane'; id: DockPanel }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; children: LayoutNode[]; sizes?: number[] }

export interface WorkspaceLayout {
  root: LayoutNode | null
  openIds: DockPanel[]
}

export interface LayoutPreset {
  id: string
  name: string
  created_at: number
  layout: LayoutNode | null
  openIds: DockPanel[]
  workspaceId: string
}

export interface ToolStatus {
  installed: boolean
  version?: string
}

export interface ToolDetection {
  claudeCode: ToolStatus
  codex: ToolStatus
  ollama: ToolStatus
  hermes: ToolStatus
}

export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  type?: 'stdio' | 'sse' | 'http'
}

export interface McpServer {
  name: string
  config: McpServerConfig
  enabled: boolean
  transport: 'stdio' | 'sse' | 'http'
  status: 'unknown' | 'checking' | 'ok' | 'error'
  statusMessage?: string
  lastChecked?: number
}

export interface McpCheckResult { status: string; message: string }

export interface SkillItem {
  name: string
  description: string
  category: string | null
  enabled: boolean
  usage: number
  provenance: 'agent' | 'hub'
}

export interface HubSkillResult {
  name: string
  description: string
  source: string
  identifier: string
  trust_level: string
  repo: string
  tags: string[]
}

export interface HermesSkillsListResponse { success: boolean; skills?: SkillItem[]; error?: string }
export interface HermesSkillsToggleResponse { success: boolean; error?: string }
export interface HermesSkillsSearchResponse { success: boolean; results?: HubSkillResult[]; error?: string }
export interface HermesSkillsInstallResponse { success: boolean; pid?: number; name?: string; error?: string }

export interface RemoteHermesConfig {
  mode: 'local' | 'remote'
  sshHost: string
  sshUser: string
  sshKeyPath: string
  hermesPath: string
}

export interface HermesActivity {
  ts: number
  kind: string
  message: string
  toolName?: string
  status?: 'running' | 'done' | 'error'
  args?: unknown
  result?: string
  details?: unknown
}
export interface HermesCheck {
  wsl2: boolean
  installed: boolean
  connected: boolean
  version?: string
  distro?: string
  error?: string
}
export interface HermesCommand { name: string; description: string; hint?: string }
export interface HermesPlanEntry { content: string; status: string }
export type HermesPermissionMode = 1 | 2 | 3 | 4 | 5
export type HermesActionKind = 'read' | 'create' | 'edit' | 'execute' | 'destructive' | 'catastrophic'
export interface HermesPermissionRequestInfo { requestId: string; action: HermesActionKind; title: string }
export type HermesEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'activity'; activity: HermesActivity }
  | { kind: 'error'; message: string }
  | { kind: 'model'; name: string }
  | { kind: 'usage'; used: number; size: number }
  | { kind: 'commands'; commands: HermesCommand[] }
  | { kind: 'plan'; entries: HermesPlanEntry[] }
  | { kind: 'permissionRequest'; request: HermesPermissionRequestInfo }

export interface HermesSendRequest {
  sessionId: string
  projectId: string
  prompt: string
  injectMemory?: boolean
  regenerateMessageId?: string
}

export interface HermesDoneEvent {
  sessionId: string
  ok?: boolean
  memorySaved?: boolean
  error?: string
}

export interface HermesUsageEvent { used: number; max: number }
export interface HermesIpcEvent { sessionId: string; event: HermesEvent }

export interface HermesRespondPermissionRequest {
  sessionId: string
  requestId: string
  approved: boolean
  actionKind?: HermesActionKind
  alwaysAllowSession?: boolean
}

export interface CCFileDiff { path: string; before: string | null; after: string }
export interface CCActivityEntry { name: string; summary: string; ok?: boolean; id?: string; diff?: CCFileDiff }
export type CCEvent =
  | { kind: 'system'; summary: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string }
  | { kind: 'tool-result'; id: string; ok: boolean; summary: string }
  | { kind: 'file_diff'; toolCallId: string; path: string; before: string | null; after: string }
  | { kind: 'error'; message: string }

export interface ClaudeCodeCheck { installed: boolean; version?: string; bin?: string; error?: string }

export interface ClaudeCodeSendRequest {
  sessionId: string
  projectId: string
  prompt: string
  injectMemory?: boolean
  model?: string
  effort?: 'normal' | 'high' | 'max'
  thinking?: boolean
  regenerateMessageId?: string
}

export interface ClaudeCodeIpcEvent { sessionId: string; event: CCEvent }
export interface ClaudeCodeDoneEvent {
  sessionId: string
  ok?: boolean
  loginRequired?: boolean
  memorySaved?: boolean
  error?: string
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export interface CodexCheck { installed: boolean; version?: string; bin?: string; error?: string }
export interface CodexActivityEntry { name: string; summary: string; ok?: boolean }
export type CodexEvent =
  | { kind: 'system'; summary: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'usage'; used: number }
  | { kind: 'error'; message: string }

export interface CodexSendRequest {
  sessionId: string
  projectId: string
  prompt: string
  sandbox?: CodexSandboxMode
  skipGitRepoCheck?: boolean
  model?: string
  imagePaths?: string[]
  regenerateMessageId?: string
}

export interface CodexIpcEvent { sessionId: string; event: CodexEvent }
export interface CodexDoneEvent {
  sessionId: string
  ok?: boolean
  loginRequired?: boolean
  trustRequired?: boolean
  memorySaved?: boolean
  error?: string
}

export interface TerminalCreateResponse { id: string }
export interface TerminalDataEvent { id: string; data: string }
export interface TerminalExitEvent { id: string }

export interface GitStatusResponse { isGitRepo: boolean; files: Record<string, string> }

export interface SettingsSecretStatus {
  configured: boolean
  masked: string | null
}

export interface SettingsSummary {
  values: Record<string, string | null>
  secrets: Record<string, SettingsSecretStatus>
}

export interface ProviderStatus {
  connected?: boolean
  defaultModel?: string | null
  installed?: boolean
  version?: string
  bin?: string
  error?: string
}

export interface SettingsDiagnostics {
  app: {
    name: string
    version: string
    electron: string
    node: string
    chrome: string
    platform: string
    userData: string
    databasePath: string
  }
  counts: { projects: number; sessions: number; memories: number }
  knowledge: KnowledgeDiagnostics
  providers: {
    ollama: { connected: boolean; defaultModel: string | null; error?: string }
    codex: CodexCheck
    claudeCode: ClaudeCodeCheck
    kimi: ProviderStatus
    hermes: HermesCheck
  }
  webCompanion: {
    enabled: boolean
    running: boolean
    hostMode: 'local' | 'private'
    port: number
    bindHost: string
    tokenConfigured: boolean
    tokenMasked: string | null
    error: string | null
  }
  settings: SettingsSummary
}

export interface SettingsImportResponse { success: boolean; imported?: number; error?: string }

export interface WebCompanionStatus {
  enabled: boolean
  running: boolean
  hostMode: 'local' | 'private'
  port: number
  bindHost: string
  localUrl: string
  privateUrls: string[]
  tokenConfigured: boolean
  tokenMasked: string | null
  error: string | null
}

export type WebCompanionConfigureRequest = Partial<Pick<WebCompanionStatus, 'enabled' | 'hostMode' | 'port'>>
export interface WebCompanionRegenerateResponse { token: string; status: WebCompanionStatus }

export interface ResearchStartRequest {
  topic: string
  scope: 'web' | 'local' | 'both'
  projectId: string | null
  saveToProject: boolean
  quick?: boolean
}

export interface ResearchProgress {
  stage: 'plan' | 'search' | 'read' | 'synthesize' | 'save' | 'done' | 'error'
  status: 'running' | 'done' | 'error'
  detail: string
}

export interface InstructionsReadResponse { exists: boolean; content: string; error?: string }
export interface InstructionsWriteResponse { success: boolean; error?: string }

export interface RegistryPackage {
  registry_name?: string
  name?: string
  version?: string
  [key: string]: unknown
}

export interface RegistryRemote {
  type?: string
  url?: string
  [key: string]: unknown
}

export interface RegistryServer {
  id?: string
  name?: string
  title?: string
  description?: string
  publisher?: { name?: string; url?: string }
  packages?: RegistryPackage[]
  repository?: { url?: string }
  remotes?: RegistryRemote[]
  homepage?: string
  version?: string
  created_at?: string
  updated_at?: string
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

export interface RegistryResult {
  server: RegistryServer
  _meta?: Record<string, unknown>
}

export interface RegistrySearchResponse {
  servers?: RegistryResult[]
  metadata?: { nextCursor?: string | null }
}

export type FsReadFileResponse = { content: string; size: number } | { error: string }
export type FsWriteFileResponse = { success: boolean } | { error: string }
export type FileCopyResponse = { success: true; path: string } | { success: false; error: string }
export type CloudModelsResponse = { success: true; models: { id: string; name: string }[] } | { success: false; error: string }
export type MutationResponse = { success: boolean; error?: string }
export type DeleteAfterResponse = { success: boolean; deletedCount?: number; error?: string }

export interface IpcApi {
  projects: {
    list(): Promise<Project[]>
    global(): Promise<Project>
    create(name: string, parentDir: string): Promise<Project>
    import(): Promise<Project | null>
    open(id: string): Promise<Project>
    archive(id: string, archived: boolean): Promise<void>
    pickFolder(): Promise<string | null>
    getLinks(projectId: string): Promise<Project[]>
    addLink(srcId: string, dstId: string): Promise<MutationResponse>
    removeLink(srcId: string, dstId: string): Promise<MutationResponse>
    getAvailableLinkTargets(projectId: string): Promise<Project[]>
  }
  models: {
    list(): Promise<string[]>
    listCloud(): Promise<CloudModelsResponse>
  }
  ollama: {
    status(): Promise<OllamaStatus>
    complete(model: string, messages: ChatModelMessage[], timeoutMs?: number): Promise<string | null>
    analyzeImage(model: string, base64: string, mimeType: string, prompt: string): Promise<string | null>
  }
  files: {
    read(path: string): Promise<FileAttachment>
    pick(): Promise<string | null>
    copyToProject(sourcePath: string, projectPath: string): Promise<FileCopyResponse>
  }
  sessions: {
    list(projectId: string, mode: string): Promise<Session[]>
    listArchived(projectId: string, mode: string): Promise<Session[]>
    create(projectId: string, mode: string, title: string): Promise<Session>
    rename(id: string, title: string): Promise<MutationResponse>
    archive(id: string, archived: boolean): Promise<MutationResponse>
    delete(id: string): Promise<MutationResponse>
    generateSummary(sessionId: string, model: string): Promise<string | null>
  }
  messages: {
    update(id: string, content: string): Promise<MutationResponse>
    deleteAfter(sessionId: string, messageId: string): Promise<DeleteAfterResponse>
    setReaction(id: string, reaction: 'up' | 'down' | null): Promise<MutationResponse>
  }
  chat: {
    messages(sessionId: string): Promise<Message[]>
    send(args: ChatSendRequest): Promise<string | null>
    abort(sessionId: string): Promise<void>
    classifyHandoff(opts: ChatClassifyHandoffRequest): Promise<HandoffClassification>
    generateHandoffPrompt(opts: ChatGenerateHandoffPromptRequest): Promise<string>
    onToken(cb: (d: ChatTokenEvent) => void): () => void
    onDone(cb: (d: ChatDoneEvent) => void): () => void
    onError(cb: (d: ChatErrorEvent) => void): () => void
    onUsage(cb: (d: ChatUsageEvent) => void): () => void
  }
  memory: {
    list(projectId: string | null): Promise<MemoryItem[]>
    save(input: MemorySaveRequest): Promise<MemoryItem>
    delete(id: string): Promise<void>
    touch(id: string): Promise<void>
    markStale(id: string, stale: boolean): Promise<void>
    count(projectId: string): Promise<number>
    clearProject(projectId: string): Promise<number>
    search(query: string, scope: SearchScope, projectId: string | null): Promise<MemoryItem[]>
    diagnostics(projectId: string | null): Promise<KnowledgeDiagnostics>
    deleteLowQualityCandidates(projectId: string | null): Promise<number>
    onIndexed(cb: (d: IndexUpdatedEvent) => void): () => void
    onSaved(cb: (d: MemorySavedEvent) => void): () => void
    extract(projectId: string | null, sessionId: string): Promise<MemoryItem[]>
    consolidate(projectId: string | null): Promise<RemovedCount>
  }
  codex: {
    check(): Promise<CodexCheck>
    messages(sessionId: string): Promise<Message[]>
    abort(sessionId: string): Promise<void>
    send(args: CodexSendRequest): Promise<string | null>
    onEvent(cb: (d: CodexIpcEvent) => void): () => void
    onDone(cb: (d: CodexDoneEvent) => void): () => void
  }
  claudeCode: {
    check(): Promise<ClaudeCodeCheck>
    messages(sessionId: string): Promise<Message[]>
    send(args: ClaudeCodeSendRequest): Promise<string | null>
    abort(sessionId: string): Promise<void>
    onEvent(cb: (d: ClaudeCodeIpcEvent) => void): () => void
    onDone(cb: (d: ClaudeCodeDoneEvent) => void): () => void
    onCheckpoint(cb: (d: CheckpointEvent) => void): () => void
  }
  checkpoints: {
    create(sessionId: string, projectPath: string, description: string): Promise<CheckpointResult>
    list(sessionId: string): Promise<Checkpoint[]>
    rollback(checkpointId: string): Promise<MutationResponse>
  }
  terminal: {
    create(projectPath: string | null): Promise<TerminalCreateResponse>
    write(id: string, data: string): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
    close(id: string): Promise<void>
    onData(cb: (d: TerminalDataEvent) => void): () => void
    onExit(cb: (d: TerminalExitEvent) => void): () => void
  }
  fs: {
    readDir(path: string): Promise<FsEntry[]>
    readFile(path: string): Promise<FsReadFileResponse>
    writeFile(path: string, content: string): Promise<FsWriteFileResponse>
  }
  git: {
    status(projectPath: string): Promise<GitStatusResponse>
  }
  hermes: {
    check(): Promise<HermesCheck>
    health(): Promise<{ ok: boolean }>
    connect(distro?: string): Promise<{ connected: boolean; version?: string; error?: string }>
    messages(sessionId: string): Promise<Message[]>
    abort(sessionId: string): Promise<void>
    send(args: HermesSendRequest): Promise<string | null>
    getConfig(): Promise<RemoteHermesConfig>
    setConfig(config: RemoteHermesConfig): Promise<void>
    testConnection(config?: RemoteHermesConfig): Promise<{ success: boolean; error?: string }>
    getPermissionMode(): Promise<HermesPermissionMode>
    setPermissionMode(mode: HermesPermissionMode): Promise<MutationResponse>
    respondPermission(args: HermesRespondPermissionRequest): Promise<MutationResponse>
    onEvent(cb: (d: HermesIpcEvent) => void): () => void
    onDone(cb: (d: HermesDoneEvent) => void): () => void
    onUsage(cb: (d: HermesUsageEvent) => void): () => void
  }
  hermesSkills: {
    list(): Promise<HermesSkillsListResponse>
    toggle(name: string, enabled: boolean): Promise<HermesSkillsToggleResponse>
    search(query: string): Promise<HermesSkillsSearchResponse>
    install(identifier: string): Promise<HermesSkillsInstallResponse>
  }
  mcp: {
    list(): Promise<McpServer[]>
    add(name: string, config: McpServerConfig): Promise<MutationResponse>
    remove(name: string): Promise<MutationResponse>
    setEnabled(name: string, enabled: boolean): Promise<MutationResponse>
    check(name: string): Promise<McpCheckResult>
    checkAll(): Promise<Record<string, McpCheckResult>>
    getConfigPath(): Promise<string>
    getKnowledgeServerPath(): Promise<string>
    getKnowledgeServerConfig(): Promise<McpServerConfig>
    getBrowserServerPath(): Promise<string>
    getBrowserServerConfig(): Promise<McpServerConfig>
  }
  setup: {
    detectTools(): Promise<ToolDetection>
    isComplete(): Promise<boolean>
    markComplete(complete?: boolean): Promise<void>
  }
  settings: {
    get(key: string): Promise<string | null>
    getMany(keys: string[]): Promise<Record<string, string | null>>
    set(key: string, value: string): Promise<void>
    setMany(values: Record<string, string>): Promise<void>
    delete(key: string): Promise<void>
    summary(): Promise<SettingsSummary>
    diagnostics(): Promise<SettingsDiagnostics>
    import(jsonString: string): Promise<SettingsImportResponse>
  }
  webCompanion: {
    status(): Promise<WebCompanionStatus>
    configure(config: WebCompanionConfigureRequest): Promise<WebCompanionStatus>
    regenerateToken(): Promise<WebCompanionRegenerateResponse>
  }
  browser: {
    createTab(url?: string): Promise<string>
    closeTab(tabId: string): Promise<void>
    setActiveTab(tabId: string): Promise<void>
    navigate(tabId: string, url: string): Promise<void>
    goBack(tabId: string): Promise<void>
    goForward(tabId: string): Promise<void>
    reload(tabId: string): Promise<void>
    stop(tabId: string): Promise<void>
    setBounds(tabId: string, bounds: BrowserBounds): Promise<void>
    hideAll(): Promise<void>
    listTabs(): Promise<BrowserTabListResponse>
    getDownloads(): Promise<BrowserDownloadStatus[]>
    reloadSessions(): Promise<void>
    onTabUpdated(cb: (d: BrowserTabState) => void): () => void
    onTabCreated(cb: (d: BrowserTabCreatedEvent) => void): () => void
    onTabClosed(cb: (d: BrowserTabClosedEvent) => void): () => void
  }
  approvals: {
    list(): Promise<BrowserApprovalRequest[]>
    respond(decision: BrowserApprovalDecision): Promise<BrowserApprovalResult>
    onChanged(cb: (requests: BrowserApprovalRequest[]) => void): () => void
  }
  activity: {
    onLog(cb: (entry: ActivityEntry) => void): () => void
  }
  research: {
    start(args: ResearchStartRequest): Promise<void>
    cancel(): Promise<void>
    onProgress(cb: (d: ResearchProgress) => void): () => void
  }
  presets: {
    list(): Promise<LayoutPreset[]>
    save(name: string, layout: LayoutNode | null, openIds: DockPanel[], workspaceId: string): Promise<LayoutPreset>
    load(id: string): Promise<LayoutPreset | null>
    delete(id: string): Promise<void>
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
  registry: {
    search(query: string, cursor: string): Promise<RegistrySearchResponse>
  }
  instructions: {
    read(filePath: string): Promise<InstructionsReadResponse>
    write(filePath: string, content: string): Promise<InstructionsWriteResponse>
    getPath(agentId: string, projectPath: string): Promise<string | null>
  }
  usage: {
    today(): Promise<UsageSummaryRow[]>
  }
  window: {
    notifyActivity(): Promise<void>
  }
  tips: {
    stats(): Promise<TipStats>
    shownIds(): Promise<string[]>
    markShown(tipId: string): Promise<void>
    dismiss(tipId: string): Promise<void>
    markHandoffUsed(): Promise<void>
  }
}
