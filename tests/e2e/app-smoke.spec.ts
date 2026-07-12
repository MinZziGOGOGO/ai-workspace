import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'
import { cleanupGeneratedTitle, fallbackTitleFromText, isGenericSessionTitle } from '../../src/shared/sessionTitles'

type Rect = { x: number; y: number; width: number; height: number }

async function panelRect(page: Page, panel: string): Promise<Rect> {
  return page.evaluate((panelId: string) => {
    const el = document.querySelector(`[data-testid="workspace-panel-${panelId}"]`)
    if (!el) throw new Error(`Missing panel ${panelId}`)
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, panel)
}

async function expectSingleContextBarWithinPanel(page: Page, panel: string, testId: string) {
  const panelLocator = page.getByTestId(`workspace-panel-${panel}`)
  const barLocator = panelLocator.getByTestId(testId)
  await expect(barLocator).toHaveCount(1)
  await expect(barLocator).toBeVisible()

  const panelBox = await panelLocator.boundingBox()
  const barBox = await barLocator.boundingBox()
  if (!panelBox || !barBox) throw new Error(`Missing context bar geometry for ${panel}`)

  expect(barBox.x).toBeGreaterThanOrEqual(panelBox.x - 1)
  expect(barBox.y).toBeGreaterThanOrEqual(panelBox.y - 1)
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
  expect(barBox.width).toBeLessThanOrEqual(panelBox.width + 1)
}

async function expectComposerHeaderReadable(page: Page, panel: string, composerTestId: string) {
  const colors = await page.evaluate(({ panel, composerTestId }) => {
    const header = document.querySelector(`.workspace-panel-head.panel-${panel}`)
    const composer = document.querySelector(`[data-testid="${composerTestId}"]`)?.closest('.composer')
    if (!header || !composer) throw new Error(`Missing ${panel} header or composer`)
    const headerStyles = getComputedStyle(header)
    const composerStyles = getComputedStyle(composer)
    return {
      headerBg: headerStyles.backgroundColor,
      headerFg: headerStyles.color,
      composerBg: composerStyles.backgroundColor,
      composerFg: composerStyles.color,
    }
  }, { panel, composerTestId })
  expect(colors.headerBg).not.toBe(colors.headerFg)
  expect(colors.composerBg).not.toBe(colors.composerFg)
}

async function contrastForSelector(page: Page, selector: string): Promise<number> {
  return page.evaluate((targetSelector) => {
    function parseRgb(value: string): { r: number; g: number; b: number; a: number } | null {
      const match = value.match(/rgba?\(([^)]+)\)/)
      if (!match) return null
      const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()))
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }
    }
    function composite(
      fg: { r: number; g: number; b: number; a: number },
      bg: { r: number; g: number; b: number; a: number }
    ) {
      return {
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      }
    }
    function luminance(color: { r: number; g: number; b: number }) {
      const [r, g, b] = [color.r, color.g, color.b].map((raw) => {
        const value = raw / 255
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    function contrast(fg: { r: number; g: number; b: number }, bg: { r: number; g: number; b: number }) {
      let foreground = luminance(fg)
      let background = luminance(bg)
      if (foreground < background) [foreground, background] = [background, foreground]
      return Number(((foreground + 0.05) / (background + 0.05)).toFixed(2))
    }
    function backgroundFor(el: Element) {
      let current: Element | null = el
      while (current) {
        const background = getComputedStyle(current).backgroundColor
        const parsed = parseRgb(background)
        if (parsed && parsed.a > 0) return parsed
        current = current.parentElement
      }
      return parseRgb(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 }
    }

    const el = document.querySelector(targetSelector)
    if (!el) throw new Error(`Missing selector: ${targetSelector}`)
    const fg = parseRgb(getComputedStyle(el).color)
    const bg = backgroundFor(el)
    if (!fg) throw new Error(`Could not parse foreground for ${targetSelector}`)
    return contrast(composite(fg, bg), bg)
  }, selector)
}

async function focusMetrics(page: Page, selector: string): Promise<{ outlineWidth: number; width: number; height: number }> {
  return page.evaluate((targetSelector) => {
    const el = document.querySelector<HTMLElement>(targetSelector)
    if (!el) throw new Error(`Missing selector: ${targetSelector}`)
    el.focus()
    const styles = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
      outlineWidth: Number.parseFloat(styles.outlineWidth || '0'),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  }, selector)
}

async function launchSmokeApp(testInfo: { outputPath: (name: string) => string }, env: Record<string, string> = {}) {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const userDataDir = testInfo.outputPath('user-data')
  await mkdir(userDataDir, { recursive: true })
  return electron.launch({
    args: [
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      '--no-sandbox',
      path.join(repoRoot, 'out', 'main', 'index.js')
    ],
    env: {
      ...process.env,
      AIWORKSPACE_TEST_USER_DATA: userDataDir,
      E2E_SKIP_SETUP_WIZARD: '1',
      ELECTRON_DISABLE_GPU: '1',
      ...env
    }
  })
}

async function createAndSelectProject(page: Page, testInfo: { outputPath: (name: string) => string }, name: string) {
  const projectParent = testInfo.outputPath(`${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-projects`)
  await mkdir(projectParent, { recursive: true })
  const project = await page.evaluate(async ({ projectName, parentDir }) => {
    return await (window as any).api.projects.create(projectName, parentDir)
  }, { projectName: name, parentDir: projectParent }) as { id: string; path: string }
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('workspace-tool-navigator').click()
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await expect(page.getByText(name).first()).toBeVisible()
  return project
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

test('session title cleanup preserves only descriptive titles', () => {
  expect(isGenericSessionTitle('Chat 11.6.2026')).toBe(true)
  expect(isGenericSessionTitle('New Chat')).toBe(true)
  expect(isGenericSessionTitle('')).toBe(true)
  expect(isGenericSessionTitle('Window Manager Refactor')).toBe(false)

  expect(cleanupGeneratedTitle('"Title: Window manager layout polish."')).toBe('Window manager layout polish')
  expect(cleanupGeneratedTitle('Chat 11.6.2026')).toBeNull()
  expect(fallbackTitleFromText('Please help me debug nested split persistence after reload')).toBe(
    'Please help me debug nested'
  )
})

test('shared session rail supports pin, rename, archive, search, and confirmed delete', async ({}, testInfo) => {
  const electronApp = await launchSmokeApp(testInfo, { E2E_FAKE_OLLAMA: '1' })
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()

    await page.evaluate(async () => {
      const api = (window as any).api
      for (let i = 0; i < 9; i++) {
        await api.sessions.create('__global__', 'chat', i === 4 ? 'Session parity target' : `Session parity extra ${i}`)
      }
    })
    await page.getByTestId('workspace-tool-chat').click()
    const chatPanel = page.getByTestId('workspace-panel-chat')
    await expect(chatPanel.getByTestId('session-item')).toHaveCount(9)

    // AgentSessionRail is shared by Chat, Hermes, Claude Code, and Codex; this
    // one-tab test covers the shared session-management behavior for all four.
    await chatPanel.getByLabel('Options for Session parity target').click()
    await page.getByTestId('session-menu-pin').click()
    const targetRow = chatPanel.locator('.session-row').filter({ hasText: 'Session parity target' })
    await expect(targetRow).toBeVisible()
    await targetRow.getByTestId('session-options').click()
    await expect(page.getByTestId('session-menu-pin')).toContainText('Unpin')
    await page.keyboard.press('Escape')

    await targetRow.getByTestId('session-options').click()
    await page.getByTestId('session-menu-rename').click()
    await page.getByTestId('session-rename-input').fill('Renamed parity session')
    await page.keyboard.press('Enter')
    await expect(chatPanel.getByTestId('session-item').filter({ hasText: 'Renamed parity session' })).toHaveCount(1)

    await chatPanel.getByPlaceholder('Search sessions...').fill('Renamed parity')
    await expect(chatPanel.getByTestId('session-item')).toHaveCount(1)
    await expect(chatPanel.getByTestId('session-item').first()).toContainText('Renamed parity session')
    await chatPanel.getByPlaceholder('Search sessions...').fill('')
    await expect(chatPanel.getByTestId('session-item')).toHaveCount(9)

    await chatPanel.locator('.session-row').filter({ hasText: 'Renamed parity session' }).getByTestId('session-options').click()
    await page.getByTestId('session-menu-archive').click()
    await expect(chatPanel.getByTestId('session-item').filter({ hasText: 'Renamed parity session' })).toHaveCount(0)
    await expect(chatPanel.getByRole('button', { name: /1 archived session/ })).toBeVisible()
    await chatPanel.getByRole('button', { name: /1 archived session/ }).click()
    await expect(chatPanel.locator('.session-archived-list').getByTestId('session-item')).toContainText('Renamed parity session')

    await chatPanel.locator('.session-archived-list').getByTestId('session-options').click()
    const deleteMenuItem = page.getByTestId('session-menu-delete')
    const restingDeleteColor = await deleteMenuItem.evaluate(element => getComputedStyle(element).color)
    await expect(deleteMenuItem).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await deleteMenuItem.hover()
    await expect(deleteMenuItem).toHaveCSS('background-color', restingDeleteColor)
    await expect(deleteMenuItem).toHaveCSS('color', 'rgb(255, 255, 255)')
    await deleteMenuItem.click()
    await expect(deleteMenuItem).toContainText('Click again to confirm')
    await deleteMenuItem.click()
    await expect(chatPanel.locator('.session-archived-list')).toHaveCount(0)
    await expect(chatPanel.getByRole('button', { name: /archived session/ })).toHaveCount(0)
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})

test('accessibility mechanics keep focus, contrast, and compact targets usable', async ({}, testInfo) => {
  const electronApp = await launchSmokeApp(testInfo, { E2E_FAKE_OLLAMA: '1' })
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()

    await page.evaluate(async () => {
      const api = (window as any).api
      await api.sessions.create('__global__', 'chat', 'Accessibility audit row')
      await api.memory.save({
        projectId: null,
        type: 'note',
        title: 'Accessibility audit memory',
        content: 'Muted text, controls, and menus should remain readable in both themes.',
        source: 'e2e',
      })
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('workspace-tool-chat').click()
    await page.getByTestId('workspace-tool-knowledge').click()
    const chatPanel = page.getByTestId('workspace-panel-chat')
    await expect(chatPanel.getByTestId('session-item').filter({ hasText: 'Accessibility audit row' })).toBeVisible()
    await expect(page.getByTestId('workspace-panel-knowledge').getByTestId('knowledge-item')).toBeVisible()

    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((nextTheme) => {
        if (nextTheme === 'dark') document.documentElement.dataset.theme = 'dark'
        else document.documentElement.removeAttribute('data-theme')
      }, theme)
      await expect.poll(() => contrastForSelector(page, '.knowledge-panel-head .muted')).toBeGreaterThanOrEqual(4.5)
      await expect.poll(() => contrastForSelector(page, '.memory-content')).toBeGreaterThanOrEqual(4.5)

      await page.locator('.topbar-group-btn').filter({ hasText: /^AI/ }).click()
      await expect(page.locator('.topbar-dropdown-item').first()).toBeVisible()
      await expect.poll(() => contrastForSelector(page, '.topbar-dropdown-item')).toBeGreaterThanOrEqual(4.5)
      await page.keyboard.press('Escape')
      await expect(page.locator('.topbar-dropdown')).toHaveCount(0)
    }

    const composer = await page.evaluate(() => {
      const textarea = document.querySelector<HTMLElement>('[data-testid="chat-composer"]')
      textarea?.focus()
      const shell = textarea?.closest<HTMLElement>('.composer-shell')
      const styles = shell ? getComputedStyle(shell) : null
      return { borderColor: styles?.borderTopColor ?? '' }
    })
    expect(composer.borderColor).not.toBe('rgba(0, 0, 0, 0)')

    const sessionFocus = await focusMetrics(page, '[data-testid="workspace-panel-chat"] [data-testid="session-item"]')
    expect(sessionFocus.outlineWidth).toBeGreaterThanOrEqual(2)

    const closeFocus = await focusMetrics(page, '[data-testid="workspace-panel-close-chat"]')
    expect(closeFocus.outlineWidth).toBeGreaterThanOrEqual(2)
    expect(closeFocus.height).toBeGreaterThanOrEqual(28)

    const optionsMetrics = await focusMetrics(page, '[data-testid="workspace-panel-chat"] [data-testid="session-options"]')
    expect(optionsMetrics.width).toBeGreaterThanOrEqual(28)
    expect(optionsMetrics.height).toBeGreaterThanOrEqual(28)

    await page.getByTestId('workspace-panel-chat').getByTestId('session-options').first().click()
    await expect(page.getByTestId('session-menu-pin')).toBeFocused()
    const menuItemBox = await page.getByTestId('session-menu-pin').boundingBox()
    if (!menuItemBox) throw new Error('Missing session menu geometry')
    expect(menuItemBox.height).toBeGreaterThanOrEqual(32)
    await page.keyboard.press('Escape')
    await expect(page.locator('.session-context-menu')).toHaveCount(0)
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})

test('Chat user messages use the same feed column as agent messages', async ({}, testInfo) => {
  const electronApp = await launchSmokeApp(testInfo, { E2E_FAKE_OLLAMA: '1' })
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()
    await createAndSelectProject(page, testInfo, 'Chat Message Layout Project')

    await page.getByTestId('workspace-tool-chat').click()
    const chatPanel = page.getByTestId('workspace-panel-chat')
    await expect(chatPanel).toBeVisible()
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'e2e-chat-model',
          messages: [
            {
              id: 'layout-user',
              session_id: 'layout-session',
              role: 'user',
              content: 'This message should sit in the normal feed column.',
              model: null,
              created_at: Date.now() - 1000,
            },
            {
              id: 'layout-assistant',
              session_id: 'layout-session',
              role: 'assistant',
              content: 'Assistant response for layout comparison.',
              model: 'e2e-chat-model',
              created_at: Date.now(),
            },
          ],
        },
      }))
    })

    await expect(chatPanel.locator('.chat-scroll > .msg.user')).toHaveCount(1)
    const layout = await chatPanel.locator('.chat-scroll').evaluate((scroll) => {
      const user = scroll.querySelector<HTMLElement>('.msg.user')
      const assistant = scroll.querySelector<HTMLElement>('.msg.assistant')
      if (!user || !assistant) throw new Error('Missing test messages')
      const userRect = user.getBoundingClientRect()
      const assistantRect = assistant.getBoundingClientRect()
      return {
        userIsDirectChild: user.parentElement === scroll,
        userWidth: Math.round(userRect.width),
        assistantWidth: Math.round(assistantRect.width),
      }
    })
    expect(layout.userIsDirectChild).toBe(true)
    expect(Math.abs(layout.userWidth - layout.assistantWidth)).toBeLessThanOrEqual(8)

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-live-state', {
        detail: {
          busy: true,
          thinking: 'I am checking the relevant constraints before answering.',
          streaming: 'Here is the answer so far.',
        },
      }))
    })
    await expect(chatPanel.locator('.thinking-block')).toBeVisible()
    await expect(chatPanel.locator('.thinking-block')).toContainText('Thought for')

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'e2e-chat-model',
          session: { id: 'layout-long-session', project_id: 'test', mode: 'chat', title: 'Long chat', created_at: now },
          messages: Array.from({ length: 32 }, (_, index) => ({
            id: `layout-long-${index}`,
            session_id: 'layout-long-session',
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `Long scroll message ${index + 1}\n\n${'This line gives the chat enough height to scroll naturally. '.repeat(8)}`,
            model: index % 2 === 0 ? null : 'e2e-chat-model',
            created_at: now + index,
          })),
        },
      }))
    })

    const scroll = chatPanel.locator('.chat-scroll')
    await expect.poll(() => scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await expect.poll(() => scroll.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 4)).toBe(true)
    await scroll.evaluate((el) => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true }))
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await expect(chatPanel.getByTestId('chat-jump-bottom')).toBeVisible()
    await chatPanel.getByTestId('chat-jump-bottom').click({ force: true })
    await expect.poll(() => scroll.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 4)).toBe(true)
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})

