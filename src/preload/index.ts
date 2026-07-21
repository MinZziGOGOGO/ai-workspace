import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ActivityEntry,
  AgentPanelDetachedChangedEvent,
  AgentPanelId,
  BrowserPreviewOpenRequest,
  BrowserTabCreatedEvent,
  BrowserTabClosedEvent,
  BrowserTabState,
  BrowserApprovalRequest,
  BrowserApprovalDecision,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatTokenEvent,
  ChatUsageEvent,
  CheckpointEvent,
  ClaudeCodeDoneEvent,
  ClaudeCodeIpcEvent,
  ClaudeCodeSendRequest,
  DockPanel,
  CodexDoneEvent,
  CodexIpcEvent,
  CodexSandboxMode,
  CodexSendRequest,
  HermesActionKind,
  HermesDoneEvent,
  HermesIpcEvent,
  HermesRespondPermissionRequest,
  HermesSendRequest,
  HermesUsageEvent,
  KimiActionKind,
  KimiAuthMethod,
  KimiDoneEvent,
  KimiIpcEvent,
  KimiLoginEvent,
  KimiRespondPermissionRequest,
  KimiSendRequest,
  KimiUsageEvent,
  IndexUpdatedEvent,
  IpcApi,
  MemorySavedEvent,
  PanelDetachedChangedEvent,
  PreviewDevServerDetectedEvent,
  PreviewPanelState,
  ResearchProgress,
  ResearchStartRequest,
  ScreenPoint,
  TerminalDataEvent,
  TerminalExitEvent,
} from '../shared/ipcTypes'

