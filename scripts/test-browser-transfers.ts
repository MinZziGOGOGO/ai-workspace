import assert from 'node:assert/strict'
import { UploadHandleRegistry, classifyDownloadRisks, sanitizeDownloadFilename } from '../src/main/browserTransfers'

assert.equal(sanitizeDownloadFilename('../secret.txt'), 'secret.txt')
assert.equal(sanitizeDownloadFilename('C:\\Windows\\system32\\evil.exe'), 'evil.exe')
assert.equal(sanitizeDownloadFilename('\\\\server\\share\\x.txt'), 'x.txt')
assert.equal(sanitizeDownloadFilename('CON'), '_CON')
assert.equal(sanitizeDownloadFilename('report. '), 'report')
assert.equal(sanitizeDownloadFilename('\u0000bad?.txt'), 'bad_.txt')
assert.equal(sanitizeDownloadFilename(''), 'download')
assert.ok(sanitizeDownloadFilename('a'.repeat(500) + '.txt').length <= 180)
assert.deepEqual(classifyDownloadRisks('invoice.pdf.exe'), ['Potentially executable file', 'Misleading double extension'])

const registry = new UploadHandleRegistry(10)
const first = registry.create({ path: 'C:\\private\\report.txt', size: 12, agentId: 'agent-a', tabId: 'tab-a', origin: 'https://example.test' })
assert.doesNotMatch(JSON.stringify(first), /private/i)
assert.equal(first.filename, 'report.txt')
assert.notEqual(first.uploadHandle, registry.create({ path: 'C:\\private\\other.txt', size: 1, agentId: 'agent-a' }).uploadHandle)
assert.equal('error' in registry.getForUse(first.uploadHandle, 'agent-b', 'tab-a', 'https://example.test'), true)
assert.equal('error' in registry.getForUse(first.uploadHandle, 'agent-a', 'tab-b', 'https://example.test'), true)
assert.equal('error' in registry.getForUse(first.uploadHandle, 'agent-a', 'tab-a', 'https://other.test'), true)
const valid = registry.getForUse(first.uploadHandle, 'agent-a', 'tab-a', 'https://example.test')
assert.equal('error' in valid, false)
registry.consume([first.uploadHandle])
assert.equal('error' in registry.getForUse(first.uploadHandle, 'agent-a', 'tab-a', 'https://example.test'), true)

const expiring = registry.create({ path: 'C:\\x.txt', size: 1, agentId: 'a' })
setTimeout(() => {
  assert.equal('error' in registry.getForUse(expiring.uploadHandle, 'a', 'tab', undefined), true)
  console.log('browser transfer tests passed')
}, 15)
