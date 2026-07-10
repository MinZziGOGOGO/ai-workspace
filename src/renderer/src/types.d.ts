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

export interface RemoteHermesConfig {
  mode: 'local' | 'remote'
  sshHost: string
  sshUser: string
  sshKeyPath: string
  hermesPath: string
}

export interface ResearchProgress {
  stage: 'plan' | 'search' | 'read' | 'synthesize' | 'save' | 'done' | 'error'
  status: 'running' | 'done' | 'error'
  detail: string
}

export interface SettingsSecretStatus {
  configured: boolean
  masked: string | null
}

export interface SettingsSummary {
  values: Record<string, string | null>
  secrets: Record<string, SettingsSecretStatus>
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
  providers: {
    ollama: { connected: boolean; defaultModel: string | null; error?: string }
    codex: CodexCheck
    claudeCode: { installed: boolean; version?: string; bin?: string; error?: string }
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
export interface Message { id: string; session_id: string; role: string; content: string; model: string | null; created_at: number; reaction?: 'up' | 'down' | null }
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
export interface MemoryItem {
  id: string; project_id: string | null; type: string; title: string; content: string
  source: string; tags: string[]; created_at: number; updated_at: number; score?: number
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
export interface LayoutPreset {
  id: string
  name: string
  created_at: number
  layout: any
  openIds: string[]
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
  type?: string
}

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

export interface McpServer {
  name: string
  config: McpServerConfig
  enabled: boolean
  transport: 'stdio' | 'sse' | 'http'
  status: 'unknown' | 'checking' | 'ok' | 'error'
  statusMessage?: string
  lastChecked?: number
}

declare global {
  interface Window {
    api: {
      projects: {
        list(): Promise<Project[]>
        global(): Promise<Project>
        create(name: string, parentDir: string): Promise<Project>
        import(): Promise<Project | null>
        open(id: string): Promise<Project>
        archive(id: string, archived: boolean): Promise<void>
        pickFolder(): Promise<string | null>
        getLinks(projectId: string): Promise<Project[]>
        addLink(srcId: string, dstId: string): Promise<{ success: boolean; error?: string }>
        removeLink(srcId: string, dstId: string): Promise<{ success: boolean; error?: string }>
        getAvailableLinkTargets(projectId: string): Promise<Project[]>
      }
      models: {
        list(): Promise<string[]>
        listCloud(): Promise<{ id: string; name: string }[]>
      }
      ollama: {
        status(): Promise<{ connected: boolean; defaultModel: string | null }>
        complete(
          model: string,
          messages: { role: string; content: string }[],
          timeoutMs?: number
        ): Promise<string | null>
        analyzeImage(model: string, base64: string, mimeType: string, prompt: string): Promise<string | null>
      }
      files: {
        read(path: string): Promise<FileAttachment>
        pick(): Promise<string | null>
        copyToProject(
          sourcePath: string,
          projectPath: string
        ): Promise<{ success: true; path: string } | { success: false; error: string }>
      }
      sessions: {
        list(projectId: string, mode: string): Promise<Session[]>
        listArchived(projectId: string, mode: string): Promise<Session[]>
        create(projectId: string, mode: string, title: string): Promise<Session>
        rename(id: string, title: string): Promise<void>
        archive(id: string, archived: boolean): Promise<void>
        delete(id: string): Promise<void>
        generateSummary(sessionId: string, model: string): Promise<string | null>
      }
      messages: {
        update(id: string, content: string): Promise<{ success: boolean; error?: string }>
        deleteAfter(sessionId: string, messageId: string): Promise<{ success: boolean; deletedCount?: number; error?: string }>
        setReaction(id: string, reaction: 'up' | 'down' | null): Promise<{ success: boolean; error?: string }>
      }
      chat: {
        messages(sessionId: string): Promise<Message[]>
        send(args: { sessionId: string; projectId: string; model: string; content: string; images?: string[]; systemPrefix?: string; regenerateMessageId?: string }): Promise<string | null>
        abort(sessionId: string): Promise<void>
        classifyHandoff(opts: { model: string; conversationContext: string; userMessage: string }): Promise<{ handoff: boolean; agent: string | null; newSession: boolean }>
        generateHandoffPrompt(opts: { model: string; agent: 'claudecode' | 'hermes' | 'codex'; conversationHistory: string }): Promise<string>
        onToken(cb: (d: { sessionId: string; token: string }) => void): () => void
        onDone(cb: (d: { sessionId: string }) => void): () => void
        onError(cb: (d: { sessionId: string; error: string }) => void): () => void
        onUsage(cb: (d: { sessionId: string; used: number; max: number | null }) => void): () => void
      }
      memory: {
        list(projectId: string | null): Promise<MemoryItem[]>
        save(input: { projectId: string | null; type: string; title: string; content: string; source: string; tags?: string[] }): Promise<MemoryItem>
        delete(id: string): Promise<void>
        count(projectId: string): Promise<number>
        clearProject(projectId: string): Promise<number>
        search(query: string, scope: string, projectId: string | null): Promise<MemoryItem[]>
        onIndexed(cb: (d: { projectIds: string[] }) => void): () => void
        onSaved(cb: (d: { title: string; type: string }) => void): () => void
        extract(projectId: string | null, sessionId: string): Promise<MemoryItem[]>
        consolidate(projectId: string | null): Promise<{ removed: number }>
      }
      codex: {
        check(): Promise<CodexCheck>
        messages(sessionId: string): Promise<Message[]>
        abort(sessionId: string): Promise<void>
        send(args: {
          sessionId: string
          projectId: string
          prompt: string
          sandbox?: CodexSandboxMode
          skipGitRepoCheck?: boolean
          model?: string
          imagePaths?: string[]
          regenerateMessageId?: string
        }): Promise<string | null>
        onEvent(cb: (d: { sessionId: string; event: CodexEvent }) => void): () => void
        onDone(cb: (d: { sessionId: string; ok?: boolean; loginRequired?: boolean; trustRequired?: boolean; memorySaved?: boolean; error?: string }) => void): () => void
      }
      claudeCode: {
        check(): Promise<{ installed: boolean; version?: string; bin?: string; error?: string }>
        messages(sessionId: string): Promise<Message[]>
        send(args: {
          sessionId: string
          projectId: string
          prompt: string
          injectMemory?: boolean
          model?: string
          effort?: 'normal' | 'high' | 'max'
          thinking?: boolean
          regenerateMessageId?: string
        }): Promise<string | null>
        abort(sessionId: string): Promise<void>
        onEvent(cb: (d: { sessionId: string; event: CCEvent }) => void): () => void
        onDone(cb: (d: { sessionId: string; ok?: boolean; loginRequired?: boolean; memorySaved?: boolean; error?: string }) => void): () => void
        onCheckpoint(cb: (d: { sessionId: string; messageId: string; success: boolean; checkpointId?: string; commitHash?: string; reason?: 'not-git' | 'dirty' | 'error'; error?: string }) => void): () => void
      }
      checkpoints: {
        create(sessionId: string, projectPath: string, description: string): Promise<CheckpointResult>
        list(sessionId: string): Promise<Checkpoint[]>
        rollback(checkpointId: string): Promise<{ success: boolean; error?: string }>
      }
      terminal: {
        create(projectPath: string | null): Promise<{ id: string }>
        write(id: string, data: string): Promise<void>
        resize(id: string, cols: number, rows: number): Promise<void>
        close(id: string): Promise<void>
        onData(cb: (d: { id: string; data: string }) => void): () => void
        onExit(cb: (d: { id: string }) => void): () => void
      }
      fs: {
        readDir(path: string): Promise<FsEntry[]>
        readFile(path: string): Promise<{ content: string; size: number } | { error: string }>
        writeFile(path: string, content: string): Promise<{ success: boolean } | { error: string }>
      }
      git: {
        status(projectPath: string): Promise<{ isGitRepo: boolean; files: Record<string, string> }>
      }
      hermes: {
        check(): Promise<HermesCheck>
        health(): Promise<{ ok: boolean }>
        connect(distro?: string): Promise<{ connected: boolean; version?: string; error?: string }>
        messages(sessionId: string): Promise<Message[]>
        abort(sessionId: string): Promise<void>
        send(args: { sessionId: string; projectId: string; prompt: string; injectMemory?: boolean; regenerateMessageId?: string }): Promise<string | null>
        getConfig(): Promise<RemoteHermesConfig>
        setConfig(config: RemoteHermesConfig): Promise<void>
        testConnection(config?: RemoteHermesConfig): Promise<{ success: boolean; error?: string }>
        getPermissionMode(): Promise<HermesPermissionMode>
        setPermissionMode(mode: HermesPermissionMode): Promise<{ success: boolean }>
        respondPermission(args: {
          sessionId: string
          requestId: string
          approved: boolean
          actionKind?: HermesActionKind
          alwaysAllowSession?: boolean
        }): Promise<{ success: boolean }>
        onEvent(cb: (d: { sessionId: string; event: HermesEvent }) => void): () => void
        onDone(cb: (d: { sessionId: string; ok?: boolean; memorySaved?: boolean; error?: string }) => void): () => void
        onUsage(cb: (d: { used: number; max: number }) => void): () => void
      }
      hermesSkills: {
        list(): Promise<{ success: boolean; skills?: SkillItem[]; error?: string }>
        toggle(name: string, enabled: boolean): Promise<{ success: boolean; error?: string }>
        search(query: string): Promise<{ success: boolean; results?: HubSkillResult[]; error?: string }>
        install(identifier: string): Promise<{ success: boolean; pid?: number; name?: string; error?: string }>
      }
      mcp: {
        list(): Promise<McpServer[]>
        add(name: string, config: McpServerConfig): Promise<{ success: boolean }>
        remove(name: string): Promise<{ success: boolean }>
        setEnabled(name: string, enabled: boolean): Promise<{ success: boolean }>
        check(name: string): Promise<{ status: string; message: string }>
        checkAll(): Promise<Record<string, { status: string; message: string }>>
        getConfigPath(): Promise<string>
        getKnowledgeServerPath(): Promise<string>
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
        import(jsonString: string): Promise<{ success: boolean; imported?: number; error?: string }>
      }
      webCompanion: {
        status(): Promise<WebCompanionStatus>
        configure(config: Partial<Pick<WebCompanionStatus, 'enabled' | 'hostMode' | 'port'>>): Promise<WebCompanionStatus>
        regenerateToken(): Promise<{ token: string; status: WebCompanionStatus }>
      }
      research: {
        start(args: {
          topic: string
          scope: 'web' | 'local' | 'both'
          projectId: string | null
          saveToProject: boolean
          quick?: boolean
        }): Promise<void>
        cancel(): Promise<void>
        onProgress(cb: (d: ResearchProgress) => void): () => void
      }
      activity: {
        onLog(cb: (entry: ActivityEntry) => void): () => void
      }
      presets: {
        list(): Promise<LayoutPreset[]>
        save(name: string, layout: any, openIds: string[], workspaceId: string): Promise<LayoutPreset>
        load(id: string): Promise<LayoutPreset | null>
        delete(id: string): Promise<void>
      }
      shell: {
        openExternal(url: string): Promise<void>
      }
      registry: {
        search(query: string, cursor: string): Promise<any>
      }
      instructions: {
        read(filePath: string): Promise<{ exists: boolean; content: string; error?: string }>
        write(filePath: string, content: string): Promise<{ success: boolean; error?: string }>
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
  }
}

export interface HermesActivity { ts: number; kind: string; message: string }
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

export interface CCFileDiff { path: string; before: string | null; after: string }
export interface CCActivityEntry { name: string; summary: string; ok?: boolean; id?: string; diff?: CCFileDiff }
export type CCEvent =
  | { kind: 'system'; summary: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string }
  | { kind: 'tool-result'; id: string; ok: boolean; summary: string }
  | { kind: 'file_diff'; toolCallId: string; path: string; before: string | null; after: string }
  | { kind: 'error'; message: string }

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export interface CodexCheck { installed: boolean; version?: string; bin?: string; error?: string }
export interface CodexActivityEntry { name: string; summary: string; ok?: boolean }
export type CodexEvent =
  | { kind: 'system'; summary: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'usage'; used: number }
  | { kind: 'error'; message: string }