function onPayload<T>(channel: string, cb: (payload: T) => void): () => void {
  const fn = (_: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.removeListener(channel, fn)
}

// Typed bridge: the renderer never touches Node APIs directly.
const api: IpcApi = {
  workspace: {
    getWindowBounds: () => ipcRenderer.invoke('workspace:getWindowBounds'),
    openPanelInMain: (panel: DockPanel) => ipcRenderer.invoke('workspace:openPanelInMain', panel),
    onOpenPanelRequested: (cb: (panel: DockPanel) => void) => onPayload('workspace:openPanelRequested', cb)
  },
  // Step 4: shared detach registry for the Hermes/Codex/Kimi/Chat tabs.
  // Claude Code keeps its own `claudeCode.*` detach calls (Step 3 pilot).
  agentPanel: {
    detach: (panel: AgentPanelId, projectId: string, dropPoint?: ScreenPoint) =>
      ipcRenderer.invoke('agentPanel:detach', panel, projectId, dropPoint),
    reattach: (panel: AgentPanelId) => ipcRenderer.invoke('agentPanel:reattach', panel),
    isDetached: (panel: AgentPanelId) => ipcRenderer.invoke('agentPanel:isDetached', panel),
    listDetached: () => ipcRenderer.invoke('agentPanel:listDetached'),
    onDetachedChanged: (cb: (d: AgentPanelDetachedChangedEvent) => void) =>
      onPayload('agentPanel:detachedChanged', cb)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    global: () => ipcRenderer.invoke('projects:global'),
    create: (name: string, parentDir: string) => ipcRenderer.invoke('projects:create', name, parentDir),
    import: () => ipcRenderer.invoke('projects:import'),
    open: (id: string) => ipcRenderer.invoke('projects:open', id),
    archive: (id: string, archived: boolean) => ipcRenderer.invoke('projects:archive', id, archived),
    pickFolder: () => ipcRenderer.invoke('projects:pickFolder'),
    getLinks: (projectId: string) => ipcRenderer.invoke('projects:getLinks', projectId),
    addLink: (srcId: string, dstId: string) => ipcRenderer.invoke('projects:addLink', srcId, dstId),
    removeLink: (srcId: string, dstId: string) => ipcRenderer.invoke('projects:removeLink', srcId, dstId),
    getAvailableLinkTargets: (projectId: string) =>
      ipcRenderer.invoke('projects:getAvailableLinkTargets', projectId)
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    listCloud: () => ipcRenderer.invoke('models:listCloud'),
    speedProbe: (force?: boolean) => ipcRenderer.invoke('models:speedProbe', force)
  },
  ollama: {
    status: () => ipcRenderer.invoke('ollama:status'),
    complete: (model: string, messages: { role: string; content: string }[], timeoutMs?: number) =>
      ipcRenderer.invoke('ollama:complete', model, messages, timeoutMs),
    analyzeImage: (model: string, base64: string, mimeType: string, prompt: string) =>
      ipcRenderer.invoke('ollama:analyzeImage', model, base64, mimeType, prompt)
  },
  files: {
    read: (path: string) => ipcRenderer.invoke('files:read', path),
    pick: () => ipcRenderer.invoke('files:pick'),
    copyToProject: (sourcePath: string, projectPath: string) =>
      ipcRenderer.invoke('files:copyToProject', sourcePath, projectPath)
  },
  sessions: {
    list: (projectId: string, mode: string) => ipcRenderer.invoke('sessions:list', projectId, mode),
    listArchived: (projectId: string, mode: string) =>
      ipcRenderer.invoke('sessions:listArchived', projectId, mode),
    create: (projectId: string, mode: string, title: string) =>
      ipcRenderer.invoke('sessions:create', projectId, mode, title),
    rename: (id: string, title: string) => ipcRenderer.invoke('sessions:rename', id, title),
    archive: (id: string, archived: boolean) => ipcRenderer.invoke('sessions:archive', id, archived),
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
    generateSummary: (sessionId: string, model: string) =>
      ipcRenderer.invoke('sessions:generateSummary', sessionId, model)
  },
  messages: {
    update: (id: string, content: string) => ipcRenderer.invoke('messages:update', id, content),
    deleteAfter: (sessionId: string, messageId: string) => ipcRenderer.invoke('messages:deleteAfter', sessionId, messageId),
    setReaction: (id: string, reaction: 'up' | 'down' | null) => ipcRenderer.invoke('messages:setReaction', id, reaction)
  },
  chat: {
    messages: (sessionId: string) => ipcRenderer.invoke('messages:list', sessionId),
    send: (args: { sessionId: string; projectId: string; model: string; content: string; images?: string[]; systemPrefix?: string; regenerateMessageId?: string }) =>
      ipcRenderer.invoke('chat:send', args),
    abort: (sessionId: string) => ipcRenderer.invoke('chat:abort', sessionId),
    classifyHandoff: (opts: { model: string; conversationContext: string; userMessage: string }) =>
      ipcRenderer.invoke('chat:classifyHandoff', opts),
    generateHandoffPrompt: (opts: { model: string; agent: 'claudecode' | 'hermes' | 'codex'; conversationHistory: string }) =>
      ipcRenderer.invoke('chat:generateHandoffPrompt', opts),
    liveState: (projectId: string) => ipcRenderer.invoke('chat:liveState', projectId),
    onToken: (cb: (d: ChatTokenEvent) => void) => onPayload('chat:token', cb),
    onDone: (cb: (d: ChatDoneEvent) => void) => onPayload('chat:done', cb),
    onError: (cb: (d: ChatErrorEvent) => void) => onPayload('chat:error', cb),
    onUsage: (cb: (d: ChatUsageEvent) => void) => onPayload('chat:usage', cb)
  },
  memory: {
    list: (projectId: string | null) => ipcRenderer.invoke('memory:list', projectId),
    save: (input: unknown) => ipcRenderer.invoke('memory:save', input),
    delete: (id: string) => ipcRenderer.invoke('memory:delete', id),
    touch: (id: string) => ipcRenderer.invoke('memory:touch', id),
    markStale: (id: string, stale: boolean) => ipcRenderer.invoke('memory:markStale', id, stale),
    count: (projectId: string) => ipcRenderer.invoke('memory:count', projectId),
    clearProject: (projectId: string) => ipcRenderer.invoke('memory:clearProject', projectId),
    search: (query: string, scope: string, projectId: string | null) =>
      ipcRenderer.invoke('memory:search', query, scope, projectId),
    diagnostics: (projectId: string | null) => ipcRenderer.invoke('memory:diagnostics', projectId),
    deleteLowQualityCandidates: (projectId: string | null) =>
      ipcRenderer.invoke('memory:deleteLowQualityCandidates', projectId),
    // M4: extract memories from a chat session / run consolidation manually.
    extract: (projectId: string | null, sessionId: string) =>
      ipcRenderer.invoke('memory:extract', projectId, sessionId),
    consolidate: (projectId: string | null) => ipcRenderer.invoke('memory:consolidate', projectId),
    // Fired after a successful memory save (for toast notifications).
    onSaved: (cb: (d: MemorySavedEvent) => void) => onPayload('memory:saved', cb),
    // Fired by the background indexer when it writes/updates memory for a project.
    onIndexed: (cb: (d: IndexUpdatedEvent) => void) => onPayload('index:updated', cb)
  },
  // Codex — headless CLI under the user's ChatGPT subscription login.
  codex: {
    check: () => ipcRenderer.invoke('codex:check'),
    messages: (sessionId: string) => ipcRenderer.invoke('codex:messages', sessionId),
    abort: (sessionId: string) => ipcRenderer.invoke('codex:abort', sessionId),
    send: (args: CodexSendRequest & { sandbox?: CodexSandboxMode }) => ipcRenderer.invoke('codex:send', args),
    listModels: () => ipcRenderer.invoke('codex:listModels'),
    liveState: (projectId: string) => ipcRenderer.invoke('codex:liveState', projectId),
    onEvent: (cb: (d: CodexIpcEvent) => void) => onPayload('codex:event', cb),
    onDone: (cb: (d: CodexDoneEvent) => void) => onPayload('codex:done', cb)
  },
  claudeCode: {
    check: () => ipcRenderer.invoke('claudecode:check'),
    messages: (sessionId: string) => ipcRenderer.invoke('messages:list', sessionId),
    send: (args: ClaudeCodeSendRequest) => ipcRenderer.invoke('claudecode:send', args),
    abort: (sessionId: string) => ipcRenderer.invoke('claudecode:abort', sessionId),
    listModels: () => ipcRenderer.invoke('claudecode:listModels'),
    liveState: (projectId: string) => ipcRenderer.invoke('claudecode:liveState', projectId),
    detach: (projectId: string, dropPoint?: ScreenPoint) => ipcRenderer.invoke('claudecode:detach', projectId, dropPoint),
    reattach: () => ipcRenderer.invoke('claudecode:reattach'),
    isDetached: () => ipcRenderer.invoke('claudecode:isDetached'),
    onEvent: (cb: (d: ClaudeCodeIpcEvent) => void) => onPayload('claudecode:event', cb),
    onDone: (cb: (d: ClaudeCodeDoneEvent) => void) => onPayload('claudecode:done', cb),
    onCheckpoint: (cb: (d: CheckpointEvent) => void) => onPayload('claudecode:checkpoint', cb),
    onDetachedChanged: (cb: (d: PanelDetachedChangedEvent) => void) => onPayload('claudecode:detachedChanged', cb)
  },
  checkpoints: {
    create: (sessionId: string, projectPath: string, description: string) =>
      ipcRenderer.invoke('checkpoints:create', sessionId, projectPath, description),
    list: (sessionId: string) => ipcRenderer.invoke('checkpoints:list', sessionId),
    rollback: (checkpointId: string) => ipcRenderer.invoke('checkpoints:rollback', checkpointId)
  },
  // Phase F: Terminal — real PTY via node-pty, rendered via xterm.js.
  terminal: {
    create: (projectPath: string | null) => ipcRenderer.invoke('terminal:create', projectPath),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    close: (id: string) => ipcRenderer.invoke('terminal:close', id),
    onData: (cb: (d: TerminalDataEvent) => void) => onPayload('terminal:data', cb),
    onExit: (cb: (d: TerminalExitEvent) => void) => onPayload('terminal:exit', cb)
  },
  // Git status for the Navigator file tree indicators.
  git: {
    status: (projectPath: string) => ipcRenderer.invoke('git:status', projectPath)
  },
  // Phase D/E: filesystem access for Navigator file tree and Editor panel.
  fs: {
    readDir: (path: string) => ipcRenderer.invoke('fs:readDir', path),
    readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content)
  },
  // M6: Hermes — autonomous agent via ACP stdio JSON-RPC (local WSL2 or remote SSH).
  hermes: {
    check: () => ipcRenderer.invoke('hermes:check'),
    health: () => ipcRenderer.invoke('hermes:health'),
    connect: (distro?: string) => ipcRenderer.invoke('hermes:connect', distro),
    messages: (sessionId: string) => ipcRenderer.invoke('messages:list', sessionId),
    abort: (sessionId: string) => ipcRenderer.invoke('hermes:abort', sessionId),
    send: (args: HermesSendRequest) =>
      ipcRenderer.invoke('hermes:send', args),
    getConfig: () => ipcRenderer.invoke('hermes:getConfig'),
    setConfig: (config: unknown) => ipcRenderer.invoke('hermes:setConfig', config),
    testConnection: (config?: unknown) => ipcRenderer.invoke('hermes:testConnection', config),
    getPermissionMode: () => ipcRenderer.invoke('hermes:getPermissionMode'),
    setPermissionMode: (mode: number) => ipcRenderer.invoke('hermes:setPermissionMode', mode),
    respondPermission: (args: HermesRespondPermissionRequest & { actionKind?: HermesActionKind }) =>
      ipcRenderer.invoke('hermes:respondPermission', args),
    getSessionSettings: (sessionId: string) => ipcRenderer.invoke('hermes:getSessionSettings', sessionId),
    setModel: (sessionId: string, modelId: string) => ipcRenderer.invoke('hermes:setModel', sessionId, modelId),
    setEffort: (sessionId: string, effort: string) => ipcRenderer.invoke('hermes:setEffort', sessionId, effort),
    command: (sessionId: string, command: string) => ipcRenderer.invoke('hermes:command', sessionId, command),
    patchStatus: () => ipcRenderer.invoke('hermes:patchStatus'),
    applyPatch: () => ipcRenderer.invoke('hermes:applyPatch'),
    liveState: (projectId: string) => ipcRenderer.invoke('hermes:liveState', projectId),
    onEvent: (cb: (d: HermesIpcEvent) => void) => onPayload('hermes:event', cb),
    onDone: (cb: (d: HermesDoneEvent) => void) => onPayload('hermes:done', cb),
    onUsage: (cb: (d: HermesUsageEvent) => void) => onPayload('hermes:usage', cb)
  },
  // Kimi — ACP over local stdio (plain PATH binary, no WSL/SSH).
  kimi: {
    check: () => ipcRenderer.invoke('kimi:check'),
    health: () => ipcRenderer.invoke('kimi:health'),
    connect: () => ipcRenderer.invoke('kimi:connect'),
    messages: (sessionId: string) => ipcRenderer.invoke('messages:list', sessionId),
    abort: (sessionId: string) => ipcRenderer.invoke('kimi:abort', sessionId),
    send: (args: KimiSendRequest) => ipcRenderer.invoke('kimi:send', args),
    listModels: () => ipcRenderer.invoke('kimi:listModels'),
    getPermissionMode: () => ipcRenderer.invoke('kimi:getPermissionMode'),
    setPermissionMode: (mode: number) => ipcRenderer.invoke('kimi:setPermissionMode', mode),
    getPlanMode: () => ipcRenderer.invoke('kimi:getPlanMode'),
    setPlanMode: (on: boolean) => ipcRenderer.invoke('kimi:setPlanMode', on),
    respondPermission: (args: KimiRespondPermissionRequest & { actionKind?: KimiActionKind }) =>
      ipcRenderer.invoke('kimi:respondPermission', args),
    getAuthMethod: () => ipcRenderer.invoke('kimi:getAuthMethod'),
    setAuthMethod: (method: KimiAuthMethod) => ipcRenderer.invoke('kimi:setAuthMethod', method),
    getAuthStatus: () => ipcRenderer.invoke('kimi:getAuthStatus'),
    setApiKey: (key: string) => ipcRenderer.invoke('kimi:setApiKey', key),
    login: () => ipcRenderer.invoke('kimi:login'),
    liveState: (projectId: string) => ipcRenderer.invoke('kimi:liveState', projectId),
    onEvent: (cb: (d: KimiIpcEvent) => void) => onPayload('kimi:event', cb),
    onDone: (cb: (d: KimiDoneEvent) => void) => onPayload('kimi:done', cb),
    onUsage: (cb: (d: KimiUsageEvent) => void) => onPayload('kimi:usage', cb),
    onLoginEvent: (cb: (d: KimiLoginEvent) => void) => onPayload('kimi:loginEvent', cb)
  },
  // Hermes dashboard skills API (Extensions panel Skills tab).
  hermesSkills: {
    list: () => ipcRenderer.invoke('hermesSkills:list'),
    toggle: (name: string, enabled: boolean) => ipcRenderer.invoke('hermesSkills:toggle', name, enabled),
    search: (query: string) => ipcRenderer.invoke('hermesSkills:search', query),
    install: (identifier: string) => ipcRenderer.invoke('hermesSkills:install', identifier)
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (name: string, config: unknown) => ipcRenderer.invoke('mcp:add', name, config),
    remove: (name: string) => ipcRenderer.invoke('mcp:remove', name),
    setEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke('mcp:setEnabled', name, enabled),
    check: (name: string) => ipcRenderer.invoke('mcp:check', name),
    checkAll: () => ipcRenderer.invoke('mcp:checkAll'),
    getConfigPath: () => ipcRenderer.invoke('mcp:getConfigPath'),
    getKnowledgeServerPath: () => ipcRenderer.invoke('mcp:getKnowledgeServerPath'),
    getKnowledgeServerConfig: () => ipcRenderer.invoke('mcp:getKnowledgeServerConfig'),
    getBrowserServerPath: () => ipcRenderer.invoke('mcp:getBrowserServerPath'),
    getBrowserServerConfig: () => ipcRenderer.invoke('mcp:getBrowserServerConfig')
  },
  // First-run setup wizard: tool detection + completion flag.
  setup: {
    detectTools: () => ipcRenderer.invoke('setup:detectTools'),
    isComplete: () => ipcRenderer.invoke('setup:isComplete'),
    markComplete: (complete?: boolean) => ipcRenderer.invoke('setup:markComplete', complete)
  },
  // Settings: thin key/value wrapper over app_meta for UI-configurable values.
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    getMany: (keys: string[]) => ipcRenderer.invoke('settings:getMany', keys),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
    setMany: (values: Record<string, string>) => ipcRenderer.invoke('settings:setMany', values),
    delete: (key: string) => ipcRenderer.invoke('settings:delete', key),
    summary: () => ipcRenderer.invoke('settings:summary'),
    diagnostics: () => ipcRenderer.invoke('settings:diagnostics'),
    import: (jsonString: string) => ipcRenderer.invoke('settings:import', jsonString)
  },
  webCompanion: {
    status: () => ipcRenderer.invoke('webCompanion:status'),
    configure: (config: unknown) => ipcRenderer.invoke('webCompanion:configure', config),
    regenerateToken: () => ipcRenderer.invoke('webCompanion:regenerateToken')
  },
  // Browser panel — native WebContentsView tabs positioned over a renderer
  // placeholder (manual browsing, Phase 1).
  browser: {
    createTab: (url?: string) => ipcRenderer.invoke('browser:createTab', url),
    closeTab: (tabId: string) => ipcRenderer.invoke('browser:closeTab', tabId),
    setActiveTab: (tabId: string) => ipcRenderer.invoke('browser:setActiveTab', tabId),
    navigate: (tabId: string, url: string) => ipcRenderer.invoke('browser:navigate', tabId, url),
    navigatePreview: (tabId: string, url: string) => ipcRenderer.invoke('browser:navigatePreview', tabId, url),
    setPreviewMode: (tabId: string, enabled: boolean) => ipcRenderer.invoke('browser:setPreviewMode', tabId, enabled),
    detectPreview: (projectId: string) => ipcRenderer.invoke('browser:detectPreview', projectId),
    inspectPreview: (tabId: string) => ipcRenderer.invoke('browser:inspectPreview', tabId),
    goBack: (tabId: string) => ipcRenderer.invoke('browser:goBack', tabId),
    goForward: (tabId: string) => ipcRenderer.invoke('browser:goForward', tabId),
    reload: (tabId: string) => ipcRenderer.invoke('browser:reload', tabId),
    stop: (tabId: string) => ipcRenderer.invoke('browser:stop', tabId),
    setBounds: (tabId: string, bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('browser:setBounds', tabId, bounds),
    hideAll: () => ipcRenderer.invoke('browser:hideAll'),
    parkForDrag: () => ipcRenderer.invoke('browser:parkForDrag'),
    restoreAfterDrag: () => ipcRenderer.invoke('browser:restoreAfterDrag'),
    listTabs: () => ipcRenderer.invoke('browser:listTabs'),
    getDownloads: () => ipcRenderer.invoke('browser:getDownloads'),
    reloadSessions: () => ipcRenderer.invoke('browser:reloadSessions'),
    detach: (projectId: string, dropPoint?: ScreenPoint) => ipcRenderer.invoke('browser:detach', projectId, dropPoint),
    reattach: () => ipcRenderer.invoke('browser:reattach'),
    isDetached: () => ipcRenderer.invoke('browser:isDetached'),
    onTabUpdated: (cb: (d: BrowserTabState) => void) => onPayload('browser:tabUpdated', cb),
    onTabCreated: (cb: (d: BrowserTabCreatedEvent) => void) => onPayload('browser:tabCreated', cb),
    onTabClosed: (cb: (d: BrowserTabClosedEvent) => void) => onPayload('browser:tabClosed', cb),
    onPreviewRequested: (cb: (d: BrowserPreviewOpenRequest) => void) => onPayload('browser:previewRequested', cb),
    onDetachedChanged: (cb: (d: PanelDetachedChangedEvent) => void) => onPayload('browser:detachedChanged', cb)
  },
  // Preview panel — a second, isolated WebContentsView surface for the user to
  // watch their own dev server. No agent/MCP tool ever calls these.
  preview: {
    navigate: (url: string) => ipcRenderer.invoke('preview:navigate', url),
    reload: () => ipcRenderer.invoke('preview:reload'),
    stop: () => ipcRenderer.invoke('preview:stop'),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('preview:setBounds', bounds),
    hideAll: () => ipcRenderer.invoke('preview:hideAll'),
    parkForDrag: () => ipcRenderer.invoke('preview:parkForDrag'),
    restoreAfterDrag: () => ipcRenderer.invoke('preview:restoreAfterDrag'),
    getState: () => ipcRenderer.invoke('preview:getState'),
    getDetectedUrl: (projectId: string) => ipcRenderer.invoke('preview:getDetectedUrl', projectId),
    detach: (projectId: string, dropPoint?: ScreenPoint) => ipcRenderer.invoke('preview:detach', projectId, dropPoint),
    reattach: () => ipcRenderer.invoke('preview:reattach'),
    isDetached: () => ipcRenderer.invoke('preview:isDetached'),
    onUpdated: (cb: (d: PreviewPanelState) => void) => onPayload('preview:updated', cb),
    onDevServerDetected: (cb: (d: PreviewDevServerDetectedEvent) => void) => onPayload('preview:devServerDetected', cb),
    onDetachedChanged: (cb: (d: PanelDetachedChangedEvent) => void) => onPayload('preview:detachedChanged', cb)
  },
  approvals: {
    list: () => ipcRenderer.invoke('approvals:list'),
    respond: (decision: BrowserApprovalDecision) => ipcRenderer.invoke('approvals:respond', decision),
    onChanged: (cb: (requests: BrowserApprovalRequest[]) => void) => onPayload('approvals:changed', cb)
  },
  // Activity log: real-time events from all AI sources (CHAT, HERMES, CODE, etc.).
  activity: {
    onLog: (cb: (entry: ActivityEntry) => void) => onPayload('activity:log', cb)
  },
  // Research pipeline: multi-stage local Ollama + SearXNG research.
  research: {
    start: (args: ResearchStartRequest) => ipcRenderer.invoke('research:start', args),
    cancel: () => ipcRenderer.invoke('research:cancel'),
    onProgress: (cb: (d: ResearchProgress) => void) => onPayload('research:progress', cb)
  },
  presets: {
    list: () => ipcRenderer.invoke('presets:list'),
    save: (name: string, layout: unknown, openIds: string[], workspaceId: string) =>
      ipcRenderer.invoke('presets:save', name, layout, openIds, workspaceId),
    load: (id: string) => ipcRenderer.invoke('presets:load', id),
    delete: (id: string) => ipcRenderer.invoke('presets:delete', id),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
  },
  registry: {
    search: (query: string, cursor: string) => ipcRenderer.invoke('registry:search', query, cursor)
  },
  instructions: {
    read: (filePath: string) => ipcRenderer.invoke('instructions:read', filePath),
    write: (filePath: string, content: string) => ipcRenderer.invoke('instructions:write', filePath, content),
    getPath: (agentId: string, projectPath: string) => ipcRenderer.invoke('instructions:getPath', agentId, projectPath)
  },
  // Lightweight daily usage counters (message/task counts, no cost estimates).
  usage: {
    today: () => ipcRenderer.invoke('usage:today')
  },
  // Background-completion notification: pings the main process for a taskbar
  // cue (flashFrame on Windows, badge count elsewhere) when unfocused.
  window: {
    notifyActivity: () => ipcRenderer.invoke('window:notifyActivity'),
    notifyApproval: (payload: { source: 'browser' | 'hermes' | 'kimi'; summary: string; panelActive?: boolean }) =>
      ipcRenderer.invoke('window:notifyApproval', payload)
  },
  // Contextual tips: simple usage stats + a shown/dismissed ledger so a tip
  // never displays more than once (see src/renderer/src/tips.ts).
  tips: {
    stats: () => ipcRenderer.invoke('tips:stats'),
    shownIds: () => ipcRenderer.invoke('tips:shownIds'),
    markShown: (tipId: string) => ipcRenderer.invoke('tips:markShown', tipId),
    dismiss: (tipId: string) => ipcRenderer.invoke('tips:dismiss', tipId),
    markHandoffUsed: () => ipcRenderer.invoke('tips:markHandoffUsed')
  },
  app: {
    resetAndRestart: () => ipcRenderer.invoke('app:resetAndRestart')
  }
}

contextBridge.exposeInMainWorld('api', api)
