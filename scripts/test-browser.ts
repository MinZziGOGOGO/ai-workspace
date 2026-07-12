import assert from 'node:assert/strict'
import { normalizeUrl } from '../src/main/browserPanel'
import { clickScript, snapshotScript, typeScript } from '../src/main/browserAgentScript'
import {
  BrowserApprovalService,
  browserRequiresApproval,
  classifyBrowserTool,
  isLoopbackUrl,
  redactBrowserInput,
} from '../src/main/browserApproval'

function assertThrowsMessage(fn: () => unknown, fragment: string): void {
  assert.throws(fn, (err) => err instanceof Error && err.message.includes(fragment))
}

assert.equal(normalizeUrl(''), 'about:blank')
assert.equal(normalizeUrl('example.com'), 'https://example.com')
assert.equal(normalizeUrl('https://example.com/path'), 'https://example.com/path')
assert.equal(normalizeUrl('localhost:5173/demo'), 'http://localhost:5173/demo')
assert.equal(normalizeUrl('http://localhost:3000'), 'http://localhost:3000/')
assert.equal(normalizeUrl('about:blank'), 'about:blank')
assert.match(normalizeUrl('search words'), /^https:\/\/duckduckgo\.com\/\?q=search%20words$/)

assertThrowsMessage(() => normalizeUrl('file:///C:/secret.txt'), 'unsupported scheme')
assertThrowsMessage(() => normalizeUrl('javascript:alert(1)'), 'unsupported scheme')
assertThrowsMessage(() => normalizeUrl('data:text/html,hello'), 'unsupported scheme')
assertThrowsMessage(() => normalizeUrl('about:config'), 'Only about:blank')

const snapshot = snapshotScript('snapshot-1')
assert.match(snapshot, /data-aiw-snapshot-id/)
assert.match(snapshot, /snapshot-1/)

const click = clickScript('e1')
assert.match(click, /Stale element/)
assert.match(click, /stale:true/)
assert.match(click, /aria-disabled/)

const typed = typeScript('e2', 'hello', { replace: false, pressEnter: true })
assert.match(typed, /var replace = false/)
assert.match(typed, /KeyboardEvent/)
assert.match(typed, /Stale element/)

assert.equal(classifyBrowserTool('browser_get_state'), 'browser.read')
assert.equal(classifyBrowserTool('browser_get_content'), 'browser.read')
assert.equal(classifyBrowserTool('browser_get_elements'), 'browser.read')
assert.equal(classifyBrowserTool('browser_screenshot'), 'browser.read')
assert.equal(classifyBrowserTool('browser_navigate', 'http://localhost:3000'), 'browser.navigate.local')
assert.equal(classifyBrowserTool('browser_navigate', 'http://127.22.3.4:8080'), 'browser.navigate.local')
assert.equal(classifyBrowserTool('browser_navigate', 'http://[::1]:5173'), 'browser.navigate.local')
assert.equal(classifyBrowserTool('browser_navigate', 'https://example.com'), 'browser.navigate.external')
assert.equal(classifyBrowserTool('browser_click'), 'browser.interact')
assert.equal(classifyBrowserTool('browser_scroll'), 'browser.interact')
assert.equal(classifyBrowserTool('browser_type'), 'browser.type')
assert.equal(isLoopbackUrl('http://localhost.test'), false)
assert.equal(isLoopbackUrl('http://192.168.1.2'), false)
assert.equal(browserRequiresApproval(3, 'browser.read'), false)
assert.equal(browserRequiresApproval(3, 'browser.navigate.local'), false)
assert.equal(browserRequiresApproval(3, 'browser.navigate.external'), true)
assert.equal(browserRequiresApproval(3, 'browser.interact'), false)
assert.equal(browserRequiresApproval(5, 'browser.sensitive'), true)
assert.equal(redactBrowserInput('super-secret', true), '[redacted 12 characters]')
assert.equal(redactBrowserInput('hello', false), 'hello')