test('execute-mode handoff sends a generated prompt to Codex', async ({}, testInfo) => {
  const electronApp = await launchSmokeApp(testInfo, {
    E2E_FAKE_OLLAMA: '1',
    E2E_FAKE_CODEX: '1'
  })
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()
    await createAndSelectProject(page, testInfo, 'Handoff Codex Project')

    await page.getByTestId('workspace-tool-codex').click()
    await expect(page.getByTestId('workspace-panel-codex')).toBeVisible()
    await page.getByTestId('workspace-tool-chat').click()
    await expect(page.getByTestId('workspace-panel-chat')).toBeVisible()
    await expect.poll(() => page.getByTestId('workspace-panel-chat').locator('select').first().inputValue()).toBe('e2e-chat-model')
    await page.getByTestId('workspace-panel-chat').getByRole('button', { name: 'New chat' }).click()
    await expect(page.getByTestId('workspace-panel-chat').locator('.chat-scroll')).toBeVisible()

    await page.getByTestId('chat-mode-execute').click()
    await expect(page.getByTestId('chat-mode-execute')).toHaveClass(/active/)
    await page.getByTestId('chat-composer').fill('Please send this plan to Codex in a new session')
    await page.getByTestId('chat-send').click()
    await expect(page.getByTestId('handoff-checking')).toBeVisible()
    await expect(page.getByTestId('handoff-card')).toBeVisible()
    await expect(page.getByTestId('handoff-card')).toContainText('Ready to send to Codex')
    await expect(page.getByTestId('handoff-card')).toContainText('E2E handoff prompt')

    await page.getByTestId('handoff-send').click()
    await expect(page.getByTestId('handoff-confirm')).toContainText('Sent to Codex')
    await expect(page.getByTestId('workspace-panel-codex')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-codex')).toContainText('Fake Codex received: # E2E handoff prompt')
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})

test('Claude Code creates checkpoints and can roll back fake file changes', async ({}, testInfo) => {
  const electronApp = await launchSmokeApp(testInfo, {
    E2E_FAKE_CLAUDE_CODE: '1',
    E2E_FAKE_OLLAMA: '1'
  })
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()
    const project = await createAndSelectProject(page, testInfo, 'Checkpoint Project')

    await writeFile(path.join(project.path, 'README.md'), '# checkpoint project\n')
    await writeFile(path.join(project.path, 'e2e-claude-output.txt'), 'before checkpoint\n')
    execFileSync('git', ['init'], { cwd: project.path, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'e2e@example.test'], { cwd: project.path, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: project.path, stdio: 'ignore' })
    execFileSync('git', ['add', '.'], { cwd: project.path, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: project.path, stdio: 'ignore' })

    await page.getByTestId('workspace-tool-claudecode').click()
    const claudePanel = page.getByTestId('workspace-panel-claudecode')
    await expect(claudePanel).toBeVisible()
    await expect(page.getByTestId('claude-code-send')).toBeEnabled()
    await page.getByTestId('claude-code-composer').fill('Modify files for checkpoint coverage')
    await page.getByTestId('claude-code-send').click()

    await expect(claudePanel).toContainText('Fake Claude Code completed: Modify files for checkpoint coverage')
    await expect(page.getByTestId('claude-code-checkpoint')).toBeVisible()
    const activeSessionId = await page.evaluate(async (projectId) => {
      const sessions = await (window as any).api.sessions.list(projectId, 'claudecode')
      const target = sessions.find((s: any) => s.title.includes('Modify files'))
      const rows = await (window as any).api.checkpoints.list(target.id)
      return { sessionId: target.id, checkpointRows: rows.length }
    }, project.id) as { sessionId: string; checkpointRows: number }
    expect(activeSessionId.checkpointRows).toBe(1)
    expect(await pathExists(path.join(project.path, 'e2e-claude-output.txt'))).toBe(true)
    expect(await readFile(path.join(project.path, 'e2e-claude-output.txt'), 'utf8')).toContain('Fake Claude Code modified files')

    await page.getByTestId('claude-code-checkpoint-open').click()
    await expect(page.getByTestId('claude-code-checkpoint-panel')).toBeVisible()
    await page.getByTestId('claude-code-checkpoint-rollback').click()
    await expect(page.getByTestId('claude-code-checkpoint-rollback')).toContainText('Continue?')
    await page.getByTestId('claude-code-checkpoint-rollback').click()
    await expect(page.locator('.toast')).toContainText('Rolled back to checkpoint')
    await expect(claudePanel).toContainText('Rolled back: file changes made after this checkpoint were discarded.')
    await expect.poll(async () => (await readFile(path.join(project.path, 'e2e-claude-output.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('before checkpoint\n')
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})

test('Hermes ask mode renders permission approvals for deny, allow once, and allow for session', async ({}, testInfo) => {
  const electronApp = await launchSmokeApp(testInfo, {
    E2E_FAKE_HERMES: '1',
    E2E_FAKE_OLLAMA: '1'
  })
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()
    await createAndSelectProject(page, testInfo, 'Hermes Permission Project')
    await page.getByTestId('workspace-tool-hermes').click()
    const hermesPanel = page.getByTestId('workspace-panel-hermes')
    await expect(hermesPanel).toBeVisible()
    await page.getByTestId('hermes-permission-mode').selectOption('1')
    await expect(page.getByTestId('hermes-permission-mode')).toHaveValue('1')

    await page.getByTestId('hermes-composer').fill('deny this permission request')
    await page.getByTestId('hermes-send').click()
    await expect(page.getByTestId('hermes-permission-card')).toContainText('Run command `npm test`')
    await expect(page.getByTestId('hermes-permission-deny')).toBeVisible()
    await expect(page.getByTestId('hermes-permission-allow-once')).toBeVisible()
    await expect(page.getByTestId('hermes-permission-allow-session')).toBeVisible()
    await page.getByTestId('hermes-permission-deny').click()
    await expect(page.getByTestId('hermes-permission-card')).toHaveCount(0)
    await expect(hermesPanel).toContainText('Fake Hermes permission denied')

    await page.getByTestId('hermes-composer').fill('allow this permission once')
    await page.getByTestId('hermes-send').click()
    await expect(page.getByTestId('hermes-permission-card')).toBeVisible()
    await page.getByTestId('hermes-permission-allow-once').click()
    await expect(page.getByTestId('hermes-permission-card')).toHaveCount(0)
    await expect(hermesPanel).toContainText('Fake Hermes approved and completed: allow this permission once')
    const firstTool = hermesPanel.getByTestId('hermes-tool-summary').filter({ hasText: 'npm test' }).first()
    await expect(firstTool).toBeVisible()
    await firstTool.click()
    await expect(hermesPanel.getByTestId('hermes-tool-details').first()).toContainText('Tool')
    await expect(hermesPanel.getByTestId('hermes-tool-details').first()).toContainText('npm test')
    await expect(hermesPanel.locator('.hermes-tool-details .syntax-block').first()).toBeVisible()
    await expect(hermesPanel.locator('.hermes-tool-details .syntax-command').first()).toBeVisible()
    const toolBox = await hermesPanel.getByTestId('hermes-tool-card').first().boundingBox()
    const responseBox = await hermesPanel.getByText('Fake Hermes approved and completed: allow this permission once').boundingBox()
    if (!toolBox || !responseBox) throw new Error('Missing Hermes tool ordering geometry')
    expect(toolBox.y).toBeLessThan(responseBox.y)
    const inlineToolStyle = await hermesPanel.evaluate((panel) => {
      const toolCard = panel.querySelector<HTMLElement>('[data-testid="hermes-tool-card"]')
      const summary = panel.querySelector<HTMLElement>('[data-testid="hermes-tool-summary"]')
      if (!toolCard || !summary) throw new Error('Missing Hermes inline tool targets')
      const cardStyle = getComputedStyle(toolCard)
      const summaryStyle = getComputedStyle(summary)
      return {
        cardBorder: cardStyle.borderTopStyle,
        cardBackground: cardStyle.backgroundColor,
        summaryBackground: summaryStyle.backgroundColor
      }
    })
    expect(inlineToolStyle.cardBorder).toBe('none')
    expect(inlineToolStyle.cardBackground).toBe('rgba(0, 0, 0, 0)')
    expect(inlineToolStyle.summaryBackground).toBe('rgba(0, 0, 0, 0)')
    await hermesPanel.getByRole('button', { name: 'Board' }).click()
    await expect(hermesPanel.locator('.kanban-board')).toContainText('npm test')
    await hermesPanel.getByRole('button', { name: 'Chat' }).click()

    await page.getByTestId('hermes-composer').fill('allow this permission for the session')
    await page.getByTestId('hermes-send').click()
    await expect(page.getByTestId('hermes-permission-card')).toBeVisible()
    await page.getByTestId('hermes-permission-allow-session').click()
    await expect(page.getByTestId('hermes-permission-card')).toHaveCount(0)
    await expect(hermesPanel).toContainText('Fake Hermes approved and completed: allow this permission for the session')
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})

test('dragging a panel header docks panels side by side and keeps both usable', async ({}, testInfo) => {
  const electronApp = await launchSmokeApp(testInfo, { E2E_FAKE_CODEX: '1' })
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()
    await page.getByTestId('workspace-tool-navigator').click()
    await page.getByTestId('workspace-tool-knowledge').click()
    await expect(page.getByTestId('workspace-panel-navigator')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-knowledge')).toBeVisible()

    const navHeader = await page.locator('.workspace-panel-head.panel-navigator').boundingBox()
    const knowledgePanel = await page.getByTestId('workspace-panel-knowledge').boundingBox()
    if (!navHeader || !knowledgePanel) throw new Error('Missing docking geometry')
    await page.mouse.move(navHeader.x + navHeader.width / 2, navHeader.y + navHeader.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      knowledgePanel.x + knowledgePanel.width - 50,
      knowledgePanel.y + knowledgePanel.height / 2,
      { steps: 14 }
    )
    await page.mouse.up()

    await expect.poll(() => page.evaluate(() => {
      const storageKey = Object.keys(localStorage).find((key) => key.startsWith('aiworkspace.layout3.'))
      if (!storageKey) return null
      return JSON.parse(localStorage.getItem(storageKey) || '{}')?.layout?.root?.type ?? null
    })).toBe('split')
    const docked = await page.evaluate(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector)
        if (!el) throw new Error(`Missing ${selector}`)
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      const storageKey = Object.keys(localStorage).find((key) => key.startsWith('aiworkspace.layout3.'))
      return {
        navigator: rect('[data-testid="workspace-panel-navigator"]'),
        knowledge: rect('[data-testid="workspace-panel-knowledge"]'),
        layout: storageKey ? JSON.parse(localStorage.getItem(storageKey) || '{}') : null
      }
    }) as { navigator: Rect; knowledge: Rect; layout: { layout?: { root?: { type?: string; direction?: string } } } | null }
    expect(Math.abs(docked.navigator.y - docked.knowledge.y)).toBeLessThan(8)
    expect(Math.abs(docked.navigator.x - docked.knowledge.x)).toBeGreaterThan(100)
    expect(docked.layout?.layout?.root?.type).toBe('split')
    expect(docked.layout?.layout?.root?.direction).toBe('horizontal')

    await expect(page.getByTestId('navigator-current-workspace')).toContainText('Global Workspace')
    await page.getByTestId('workspace-panel-knowledge').getByPlaceholder(/Search memory/).fill('dock still works')
    await expect(page.getByTestId('workspace-panel-knowledge').getByPlaceholder(/Search memory/)).toHaveValue('dock still works')
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})

test('Codex message regenerate replaces the last response and edit-resend forks the turn', async ({}, testInfo) => {
  const electronApp = await launchSmokeApp(testInfo, {
    E2E_FAKE_CODEX: '1',
    E2E_FAKE_OLLAMA: '1'
  })
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()
    await createAndSelectProject(page, testInfo, 'Message Actions Project')
    await page.getByTestId('workspace-tool-codex').click()
    const codexPanel = page.getByTestId('workspace-panel-codex')
    await expect(codexPanel).toBeVisible()

    await page.getByTestId('codex-composer').fill('original codex prompt')
    await page.getByTestId('codex-send').click()
    await expect(codexPanel).toContainText('Fake Codex received: original codex prompt')
    await expect(codexPanel).toContainText('Fake Codex run #')
    const firstRun = await codexPanel.locator('.msg.assistant').last().textContent()

    await page.getByTestId('regenerate-response').click()
    await expect.poll(async () => {
      const text = await codexPanel.locator('.msg.assistant').last().textContent()
      return text !== firstRun && text?.includes('Fake Codex received: original codex prompt')
    }).toBe(true)
    await expect(codexPanel.locator('.msg.assistant')).toHaveCount(1)

    await page.getByTestId('edit-message-btn').click()
    await page.getByTestId('edit-message-textarea').fill('edited codex prompt')
    await page.getByTestId('edit-message-save').click()
    await expect(codexPanel).toContainText('Fake Codex received: edited codex prompt')
    await expect(codexPanel).not.toContainText('Fake Codex received: original codex prompt')
    await expect(codexPanel.locator('.msg.user')).toHaveCount(1)
    await expect(codexPanel.locator('.msg.assistant')).toHaveCount(1)
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})

test('dark mode menus and topbar hover stay readable and calm', async ({}, testInfo) => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const userDataDir = testInfo.outputPath('user-data')
  await mkdir(userDataDir, { recursive: true })

  const electronApp = await electron.launch({
    args: [
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      '--no-sandbox',
      path.join(repoRoot, 'out', 'main', 'index.js')
    ],
    env: {
      ...process.env,
      AIWORKSPACE_TEST_USER_DATA: userDataDir,
      E2E_SKIP_SETUP_WIZARD: '1',
      E2E_FAKE_CODEX: '1',
      E2E_FAKE_REGISTRY: '1',
      ELECTRON_DISABLE_GPU: '1'
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()

    await page.evaluate(async () => {
      await window.api.settings.set('ui_theme', 'dark')
      await window.api.settings.set('ui_motion_mode', 'off')
      document.documentElement.dataset.theme = 'dark'
      document.documentElement.dataset.motion = 'off'
      document.documentElement.dataset.motionPreference = 'off'
      document.documentElement.dataset.reducedMotion = 'true'
    })

    const aiButton = page.locator('.topbar-group-btn').filter({ hasText: /^AI/ })
    await aiButton.hover()
    await expect(aiButton).toHaveCSS('box-shadow', 'none')

    await aiButton.click()
    await expect(page.locator('.topbar-dropdown')).toBeVisible()
    const menuColors = await page.evaluate(() => {
      const menu = document.querySelector('.topbar-dropdown')
      const item = document.querySelector('.topbar-dropdown-item')
      if (!menu || !item) throw new Error('Missing dark mode topbar dropdown')
      const menuStyles = getComputedStyle(menu)
      const itemStyles = getComputedStyle(item)
      return {
        menuBackground: menuStyles.backgroundColor,
        itemColor: itemStyles.color,
        backdropFilter: menuStyles.backdropFilter || (menuStyles as any).webkitBackdropFilter || '',
      }
    })
    expect(menuColors.menuBackground).not.toBe('rgb(255, 255, 255)')
    expect(menuColors.itemColor).not.toBe('rgb(255, 255, 255)')
    expect(menuColors.backdropFilter === '' || menuColors.backdropFilter === 'none').toBe(true)

    await page.mouse.click(20, 100)
    await page.getByTestId('open-settings').click()
    await expect(page.locator('.settings-shell')).toBeVisible()
    await page.getByRole('button', { name: 'Appearance' }).click()
    const selectStyles = await page.evaluate(() => {
      const select = document.querySelector('.settings-control select')
      const option = select?.querySelector('option')
      if (!select || !option) throw new Error('Missing settings select')
      const selectComputed = getComputedStyle(select)
      const optionComputed = getComputedStyle(option)
      return {
        selectBackground: selectComputed.backgroundColor,
        selectColor: selectComputed.color,
        optionBackground: optionComputed.backgroundColor,
        optionColor: optionComputed.color,
      }
    })
    expect(selectStyles.selectBackground).not.toBe('rgb(255, 255, 255)')
    expect(selectStyles.optionBackground).not.toBe('rgb(255, 255, 255)')
    expect(selectStyles.selectColor).not.toBe(selectStyles.selectBackground)
    expect(selectStyles.optionColor).not.toBe(selectStyles.optionBackground)
  } finally {
    await electronApp.close()
  }
})

test('project home command center shows global and project states with working actions', async ({}, testInfo) => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const userDataDir = testInfo.outputPath('user-data')
  const projectParent = testInfo.outputPath('projects')
  await mkdir(userDataDir, { recursive: true })
  await mkdir(projectParent, { recursive: true })

  const electronApp = await electron.launch({
    args: [
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      '--no-sandbox',
      path.join(repoRoot, 'out', 'main', 'index.js')
    ],
    env: {
      ...process.env,
      AIWORKSPACE_TEST_USER_DATA: userDataDir,
      E2E_SKIP_SETUP_WIZARD: '1',
      E2E_FAKE_SETUP_TOOLS: '1',
      E2E_FAKE_CODEX: '1',
      E2E_FAKE_REGISTRY: '1',
      ELECTRON_DISABLE_GPU: '1'
    }
  })

  const consoleErrors: string[] = []
  try {
    const page = await electronApp.firstWindow()
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()

    await expect(page.getByTestId('workspace-panel-home')).toBeVisible()
    await expect(page.getByTestId('project-home')).toContainText('Welcome to Global Workspace')
    await expect(page.getByTestId('project-home-tool-readiness')).toContainText('Ollama')
    await expect(page.getByTestId('project-home-tool-readiness')).toContainText('Web Companion')

    await page.getByTestId('project-home-action-start-chat').click()
    await expect(page.getByTestId('workspace-panel-chat')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-chat').locator('[data-composer="true"]')).toHaveValue(/global workspace/i)

    await page.getByTestId('project-home-action-open-knowledge').click()
    await expect(page.getByTestId('workspace-panel-knowledge')).toBeVisible()

    await page.getByTestId('project-home-action-open-settings').click()
    await expect(page.getByTestId('settings-shell')).toBeVisible()
    await page.getByTestId('settings-close').click()
    await expect(page.getByTestId('settings-shell')).not.toBeVisible()

    const project = await page.evaluate(async (parentDir) => {
      return await (window as any).api.projects.create('Home Command Project', parentDir)
    }, projectParent) as { id: string; path: string }
    await writeFile(path.join(project.path, 'README.md'), '# Home Command Project\n')
    await writeFile(path.join(project.path, 'package.json'), '{"scripts":{"build":"echo ok"}}\n')

    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('workspace-tool-navigator').click()
    await page.getByRole('button', { name: /Home Command Project/ }).click()

    const home = page.getByTestId('project-home')
    await expect(page.getByTestId('workspace-panel-home')).toBeVisible()
    await expect(home).toContainText('Home Command Project')
    await expect(page.getByTestId('project-home-summary')).toContainText('Project')
    await expect(page.getByTestId('project-home-files')).toContainText('README found')
    await expect(page.getByTestId('project-home-files')).toContainText('package.json found')

    await page.getByTestId('project-home-starter-summarize-this-project').click()
    await expect(page.getByTestId('workspace-panel-chat')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-chat').locator('[data-composer="true"]')).toHaveValue(/Summarize this project/)

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    const darkReadable = await page.evaluate(() => {
      const home = document.querySelector('[data-testid="project-home"]')
      const title = document.querySelector('.project-home-title-block h1')
      if (!home || !title) throw new Error('Missing Project Home for dark theme check')
      const homeStyles = getComputedStyle(home)
      const titleStyles = getComputedStyle(title)
      return {
        bg: homeStyles.backgroundColor,
        fg: titleStyles.color,
      }
    })
    expect(darkReadable.bg).not.toBe(darkReadable.fg)

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light'
    })
    const lightReadable = await page.evaluate(() => {
      const home = document.querySelector('[data-testid="project-home"]')
      const title = document.querySelector('.project-home-title-block h1')
      if (!home || !title) throw new Error('Missing Project Home for light theme check')
      const homeStyles = getComputedStyle(home)
      const titleStyles = getComputedStyle(title)
      return {
        bg: homeStyles.backgroundColor,
        fg: titleStyles.color,
      }
    })
    expect(lightReadable.bg).not.toBe(lightReadable.fg)

    expect(consoleErrors).toEqual([])
  } finally {
    await electronApp.close()
  }
})

test('global workspace UI smoke path', async ({}, testInfo) => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const userDataDir = testInfo.outputPath('user-data')
  await mkdir(userDataDir, { recursive: true })

  const electronApp = await electron.launch({
    args: [
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      '--no-sandbox',
      path.join(repoRoot, 'out', 'main', 'index.js')
    ],
    env: {
      ...process.env,
      AIWORKSPACE_TEST_USER_DATA: userDataDir,
      E2E_SKIP_SETUP_WIZARD: '1',
      E2E_FAKE_CODEX: '1',
      E2E_FAKE_REGISTRY: '1',
      ELECTRON_DISABLE_GPU: '1'
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // --- Phase A/B: startup and workspace shell ---
    await expect(page.getByTestId('workspace-shell')).toBeVisible()
    await expect(page.getByTestId('project-picker')).toHaveCount(0)
    await expect(page.getByText('Global Workspace').first()).toBeVisible()

    // Phase B: Project Home opens by default; quick action opens Chat.
    await expect(page.getByTestId('workspace-panel-home')).toBeVisible()
    await expect(page.getByTestId('project-home')).toContainText('Welcome to Global Workspace')
    await expect(page.getByTestId('workspace-panel-navigator')).toHaveCount(0)
    await page.getByTestId('project-home-action-start-chat').click()
    await expect(page.getByTestId('workspace-panel-chat')).toBeVisible()
    await expectSingleContextBarWithinPanel(page, 'chat', 'context-bar-chat')
    await expect(page.getByTestId('chat-composer')).toBeVisible()
    await expect(page.getByTestId('chat-send')).toBeVisible()
    await expect(page.getByTestId('chat-mode-pill')).toBeVisible()
    await expect(page.getByTestId('chat-extract-memories')).toBeVisible()
    await expect(page.getByTestId('chat-extract-memories')).toBeDisabled()
    await expect(page.getByTestId('voice-input-chat')).toBeVisible()
    const hasSpeechRecognition = await page.evaluate(() =>
      Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)
    )
    if (hasSpeechRecognition) {
      await expect(page.getByTestId('voice-input-chat')).toBeEnabled()
    } else {
      await expect(page.getByTestId('voice-input-chat')).toBeDisabled()
    }
    await expect(page.locator('.workspace-panel-head.panel-chat .workspace-panel-kind')).toHaveCount(0)
    await expect(page.locator('.workspace-panel-head.panel-chat')).not.toContainText(/Chat\s+Chat/)
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await expectComposerHeaderReadable(page, 'chat', 'chat-composer')
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    await expectComposerHeaderReadable(page, 'chat', 'chat-composer')

    await page.evaluate(() => {
      const now = Date.now()
      const tree = [
        'tower-defense/',
        '\u251c\u2500\u2500 index.html',
        '\u251c\u2500\u2500 package.json',
        '\u251c\u2500\u2500 src/',
        '\u2502   \u251c\u2500\u2500 main.js',
        '\u2502   \u2514\u2500\u2500 scenes/',
        '\u2502       \u251c\u2500\u2500 BootScene.js',
        '\u2502       \u2514\u2500\u2500 GameScene.js',
      ].join('\n')
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'prompt-output-session', project_id: '__global__', mode: 'chat', title: 'Prompt output', created_at: now },
          messages: [{
            id: 'assistant-prompt-output',
            session_id: 'prompt-output-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: [
              'Claude Code Prompt: Tower Defense Project Setup',
              '',
              'Create a new Phaser 3 tower defense game project using Vite. Set it up in a directory called "tower-defense".',
              '',
              '## Project Structure',
              '',
              '```text',
              tree,
              '```',
              '',
              '## Requirements',
              '',
              '### 1. Project Setup',
              '- Use Vite as the build tool',
              '- Install Phaser 3 as a dependency',
              '- Set up the dev server to run on http://localhost:3000',
              '',
              '```json',
              '{"scripts":{"dev":"vite --host 127.0.0.1 --port 3000"}}',
              '```',
            ].join('\n')
          }]
        }
      }))
    })
    const promptCard = page.getByTestId('prompt-output-card')
    await expect(promptCard).toBeVisible()
    await expect(promptCard.getByRole('button', { name: 'Copy full prompt' })).toBeVisible()
    await expect(page.getByTestId('copy-response').first()).toBeVisible()
    await expect(promptCard).toContainText('Claude Code Prompt: Tower Defense Project Setup')
    await expect(promptCard).toContainText('tower-defense/')
    await expect(promptCard).toContainText('GameScene.js')
    await expect(promptCard.locator('.code-copy').first()).toBeVisible()

    await page.evaluate(() => {
      ;(window as any).api.chat.send = async () => null
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'clarification-single-session', project_id: '__global__', mode: 'chat', title: 'Clarification single', created_at: now },
          messages: [{
            id: 'assistant-clarification-single',
            session_id: 'clarification-single-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: 'A quick choice will help.\n\n```clarification\n{"id":"design-app-kind","question":"What kind of question app do you want to build?","mode":"single","options":["Guided design assistant","Client intake questionnaire","Survey or research tool","Something else"],"allowFreewrite":true,"freewriteLabel":"Describe your idea"}\n```'
          }]
        }
      }))
    })
    await expect(page.getByTestId('clarification-card')).toBeVisible()
    await page.getByTestId('clarification-option').filter({ hasText: 'Guided design assistant' }).click()
    await page.getByTestId('clarification-freewrite').fill('I want it for solo app design brainstorming.')
    await page.getByTestId('clarification-submit').click()
    await expect(page.getByText('Clarification answer:')).toBeVisible()
    await expect(page.getByText('Selected: Guided design assistant')).toBeVisible()
    await expect(page.getByText('Additional details: I want it for solo app design brainstorming.')).toBeVisible()
    await expect(page.getByTestId('clarification-card')).toHaveCount(0)

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'choice-structured-session', project_id: '__global__', mode: 'chat', title: 'Choice structured', created_at: now },
          messages: [{
            id: 'assistant-choice-structured',
            session_id: 'choice-structured-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: 'Try this one.\n\n```choice_question\n{"id":"random-tree-question","question":"What is the largest living species of tree by trunk volume?","mode":"single","options":["Coast Redwood","Giant Sequoia","Amazonian Ceiba","European Oak"],"allowFreewrite":false}\n```'
          }]
        }
      }))
    })
    await expect(page.getByTestId('choice-card')).toBeVisible()
    await expect(page.getByTestId('choice-card')).toContainText('What is the largest living species of tree by trunk volume?')
    await page.getByTestId('choice-option').filter({ hasText: 'Giant Sequoia' }).click()
    await page.getByTestId('choice-submit').click()
    await expect(page.getByText('Answer:')).toBeVisible()
    await expect(page.getByText('Question: What is the largest living species of tree by trunk volume?')).toBeVisible()
    await expect(page.getByText('Selected: Giant Sequoia')).toBeVisible()
    await expect(page.getByTestId('choice-card')).toHaveCount(0)

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'choice-inline-session', project_id: '__global__', mode: 'chat', title: 'Choice inline', created_at: now },
          messages: [{
            id: 'assistant-choice-inline',
            session_id: 'choice-inline-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: "Here's a random question for you:\n\n\uD83C\uDF32 **What is the largest living species of tree by trunk volume?**\n\n**A)** Coast Redwood **B)** Giant Sequoia **C)** Amazonian Ceiba **D)** European Oak\n\nWant another question? Just ask! \uD83C\uDFAF"
          }]
        }
      }))
    })
    await expect(page.getByTestId('choice-card')).toBeVisible()
    await expect(page.getByTestId('choice-card')).toContainText('What is the largest living species of tree by trunk volume?')
    await expect(page.getByText("Here's a random question for you:")).toBeVisible()
    await expect(page.getByText('Want another question? Just ask!')).toBeVisible()
    await expect(page.getByTestId('choice-option')).toHaveCount(4)
    await expect(page.getByTestId('choice-option').filter({ hasText: 'Coast Redwood' })).toBeVisible()
    await expect(page.getByTestId('choice-option').filter({ hasText: 'Giant Sequoia' })).toBeVisible()
    await expect(page.getByTestId('choice-option').filter({ hasText: 'Amazonian Ceiba' })).toBeVisible()
    await expect(page.getByTestId('choice-option').filter({ hasText: 'European Oak' })).toBeVisible()
    await expect(page.getByTestId('choice-submit')).toBeDisabled()
    await page.getByTestId('choice-option').filter({ hasText: 'Giant Sequoia' }).click()
    await expect(page.getByTestId('choice-submit')).toBeEnabled()
    await page.getByTestId('choice-submit').click()
    await expect(page.getByText('Answer:')).toBeVisible()
    await expect(page.getByText('Selected: Giant Sequoia')).toBeVisible()
    await expect(page.getByTestId('choice-card')).toHaveCount(0)

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'choice-multiline-session', project_id: '__global__', mode: 'chat', title: 'Choice multiline', created_at: now },
          messages: [{
            id: 'assistant-choice-multiline',
            session_id: 'choice-multiline-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: "Here's another one!\n\n**What is the smallest country in the world by area?**\n\n**A)** Monaco\n**B)** Vatican City\n**C)** San Marino\n**D)** Liechtenstein\n\nTake your guess! \uD83C\uDFAF"
          }]
        }
      }))
    })
    await expect(page.getByTestId('choice-card')).toBeVisible()
    await expect(page.getByTestId('choice-card')).toContainText('What is the smallest country in the world by area?')
    await expect(page.getByText("Here's another one!")).toBeVisible()
    await expect(page.getByText('Take your guess!')).toBeVisible()
    await expect(page.getByTestId('choice-option')).toHaveCount(4)
    await expect(page.getByTestId('choice-option').filter({ hasText: 'Monaco' })).toBeVisible()
    await expect(page.getByTestId('choice-option').filter({ hasText: 'Vatican City' })).toBeVisible()
    await expect(page.getByTestId('choice-option').filter({ hasText: 'San Marino' })).toBeVisible()
    await expect(page.getByTestId('choice-option').filter({ hasText: 'Liechtenstein' })).toBeVisible()
    const visibleMarkdownOutsideChoiceCard = await page.evaluate(() => {
      const body = document.querySelector('.msg.assistant .msg-body')
      if (!body) throw new Error('Missing assistant body')
      const clone = body.cloneNode(true) as HTMLElement
      clone.querySelector('[data-testid="choice-card"]')?.remove()
      return clone.innerText
    })
    expect(visibleMarkdownOutsideChoiceCard).not.toContain('D) Liechtenstein')
    await expect(page.getByTestId('choice-submit')).toBeDisabled()
    await page.getByTestId('choice-option').filter({ hasText: 'Liechtenstein' }).click()
    await expect(page.getByTestId('choice-submit')).toBeEnabled()
    await page.getByTestId('choice-submit').click()
    await expect(page.getByText('Answer:')).toBeVisible()
    await expect(page.getByText('Question: What is the smallest country in the world by area?')).toBeVisible()
    await expect(page.getByText('Selected: Liechtenstein')).toBeVisible()
    await expect(page.getByTestId('choice-card')).toHaveCount(0)

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'questionnaire-structured-session', project_id: '__global__', mode: 'chat', title: 'Questionnaire structured', created_at: now },
          messages: [{
            id: 'assistant-questionnaire-structured',
            session_id: 'questionnaire-structured-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: 'A couple choices will help.\n\n```questionnaire\n{"id":"design-app-followup","title":"A few questions to shape the app","questions":[{"id":"tone","question":"What tone should the questions have?","mode":"single","options":["Professional/formal","Friendly/conversational","Playful/fun","Mysterious/creative"],"allowFreewrite":true,"freewriteLabel":"Other tone"},{"id":"structure","question":"How should questions be structured?","mode":"single","options":["One at a time","All visible","Branching","Mixed"],"allowFreewrite":true,"freewriteLabel":"Other structure"}]}\n```'
          }]
        }
      }))
    })
    await expect(page.getByTestId('questionnaire-card')).toBeVisible()
    await page.getByTestId('questionnaire-option').filter({ hasText: 'Friendly/conversational' }).click()
    await page.getByTestId('questionnaire-option').filter({ hasText: 'One at a time' }).click()
    await page.getByTestId('questionnaire-question-freewrite').first().fill('Warm, but still useful.')
    await page.getByTestId('questionnaire-freewrite').fill('I want it to feel like a design coach.')
    await page.getByTestId('questionnaire-submit').click()
    await expect(page.getByText('Clarification answers:')).toBeVisible()
    await expect(page.getByText('1. What tone should the questions have?')).toBeVisible()
    await expect(page.getByText('Selected: Friendly/conversational')).toBeVisible()
    await expect(page.getByText('Additional details: Warm, but still useful.')).toBeVisible()
    await expect(page.getByText('2. How should questions be structured?')).toBeVisible()
    await expect(page.getByText('Selected: One at a time')).toBeVisible()
    await expect(page.getByText('I want it to feel like a design coach.')).toBeVisible()
    await expect(page.getByTestId('questionnaire-card')).toHaveCount(0)

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'questionnaire-markdown-session', project_id: '__global__', mode: 'chat', title: 'Questionnaire markdown', created_at: now },
          messages: [{
            id: 'assistant-questionnaire-markdown',
            session_id: 'questionnaire-markdown-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: "6. What's the tone/style of the questions?\n   Professional/formal\n   Friendly/conversational\n   Playful/fun\n   Mysterious/creative\n\n7. How should questions be structured?\n   One at a time\n   All visible\n   Branching\n   Mix"
          }]
        }
      }))
    })
    await expect(page.getByTestId('questionnaire-card')).toBeVisible()
    await expect(page.getByTestId('questionnaire-question')).toHaveCount(2)
    await page.getByTestId('questionnaire-option').filter({ hasText: 'Friendly/conversational' }).click()
    await page.getByTestId('questionnaire-option').filter({ hasText: 'One at a time' }).click()
    await page.getByTestId('questionnaire-freewrite').fill('I want it to feel like a design coach.')
    await page.getByTestId('questionnaire-submit').click()
    await expect(page.getByText('Clarification answers:')).toBeVisible()
    await expect(page.getByText("1. What's the tone/style of the questions?")).toBeVisible()
    await expect(page.getByText('Selected: Friendly/conversational')).toBeVisible()
    await expect(page.getByText('2. How should questions be structured?')).toBeVisible()
    await expect(page.getByText('Selected: One at a time')).toBeVisible()
    await expect(page.getByText('I want it to feel like a design coach.')).toBeVisible()
    await expect(page.getByTestId('questionnaire-card')).toHaveCount(0)

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'clarification-multiple-session', project_id: '__global__', mode: 'chat', title: 'Clarification multiple', created_at: now },
          messages: [{
            id: 'assistant-clarification-multiple',
            session_id: 'clarification-multiple-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: 'Pick the parts you want.\n\n```clarification\n{"id":"design-app-features","question":"Which features should the app include?","mode":"multiple","options":["Question templates","Progress tracking","Export responses"],"allowFreewrite":true,"freewriteLabel":"Other feature"}\n```'
          }]
        }
      }))
    })
    await expect(page.getByTestId('clarification-card')).toBeVisible()
    await page.getByTestId('clarification-option').filter({ hasText: 'Question templates' }).click()
    await page.getByTestId('clarification-option').filter({ hasText: 'Export responses' }).click()
    await page.getByTestId('clarification-submit').click()
    await expect(page.getByText('Selected: Question templates, Export responses')).toBeVisible()

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'clarification-invalid-session', project_id: '__global__', mode: 'chat', title: 'Clarification invalid', created_at: now },
          messages: [{
            id: 'assistant-clarification-invalid',
            session_id: 'clarification-invalid-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: 'Invalid block stays readable.\n\n```clarification\n{"question": 42,\n```'
          }]
        }
      }))
    })
    await expect(page.getByText('Invalid block stays readable.')).toBeVisible()
    await expect(page.getByTestId('clarification-card')).toHaveCount(0)
    await expect(page.getByTestId('questionnaire-card')).toHaveCount(0)

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'questionnaire-invalid-session', project_id: '__global__', mode: 'chat', title: 'Questionnaire invalid', created_at: now },
          messages: [{
            id: 'assistant-questionnaire-invalid',
            session_id: 'questionnaire-invalid-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: 'Invalid questionnaire stays readable.\n\n```questionnaire\n{"questions": [\n```'
          }]
        }
      }))
    })
    await expect(page.getByText('Invalid questionnaire stays readable.')).toBeVisible()
    await expect(page.getByTestId('questionnaire-card')).toHaveCount(0)

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'choice-non-question-session', project_id: '__global__', mode: 'chat', title: 'Choice non question', created_at: now },
          messages: [{
            id: 'assistant-choice-non-question',
            session_id: 'choice-non-question-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: 'Normal release labels should stay as markdown: A) alpha support B) beta support C) stable support. There is no preceding question here.'
          }]
        }
      }))
    })
    await expect(page.getByText('Normal release labels should stay as markdown')).toBeVisible()
    await expect(page.getByTestId('choice-card')).toHaveCount(0)

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'clarification-layout-session', project_id: '__global__', mode: 'chat', title: 'Clarification layout', created_at: now },
          messages: [{
            id: 'assistant-clarification-layout',
            session_id: 'clarification-layout-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: 'Layout check.\n\n```clarification\n{"id":"layout-check","question":"Does this fit in the Chat panel?","mode":"single","options":["Yes, it fits","No, it overflows"],"allowFreewrite":true}\n```'
          }]
        }
      }))
    })
    const clarificationGeometry = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="workspace-panel-chat"]')?.getBoundingClientRect()
      const card = document.querySelector('[data-testid="clarification-card"]')?.getBoundingClientRect()
      if (!panel || !card) throw new Error('Missing clarification geometry')
      return {
        panel: { x: panel.x, width: panel.width },
        card: { x: card.x, width: card.width }
      }
    })
    expect(clarificationGeometry.card.x).toBeGreaterThanOrEqual(clarificationGeometry.panel.x - 1)
    expect(clarificationGeometry.card.x + clarificationGeometry.card.width).toBeLessThanOrEqual(
      clarificationGeometry.panel.x + clarificationGeometry.panel.width + 1
    )

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'questionnaire-layout-session', project_id: '__global__', mode: 'chat', title: 'Questionnaire layout', created_at: now },
          messages: [{
            id: 'assistant-questionnaire-layout',
            session_id: 'questionnaire-layout-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: "6. What's the tone/style of the questions?\n   Professional/formal\n   Friendly/conversational\n   Playful/fun\n   Mysterious/creative\n\n7. How should questions be structured?\n   One at a time\n   All visible\n   Branching\n   Mix"
          }]
        }
      }))
    })
    const questionnaireGeometry = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="workspace-panel-chat"]')?.getBoundingClientRect()
      const card = document.querySelector('[data-testid="questionnaire-card"]')?.getBoundingClientRect()
      if (!panel || !card) throw new Error('Missing questionnaire geometry')
      return {
        panel: { x: panel.x, width: panel.width },
        card: { x: card.x, width: card.width }
      }
    })
    expect(questionnaireGeometry.card.x).toBeGreaterThanOrEqual(questionnaireGeometry.panel.x - 1)
    expect(questionnaireGeometry.card.x + questionnaireGeometry.card.width).toBeLessThanOrEqual(
      questionnaireGeometry.panel.x + questionnaireGeometry.panel.width + 1
    )

    await page.evaluate(() => {
      const now = Date.now()
      window.dispatchEvent(new CustomEvent('aiworkspace:test:set-chat-state', {
        detail: {
          model: 'test-model',
          session: { id: 'choice-layout-session', project_id: '__global__', mode: 'chat', title: 'Choice layout', created_at: now },
          messages: [{
            id: 'assistant-choice-layout',
            session_id: 'choice-layout-session',
            role: 'assistant',
            model: 'test-model',
            created_at: now,
            content: "Here's a random question for you:\n\n\uD83C\uDF32 **What is the largest living species of tree by trunk volume?**\n\n**A)** Coast Redwood **B)** Giant Sequoia **C)** Amazonian Ceiba **D)** European Oak\n\nWant another question? Just ask! \uD83C\uDFAF"
          }]
        }
      }))
    })
    const choiceGeometry = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="workspace-panel-chat"]')?.getBoundingClientRect()
      const card = document.querySelector('[data-testid="choice-card"]')?.getBoundingClientRect()
      if (!panel || !card) throw new Error('Missing choice geometry')
      return {
        panel: { x: panel.x, width: panel.width },
        card: { x: card.x, width: card.width }
      }
    })
    expect(choiceGeometry.card.x).toBeGreaterThanOrEqual(choiceGeometry.panel.x - 1)
    expect(choiceGeometry.card.x + choiceGeometry.card.width).toBeLessThanOrEqual(
      choiceGeometry.panel.x + choiceGeometry.panel.width + 1
    )

    await expect(page.getByTestId('workspace-tool-chat')).toBeVisible()
    await expect(page.getByTestId('workspace-tool-navigator')).toBeVisible()
    await expect(page.getByTestId('workspace-tool-knowledge')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-navigator')).not.toBeVisible()
    await expect(page.getByTestId('workspace-panel-knowledge')).not.toBeVisible()
    await expect(page.locator('.workspace-panel-head.panel-chat .workspace-panel-kind')).toHaveCount(0)
    await expect(page.locator('.workspace-panel-head.panel-chat')).not.toContainText(/Chat\s+Chat/)
    await expect(page.locator('.workspace-panel-head.panel-chat .workspace-status-badge')).toContainText('Ready')

    const workspaceHeights = await page.evaluate(() => {
      const shell = document.querySelector('[data-testid="workspace-shell"]')?.getBoundingClientRect()
      const area = document.querySelector('.workspace-area')?.getBoundingClientRect()
      const chatPanel = document.querySelector('[data-testid="workspace-panel-chat"]')?.getBoundingClientRect()
      return {
        shell: shell?.height ?? 0,
        area: area?.height ?? 0,
        chatPanel: chatPanel?.height ?? 0
      }
    })
    expect(workspaceHeights.area).toBeGreaterThan(workspaceHeights.shell * 0.7)
    expect(workspaceHeights.chatPanel).toBeGreaterThan(workspaceHeights.area * 0.7)

    // Phase B: navigator open — becomes active tab in the full slot (tabs with chat)
    await page.getByTestId('workspace-tool-navigator').click()
    await expect(page.getByTestId('workspace-panel-navigator')).toBeVisible()
    await expect(page.getByTestId('navigator-current-workspace')).toContainText('Global Workspace')
    await expect(page.getByTestId('global-workspace-button')).toContainText('Global Workspace')
    await expect(page.getByTestId('navigator-new-project')).toBeVisible()
    await expect(page.getByTestId('navigator-import-project')).toBeVisible()

    // Close navigator via its tab close button or Return button
    await page.getByTestId('workspace-panel-close-navigator').click()
    await expect(page.getByTestId('workspace-panel-navigator')).not.toBeVisible()

    // Phase B: knowledge open/search/close. The saved item uses the same
    // knowledge API path extraction uses, so this verifies Knowledge renders
    // extractor-sourced memory without a separate UI source.
    const extractedSmokeTitle = 'Extracted Smoke Memory'
    const thinCandidateTitle = 'Thin Candidate'
    const extractedSmokeContent = 'Memory extracted during automated smoke verification. '.repeat(6) +
      'Full detail inspection text only appears after opening the knowledge item.'
    await page.evaluate(async ({ title, content, thinTitle }) => {
      await (window as any).api.memory.save({
        projectId: null,
        type: 'decision',
        title,
        content,
        source: 'extractor',
        tags: ['extracted', 'smoke']
      })
      await (window as any).api.memory.save({
        projectId: null,
        type: 'note',
        title: thinTitle,
        content: 'Supercalifragilisticexpialidocious note',
        source: 'chat',
        tags: ['smoke']
      })
    }, { title: extractedSmokeTitle, content: extractedSmokeContent, thinTitle: thinCandidateTitle })
    await page.getByTestId('workspace-tool-knowledge').click()
    await expect(page.getByTestId('workspace-panel-knowledge')).toBeVisible()
    await expect(page.locator('.workspace-panel-head.panel-knowledge .workspace-panel-kind')).toContainText('Memory')
    await expect(page.getByTestId('workspace-panel-knowledge').locator('.knowledge-panel-head .workspace-status-badge')).toContainText('2 items')
    await expect(page.getByTestId('knowledge-diagnostics')).toContainText('Embedded')
    await expect(page.getByTestId('knowledge-diagnostics')).toContainText('Review')
    await expect(page.getByText(extractedSmokeTitle)).toBeVisible()
    await page.getByPlaceholder(/Search memory/).fill('automated smoke verification')
    await page.getByTestId('workspace-panel-knowledge').getByRole('button', { name: 'Search' }).click()
    await expect(page.getByText(extractedSmokeTitle)).toBeVisible()
    await page.getByTestId('knowledge-item').filter({ hasText: extractedSmokeTitle }).click()
    await expect(page.getByTestId('knowledge-detail')).toBeVisible()
    await expect(page.getByTestId('knowledge-detail')).toContainText(extractedSmokeTitle)
    await expect(page.getByTestId('knowledge-detail')).toContainText('extractor')
    await expect(page.getByTestId('knowledge-detail-content')).toContainText('Full detail inspection text only appears after opening the knowledge item.')
    await expect(page.locator('.memory-edit')).toHaveCount(0)
    const detailOffset = await page.getByTestId('knowledge-detail').evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return {
        x: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2),
        y: Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2)
      }
    })
    expect(detailOffset.x).toBeLessThanOrEqual(12)
    expect(detailOffset.y).toBeLessThanOrEqual(12)
    await expect(page.getByTestId('knowledge-detail-copy')).toBeVisible()
    await page.getByTestId('knowledge-detail-edit').click()
    await page.getByTestId('knowledge-detail-editor').fill(`${extractedSmokeContent}\nEdited inside the detail window only.`)
    await page.getByTestId('knowledge-detail-save-edit').click()
    await expect(page.getByTestId('knowledge-detail-content')).toContainText('Edited inside the detail window only.')
    await expect(page.getByTestId('knowledge-detail')).toContainText('Uses')
    await page.getByTestId('knowledge-detail-stale').click()
    await expect(page.getByTestId('knowledge-detail')).toContainText('Stale since')
    await page.getByTestId('knowledge-detail-close').click()
    await expect(page.getByTestId('knowledge-detail')).toHaveCount(0)
    await page.getByTestId('knowledge-review-low-quality').click()
    await expect(page.getByText(thinCandidateTitle)).toBeVisible()
    await page.evaluate(() => { window.confirm = () => true })
    await page.getByTestId('knowledge-item').filter({ hasText: thinCandidateTitle }).click()
    await expect(page.getByTestId('knowledge-quality-note')).toContainText('thin-content')
    await page.getByTestId('knowledge-detail-delete').click()
    await expect(page.getByText(thinCandidateTitle)).toHaveCount(0)
    await page.getByTestId('workspace-panel-close-knowledge').click()
    await expect(page.getByTestId('workspace-panel-knowledge')).not.toBeVisible()

    // Phase B: open multiple panels then reset layout
    await page.getByTestId('workspace-tool-navigator').click()
    await page.getByTestId('workspace-tool-knowledge').click()
    // knowledge is now the active tab; verify it is visible
    await expect(page.getByTestId('workspace-panel-knowledge')).toBeVisible()
    await page.getByTestId('workspace-panel-layout-knowledge').hover()
    await expect(page.locator('.layout-picker-popup')).toBeVisible()
    await page.getByTestId('layout-picker-zone-right').click()
    await page.waitForTimeout(100)
    await expect(page.getByTestId('workspace-panel-knowledge')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-navigator')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-claudecode')).not.toBeVisible()
    const sideBySide = await page.evaluate(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector)
        if (!el) throw new Error(`Missing ${selector}`)
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      return {
        area: rect('.workspace-area'),
        navigator: rect('[data-testid="workspace-panel-navigator"]'),
        knowledge: rect('[data-testid="workspace-panel-knowledge"]')
      }
    }) as { area: Rect; navigator: Rect; knowledge: Rect }

    expect(sideBySide.navigator.width).toBeGreaterThan(sideBySide.area.width * 0.2)
    expect(sideBySide.knowledge.width).toBeGreaterThan(sideBySide.area.width * 0.2)
    expect(Math.abs(sideBySide.navigator.x - sideBySide.knowledge.x)).toBeGreaterThan(100)
    expect(Math.abs(sideBySide.navigator.y - sideBySide.knowledge.y)).toBeLessThan(8)
    expect(Math.abs(sideBySide.navigator.height - sideBySide.knowledge.height)).toBeLessThan(8)
    expect(sideBySide.navigator.height).toBeGreaterThan(sideBySide.area.height * 0.85)
    expect(sideBySide.knowledge.height).toBeGreaterThan(sideBySide.area.height * 0.85)

    await page.getByTestId('workspace-panel-layout-knowledge').hover()
    await expect(page.locator('.layout-picker-popup')).toBeVisible()
    await page.getByTestId('layout-picker-zone-top').click()
    await page.waitForTimeout(100)
    const topBottom = await page.evaluate(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector)
        if (!el) throw new Error(`Missing ${selector}`)
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      return {
        area: rect('.workspace-area'),
        navigator: rect('[data-testid="workspace-panel-navigator"]'),
        knowledge: rect('[data-testid="workspace-panel-knowledge"]')
      }
    }) as { area: Rect; navigator: Rect; knowledge: Rect }

    expect(topBottom.navigator.height).toBeGreaterThan(topBottom.area.height * 0.25)
    expect(topBottom.knowledge.height).toBeGreaterThan(topBottom.area.height * 0.25)
    expect(Math.abs(topBottom.navigator.y - topBottom.knowledge.y)).toBeGreaterThan(100)
    expect(topBottom.knowledge.x).toBeLessThan(8)
    expect(topBottom.knowledge.width).toBeGreaterThan(topBottom.area.width * 0.9)
    // reset layout — back to default (chat only, full slot)
    await page.getByTestId('workspace-reset-layout').click()
    await expect(page.getByTestId('workspace-panel-home')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-navigator')).not.toBeVisible()
    await expect(page.getByTestId('workspace-panel-knowledge')).not.toBeVisible()

    await page.getByTestId('workspace-tool-terminal').click()
    await expect(page.getByTestId('workspace-panel-terminal')).toBeVisible()
    await page.getByTestId('workspace-panel-layout-terminal').hover()
    await expect(page.locator('.layout-picker-popup')).toBeVisible()
    await page.getByTestId('layout-picker-zone-bottom').click()
    await page.waitForTimeout(100)

    const terminalBeforeDrop = await page.getByTestId('workspace-panel-terminal').boundingBox()
    const editorTool = await page.getByTestId('workspace-tool-editor').boundingBox()
    if (!terminalBeforeDrop || !editorTool) throw new Error('Missing drag geometry')
    await page.mouse.move(editorTool.x + editorTool.width / 2, editorTool.y + editorTool.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      terminalBeforeDrop.x + terminalBeforeDrop.width - 60,
      terminalBeforeDrop.y + terminalBeforeDrop.height / 2,
      { steps: 12 }
    )
    await page.mouse.up()

    await expect(page.getByTestId('workspace-panel-terminal')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-editor')).toBeVisible()
    const localSplit = await page.evaluate(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector)
        if (!el) throw new Error(`Missing ${selector}`)
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
      return {
        area: rect('.workspace-area'),
        terminal: rect('[data-testid="workspace-panel-terminal"]'),
        editor: rect('[data-testid="workspace-panel-editor"]')
      }
    }) as { area: Rect; terminal: Rect; editor: Rect }

    expect(Math.abs(localSplit.terminal.y - localSplit.editor.y)).toBeLessThan(8)
    expect(Math.abs(localSplit.terminal.height - localSplit.editor.height)).toBeLessThan(8)
    expect(Math.abs(localSplit.terminal.x - localSplit.editor.x)).toBeGreaterThan(100)
    expect(localSplit.terminal.y).toBeGreaterThan(localSplit.area.y + localSplit.area.height * 0.35)
    expect(localSplit.editor.y).toBeGreaterThan(localSplit.area.y + localSplit.area.height * 0.35)
    expect(localSplit.terminal.height).toBeLessThan(localSplit.area.height * 0.7)
    expect(localSplit.editor.height).toBeLessThan(localSplit.area.height * 0.7)
    await page.getByTestId('workspace-tool-chat').click()
    await expectSingleContextBarWithinPanel(page, 'chat', 'context-bar-chat')
    await page.getByTestId('workspace-panel-close-chat').click()
    await expect(page.getByTestId('workspace-panel-chat')).not.toBeVisible()
    await expect(page.locator('.local-drop-highlight')).toHaveCount(0)

    const terminalHeader = await page.locator('.workspace-panel-head.panel-terminal').boundingBox()
    const terminalBody = await page.getByTestId('workspace-panel-terminal').boundingBox()
    if (!terminalHeader || !terminalBody) throw new Error('Missing terminal self-drop geometry')
    await page.mouse.move(terminalHeader.x + terminalHeader.width / 2, terminalHeader.y + terminalHeader.height / 2)
    await page.mouse.down()
    await page.mouse.move(terminalBody.x + terminalBody.width / 2, terminalBody.y + terminalBody.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect(page.getByTestId('workspace-panel-terminal')).toHaveCount(1)
    await expect(page.getByTestId('workspace-panel-editor')).toHaveCount(1)
    await expect(page.locator('.local-drop-highlight')).toHaveCount(0)

    await page.waitForTimeout(650)
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-terminal')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-editor')).toBeVisible()
    const persistedTerminal = await panelRect(page, 'terminal')
    const persistedEditor = await panelRect(page, 'editor')
    expect(Math.abs(persistedTerminal.y - persistedEditor.y)).toBeLessThan(8)
    expect(Math.abs(persistedTerminal.height - persistedEditor.height)).toBeLessThan(8)
    expect(Math.abs(persistedTerminal.x - persistedEditor.x)).toBeGreaterThan(100)

    await page.getByTestId('workspace-panel-close-editor').click()
    await expect(page.getByTestId('workspace-panel-editor')).not.toBeVisible()
    await expect(page.getByTestId('workspace-panel-terminal')).toBeVisible()
    const terminalAfterEditorClose = await page.evaluate(() => {
      const area = document.querySelector('.workspace-area')?.getBoundingClientRect()
      const terminal = document.querySelector('[data-testid="workspace-panel-terminal"]')?.getBoundingClientRect()
      if (!area || !terminal) throw new Error('Missing close/collapse terminal geometry')
      return {
        area: { x: area.x, y: area.y, width: area.width, height: area.height },
        terminal: { x: terminal.x, y: terminal.y, width: terminal.width, height: terminal.height }
      }
    }) as { area: Rect; terminal: Rect }
    expect(terminalAfterEditorClose.terminal.width).toBeGreaterThan(terminalAfterEditorClose.area.width * 0.9)
    expect(terminalAfterEditorClose.terminal.y).toBeGreaterThan(terminalAfterEditorClose.area.y + terminalAfterEditorClose.area.height * 0.35)

    const terminalBeforeSecondDrop = await page.getByTestId('workspace-panel-terminal').boundingBox()
    const editorToolSecond = await page.getByTestId('workspace-tool-editor').boundingBox()
    if (!terminalBeforeSecondDrop || !editorToolSecond) throw new Error('Missing second drag geometry')
    await page.mouse.move(editorToolSecond.x + editorToolSecond.width / 2, editorToolSecond.y + editorToolSecond.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      terminalBeforeSecondDrop.x + terminalBeforeSecondDrop.width - 60,
      terminalBeforeSecondDrop.y + terminalBeforeSecondDrop.height / 2,
      { steps: 12 }
    )
    await page.mouse.up()
    await expect(page.getByTestId('workspace-panel-editor')).toBeVisible()
    await page.getByTestId('workspace-panel-close-terminal').click()
    await expect(page.getByTestId('workspace-panel-terminal')).not.toBeVisible()
    await expect(page.getByTestId('workspace-panel-editor')).toBeVisible()
    const editorAfterTerminalClose = await page.evaluate(() => {
      const area = document.querySelector('.workspace-area')?.getBoundingClientRect()
      const editor = document.querySelector('[data-testid="workspace-panel-editor"]')?.getBoundingClientRect()
      if (!area || !editor) throw new Error('Missing close/collapse editor geometry')
      return {
        area: { x: area.x, y: area.y, width: area.width, height: area.height },
        editor: { x: editor.x, y: editor.y, width: editor.width, height: editor.height }
      }
    }) as { area: Rect; editor: Rect }
    expect(editorAfterTerminalClose.editor.width).toBeGreaterThan(editorAfterTerminalClose.area.width * 0.9)
    expect(editorAfterTerminalClose.editor.y).toBeGreaterThan(editorAfterTerminalClose.area.y + editorAfterTerminalClose.area.height * 0.35)

    await page.getByTestId('workspace-reset-layout').click()
    await expect(page.getByTestId('workspace-panel-editor')).not.toBeVisible()
    await expect(page.getByTestId('workspace-panel-terminal')).not.toBeVisible()

    // --- Phase C: Hermes and Claude Code tool rack buttons ---
    await expect(page.getByTestId('workspace-tool-hermes')).toBeVisible()
    await expect(page.getByTestId('workspace-tool-claudecode')).toBeVisible()
    await expect(page.getByTestId('workspace-tool-codex')).toBeVisible()
    await expect(page.locator('.topbar-group-btn').filter({ hasText: /^Codex$/ })).toHaveCount(0)
    const codexRackGroup = await page.evaluate(() => {
      const codex = document.querySelector('[data-testid="workspace-tool-codex"]')
      return codex?.closest('.topbar-group')?.querySelector('.topbar-group-btn')?.textContent ?? ''
    })
    expect(codexRackGroup).toContain('AI')

    // Phase C: Codex panel opens as native UI and does not auto-start in Global Workspace.
    await expect(page.getByTestId('workspace-panel-codex')).not.toBeVisible()
    await page.locator('.topbar-group-btn').filter({ hasText: /^AI/ }).click()
    await page.locator('.topbar-dropdown-item').filter({ hasText: 'Codex' }).click()
    await expect(page.getByTestId('workspace-panel-codex')).toBeVisible()
    await expect(page.getByTestId('codex-project-required')).toContainText('Open a project to use Codex.')
    await expect(page.getByTestId('workspace-panel-codex').locator('.xterm')).toHaveCount(0)
    await page.locator('.topbar-group-btn').filter({ hasText: /^AI/ }).click()
    await expect(page.locator('.topbar-dropdown-item.is-open').filter({ hasText: 'Codex' })).toBeVisible()
    await page.locator('.topbar-dropdown-item').filter({ hasText: 'Codex' }).click()
    await expect(page.getByTestId('workspace-panel-codex')).toBeVisible()
    await page.getByTestId('workspace-panel-close-codex').click()
    await expect(page.getByTestId('workspace-panel-codex')).not.toBeVisible()

    // Phase C: Claude Code panel opens and shows global unavailable state
    await expect(page.getByTestId('workspace-panel-claudecode')).not.toBeVisible()
    await page.getByTestId('workspace-tool-claudecode').click()
    await expect(page.getByTestId('workspace-panel-claudecode')).toBeVisible()
    await expectSingleContextBarWithinPanel(page, 'claudecode', 'context-bar-claude-code')
    await expect(page.getByTestId('voice-input-claude-code')).toBeVisible()
    await expect(page.getByTestId('voice-input-claude-code')).toBeDisabled()
    await page.getByTestId('voice-input-claude-code').click({ force: true })
    await expect(page.getByTestId('claude-global-unavailable')).toContainText(
      'Claude Code needs a project folder.'
    )
    await page.getByTestId('workspace-panel-close-claudecode').click()
    await expect(page.getByTestId('workspace-panel-claudecode')).not.toBeVisible()

    // Phase C: Hermes panel opens and shows global unavailable state
    await expect(page.getByTestId('workspace-panel-hermes')).not.toBeVisible()
    await page.getByTestId('workspace-tool-hermes').click()
    await expect(page.getByTestId('workspace-panel-hermes')).toBeVisible()
    await expectSingleContextBarWithinPanel(page, 'hermes', 'context-bar-hermes')
    await expect(page.getByTestId('hermes-global-unavailable')).toContainText(
      'Hermes needs a project folder.'
    )
    await page.getByTestId('workspace-panel-close-hermes').click()
    await expect(page.getByTestId('workspace-panel-hermes')).not.toBeVisible()

    // --- Phase D: file tree in Navigator ---

    // In Global Workspace the Navigator panel must NOT show the PROJECT FILES section.
    await page.getByTestId('workspace-tool-navigator').click()
    await expect(page.getByTestId('workspace-panel-navigator')).toBeVisible()
    await expect(page.getByTestId('navigator-project-files')).toHaveCount(0)
    await page.getByTestId('workspace-panel-close-navigator').click()
    await expect(page.getByTestId('workspace-panel-navigator')).not.toBeVisible()

    // The preload bridge must expose window.api.fs.readDir as a function.
    const fsReadDirType = await page.evaluate(() => typeof (window as any).api?.fs?.readDir)
    expect(fsReadDirType).toBe('function')

    // --- Phase E: Editor panel ---

    await expect(page.getByTestId('workspace-tool-editor')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-editor')).not.toBeVisible()

    await page.getByTestId('workspace-tool-editor').click()
    await expect(page.getByTestId('workspace-panel-editor')).toBeVisible()

    await expect(page.getByTestId('editor-empty-state')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-editor')).toContainText('No file selected')

    await page.getByTestId('workspace-panel-close-editor').click()
    await expect(page.getByTestId('workspace-panel-editor')).not.toBeVisible()

    const fsReadFileType = await page.evaluate(() => typeof (window as any).api?.fs?.readFile)
    expect(fsReadFileType).toBe('function')
    const fsWriteFileType = await page.evaluate(() => typeof (window as any).api?.fs?.writeFile)
    expect(fsWriteFileType).toBe('function')

    // --- Phase F: Terminal panel ---

    await expect(page.getByTestId('workspace-tool-terminal')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-terminal')).not.toBeVisible()

    await page.getByTestId('workspace-tool-terminal').click()
    await expect(page.getByTestId('workspace-panel-terminal')).toBeVisible()

    await expect(page.getByTestId('terminal-global-unavailable')).toContainText(
      'Terminal needs a project folder.'
    )

    const terminalCreateType = await page.evaluate(() => typeof (window as any).api?.terminal?.create)
    expect(terminalCreateType).toBe('function')
    const terminalWriteType = await page.evaluate(() => typeof (window as any).api?.terminal?.write)
    expect(terminalWriteType).toBe('function')

    await page.getByTestId('workspace-panel-close-terminal').click()
    await expect(page.getByTestId('workspace-panel-terminal')).not.toBeVisible()

    // --- Research panel ---
    await expect(page.getByTestId('workspace-tool-research')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-research')).not.toBeVisible()

    await page.getByTestId('workspace-tool-research').click()
    await expect(page.getByTestId('workspace-panel-research')).toBeVisible()

    await page.getByTestId('workspace-panel-close-research').click()
    await expect(page.getByTestId('workspace-panel-research')).not.toBeVisible()

    // --- Extensions panel ---
    await expect(page.getByTestId('workspace-tool-extensions')).toBeVisible()
    await expect(page.getByTestId('workspace-panel-extensions')).not.toBeVisible()

    await page.locator('.topbar-group-btn').filter({ hasText: /^Tools/ }).click()
    await page.locator('.topbar-dropdown-item').filter({ hasText: 'Extensions' }).click()
    const extensionsPanel = page.getByTestId('workspace-panel-extensions')
    await expect(extensionsPanel).toBeVisible()
    await expect(extensionsPanel).toContainText('MCP SERVERS')
    await expect(extensionsPanel.getByRole('tab', { name: 'MCP Servers' })).toHaveAttribute('aria-selected', 'true')
    const extensionsScroll = extensionsPanel.locator('.ext-tab-panel').first()
    await expect(extensionsScroll).toBeVisible()
    const initialTabMetrics = await extensionsPanel.evaluate((panel) => {
      const active = panel.querySelector<HTMLElement>('.ext-tab.active')
      const inactive = panel.querySelector<HTMLElement>('.ext-tab:not(.active)')
      const body = panel.querySelector<HTMLElement>('.ext-tab-panel')
      const registry = panel.querySelector<HTMLElement>('[data-testid="mcp-registry-browser"]')
      if (!active || !inactive || !body || !registry) throw new Error('Missing extension picker or panel body')
      const probe = document.createElement('div')
      probe.style.height = '900px'
      probe.style.flex = '0 0 900px'
      body.appendChild(probe)
      body.scrollTop = 400
      const scrollProbeMoved = body.scrollTop > 0
      probe.remove()
      body.scrollTop = 0
      return {
        activeBackground: getComputedStyle(active).backgroundColor,
        inactiveBackground: getComputedStyle(inactive).backgroundColor,
        panelOverflowY: getComputedStyle(body).overflowY,
        registryIsClipped: registry.scrollHeight > registry.clientHeight + 1,
        scrollProbeMoved,
      }
    })
    expect(initialTabMetrics.activeBackground).not.toBe(initialTabMetrics.inactiveBackground)
    expect(initialTabMetrics.panelOverflowY).toBe('auto')
    expect(initialTabMetrics.registryIsClipped).toBe(false)
    expect(initialTabMetrics.scrollProbeMoved).toBe(true)
    await expect(extensionsPanel.getByTestId('mcp-registry-browser')).toContainText('Discover MCP servers')
    await expect(extensionsPanel.getByRole('button', { name: /Developer Tools/ })).toBeVisible()
    await expect(extensionsPanel.getByRole('button', { name: /Data & Storage/ })).toBeVisible()
    await expect(extensionsPanel.getByTestId('mcp-registry-result').first()).toContainText('github MCP Server')

    await extensionsPanel.getByRole('button', { name: /Data & Storage/ }).click()
    await expect(extensionsPanel.getByTestId('mcp-registry-query-note')).toContainText('postgres')
    await expect(extensionsPanel.getByTestId('mcp-registry-result').first()).toContainText('postgres MCP Server')

    await extensionsPanel.getByRole('tab', { name: 'Skills', exact: true }).click()
    await expect(extensionsPanel.getByRole('tab', { name: 'Skills', exact: true })).toHaveAttribute('aria-selected', 'true')
    // Deterministic chrome only: the list/error body depends on whether a real
    // Hermes dashboard is reachable on the machine running the suite.
    await expect(extensionsPanel).toContainText('INSTALLED SKILLS')
    await expect(extensionsPanel.getByTestId('skills-search')).toBeVisible()
    await expect(extensionsPanel.getByTestId('skills-hub-toggle')).toBeVisible()

    await page.getByTestId('workspace-panel-close-extensions').click()
    await expect(page.getByTestId('workspace-panel-extensions')).not.toBeVisible()

    // --- Codex selected-project fake path ---
    const codexProjectParent = testInfo.outputPath('codex-projects')
    await page.evaluate(async (parentDir) => {
      await (window as any).api.projects.create('Codex Smoke Project', parentDir)
    }, codexProjectParent)
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('workspace-tool-navigator').click()
    await page.getByRole('button', { name: /Codex Smoke Project/ }).click()
    await expect(page.getByText('Codex Smoke Project').first()).toBeVisible()

    await page.getByTestId('workspace-tool-chat').click()
    const selectedChatPanel = page.getByTestId('workspace-panel-chat')
    await expect(selectedChatPanel).toBeVisible()
    await expect(selectedChatPanel.locator('.empty-hero')).toBeVisible()
    await expect(selectedChatPanel.locator('.empty-state-heading')).toBeVisible()
    await expect(page.getByTestId('chat-composer')).toBeVisible()
    await expect(page.getByTestId('chat-send')).toBeVisible()
    await expect(page.getByTestId('chat-mode-pill')).toBeVisible()
    await page.getByTestId('workspace-panel-close-chat').click()

    await page.getByTestId('workspace-tool-claudecode').click()
    const claudePanel = page.getByTestId('workspace-panel-claudecode')
    await expect(claudePanel).toBeVisible()
    await page.waitForTimeout(100)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('aiworkspace:test:set-claude-code-check')))
    await expect(claudePanel.locator('.empty-hero')).toBeVisible()
    await expect(claudePanel.locator('.empty-state-heading')).toBeVisible()
    await expect(page.getByTestId('claude-code-composer')).toBeVisible()
    await expect(page.getByTestId('claude-code-send')).toBeVisible()
    await expect(page.getByTestId('claude-code-effort-pill')).toBeVisible()
    await page.getByTestId('workspace-panel-close-claudecode').click()

    await page.getByTestId('workspace-tool-hermes').click()
    const hermesPanel = page.getByTestId('workspace-panel-hermes')
    await expect(hermesPanel).toBeVisible()
    await page.waitForTimeout(100)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('aiworkspace:test:set-hermes-check')))
    await expect(hermesPanel.locator('.empty-hero')).toBeVisible()
    await expect(hermesPanel.locator('.empty-state-heading')).toBeVisible()
    await expect(page.getByTestId('hermes-composer')).toBeVisible()
    await expect(page.getByTestId('hermes-send')).toBeVisible()
    await expect(page.getByTestId('hermes-mode-control')).toBeVisible()
    await page.getByTestId('workspace-panel-close-hermes').click()

    await page.locator('.topbar-group-btn').filter({ hasText: /^AI/ }).click()
    await page.locator('.topbar-dropdown-item').filter({ hasText: 'Codex' }).click()
    const codexPanel = page.getByTestId('workspace-panel-codex')
    await expect(codexPanel).toBeVisible()
    // Selected project + installed CLI → chat-layout with the empty state.
    // The empty state IS the composer now (heading + composer, no start button).
    // Heading rotates between a few variations (see CODEX_EMPTY_HEADINGS), so match any of them.
    await expect(codexPanel).toContainText(/What are we building\?|Ready when you are\.|Describe a task for Codex\./)
    await expect(codexPanel.locator('.xterm')).toHaveCount(0)

    // Composer + safety controls are available immediately in the empty state.
    await expect(page.getByTestId('codex-composer')).toBeVisible()
    await expect(page.getByTestId('codex-sandbox')).toBeVisible()
    await expect(codexPanel.locator('.empty-hero')).toBeVisible()
    await expect(codexPanel.locator('.empty-state-heading')).toBeVisible()
    // Sandbox is a segmented pill toggle now — click the segment instead of selectOption.
    await page.getByTestId('codex-sandbox-workspace-write').click()
    await page.getByTestId('codex-composer').fill('Create a tiny hello file')
    await expect(page.getByTestId('codex-send')).toBeEnabled()
    await page.getByTestId('codex-send').click()
    // Composer clears immediately on send; sending creates the session.
    await expect(page.getByTestId('codex-composer')).toHaveValue('')
    await expect(codexPanel).toContainText('Fake Codex received: Create a tiny hello file')
    await expect(codexPanel).toContainText('sandbox=workspace-write skipGitRepoCheck=false')
    await expect(codexPanel).toContainText('sandbox: workspace-write')
    await expect(codexPanel.locator('.activity-line').first()).toContainText('codex')
    await expect(codexPanel.locator('.session-item.active')).toContainText('Create a tiny hello')
    // Session view now shows the agent status strip, back to Ready after the run.
    await expect(codexPanel.locator('.agent-status-strip')).toContainText('Codex')
    await expect(codexPanel.locator('.agent-status-strip')).toContainText('Ready')
    // Back to the idle Run button (no Stop) once the run completes.
    await expect(page.getByTestId('codex-send')).toBeVisible()
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})

