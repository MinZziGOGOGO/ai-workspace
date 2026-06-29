// Knowledge MCP server (Milestone 2) — the keystone.
//
// Memory is implemented once in this app (src/main/knowledge.ts) and exposed
// three ways. This is the MCP face: a stdio server that Hermes, Claude Code,
// and Claude Desktop can connect to. It reuses the exact same knowledge layer
// and write queue as the Chat tab — there is no second memory system.
//
// Transport note: stdio MCP uses stdout for the JSON-RPC stream. Nothing here
// may write to stdout except the protocol. All logging goes to stderr (db.ts
// already follows this rule).

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import { join } from 'path'
import { initDb } from '../db'
import {
  searchMemory,
  saveMemory,
  getProjectContext,
  type SearchScope,
  type ProjectContext
} from '../knowledge'

const tools: Tool[] = [
  {
    name: 'search_memory',
    description:
      'Semantic + keyword search over the shared project knowledge base. Returns memory items ' +
      '(decisions, research, preferences, notes, files, tasks) ranked by relevance. Use this before ' +
      'answering or acting, to ground yourself in what the workspace already knows.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        scope: {
          type: 'string',
          enum: ['project', 'related', 'global'],
          description:
            "'project' = this project + global items; 'related' = also linked projects; " +
            "'global' = everything. Defaults to 'project'.",
          default: 'project'
        },
        projectId: {
          type: 'string',
          description: 'Project id to scope the search to. Omit (or null) for global search.'
        },
        limit: { type: 'number', description: 'Max results (default 8).' }
      },
      required: ['query']
    }
  },
  {
    name: 'save_memory',
    description:
      'Persist a durable knowledge item into the shared memory. Use for decisions, research findings, ' +
      'preferences, and notes worth keeping across sessions. Writes go through the single serialized ' +
      'write queue and are embedded for future semantic search.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'One of: decision | research | preference | file | task | note.'
        },
        title: { type: 'string', description: 'Short title / summary line.' },
        content: { type: 'string', description: 'Full content of the memory item.' },
        projectId: {
          type: 'string',
          description: 'Owning project id. Omit (or null) for global knowledge (e.g. user preferences).'
        },
        source: {
          type: 'string',
          description: 'Origin of the item (chat | hermes | claudecode | indexer | user). Defaults to "mcp".'
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' }
      },
      required: ['type', 'title', 'content']
    }
  },
  {
    name: 'get_project_context',
    description:
      'Return a compact snapshot of a project before working in it: the project itself, its standing ' +
      'decisions and preferences, the most recent knowledge, and the systems mapped in the knowledge ' +
      'graph. This is what the "Inject memory" button renders into a prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id to summarize.' }
      },
      required: ['projectId']
    }
  }
]

const server = new Server(
  { name: 'ai-workspace-knowledge', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params
  const args = (req.params.arguments ?? {}) as Record<string, any>
  try {
    switch (name) {
      case 'search_memory': {
        if (typeof args.query !== 'string' || !args.query.trim())
          return textError('search_memory requires a non-empty "query" string.')
        const results = await searchMemory(
          args.query,
          (args.scope as SearchScope) ?? 'project',
          args.projectId ?? null,
          typeof args.limit === 'number' ? args.limit : 8
        )
        return json(results)
      }
      case 'save_memory': {
        for (const f of ['type', 'title', 'content'] as const)
          if (typeof args[f] !== 'string' || !args[f].trim())
            return textError(`save_memory requires a non-empty "${f}" string.`)
        const item = await saveMemory({
          projectId: args.projectId ?? null,
          type: args.type,
          title: args.title,
          content: args.content,
          source: typeof args.source === 'string' ? args.source : 'mcp',
          tags: Array.isArray(args.tags) ? args.tags : undefined
        })
        return json(item)
      }
      case 'get_project_context': {
        if (typeof args.projectId !== 'string' || !args.projectId.trim())
          return textError('get_project_context requires a "projectId" string.')
        const ctx = getProjectContext(args.projectId)
        if (!ctx.project) return textError(`No project found with id "${args.projectId}".`)
        return { content: [{ type: 'text', text: formatContext(ctx) }] }
      }
      default:
        return textError(`Unknown tool: ${name}`)
    }
  } catch (err: any) {
    console.error(`[knowledge-mcp] tool "${name}" failed:`, err)
    return textError(`Tool "${name}" failed: ${err?.message ?? String(err)}`)
  }
})

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

function textError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

// Render a ProjectContext as a readable Markdown block for prompt injection.
function formatContext(ctx: ProjectContext): string {
  const p = ctx.project!
  const lines: string[] = [`# Project context: ${p.name}`, `Path: ${p.path} · Status: ${p.status}`, '']
  const section = (title: string, items: { title: string; content: string }[]) => {
    if (items.length === 0) return
    lines.push(`## ${title}`)
    for (const it of items) lines.push(`- **${it.title}** — ${it.content}`)
    lines.push('')
  }
  section('Decisions', ctx.decisions)
  section('Preferences', ctx.preferences)
  if (ctx.systems.length > 0) {
    lines.push('## Systems')
    for (const s of ctx.systems) lines.push(`- **${s.name}**${s.summary ? ` — ${s.summary}` : ''}`)
    lines.push('')
  }
  section('Recent knowledge', ctx.recent)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

async function main(): Promise<void> {
  // Standalone process: resolve the same on-disk DB Electron uses. Electron's
  // userData on Windows is %APPDATA%/<productName>; override with AIWORKSPACE_DB_DIR.
  const dbDir =
    process.env.AIWORKSPACE_DB_DIR ?? join(process.env.APPDATA ?? process.cwd(), 'ai-workspace')
  await initDb(dbDir)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[knowledge-mcp] connected over stdio; db dir:', dbDir)
}

main().catch((err) => {
  console.error('[knowledge-mcp] fatal:', err)
  process.exit(1)
})
