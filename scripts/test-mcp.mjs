// Manual end-to-end test for the knowledge MCP server.
// Spawns the built stdio server as a real MCP client would, then calls every
// tool and prints the results. Usage: node scripts/test-mcp.mjs <projectId>
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
// In a plain-node context the electron module's default export is the path to
// the Electron binary. The server loads the Electron-ABI better-sqlite3, so we
// launch it through Electron in run-as-node mode (ELECTRON_RUN_AS_NODE=1) — the
// same way the app registers it.
import electronPath from 'electron'

const projectId = process.argv[2]
if (!projectId) {
  console.error('Usage: node scripts/test-mcp.mjs <projectId>')
  process.exit(1)
}

const transport = new StdioClientTransport({
  command: electronPath,
  args: ['out/mcp/server.cjs'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
const client = new Client({ name: 'mcp-smoke-test', version: '1.0.0' }, { capabilities: {} })

const text = (r) => r.content.map((c) => c.text).join('\n')
const hr = (t) => console.log(`\n${'='.repeat(60)}\n${t}\n${'='.repeat(60)}`)

await client.connect(transport)

hr('1) listTools')
const { tools } = await client.listTools()
console.log(tools.map((t) => `- ${t.name}: ${t.description.slice(0, 70)}...`).join('\n'))

hr('2) save_memory (decision)')
const saved = await client.callTool({
  name: 'save_memory',
  arguments: {
    projectId,
    type: 'decision',
    title: 'Knowledge layer is exposed via stdio MCP',
    content:
      'Milestone 2: memory is implemented once in knowledge.ts and surfaced to Hermes / Claude Code / Claude Desktop through a stdio MCP server. No second memory system.',
    source: 'user',
    tags: ['architecture', 'mcp', 'm2']
  }
})
console.log(text(saved))
const savedId = JSON.parse(text(saved)).id

hr('3) search_memory (project scope) for the item we just saved')
const found = await client.callTool({
  name: 'search_memory',
  arguments: { query: 'how is knowledge exposed to other AIs?', scope: 'project', projectId, limit: 5 }
})
const hits = JSON.parse(text(found))
console.log(`returned ${hits.length} hit(s):`)
for (const h of hits) console.log(`  [${(h.score ?? 0).toFixed(3)}] ${h.type} — ${h.title}`)
console.log('round-trip found saved item:', hits.some((h) => h.id === savedId))

hr('4) get_project_context')
const ctx = await client.callTool({ name: 'get_project_context', arguments: { projectId } })
console.log(text(ctx))

hr('5) error handling: missing required arg')
const err = await client.callTool({ name: 'search_memory', arguments: {} })
console.log('isError:', err.isError, '|', text(err))

await client.close()
console.log('\nAll calls completed.')