test('extensions registry browser supports categories, search, paging, and details', async ({}, testInfo) => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const userDataDir = testInfo.outputPath('user-data')
  await mkdir(userDataDir, { recursive: true })

  const electronApp = await electron.launch({
    args: [
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      '--no-sandbox',
      path.join(repoRoot, 'out', 'main', 'index.js')
    ],
    env: {
      ...process.env,
      AIWORKSPACE_TEST_USER_DATA: userDataDir,
      E2E_SKIP_SETUP_WIZARD: '1',
      E2E_FAKE_CODEX: '1',
      E2E_FAKE_REGISTRY: '1',
      ELECTRON_DISABLE_GPU: '1'
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()

    await page.locator('.topbar-group-btn').filter({ hasText: /^Tools/ }).click()
    await page.locator('.topbar-dropdown-item').filter({ hasText: 'Extensions' }).click()
    const extensionsPanel = page.getByTestId('workspace-panel-extensions')
    await expect(extensionsPanel).toBeVisible()
    await expect(extensionsPanel.getByTestId('mcp-registry-browser')).toContainText('Discover MCP servers')
    await expect(extensionsPanel.getByTestId('mcp-registry-result').first()).toContainText('github MCP Server')

    const registryCategories = [
      ['All', 'all', 'github MCP Server'],
      ['Developer Tools', 'github', 'github MCP Server'],
      ['Data & Storage', 'postgres', 'postgres MCP Server'],
      ['Communication', 'slack', 'slack MCP Server'],
      ['Web & Search', 'search', 'search MCP Server'],
      ['AI & ML', 'llm', 'llm MCP Server'],
      ['Productivity', 'notion', 'notion MCP Server'],
      ['Files & Docs', 'filesystem', 'filesystem MCP Server'],
    ] as const
    const categoryChips = extensionsPanel.locator('.ext-registry-tabs .ext-registry-tab')
    for (const [label, query, result] of registryCategories) {
      await categoryChips.filter({ hasText: label }).first().click()
      await expect(extensionsPanel.getByTestId('mcp-registry-query-note')).toContainText(query)
      await expect(extensionsPanel.getByTestId('mcp-registry-result').first()).toContainText(result)
    }

    await extensionsPanel.getByTestId('mcp-registry-search').fill('filesystem')
    await extensionsPanel.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(extensionsPanel.getByTestId('mcp-registry-query-note')).toContainText('Manual search')
    await expect(extensionsPanel.getByTestId('mcp-registry-result').first()).toContainText('filesystem MCP Server')
    await expect(categoryChips.filter({ hasText: 'All' }).first()).toHaveClass(/active/)

    await extensionsPanel.getByRole('button', { name: 'Next' }).click()
    await expect(extensionsPanel.locator('.ext-registry-pagination')).toContainText('Page 2')
    await expect(extensionsPanel.getByRole('button', { name: 'Previous' })).toBeEnabled()
    await expect(extensionsPanel.getByRole('button', { name: 'Next' })).toBeDisabled()

    await extensionsPanel.getByRole('button', { name: 'Previous' }).click()
    await expect(extensionsPanel.locator('.ext-registry-pagination')).toContainText('Page 1')
    await expect(extensionsPanel.getByRole('button', { name: 'Previous' })).toBeDisabled()
    await expect(extensionsPanel.getByRole('button', { name: 'Next' })).toBeEnabled()

    await extensionsPanel.getByRole('button', { name: 'Details', exact: true }).first().click()
    await expect(extensionsPanel.getByTestId('mcp-registry-details')).toContainText('Registry details')
    await expect(extensionsPanel.getByTestId('mcp-registry-details')).toContainText('Package')
    await expect(extensionsPanel.getByRole('button', { name: 'Copy name' })).toBeVisible()
    await extensionsPanel.getByRole('button', { name: 'Close' }).click()

    await extensionsPanel.getByRole('button', { name: 'Clear' }).click()
    await expect(extensionsPanel.getByTestId('mcp-registry-query-note')).toContainText('All servers')
    await expect(extensionsPanel.getByTestId('mcp-registry-query-note')).toContainText('all')
  } finally {
    await electronApp.close()
  }
})

test('codex missing CLI diagnostic is retryable without real CLI login', async ({}, testInfo) => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const userDataDir = testInfo.outputPath('user-data')
  const projectParent = testInfo.outputPath('projects')
  await mkdir(userDataDir, { recursive: true })
  await mkdir(projectParent, { recursive: true })

  const electronApp = await electron.launch({
    args: [
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      '--no-sandbox',
      path.join(repoRoot, 'out', 'main', 'index.js')
    ],
    env: {
      ...process.env,
      AIWORKSPACE_TEST_USER_DATA: userDataDir,
      E2E_SKIP_SETUP_WIZARD: '1',
      E2E_MISSING_CODEX: '1',
      ELECTRON_DISABLE_GPU: '1'
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (parentDir) => {
      await (window as any).api.projects.create('Missing Codex Project', parentDir)
    }, projectParent)
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('workspace-tool-navigator').click()
    await page.getByRole('button', { name: /Missing Codex Project/ }).click()
    await page.locator('.topbar-group-btn').filter({ hasText: /^AI/ }).click()
    await page.locator('.topbar-dropdown-item').filter({ hasText: 'Codex' }).click()
    await expect(page.getByTestId('workspace-panel-codex')).toBeVisible()
    // Missing CLI → setup screen with install/login guidance and a Re-check button.
    await expect(page.getByTestId('codex-setup')).toContainText("Codex isn't installed")
    await expect(page.getByTestId('codex-setup')).toContainText('npm install -g @openai/codex')
    await expect(page.getByTestId('codex-setup-error')).toContainText('Codex CLI not found.')
    await expect(page.getByTestId('codex-setup-error')).toContainText('where.exe codex')
    await expect(page.getByTestId('codex-setup-error')).toContainText('AI_WORKSPACE_CODEX_PATH')
    await expect(page.getByTestId('codex-recheck')).toBeVisible()
    await page.getByTestId('codex-recheck').click()
    await expect(page.getByTestId('codex-setup-error')).toContainText('Codex CLI not found.')
  } finally {
    await electronApp.close()
  }
})

test('codex trust error requires explicit skip-git consent before retry', async ({}, testInfo) => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const userDataDir = testInfo.outputPath('user-data')
  const projectParent = testInfo.outputPath('projects')
  await mkdir(userDataDir, { recursive: true })
  await mkdir(projectParent, { recursive: true })

  const electronApp = await electron.launch({
    args: [
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      '--no-sandbox',
      path.join(repoRoot, 'out', 'main', 'index.js')
    ],
    env: {
      ...process.env,
      AIWORKSPACE_TEST_USER_DATA: userDataDir,
      E2E_SKIP_SETUP_WIZARD: '1',
      E2E_CODEX_TRUST_ERROR: '1',
      ELECTRON_DISABLE_GPU: '1'
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(async (parentDir) => {
      await (window as any).api.projects.create('Trust Codex Project', parentDir)
    }, projectParent)
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('workspace-tool-navigator').click()
    await page.getByRole('button', { name: /Trust Codex Project/ }).click()
    await page.locator('.topbar-group-btn').filter({ hasText: /^AI/ }).click()
    await page.locator('.topbar-dropdown-item').filter({ hasText: 'Codex' }).click()
    const codexPanel = page.getByTestId('workspace-panel-codex')
    await expect(codexPanel).toBeVisible()

    // Installed CLI → the empty-state composer is ready immediately; send
    // without trust consent (sending creates the session).
    await expect(page.getByTestId('codex-composer')).toBeVisible()
    await page.getByTestId('codex-composer').fill('hello')
    await page.getByTestId('codex-send').click()

    // Trust block: clear error, composer refilled with the attempted prompt.
    await expect(page.getByTestId('codex-error')).toContainText(
      'Codex refused to run because this folder is not trusted or is not a Git repository.'
    )
    await expect(page.getByTestId('codex-composer')).toBeEnabled()
    await expect(page.getByTestId('codex-composer')).toHaveValue('hello')
    await expect(page.getByTestId('codex-send')).toBeEnabled()

    // Grant trust and resend → run succeeds.
    await page.getByTestId('codex-allow-untrusted').check()
    await page.getByTestId('codex-send').click()
    await expect(codexPanel).toContainText('Fake Codex ran with skipGitRepoCheck: hello')
  } finally {
    await electronApp.close()
  }
})

test('settings control center opens, navigates, searches, saves, and reports diagnostics', async ({}, testInfo) => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const userDataDir = testInfo.outputPath('user-data')
  await mkdir(userDataDir, { recursive: true })

  let electronApp = await electron.launch({
    args: [
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-software-rasterizer',
      '--in-process-gpu',
      '--no-sandbox',
      path.join(repoRoot, 'out', 'main', 'index.js')
    ],
    env: {
      ...process.env,
      AIWORKSPACE_TEST_USER_DATA: userDataDir,
      E2E_SKIP_SETUP_WIZARD: '1',
      E2E_FAKE_CODEX: '1',
      ELECTRON_DISABLE_GPU: '1'
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()

    // --- Global keyboard shortcuts ---
    await page.keyboard.press('Control+/')
    await expect(page.getByTestId('shortcuts-overlay')).toBeVisible()
    await expect(page.getByTestId('shortcuts-overlay')).toContainText('Switch to Chat')
    await page.keyboard.press('Control+/')
    await expect(page.getByTestId('shortcuts-overlay')).not.toBeVisible()

    await page.keyboard.press('Control+2')
    await expect(page.getByTestId('workspace-panel-hermes')).toBeVisible()
    await page.keyboard.press('Control+3')
    await expect(page.getByTestId('workspace-panel-claudecode')).toBeVisible()
    await page.keyboard.press('Control+4')
    await expect(page.getByTestId('workspace-panel-codex')).toBeVisible()
    await page.keyboard.press('Control+1')
    await expect(page.getByTestId('workspace-panel-chat')).toBeVisible()

    // --- Open Settings ---
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('settings-shell')).toBeVisible()
    await expect(page.getByTestId('settings-panel')).toBeVisible()

    // --- Overview section loads by default ---
    await expect(page.getByTestId('settings-nav-overview')).toBeVisible()
    await expect(page.getByTestId('settings-section-overview')).toBeVisible()

    // --- Navigate to Appearance ---
    await page.getByTestId('settings-nav-appearance').click()
    await expect(page.getByTestId('settings-section-appearance')).toBeVisible()

    // --- Navigate to Diagnostics ---
    await page.getByTestId('settings-nav-diagnostics').click()
    await expect(page.getByTestId('settings-load-diagnostics')).toBeVisible()

    // --- Load diagnostics report ---
    await page.getByTestId('settings-load-diagnostics').click()
    await expect(page.getByTestId('settings-diagnostics-report')).toBeVisible({ timeout: 8000 })

    const reportText = await page.getByTestId('settings-diagnostics-report').textContent()
    expect(reportText).toContain('AI Workspace diagnostics')
    expect(reportText).toContain('App:')
    expect(reportText).toContain('Runtime:')
    expect(reportText).toContain('Database:')
    expect(reportText).toContain('Knowledge:')
    expect(reportText).toContain('Knowledge by type:')
    expect(reportText).toContain('Last consolidation:')

    // Secrets must not appear in plain text in the diagnostics report
    expect(reportText).not.toMatch(/Bearer\s+\S{10,}/)
    expect(reportText).not.toMatch(/sk-[A-Za-z0-9]{20,}/)
    // Cloud key is only reported as configured/not configured
    expect(reportText).toContain('Ollama Cloud key:')
    expect(reportText).toMatch(/configured|not configured/)

    // --- Copy diagnostics button exists ---
    await expect(page.getByTestId('settings-copy-diagnostics')).toBeVisible()

    // --- Search settings ---
    await page.getByTestId('settings-nav-overview').click()
    await page.getByTestId('settings-search').fill('density')
    // Appearance section should still be visible (contains density setting)
    await expect(page.getByTestId('settings-nav-appearance')).toBeVisible()
    // Non-matching sections should be filtered out
    await expect(page.getByTestId('settings-nav-diagnostics')).not.toBeVisible()

    // Clear search
    await page.getByTestId('settings-search').fill('')
    await expect(page.getByTestId('settings-nav-diagnostics')).toBeVisible()

    // --- Navigate to Models and verify cloud key is masked (not plaintext) ---
    await page.getByTestId('settings-nav-models').click()
    await expect(page.getByTestId('settings-section-models')).toBeVisible()

    // Cloud key section exists and does not expose raw key
    const modelsContent = await page.getByTestId('settings-section-models').textContent()
    expect(modelsContent).not.toMatch(/sk-[A-Za-z0-9]{20,}/)

    // --- Navigate to Privacy and verify local-first explanation ---
    await page.getByTestId('settings-nav-privacy').click()
    await expect(page.getByTestId('settings-section-privacy')).toBeVisible()
    const privacyContent = await page.getByTestId('settings-section-privacy').textContent()
    expect(privacyContent).toContain('local')

    // --- Navigate to Web Companion and verify the opt-in security boundary ---
    await page.getByTestId('settings-nav-web').click()
    await expect(page.getByTestId('settings-section-web')).toBeVisible()
    await expect(page.getByTestId('settings-section-web')).toContainText('disabled by default')
    await expect(page.getByTestId('settings-section-web')).toContainText('does not expose Terminal')

    // --- Shortcuts editor records custom keys ---
    await page.getByTestId('settings-nav-shortcuts').click()
    await expect(page.getByTestId('shortcuts-editor')).toBeVisible()
    await page.getByTestId('shortcut-key-nav_chat').click()
    await expect(page.getByTestId('shortcut-key-nav_chat')).toContainText('Press any key')
    await page.keyboard.press('Control+Alt+Y')
    await expect(page.getByTestId('shortcut-key-nav_chat')).toContainText('Ctrl+Alt+Y')

    // --- Escape closes Settings ---
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-shell')).not.toBeVisible()

    // --- Re-open Settings, toggle density, verify save feedback ---
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('settings-shell')).toBeVisible()
    await page.getByTestId('settings-nav-appearance').click()
    await expect(page.getByTestId('settings-section-appearance')).toBeVisible()

    // Motion mode is fully wired and updates the document-level motion guard.
    await page.getByRole('combobox', { name: 'Motion' }).selectOption('off')
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.motion)).toBe('off')
    await expect(page.getByRole('combobox', { name: 'App font' }).locator('option')).toHaveCount(27)
    await expect
      .poll(() =>
        page
          .getByRole('combobox', { name: 'App font' })
          .locator('option[value="palatino"]')
          .evaluate((option) => (option as HTMLOptionElement).style.fontFamily)
      )
      .toContain('Palatino')
    await page.getByRole('combobox', { name: 'App font' }).selectOption('georgia')
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.fontFamily)).toBe('georgia')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-sans'))).toContain('Georgia')
    // Save feedback appears briefly
    await expect(page.getByTestId('settings-message')).toBeVisible({ timeout: 3000 })

    // Close with the Close button
    await page.getByTestId('settings-close').click()
    await expect(page.getByTestId('settings-shell')).not.toBeVisible()

    // --- Shortcut customizations persist across app restart ---
    await electronApp.close()
    electronApp = await electron.launch({
      args: [
        '--disable-gpu',
        '--disable-gpu-compositing',
        '--disable-software-rasterizer',
        '--in-process-gpu',
        '--no-sandbox',
        path.join(repoRoot, 'out', 'main', 'index.js')
      ],
      env: {
        ...process.env,
        AIWORKSPACE_TEST_USER_DATA: userDataDir,
      E2E_SKIP_SETUP_WIZARD: '1',
        E2E_FAKE_CODEX: '1',
        ELECTRON_DISABLE_GPU: '1'
      }
    })
    const restartedPage = await electronApp.firstWindow()
    await restartedPage.waitForLoadState('domcontentloaded')
    await expect(restartedPage.getByTestId('workspace-shell')).toBeVisible()
    await expect.poll(() => restartedPage.evaluate(() => document.documentElement.dataset.fontFamily)).toBe('georgia')
    await restartedPage.getByTestId('open-settings').click()
    await restartedPage.getByTestId('settings-nav-shortcuts').click()
    await expect(restartedPage.getByTestId('shortcut-key-nav_chat')).toContainText('Ctrl+Alt+Y')
  } finally {
    await electronApp.close()
  }
})

