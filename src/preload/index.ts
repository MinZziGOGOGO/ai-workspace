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
    pickFolder: () => ipcRenderer.invoke('projects:pickFolder')
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
    create: (projectId: string, mode: string, title: string) =>
      ipcRenderer.invoke('sessions:create', projectId, mode, title),
    rename: (id: string, title: string) => ipcRenderer.invoke('sessions:rename', id, title),
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id)
  },
  chat: {
    messages: (sessionId: string) => ipcRenderer.invoke('messages:list', sessionId),
    send: (args: { sessionId: string; projectId: string; model: string; content: string; images?: string[] }) =>
      ipcRenderer.invoke('chat:send', args),
    abort: (sessionId: string) => ipcRenderer.invoke('chat:abort', sessionId),
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
    onUsage: (cb: (d: { used: number; max: number | null }) => void) => {
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
    }
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
    send: (args: { sessionId: string; projectId: string; prompt: string; injectMemory?: boolean }) =>
      ipcRenderer.invoke('hermes:send', args),
    getConfig: () => ipcRenderer.invoke('hermes:getConfig'),
    setConfig: (config: unknown) => ipcRenderer.invoke('hermes:setConfig', config),
    testConnection: (config?: unknown) => ipcRenderer.invoke('hermes:testConnection', config),
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
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (name: string, config: unknown) => ipcRenderer.invoke('mcp:add', name, config),
    remove: (name: string) => ipcRenderer.invoke('mcp:remove', name),
    setEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke('mcp:setEnabled', name, enabled),
    check: (name: string) => ipcRenderer.invoke('mcp:check', name),
    checkAll: () => ipcRenderer.invoke('mcp:checkAll'),
    getConfigPath: () => ipcRenderer.invoke('mcp:getConfigPath')
  },
  // Settings: thin key/value wrapper over app_meta for UI-configurable values.
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    getMany: (keys: string[]) => ipcRenderer.invoke('settings:getMany', keys),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
    setMany: (values: Record<string, string>) => ipcRenderer.invoke('settings:setMany', values),
    delete: (key: string) => ipcRenderer.invoke('settings:delete', key),
    summary: () => ipcRenderer.invoke('settings:summary'),
    diagnostics: () => ipcRenderer.invoke('settings:diagnostics')
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
  }
})
