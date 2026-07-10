import { contextBridge, ipcRenderer } from 'electron'

// Typed bridge: the renderer never touches Node APIs directly.
contextBridge.exposeInMainWorld('api', {
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
    listCloud: () => ipcRenderer.invoke('models:listCloud')
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
    onToken: (cb: (d: { sessionId: string; token: string }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('chat:token', fn)
      return () => ipcRenderer.removeListener('chat:token', fn)
    },
    onDone: (cb: (d: { sessionId: string }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('chat:done', fn)
      return () => ipcRenderer.removeListener('chat:done', fn)
    },
    onError: (cb: (d: { sessionId: string; error: string }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('chat:error', fn)
      return () => ipcRenderer.removeListener('chat:error', fn)
    },
    onUsage: (cb: (d: { sessionId: string; used: number; max: number | null }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('chat:usage', fn)
      return () => ipcRenderer.removeListener('chat:usage', fn)
    }
  },
  memory: {
    list: (projectId: string | null) => ipcRenderer.invoke('memory:list', projectId),
    save: (input: unknown) => ipcRenderer.invoke('memory:save', input),
    delete: (id: string) => ipcRenderer.invoke('memory:delete', id),
    count: (projectId: string) => ipcRenderer.invoke('memory:count', projectId),
    clearProject: (projectId: string) => ipcRenderer.invoke('memory:clearProject', projectId),
    search: (query: string, scope: string, projectId: string | null) =>
      ipcRenderer.invoke('memory:search', query, scope, projectId),
    // M4: extract memories from a chat session / run consolidation manually.
    extract: (projectId: string | null, sessionId: string) =>
      ipcRenderer.invoke('memory:extract', projectId, sessionId),
    consolidate: (projectId: string | null) => ipcRenderer.invoke('memory:consolidate', projectId),
    // Fired after a successful memory save (for toast notifications).
    onSaved: (cb: (d: { title: string; type: string }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('memory:saved', fn)
      return () => ipcRenderer.removeListener('memory:saved', fn)
    },
    // Fired by the background indexer when it writes/updates memory for a project.
    onIndexed: (cb: (d: { projectIds: string[] }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('index:updated', fn)
      return () => ipcRenderer.removeListener('index:updated', fn)
    }
  },
  // Codex — headless CLI under the user's ChatGPT subscription login.
  codex: {
    check: () => ipcRenderer.invoke('codex:check'),
    messages: (sessionId: string) => ipcRenderer.invoke('codex:messages', sessionId),
    abort: (sessionId: string) => ipcRenderer.invoke('codex:abort', sessionId),
    send: (args: {
      sessionId: string
      projectId: string
      prompt: string
      sandbox?: 'read-only' | 'workspace-write'
      skipGitRepoCheck?: boolean
      model?: string
      imagePaths?: string[]
      regenerateMessageId?: string
    }) => ipcRenderer.invoke('codex:send', args),
    onEvent: (cb: (d: any) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('codex:event', fn)
      return () => ipcRenderer.removeListener('codex:event', fn)
    },
    onDone: (cb: (d: any) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('codex:done', fn)
      return () => ipcRenderer.removeListener('codex:done', fn)
    }
  },
  claudeCode: {
    check: () => ipcRenderer.invoke('claudecode:check'),
    messages: (sessionId: string) => ipcRenderer.invoke('messages:list', sessionId),
    send: (args: {
      sessionId: string
      projectId: string
      prompt: string
      injectMemory?: boolean
      model?: string
      effort?: 'normal' | 'high' | 'max'
      thinking?: boolean
      regenerateMessageId?: string
    }) => ipcRenderer.invoke('claudecode:send', args),
    abort: (sessionId: string) => ipcRenderer.invoke('claudecode:abort', sessionId),
    onEvent: (cb: (d: { sessionId: string; event: any }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('claudecode:event', fn)
      return () => ipcRenderer.removeListener('claudecode:event', fn)
    },
    onDone: (cb: (d: {
      sessionId: string
      ok?: boolean
      loginRequired?: boolean
      memorySaved?: boolean
      error?: string
    }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('claudecode:done', fn)
      return () => ipcRenderer.removeListener('claudecode:done', fn)
    },
    onCheckpoint: (cb: (d: {
      sessionId: string
      messageId: string
      success: boolean
      checkpointId?: string
      commitHash?: string
      reason?: 'not-git' | 'dirty' | 'error'
      error?: string
    }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('claudecode:checkpoint', fn)
      return () => ipcRenderer.removeListener('claudecode:checkpoint', fn)
    }
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
    onData: (cb: (d: { id: string; data: string }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('terminal:data', fn)
      return () => ipcRenderer.removeListener('terminal:data', fn)
    },
    onExit: (cb: (d: { id: string }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('terminal:exit', fn)
      return () => ipcRenderer.removeListener('terminal:exit', fn)
    }
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
    send: (args: { sessionId: string; projectId: string; prompt: string; injectMemory?: boolean; regenerateMessageId?: string }) =>
      ipcRenderer.invoke('hermes:send', args),
    getConfig: () => ipcRenderer.invoke('hermes:getConfig'),
    setConfig: (config: unknown) => ipcRenderer.invoke('hermes:setConfig', config),
    testConnection: (config?: unknown) => ipcRenderer.invoke('hermes:testConnection', config),
    getPermissionMode: () => ipcRenderer.invoke('hermes:getPermissionMode'),
    setPermissionMode: (mode: number) => ipcRenderer.invoke('hermes:setPermissionMode', mode),
    respondPermission: (args: {
      sessionId: string
      requestId: string
      approved: boolean
      actionKind?: string
      alwaysAllowSession?: boolean
    }) => ipcRenderer.invoke('hermes:respondPermission', args),
    onEvent: (cb: (d: { sessionId: string; event: any }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('hermes:event', fn)
      return () => ipcRenderer.removeListener('hermes:event', fn)
    },
    onDone: (cb: (d: {
      sessionId: string
      ok?: boolean
      memorySaved?: boolean
      error?: string
    }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('hermes:done', fn)
      return () => ipcRenderer.removeListener('hermes:done', fn)
    },
    onUsage: (cb: (d: { used: number; max: number }) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('hermes:usage', fn)
      return () => ipcRenderer.removeListener('hermes:usage', fn)
    }
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
    getKnowledgeServerPath: () => ipcRenderer.invoke('mcp:getKnowledgeServerPath')
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
  // Activity log: real-time events from all AI sources (CHAT, HERMES, CODE, etc.).
  activity: {
    onLog: (cb: (entry: any) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('activity:log', fn)
      return () => ipcRenderer.removeListener('activity:log', fn)
    }
  },
  // Research pipeline: multi-stage local Ollama + SearXNG research.
  research: {
    start: (args: {
      topic: string
      scope: 'web' | 'local' | 'both'
      projectId: string | null
      saveToProject: boolean
      quick?: boolean
    }) => ipcRenderer.invoke('research:start', args),
    cancel: () => ipcRenderer.invoke('research:cancel'),
    onProgress: (cb: (d: any) => void) => {
      const fn = (_: unknown, d: any) => cb(d)
      ipcRenderer.on('research:progress', fn)
      return () => ipcRenderer.removeListener('research:progress', fn)
    }
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
    notifyActivity: () => ipcRenderer.invoke('window:notifyActivity')
  },
  // Contextual tips: simple usage stats + a shown/dismissed ledger so a tip
  // never displays more than once (see src/renderer/src/tips.ts).
  tips: {
    stats: () => ipcRenderer.invoke('tips:stats'),
    shownIds: () => ipcRenderer.invoke('tips:shownIds'),
    markShown: (tipId: string) => ipcRenderer.invoke('tips:markShown', tipId),
    dismiss: (tipId: string) => ipcRenderer.invoke('tips:dismiss', tipId),
    markHandoffUsed: () => ipcRenderer.invoke('tips:markHandoffUsed')
  }
})