test('setup wizard runs on first launch and stays dismissed after completion', async ({}, testInfo) => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const userDataDir = testInfo.outputPath('user-data')
  await mkdir(userDataDir, { recursive: true })

  // No E2E_SKIP_SETUP_WIZARD here: this test exercises the real first-run path.
  // E2E_FAKE_SETUP_TOOLS makes detection deterministic and instant.
  const launchApp = () =>
    electron.launch({
      args: [
        '--disable-gpu',
        '--disable-gpu-compositing',
        '--disable-software-rasterizer',
        '--in-process-gpu',
        '--no-sandbox',
        path.join(repoRoot, 'out', 'main', 'index.js')
      ],
      env: {
        ...process.env,
        AIWORKSPACE_TEST_USER_DATA: userDataDir,
        E2E_FAKE_SETUP_TOOLS: '1',
        ELECTRON_DISABLE_GPU: '1'
      }
    })

  let electronApp = await launchApp()
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // Fresh DB → wizard appears instead of the workspace.
    await expect(page.getByTestId('setup-wizard')).toBeVisible()
    await expect(page.getByTestId('setup-wizard-step-1')).toBeVisible()
    await expect(page.getByTestId('workspace-shell')).toHaveCount(0)
    await expect(page.getByTestId('setup-wizard')).toContainText('Welcome to AI Workspace')

    // Step 1 → 2: detection checklist fills in with the fake results.
    await page.getByTestId('setup-wizard-get-started').click()
    await expect(page.getByTestId('setup-wizard-step-2')).toBeVisible()
    await expect(page.getByTestId('setup-tool-claudeCode')).toContainText('1.2.3', { timeout: 10000 })
    await expect(page.getByTestId('setup-tool-codex')).toContainText('not found')
    await expect(page.getByTestId('setup-tool-ollama')).toContainText('0.1.45')
    await expect(page.getByTestId('setup-tool-hermes')).toContainText('not found')
    await expect(page.getByTestId('setup-wizard-next')).toBeEnabled()

    // Step 2 → 3: results summary with install CTAs for missing tools.
    await page.getByTestId('setup-wizard-next').click()
    await expect(page.getByTestId('setup-wizard-step-3')).toBeVisible()
    await expect(page.getByTestId('setup-result-codex')).toContainText('npm install -g @openai/codex')
    await expect(page.getByTestId('setup-result-hermes')).toContainText('github.com/nouresearch/hermes')
    await expect(page.getByTestId('setup-result-claudeCode')).toContainText('1.2.3')

    // Back returns to the detection step, results retained.
    await page.getByTestId('setup-wizard-back').click()
    await expect(page.getByTestId('setup-wizard-step-2')).toBeVisible()
    await expect(page.getByTestId('setup-tool-claudeCode')).toContainText('1.2.3')
    await page.getByTestId('setup-wizard-next').click()
    await expect(page.getByTestId('setup-wizard-step-3')).toBeVisible()

    // Step 3 → 4: keep the default "skip project" choice.
    await page.getByTestId('setup-wizard-next').click()
    await expect(page.getByTestId('setup-wizard-step-4')).toBeVisible()
    await expect(page.getByTestId('setup-wizard-skip-project')).toBeChecked()

    // Step 4 → 5: finish with "don't show again" checked (default).
    await page.getByTestId('setup-wizard-next').click()
    await expect(page.getByTestId('setup-wizard-step-5')).toBeVisible()
    await expect(page.getByTestId('setup-wizard-dont-show')).toBeChecked()
    await page.getByTestId('setup-wizard-start-working').click()

    // Wizard closes, workspace renders.
    await expect(page.getByTestId('workspace-shell')).toBeVisible()
    await expect(page.getByTestId('setup-wizard')).toHaveCount(0)

    // Let the debounced sql.js persist land before quitting (flush also runs on quit).
    await page.waitForTimeout(700)
    await electronApp.close()

    // Restart with the same userData: flag persisted → straight to the workspace.
    electronApp = await launchApp()
    const restarted = await electronApp.firstWindow()
    await restarted.waitForLoadState('domcontentloaded')
    await expect(restarted.getByTestId('workspace-shell')).toBeVisible()
    await expect(restarted.getByTestId('setup-wizard')).toHaveCount(0)

    // Settings → Advanced re-arms the wizard for the next launch.
    await restarted.getByTestId('open-settings').click()
    await restarted.getByTestId('settings-nav-advanced').click()
    await expect(restarted.getByTestId('settings-show-setup-wizard')).toBeVisible()
    await expect(restarted.getByTestId('settings-show-setup-wizard')).toHaveAttribute('aria-checked', 'false')
    await restarted.getByTestId('settings-show-setup-wizard').click()
    await expect(restarted.getByTestId('settings-show-setup-wizard')).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => restarted.evaluate(() => (window as any).api.setup.isComplete())).toBe(false)
    await restarted.waitForTimeout(700)
    await electronApp.close()

    // Third launch: wizard shows again because the flag was cleared.
    electronApp = await launchApp()
    const third = await electronApp.firstWindow()
    await third.waitForLoadState('domcontentloaded')
    await expect(third.getByTestId('setup-wizard')).toBeVisible()
    await expect(third.getByTestId('setup-wizard-step-1')).toBeVisible()
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})