async function testApprovalService(): Promise<void> {
const identity = { agentId: 'test-agent', agentName: 'Test Agent', identityVerified: true, transport: 'test' }
const draft = {
  category: 'browser.navigate.external' as const,
  toolName: 'browser_navigate',
  tabId: 'tab-1',
  targetUrl: 'https://example.com/',
  targetOrigin: 'https://example.com',
  leavesLocalhost: true,
  actionSummary: 'Navigate externally',
  sensitive: false,
  riskFlags: ['Leaves localhost'],
  mutation: true,
}

const deniedService = new BrowserApprovalService(1000)
const denied = deniedService.submit(identity, 3, draft, async () => 'should-not-run')
assert.equal(deniedService.listPending().length, 1)
const deniedId = deniedService.listPending()[0].requestId
await deniedService.respond({ requestId: deniedId, approved: false })
assert.deepEqual(await denied, { ok: false, code: 'denied', error: 'Browser action denied by the user.', requestId: deniedId })

const timeoutService = new BrowserApprovalService(5)
const timedOut = await timeoutService.submit(identity, 3, draft, async () => 'never')
assert.equal(timedOut.ok, false)
if (!timedOut.ok) assert.equal(timedOut.code, 'timed_out')

const disconnectService = new BrowserApprovalService(1000)
const disconnected = disconnectService.submit(identity, 2, draft, async () => 'never')
disconnectService.cancelForAgent(identity.agentId)
const disconnectedResult = await disconnected
assert.equal(disconnectedResult.ok, false)
if (!disconnectedResult.ok) assert.equal(disconnectedResult.code, 'cancelled')

const destroyedTabService = new BrowserApprovalService(1000)
const destroyed = destroyedTabService.submit(identity, 2, draft, async () => 'never')
destroyedTabService.cancelForTab('tab-1')
const destroyedResult = await destroyed
assert.equal(destroyedResult.ok, false)
if (!destroyedResult.ok) assert.equal(destroyedResult.code, 'cancelled')

const sensitiveService = new BrowserApprovalService(1000)
const secret = 'sk-secret-value'
const sensitive = sensitiveService.submit(identity, 5, {
  ...draft,
  category: 'browser.sensitive',
  redactedInputPreview: redactBrowserInput(secret, true),
  characterCount: secret.length,
  sensitive: true,
}, async () => 'never')
assert.doesNotMatch(JSON.stringify(sensitiveService.listPending()), /sk-secret-value/)
sensitiveService.cancelAll()
await sensitive

const onceService = new BrowserApprovalService(1000)
let executions = 0
const once = onceService.submit({ ...identity, clientRequestId: 'same-call' }, 3, draft, async () => ++executions)
const duplicate = onceService.submit({ ...identity, clientRequestId: 'same-call' }, 3, draft, async () => ++executions)
const onceId = onceService.listPending()[0].requestId
await Promise.all([
  onceService.respond({ requestId: onceId, approved: true }),
  onceService.respond({ requestId: onceId, approved: true }),
])
assert.equal((await once).ok, true)
assert.equal((await duplicate).ok, true)
assert.equal(executions, 1)

const queueService = new BrowserApprovalService()
const order: string[] = []
const mutation = (name: string, delay: number) => queueService.submit(identity, 5, { ...draft, category: 'browser.interact' }, async () => {
  order.push(`${name}:start`)
  await new Promise((resolve) => setTimeout(resolve, delay))
  order.push(`${name}:end`)
  return name
})
await Promise.all([mutation('one', 15), mutation('two', 0)])
assert.deepEqual(order, ['one:start', 'one:end', 'two:start', 'two:end'])

let concurrent = 0
let peak = 0
const readDraft = { ...draft, category: 'browser.read' as const, mutation: false }
await Promise.all([1, 2].map(() => queueService.submit(identity, 3, readDraft, async () => {
  concurrent += 1
  peak = Math.max(peak, concurrent)
  await new Promise((resolve) => setTimeout(resolve, 10))
  concurrent -= 1
})))
assert.equal(peak, 2)
}

testApprovalService()
  .then(() => console.log('browser tests passed'))
  .catch((error) => { console.error(error); process.exitCode = 1 })
