// Registers the knowledge MCP server in Claude Desktop's config.
// Idempotent: preserves all existing config, backs up before writing.
// Uses forward-slash paths (valid for Node spawn on Windows, no escaping pain).
const fs = require('fs')
const path = require('path')

const repo = path.resolve(__dirname, '..').replace(/\\/g, '/')
const cfgPath = path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json')
const nodeExe = process.execPath.replace(/\\/g, '/')
const dbDir = path.join(process.env.APPDATA, 'ai-workspace')

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
fs.writeFileSync(cfgPath + '.bak-' + Date.now(), JSON.stringify(cfg, null, 2))

cfg.mcpServers = cfg.mcpServers || {}
cfg.mcpServers['ai-workspace-knowledge'] = {
  command: nodeExe,
  args: [`${repo}/out/mcp/server.cjs`],
  env: { AIWORKSPACE_DB_DIR: dbDir }
}

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
console.log('Wrote', cfgPath)
console.log(JSON.stringify(cfg.mcpServers, null, 2))