test('Browser panel opens with working chrome and closes cleanly', async ({}, testInfo) => {
  const electronApp = await launchSmokeApp(testInfo)
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('workspace-shell')).toBeVisible()

    // Default closed in all workspaces.
    await expect(page.getByTestId('workspace-panel-browser')).toHaveCount(0)

    // Opens from the Tools group and renders the full chrome (tab bar + URL bar).
    // The web page itself is a native WebContentsView above the DOM, so the e2e
    // harness can only exercise the React-rendered chrome, not real page loads.
    await page.getByTestId('workspace-tool-browser').click()
    const browserPanel = page.getByTestId('workspace-panel-browser')
    await expect(browserPanel).toBeVisible()
    await expect(browserPanel.getByTestId('browser-tabbar')).toBeVisible()
    await expect(browserPanel.getByTestId('browser-url-input')).toBeVisible()
    await expect(browserPanel.getByTestId('browser-new-tab')).toBeVisible()
    await expect(browserPanel.getByTestId('browser-persist-toggle')).toBeVisible()

    // A first tab is created automatically; a second can be added and selected.
    await expect.poll(() => browserPanel.getByTestId('browser-tab').count()).toBeGreaterThanOrEqual(1)
    const initialCount = await browserPanel.getByTestId('browser-tab').count()
    await browserPanel.getByTestId('browser-new-tab').click()
    await expect.poll(() => browserPanel.getByTestId('browser-tab').count()).toBe(initialCount + 1)

    // The URL bar accepts input (address editing works without a live page).
    await browserPanel.getByTestId('browser-url-input').fill('example.com')
    await expect(browserPanel.getByTestId('browser-url-input')).toHaveValue('example.com')

    // Unsafe schemes are blocked in main and surfaced in the browser chrome.
    await browserPanel.getByTestId('browser-url-input').fill('file:///C:/Windows/win.ini')
    await browserPanel.getByTestId('browser-go').click()
    await expect(browserPanel.getByTestId('browser-navigation-error')).toContainText('unsupported scheme')

    // The chrome reads correctly in both themes.
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate((t) => {
        if (t === 'dark') document.documentElement.dataset.theme = 'dark'
        else document.documentElement.removeAttribute('data-theme')
      }, theme)
      const colors = await browserPanel.getByTestId('browser-url-input').evaluate((el) => {
        const s = getComputedStyle(el)
        return { bg: s.backgroundColor, fg: s.color }
      })
      expect(colors.bg).not.toBe(colors.fg)
    }

    // Closing the panel removes it and unmounts the chrome.
    await page.getByTestId('workspace-panel-close-browser').click()
    await expect(page.getByTestId('workspace-panel-browser')).toHaveCount(0)
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})

test('Browser MCP navigation uses the shared approval card and parks native content', async ({}, testInfo) => {
  const port = 18973
  const pagePort = 18974
  const localPage = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><body><label for="note">Private note</label><input id="note" aria-label="Private note"><button>Save</button></body></html>')
  })
  await new Promise<void>((resolve) => localPage.listen(pagePort, '127.0.0.1', resolve))
  const electronApp = await launchSmokeApp(testInfo, {
    E2E_BROWSER_CONTROL: '1',
    AIWORKSPACE_BROWSER_CONTROL_PORT: String(port),
  })
  const headers = {
    'content-type': 'application/json',
    'x-aiw-agent-id': 'e2e-codex',
    'x-aiw-agent-name': 'Codex E2E',
    'x-aiw-identity-source': 'app-launch',
  }
  try {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('workspace-tool-browser').click()
    await expect.poll(async () => (await page.evaluate(() => window.api.browser.listTabs())).activeTabId).not.toBeNull()
    const tabId = (await page.evaluate(() => window.api.browser.listTabs())).activeTabId!
    await expect.poll(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/browser/state`, { headers })).status } catch { return 0 }
    }).toBe(200)

    const deniedFetch = fetch(`http://127.0.0.1:${port}/browser/tabs/${encodeURIComponent(tabId)}/navigate`, {
      method: 'POST', headers: { ...headers, 'x-aiw-request-id': 'deny-navigation' }, body: JSON.stringify({ url: 'https://example.com/denied' })
    })
    await expect(page.getByTestId('browser-approval-card')).toBeVisible()
    await expect(page.getByTestId('browser-approval-card')).toContainText('Codex E2E')
    await expect(page.getByTestId('browser-approval-card')).toContainText('https://example.com')
    const parked = await (await fetch(`http://127.0.0.1:${port}/browser/state`, { headers })).json() as { result?: { panelVisible?: boolean } }
    expect(parked.result?.panelVisible).toBe(false)
    await page.getByTestId('browser-approval-deny').click()
    expect((await deniedFetch).status).toBe(403)
    expect((await page.evaluate(() => window.api.browser.listTabs())).tabs.find((tab) => tab.id === tabId)?.url).not.toContain('/denied')

    const approvedFetch = fetch(`http://127.0.0.1:${port}/browser/tabs/${encodeURIComponent(tabId)}/navigate`, {
      method: 'POST', headers: { ...headers, 'x-aiw-request-id': 'approve-navigation' }, body: JSON.stringify({ url: 'https://example.com/approved' })
    })
    await expect(page.getByTestId('browser-approval-card')).toBeVisible()
    await page.getByTestId('browser-approval-approve').click()
    expect((await approvedFetch).status).toBe(200)
    await expect.poll(async () => (await page.evaluate(() => window.api.browser.listTabs())).tabs.find((tab) => tab.id === tabId)?.url).toContain('/approved')
    await expect(page.getByTestId('browser-approval-card')).toHaveCount(0)

    // Element-bound actions use the same queue. Mode 2 permits reads/local
    // navigation but prompts for typing, which lets this test invalidate an
    // approved target by navigating while its card is pending.
    await page.evaluate(({ id, url }) => window.api.browser.navigate(id, url), { id: tabId, url: `http://127.0.0.1:${pagePort}/form` })
    await expect.poll(async () => (await page.evaluate(() => window.api.browser.listTabs())).tabs.find((tab) => tab.id === tabId)?.url).toContain('/form')
    await page.evaluate(() => window.api.hermes.setPermissionMode(2))
    const snapshotResponse = await fetch(`http://127.0.0.1:${port}/browser/tabs/${encodeURIComponent(tabId)}/snapshot`, { headers })
    const snapshotJson = await snapshotResponse.json() as { result: { elements: Array<{ id: string; role: string }> } }
    const inputId = snapshotJson.result.elements.find((element) => element.role === 'textbox')?.id
    expect(inputId).toBeTruthy()

    const staleType = fetch(`http://127.0.0.1:${port}/browser/tabs/${encodeURIComponent(tabId)}/type`, {
      method: 'POST', headers: { ...headers, 'x-aiw-request-id': 'stale-type' }, body: JSON.stringify({ elementId: inputId, text: 'do not retain me' })
    })
    await expect(page.getByTestId('browser-approval-card')).toBeVisible()
    await page.evaluate(({ id, url }) => window.api.browser.navigate(id, url), { id: tabId, url: `http://127.0.0.1:${pagePort}/changed` })
    expect((await staleType).status).toBe(403)
    await expect(page.getByTestId('browser-approval-card')).toHaveCount(0)

    await page.evaluate(({ id, url }) => window.api.browser.navigate(id, url), { id: tabId, url: `http://127.0.0.1:${pagePort}/form` })
    await expect.poll(async () => (await page.evaluate(() => window.api.browser.listTabs())).tabs.find((tab) => tab.id === tabId)?.url).toContain('/form')
    const freshSnapshot = await (await fetch(`http://127.0.0.1:${port}/browser/tabs/${encodeURIComponent(tabId)}/snapshot`, { headers })).json() as { result: { elements: Array<{ id: string; role: string }> } }
    const freshInputId = freshSnapshot.result.elements.find((element) => element.role === 'textbox')?.id
    const approvedType = fetch(`http://127.0.0.1:${port}/browser/tabs/${encodeURIComponent(tabId)}/type`, {
      method: 'POST', headers: { ...headers, 'x-aiw-request-id': 'approved-type' }, body: JSON.stringify({ elementId: freshInputId, text: 'approved text' })
    })
    await expect(page.getByTestId('browser-approval-card')).toBeVisible()
    await expect(page.getByTestId('browser-approval-card')).toContainText('13 characters')
    await page.getByTestId('browser-approval-approve').click()
    expect((await approvedType).status).toBe(200)
  } finally {
    await electronApp.close().catch(() => undefined)
    await new Promise<void>((resolve) => localPage.close(() => resolve()))
  }
})
