import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  HermesCheck,
  KimiAuthMethod,
  KimiAuthStatus,
  KimiCheck,
  Project,
  RemoteHermesConfig,
  SettingsDiagnostics,
  SettingsSummary,
  UsageSummaryRow,
  WebCompanionStatus,
} from '../types'
import { isGlobalProjectId } from '../../../shared/globalWorkspace'
import { StatusBadge, WorkspaceNotice } from './WorkspacePrimitives'
import { useShortcuts } from '../ShortcutContext'
import { formatShortcutKey, isModifierOnlyKey, parseKey, type Shortcut } from '../shortcuts'
import { applyMotionPreference, type MotionMode } from '../motion'
import { applyFontFamily, applyTheme, readStoredFontFamily, storeFontFamily } from '../theme'
import { APP_FONT_OPTIONS } from '../../../shared/appFonts'
import { SETTING_CHANGED_EVENT } from '../notify'
import CardSelect, { type CardSelectOption } from './CardSelect'
import NumberStepper from './NumberStepper'

type OllamaStatus = { connected: boolean; defaultModel: string | null }
type ClaudeStatus = { installed: boolean; version?: string; bin?: string; error?: string }
type CodexStatus = { installed: boolean; version?: string; bin?: string; error?: string }

type SectionId =
  | 'overview' | 'appearance' | 'workspace' | 'agents' | 'models' | 'knowledge'
  | 'usage' | 'research' | 'editor' | 'web' | 'privacy' | 'shortcuts' | 'diagnostics' | 'advanced'

interface SettingMeta {
  key: string
  label: string
  description: string
  section: SectionId
  type: 'toggle' | 'select' | 'text' | 'number'
  options?: { value: string; label: string; stack?: string; description?: string }[]
  wired: 'wired' | 'partial' | 'planned'
}

const SETTINGS: SettingMeta[] = [
  { key: 'ui_theme', label: 'Theme', description: 'Applies a system, dark, or light palette preference.', section: 'appearance', type: 'select', wired: 'wired', options: [
    { value: 'system', label: 'System' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' },
  ] },
  { key: 'ui_density', label: 'Density', description: 'Controls workspace spacing and compactness.', section: 'appearance', type: 'select', wired: 'wired', options: [
    { value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' },
  ] },
  { key: 'ui_font_scale', label: 'UI text size', description: 'Scales interface text across the renderer.', section: 'appearance', type: 'select', wired: 'wired', options: [
    { value: '95', label: 'Small (95%)' }, { value: '100', label: 'Default (100%)' }, { value: '110', label: 'Large (110%)' }, { value: '120', label: 'Extra large (120%)' },
  ] },
  { key: 'ui_font_family', label: 'App font', description: 'Changes the main interface font across the app. Code and terminal text keep the monospace font.', section: 'appearance', type: 'select', wired: 'wired', options: APP_FONT_OPTIONS },
  { key: 'ui_motion_mode', label: 'Motion', description: 'Controls workspace animation. Reduced also follows the OS reduced-motion setting.', section: 'appearance', type: 'select', wired: 'wired', options: [
    { value: 'full', label: 'Full' }, { value: 'reduced', label: 'Reduced' }, { value: 'off', label: 'Off' },
  ] },
  { key: 'notify_sound_enabled', label: 'Play sound when a response completes', description: "Plays a short tone when a response finishes in the background — while this window isn't focused, or that panel isn't the one you're looking at.", section: 'appearance', type: 'toggle', wired: 'wired' },
  { key: 'workspace_startup', label: 'Startup workspace', description: 'Preferred workspace landing behavior on next launch.', section: 'workspace', type: 'select', wired: 'planned', options: [
    { value: 'last', label: 'Last opened' }, { value: 'global', label: 'Global Workspace' },
  ] },
  { key: 'workspace_confirm_destructive', label: 'Confirm destructive actions', description: 'Shows an extra confirmation before clearing project memory.', section: 'workspace', type: 'toggle', wired: 'partial' },
  { key: 'workspace_panel_hints', label: 'Panel hints', description: 'Show concise hints in panel chrome where supported.', section: 'workspace', type: 'toggle', wired: 'planned' },
  { key: 'agent_default', label: 'Default code agent', description: 'Preference used by future task handoff flows.', section: 'agents', type: 'select', wired: 'planned', options: [
    { value: 'codex', label: 'Codex' }, { value: 'claudecode', label: 'Claude Code' }, { value: 'hermes', label: 'Hermes' }, { value: 'kimi', label: 'Kimi' },
  ] },
  { key: 'agent_save_outputs_to_knowledge', label: 'Save agent outputs to Knowledge', description: 'Agents already save completed task summaries. This preference gates future auto-save flows.', section: 'agents', type: 'toggle', wired: 'partial' },
  { key: 'agent_show_advanced_logs', label: 'Show advanced agent logs', description: 'Enables expanded tool/run log display when supported.', section: 'agents', type: 'toggle', wired: 'planned' },
  { key: 'searxng_url', label: 'SearXNG URL', description: 'Research uses this local or remote SearXNG endpoint for web search.', section: 'research', type: 'text', wired: 'wired' },
  { key: 'research_default_scope', label: 'Default research scope', description: 'Default scope used when starting new research sessions.', section: 'research', type: 'select', wired: 'partial', options: [
    { value: 'web', label: 'Web only' }, { value: 'local', label: 'Local knowledge' }, { value: 'both', label: 'Web + local knowledge' },
  ] },
  { key: 'research_result_limit', label: 'Research result target', description: 'Stored preference for result-volume tuning in future research builds.', section: 'research', type: 'number', wired: 'planned' },
  { key: 'editor_font_size', label: 'Editor font size (pt)', description: 'Default font size for Editor panel sessions.', section: 'editor', type: 'number', wired: 'wired' },
  { key: 'editor_tab_size', label: 'Editor tab size', description: 'Default tab/indent size for code editing.', section: 'editor', type: 'number', wired: 'wired' },
  { key: 'editor_word_wrap', label: 'Editor word wrap', description: 'Default word wrap preference for editor sessions.', section: 'editor', type: 'toggle', wired: 'wired' },
  { key: 'terminal_start_dir', label: 'Terminal startup folder', description: 'Terminal opens in the project folder when available, otherwise falls back.', section: 'editor', type: 'select', wired: 'partial', options: [
    { value: 'project', label: 'Project folder' }, { value: 'app', label: 'App folder fallback' },
  ] },
]

const SECTION_ICONS: Record<SectionId, string> = {
  overview:    '◎',
  appearance:  '◐',
  workspace:   '⬜',
  agents:      '⚡',
  models:      '◈',
  knowledge:   '◇',
  usage:       '▤',
  research:    '◎',
  editor:      '▣',
  web:         '◈',
  privacy:     '⊙',
  shortcuts:   '⌘',
  diagnostics: '◉',
  advanced:    '⚙',
}

const SECTIONS: { id: SectionId; label: string; description: string }[] = [
  { id: 'overview',    label: 'Overview',         description: 'Workspace health, quick status, and fast-links.' },
  { id: 'appearance',  label: 'Appearance',        description: 'Theme, density, text scale, and motion.' },
  { id: 'workspace',   label: 'Workspace',         description: 'Startup behavior, panel layout, and safety prompts.' },
  { id: 'agents',      label: 'Agents',            description: 'Codex, Claude Code, Hermes, and Kimi status and preferences.' },
  { id: 'models',      label: 'Models',            description: 'Ollama host, default models, and cloud key status.' },
  { id: 'knowledge',   label: 'Knowledge',         description: 'Shared memory controls, visibility, and explanations.' },
  { id: 'usage',       label: 'Usage',             description: 'Today\'s message and task counts per agent.' },
  { id: 'research',    label: 'Research',          description: 'SearXNG endpoint and research defaults.' },
  { id: 'editor',      label: 'Editor & Terminal', description: 'Local editing and shell preferences.' },
  { id: 'web',         label: 'Web Companion',     description: 'Optional private-network mobile Chat access.' },
  { id: 'privacy',     label: 'Privacy',           description: 'Local-first storage explanation and secret status.' },
  { id: 'shortcuts',   label: 'Shortcuts',         description: 'Keyboard reference for current app behavior.' },
  { id: 'diagnostics', label: 'Diagnostics',       description: 'Runtime report safe to copy for bug reports.' },
  { id: 'advanced',    label: 'Advanced',          description: 'Export, reset layout, and careful tools.' },
]

const DEFAULT_VALUES: Record<string, string> = {
  ui_theme: 'system',
  ui_density: 'comfortable',
  ui_font_scale: '100',
  ui_font_family: 'default',
  ui_motion_mode: 'full',
  ui_reduced_motion: 'false',
  notify_sound_enabled: 'false',
  workspace_startup: 'last',
  workspace_confirm_destructive: 'true',
  workspace_panel_hints: 'true',
  agent_default: 'codex',
  agent_save_outputs_to_knowledge: 'true',
  agent_show_advanced_logs: 'false',
  searxng_url: 'http://localhost:8080',
  research_default_scope: 'both',
  research_result_limit: '8',
  editor_font_size: '13',
  editor_tab_size: '2',
  editor_word_wrap: 'true',
  terminal_start_dir: 'project',
}

function applyUiPrefs(values: Record<string, string | null>) {
  const root = document.documentElement
  applyTheme(values.ui_theme ?? DEFAULT_VALUES.ui_theme)
  applyFontFamily(values.ui_font_family ?? DEFAULT_VALUES.ui_font_family)
  root.dataset.density = values.ui_density ?? DEFAULT_VALUES.ui_density
  root.dataset.fontScale = values.ui_font_scale ?? DEFAULT_VALUES.ui_font_scale
  const rawMotion = values.ui_motion_mode ?? (values.ui_reduced_motion === 'true' ? 'reduced' : DEFAULT_VALUES.ui_motion_mode)
  const motionMode: MotionMode = rawMotion === 'reduced' || rawMotion === 'off' ? rawMotion : 'full'
  applyMotionPreference(motionMode)
}

const USAGE_AGENTS = ['chat', 'claudecode', 'hermes', 'codex', 'kimi'] as const
const USAGE_LABELS: Record<(typeof USAGE_AGENTS)[number], string> = {
  chat: 'Chat',
  claudecode: 'Claude Code',
  hermes: 'Hermes',
  codex: 'Codex',
  kimi: 'Kimi',
}

function tone(ok: boolean | undefined): 'success' | 'error' {
  return ok ? 'success' : 'error'
}

function statusText(ok: boolean | undefined, yes = 'Ready', no = 'Unavailable') {
  return ok ? yes : no
}

function sectionMatches(section: SectionId, query: string) {
  if (!query) return true
  const q = query.toLowerCase()
  const sectionMeta = SECTIONS.find((s) => s.id === section)
  return (
    sectionMeta?.label.toLowerCase().includes(q) ||
    sectionMeta?.description.toLowerCase().includes(q) ||
    SETTINGS.some((s) => s.section === section && (`${s.label} ${s.description} ${s.key}`).toLowerCase().includes(q))
  )
}

function Badge({ wired }: { wired: SettingMeta['wired'] }) {
  if (wired === 'wired') return <span className="settings-mini-badge good">Live</span>
  if (wired === 'partial') return <span className="settings-mini-badge warn">Partial</span>
  return <span className="settings-mini-badge">Planned</span>
}

function SettingsSection(props: { id: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="settings-section-panel motion-section" id={props.id} data-testid={`settings-section-${props.id.replace('settings-', '')}`}>
      <div className="settings-section-title">
        <div>
          <h2>{props.title}</h2>
          <p>{props.description}</p>
        </div>
      </div>
      {props.children}
    </section>
  )
}

function SettingsRow(props: {
  label: string
  description?: string
  badge?: React.ReactNode
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="settings-control-row motion-row">
      <div className="settings-control-copy">
        <div className="settings-control-label">
          <span>{props.label}</span>
          {props.badge}
        </div>
        {props.description && <p>{props.description}</p>}
        {props.error && <div className="settings-inline-error">{props.error}</div>}
      </div>
      <div className="settings-control">{props.children}</div>
    </div>
  )
}

function SettingsToggle(props: { checked: boolean; onChange: (next: boolean) => void; label: string; testId?: string }) {
  return (
    <button
      type="button"
      className={`settings-toggle ${props.checked ? 'on' : ''}`}
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
      data-testid={props.testId}
    >
      <span />
    </button>
  )
}

function optionDescription(key: string, value: string, label: string) {
  const descriptions: Record<string, Record<string, string>> = {
    ui_theme: {
      system: 'Match your OS setting',
      dark: 'Low-light theme',
      light: 'Bright theme',
    },
    ui_density: {
      comfortable: 'Roomier rows and controls',
      compact: 'Tighter spacing for dense work',
    },
    ui_font_scale: {
      '95': 'Slightly smaller interface text',
      '100': 'Standard interface text size',
      '110': 'Larger text for easier scanning',
      '120': 'Largest app-wide text setting',
    },
    ui_font_family: {},
    ui_motion_mode: {
      full: 'Use the app\'s full motion system',
      reduced: 'Minimize movement and follow OS preference',
      off: 'Disable nonessential animation',
    },
    workspace_startup: {
      last: 'Return to the workspace you used last',
      global: 'Start in the general workspace',
    },
    agent_default: {
      codex: 'Use Codex for future handoff defaults',
      claudecode: 'Use Claude Code for future handoff defaults',
      hermes: 'Use Hermes for future autonomous tasks',
    },
    research_default_scope: {
      web: 'Search external web results only',
      local: 'Search saved workspace knowledge only',
      both: 'Blend web results with local knowledge',
    },
    terminal_start_dir: {
      project: 'Open shells in the active project folder',
      app: 'Fall back to the app workspace folder',
    },
    hermes_mode: {
      local: 'Run Hermes through local WSL2',
      remote: 'Connect to Hermes over SSH',
    },
    web_companion_host_mode: {
      local: 'Accept browser connections from this computer',
      private: 'Accept private LAN or Tailscale connections',
    },
  }
  return descriptions[key]?.[value] ?? (key === 'ui_font_family' ? `Preview using ${label}` : label)
}

function SettingsSelect(props: {
  value: string
  options: { value: string; label: string; stack?: string; description?: string }[]
  onChange: (next: string) => void
  label: string
  settingKey: string
  testId?: string
}) {
  const options: CardSelectOption[] = props.options.map((option) => ({
    ...option,
    description: option.description ?? optionDescription(props.settingKey, option.value, option.label),
  }))
  return (
    <CardSelect
      label={props.label}
      value={props.value}
      options={options}
      onChange={props.onChange}
      testId={props.testId}
    />
  )
}

function InfoCard(props: { label: string; value: string; detail?: string; tone?: 'success' | 'warning' | 'error' | 'info' }) {
  return (
    <div className={`settings-info-card tone-${props.tone ?? 'info'}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {props.detail && <p>{props.detail}</p>}
    </div>
  )
}

function ShortcutsEditor(props: { onSaved: (message: string) => void }) {
  const { shortcuts, updateShortcut, resetShortcut, resetAll } = useShortcuts()
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<Record<string, string>>({})

  const grouped: { title: string; scope: Shortcut['scope'] }[] = [
    { title: 'Global Shortcuts', scope: 'global' },
    { title: 'Composer Shortcuts', scope: 'composer' },
    { title: 'Panel Shortcuts', scope: 'panel' },
  ]

  function recordKey(shortcut: Shortcut, e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (recordingId !== shortcut.id) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecordingId(null)
      setConflicts((prev) => ({ ...prev, [shortcut.id]: '' }))
      return
    }
    if (isModifierOnlyKey(e.key)) return

    const nextKey = parseKey(e.nativeEvent)
    const duplicate = shortcuts.find((item) => item.id !== shortcut.id && item.currentKey === nextKey)
    if (duplicate) {
      setConflicts((prev) => ({ ...prev, [shortcut.id]: `Already used by: ${duplicate.label}` }))
      return
    }

    updateShortcut(shortcut.id, nextKey)
    setConflicts((prev) => ({ ...prev, [shortcut.id]: '' }))
    setRecordingId(null)
    props.onSaved('Shortcut saved')
  }

  return (
    <div className="settings-shortcuts-editor" data-testid="shortcuts-editor">
      {grouped.map((group) => {
        const items = shortcuts.filter((shortcut) => shortcut.scope === group.scope)
        if (items.length === 0) return null
        return (
          <div className="settings-shortcut-group" key={group.scope}>
            <div className="shortcuts-section-title">{group.title}</div>
            {items.map((shortcut) => {
              const conflict = conflicts[shortcut.id]
              const isRecording = recordingId === shortcut.id
              return (
                <SettingsRow
                  key={shortcut.id}
                  label={shortcut.label}
                  description={shortcut.description}
                  error={conflict}
                >
                  <button
                    type="button"
                    className={`shortcut-key-input${isRecording ? ' recording' : ''}${conflict ? ' conflict' : ''}`}
                    data-testid={`shortcut-key-${shortcut.id}`}
                    onClick={() => {
                      setRecordingId(shortcut.id)
                      setConflicts((prev) => ({ ...prev, [shortcut.id]: '' }))
                    }}
                    onKeyDown={(e) => recordKey(shortcut, e)}
                  >
                    {isRecording ? 'Press any key...' : formatShortcutKey(shortcut.currentKey)}
                  </button>
                  <button
                    type="button"
                    className="shortcut-reset-btn"
                    onClick={() => {
                      resetShortcut(shortcut.id)
                      setConflicts((prev) => ({ ...prev, [shortcut.id]: '' }))
                      props.onSaved('Shortcut reset')
                    }}
                  >
                    Reset
                  </button>
                </SettingsRow>
              )
            })}
          </div>
        )
      })}
      <div className="settings-action-row">
        <button
          type="button"
          className="ghost"
          data-testid="shortcuts-reset-all"
          onClick={() => {
            resetAll()
            setConflicts({})
            setRecordingId(null)
            props.onSaved('Shortcuts reset')
          }}
        >
          Reset all shortcuts to defaults
        </button>
      </div>
    </div>
  )
}

export default function SettingsPanel(props: {
  project: Project
  onClose: () => void
  onResetLayout?: () => void
}) {
  const [active, setActive] = useState<SectionId>(() => {
    try { return (localStorage.getItem('aiworkspace.settings.section') as SectionId) || 'overview' } catch { return 'overview' }
  })
  const [query, setQuery] = useState('')
  const [values, setValues] = useState<Record<string, string | null>>({ ...DEFAULT_VALUES })
  const [summary, setSummary] = useState<SettingsSummary | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [ollama, setOllama] = useState<OllamaStatus | null>(null)
  const [codex, setCodex] = useState<CodexStatus | null>(null)
  const [claude, setClaude] = useState<ClaudeStatus | null>(null)
  const [hermes, setHermes] = useState<HermesCheck | null>(null)
  const [hermesConfig, setHermesConfig] = useState<RemoteHermesConfig | null>(null)
  const [kimi, setKimi] = useState<KimiCheck | null>(null)
  const [kimiAuth, setKimiAuth] = useState<KimiAuthStatus | null>(null)
  const [kimiApiKeyInput, setKimiApiKeyInput] = useState('')
  const [kimiLoginBusy, setKimiLoginBusy] = useState(false)
  const [webCompanion, setWebCompanion] = useState<WebCompanionStatus | null>(null)
  const [newWebToken, setNewWebToken] = useState('')
  const [diagnostics, setDiagnostics] = useState<SettingsDiagnostics | null>(null)
  const [usage, setUsage] = useState<UsageSummaryRow[] | null>(null)
  const [cloudKeyInput, setCloudKeyInput] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  // Setup wizard flag: checked = wizard will run again on next launch.
  const [showWizardNextLaunch, setShowWizardNextLaunch] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [validation, setValidation] = useState<Record<string, string>>({})
  const msgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshSeq = useRef(0)

  const isGlobalWorkspace = isGlobalProjectId(props.project.id)

  const visibleSections = useMemo(
    () => SECTIONS.filter((section) => sectionMatches(section.id, query)),
    [query]
  )

  function showMessage(msg: string) {
    setMessage(msg)
    if (msgTimerRef.current) clearTimeout(msgTimerRef.current)
    msgTimerRef.current = setTimeout(() => setMessage(''), 3000)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (msgTimerRef.current) clearTimeout(msgTimerRef.current)
    }
  }, [props.onClose])

  useEffect(() => {
    try { localStorage.setItem('aiworkspace.settings.section', active) } catch {}
  }, [active])

  useEffect(() => {
    refresh()
  }, [props.project.id])

  async function refresh() {
    const seq = ++refreshSeq.current
    try {
      setError('')
      const [settingsSummary, nextWeb] = await Promise.all([
        window.api.settings.summary(),
        window.api.webCompanion.status(),
      ])
      if (seq !== refreshSeq.current) return
      setSummary(settingsSummary)
      const merged = {
        ...DEFAULT_VALUES,
        ...settingsSummary.values,
        ui_font_family: settingsSummary.values.ui_font_family ?? readStoredFontFamily() ?? DEFAULT_VALUES.ui_font_family,
      }
      setValues(merged)
      applyUiPrefs(merged)
      setWebCompanion(nextWeb)
      void window.api.setup.isComplete()
        .then((complete) => { if (seq === refreshSeq.current) setShowWizardNextLaunch(!complete) })
        .catch(() => {})
      void refreshMemoryCount(seq)
      window.setTimeout(() => void refreshProviderStatus(seq), 50)
      void window.api.usage.today()
        .then((rows) => { if (seq === refreshSeq.current) setUsage(rows) })
        .catch(() => {})
    } catch (e: any) {
      setError(String(e?.message ?? e))
    }
  }

  async function refreshMemoryCount(seq = refreshSeq.current) {
    try {
      const nextCount = isGlobalWorkspace
        ? (await window.api.memory.list(props.project.id)).length
        : await window.api.memory.count(props.project.id)
      if (seq === refreshSeq.current) setCount(nextCount)
    } catch (e: any) {
      if (seq === refreshSeq.current) setError(String(e?.message ?? e))
    }
  }

  async function refreshProviderStatus(seq = refreshSeq.current) {
    try {
      const [nextOllama, nextCodex, nextClaude, nextHermes, cfg, nextKimi, nextKimiAuth] = await Promise.all([
        window.api.ollama.status(),
        window.api.codex.check(),
        window.api.claudeCode.check(),
        window.api.hermes.check(),
        window.api.hermes.getConfig(),
        window.api.kimi.check(),
        window.api.kimi.getAuthStatus(),
      ])
      if (seq !== refreshSeq.current) return
      setOllama(nextOllama)
      setCodex(nextCodex)
      setClaude(nextClaude)
      setHermes(nextHermes)
      setHermesConfig(cfg)
      setKimi(nextKimi)
      setKimiAuth(nextKimiAuth)
    } catch (e: any) {
      if (seq === refreshSeq.current) setError(String(e?.message ?? e))
    }
  }

  function valueFor(key: string) {
    return values[key] ?? DEFAULT_VALUES[key] ?? ''
  }

  function numberValueFor(key: string) {
    const current = Number(valueFor(key))
    if (Number.isFinite(current)) return current
    const fallback = Number(DEFAULT_VALUES[key] ?? 0)
    return Number.isFinite(fallback) ? fallback : 0
  }

  function validate(meta: SettingMeta, next: string): string {
    if (meta.key === 'searxng_url') {
      try {
        const url = new URL(next)
        if (!['http:', 'https:'].includes(url.protocol)) return 'Use an http or https URL.'
      } catch {
        return 'Enter a valid URL.'
      }
    }
    if (meta.type === 'number' && (!Number.isFinite(Number(next)) || Number(next) < 0)) {
      return 'Enter a positive number.'
    }
    return ''
  }

  async function saveSetting(meta: SettingMeta, next: string) {
    const validationError = validate(meta, next)
    setValidation((prev) => ({ ...prev, [meta.key]: validationError }))
    const nextValues = { ...values, [meta.key]: next }
    setValues((prev) => ({ ...prev, [meta.key]: next }))
    if (validationError) return

    if (meta.key === 'ui_font_family') {
      storeFontFamily(next)
      applyUiPrefs(nextValues)
      window.dispatchEvent(new CustomEvent(SETTING_CHANGED_EVENT, { detail: { key: meta.key, value: next } }))

      const mainSupportsFontSetting = Object.prototype.hasOwnProperty.call(summary?.values ?? {}, meta.key)
      if (!mainSupportsFontSetting) {
        showMessage('Saved')
        return
      }

      setSavingKey(meta.key)
      try {
        await window.api.settings.set(meta.key, next)
        showMessage('Saved')
      } catch (e: any) {
        if (String(e?.message ?? e).includes('Unsupported setting')) {
          showMessage('Saved')
        } else {
          setError(String(e?.message ?? e))
        }
      } finally {
        setSavingKey(null)
      }
      return
    }

    setSavingKey(meta.key)
    try {
      await window.api.settings.set(meta.key, next)
      if (meta.section === 'appearance') applyUiPrefs(nextValues)
      window.dispatchEvent(new CustomEvent(SETTING_CHANGED_EVENT, { detail: { key: meta.key, value: next } }))
      showMessage('Saved')
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setSavingKey(null)
    }
  }

  function renderSetting(meta: SettingMeta) {
    const current = valueFor(meta.key)
    const saving = savingKey === meta.key && <span className="settings-saving">Saving…</span>
    return (
      <SettingsRow
        key={meta.key}
        label={meta.label}
        description={meta.description}
        badge={<Badge wired={meta.wired} />}
        error={validation[meta.key]}
      >
        {meta.type === 'toggle' ? (
          <SettingsToggle
            label={meta.label}
            checked={current === 'true'}
            onChange={(next) => saveSetting(meta, String(next))}
          />
        ) : meta.type === 'select' ? (
          <SettingsSelect
            label={meta.label}
            value={current}
            options={meta.options ?? []}
            onChange={(next) => saveSetting(meta, next)}
            settingKey={meta.key}
            testId={`settings-select-${meta.key}`}
          />
        ) : meta.type === 'number' ? (
          <>
            {saving}
            <NumberStepper
              value={numberValueFor(meta.key)}
              onChange={(next) => saveSetting(meta, String(next))}
              min={0}
              label={meta.label}
              testId={`settings-number-${meta.key}`}
            />
          </>
        ) : (
          <input
            type="text"
            value={current}
            onChange={(e) => saveSetting(meta, e.target.value)}
            aria-label={meta.label}
          />
        )}
        {meta.type !== 'number' && saving}
      </SettingsRow>
    )
  }

  async function saveCloudKey(keyToSave?: string) {
    const key = keyToSave !== undefined ? keyToSave : cloudKeyInput.trim()
    setSavingKey('ollama_cloud_key')
    try {
      await window.api.settings.set('ollama_cloud_key', key)
      setCloudKeyInput('')
      const next = await window.api.settings.summary()
      setSummary(next)
      showMessage(key ? 'Cloud key saved' : 'Cloud key cleared')
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setSavingKey(null)
    }
  }

  async function saveHermesConfig() {
    if (!hermesConfig) return
    setSavingKey('hermes')
    try {
      await window.api.hermes.setConfig(hermesConfig)
      showMessage('Hermes settings saved')
      setHermes(await window.api.hermes.check())
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setSavingKey(null)
    }
  }

  async function testHermes() {
    if (!hermesConfig) return
    setSavingKey('hermes-test')
    const result = await window.api.hermes.testConnection(hermesConfig)
    showMessage(result.success ? 'Hermes SSH connection works' : result.error ?? 'Hermes connection failed')
    setSavingKey(null)
  }

  async function setKimiAuthMethodChoice(method: KimiAuthMethod) {
    setSavingKey('kimi-auth-method')
    try {
      await window.api.kimi.setAuthMethod(method)
      setKimiAuth(await window.api.kimi.getAuthStatus())
    } finally {
      setSavingKey(null)
    }
  }

  async function saveKimiApiKey() {
    if (!kimiApiKeyInput.trim()) return
    setSavingKey('kimi-api-key')
    try {
      await window.api.kimi.setApiKey(kimiApiKeyInput.trim())
      setKimiApiKeyInput('')
      showMessage('Kimi API key saved')
      setKimiAuth(await window.api.kimi.getAuthStatus())
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setSavingKey(null)
    }
  }

  async function runKimiLoginFlow() {
    setKimiLoginBusy(true)
    try {
      const r = await window.api.kimi.login()
      showMessage(r.success ? 'Kimi login succeeded' : r.error ?? 'Kimi login failed')
      setKimiAuth(await window.api.kimi.getAuthStatus())
    } finally {
      setKimiLoginBusy(false)
    }
  }

  async function clearMemories() {
    if (isGlobalWorkspace) return
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    const removed = await window.api.memory.clearProject(props.project.id)
    setConfirmClear(false)
    setCount(await window.api.memory.count(props.project.id))
    showMessage(`Removed ${removed} ${removed === 1 ? 'item' : 'items'}.`)
  }

  async function loadDiagnostics() {
    setSavingKey('diagnostics')
    setDiagnostics(await window.api.settings.diagnostics())
    setSavingKey(null)
  }

  function diagnosticsText() {
    const report = diagnostics
    if (!report) return ''
    return [
      'AI Workspace diagnostics',
      `App: ${report.app.name} ${report.app.version}`,
      `Runtime: Electron ${report.app.electron}, Node ${report.app.node}, Chrome ${report.app.chrome}`,
      `Platform: ${report.app.platform}`,
      `User data: ${report.app.userData}`,
      `Database: ${report.app.databasePath}`,
      `Counts: ${report.counts.projects} projects, ${report.counts.sessions} sessions, ${report.counts.memories} memories`,
      `Knowledge: ${report.knowledge.embeddingsPresent} embedded, ${report.knowledge.embeddingsMissing} missing embeddings, ${report.knowledge.unusedCount} unused, ${report.knowledge.staleCount} stale, ${report.knowledge.recentlyAccessedCount} recently accessed, ${report.knowledge.lowQualityCount} review candidates`,
      `Knowledge by type: ${Object.entries(report.knowledge.byType).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
      `Knowledge by source: ${Object.entries(report.knowledge.bySource).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
      `Last consolidation: ${report.knowledge.lastConsolidationAt ? new Date(report.knowledge.lastConsolidationAt).toISOString() : 'never'}`,
      `Ollama: ${report.providers.ollama.connected ? 'connected' : 'not running'} (${report.providers.ollama.defaultModel ?? 'no default model'})`,
      `Codex: ${report.providers.codex.installed ? 'installed' : 'missing'} ${report.providers.codex.version ?? ''}`,
      `Claude Code: ${report.providers.claudeCode.installed ? 'installed' : 'missing'} ${report.providers.claudeCode.version ?? ''}`,
      `Hermes: ${report.providers.hermes.connected ? 'connected' : report.providers.hermes.installed ? 'installed' : 'not installed'}`,
      `Kimi: ${report.providers.kimi.installed ? 'installed' : 'not installed'} ${report.providers.kimi.version ?? ''}`,
      `Web Companion: ${report.webCompanion.running ? 'running' : report.webCompanion.enabled ? 'enabled but stopped' : 'disabled'} (${report.webCompanion.hostMode}, port ${report.webCompanion.port})`,
      `Ollama Cloud key: ${report.settings.secrets.ollama_cloud_key?.configured ? 'configured' : 'not configured'}`,
      `Kimi API key: ${report.settings.secrets.kimi_api_key?.configured ? 'configured' : 'not configured'}`,
    ].join('\n')
  }

  async function copyText(text: string, label: string) {
    await navigator.clipboard.writeText(text)
    showMessage(`${label} copied`)
  }

  function exportText() {
    return JSON.stringify({ exportedAt: new Date().toISOString(), settings: summary }, null, 2)
  }

  async function importSettings() {
    const filePath = await window.api.files.pick()
    if (!filePath) return
    if (!filePath.toLowerCase().endsWith('.json')) {
      setError('Choose a .json settings file.')
      return
    }
    const confirmed = window.confirm(
      'This will overwrite your current settings with values from the file. Continue?'
    )
    if (!confirmed) return
    setSavingKey('settings-import')
    try {
      const file = await window.api.files.read(filePath)
      if (file.type !== 'text' || typeof file.content !== 'string') {
        setError('Could not read the file as text.')
        return
      }
      const result = await window.api.settings.import(file.content)
      if (result.success) {
        showMessage(`Imported ${result.imported ?? 0} ${result.imported === 1 ? 'setting' : 'settings'}`)
        await refresh()
      } else {
        setError(result.error ?? 'Import failed')
      }
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setSavingKey(null)
    }
  }

  function sectionSettings(section: SectionId) {
    return SETTINGS.filter((s) => s.section === section && (!query || `${s.label} ${s.description} ${s.key}`.toLowerCase().includes(query.toLowerCase())))
  }

  async function configureWeb(next: Partial<Pick<WebCompanionStatus, 'enabled' | 'hostMode' | 'port'>>) {
    setSavingKey('web-companion')
    setNewWebToken('')
    try {
      const status = await window.api.webCompanion.configure(next)
      setWebCompanion(status)
      showMessage(status.running ? 'Web Companion running' : 'Web Companion stopped')
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setSavingKey(null)
    }
  }

  async function regenerateWebToken() {
    setSavingKey('web-token')
    try {
      const result = await window.api.webCompanion.regenerateToken()
      setWebCompanion(result.status)
      setNewWebToken(result.token)
      showMessage('Access token regenerated')
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setSavingKey(null)
    }
  }

  const activeSection = visibleSections.some((s) => s.id === active) ? active : visibleSections[0]?.id ?? 'overview'

  const agentCount = (codex?.installed ? 1 : 0) + (claude?.installed ? 1 : 0) + (hermes?.installed ? 1 : 0) + (kimi?.installed ? 1 : 0)

  const usageByAgent = useMemo(() => {
    const map: Partial<Record<(typeof USAGE_AGENTS)[number], UsageSummaryRow>> = {}
    for (const row of usage ?? []) {
      if ((USAGE_AGENTS as readonly string[]).includes(row.agent)) map[row.agent as (typeof USAGE_AGENTS)[number]] = row
    }
    return map
  }, [usage])
  const maxUsageCount = Math.max(1, ...USAGE_AGENTS.map((id) => usageByAgent[id]?.message_count ?? 0))

  return (
    <div className="settings-overlay" onClick={props.onClose} data-testid="settings-overlay">
      <div className="settings-shell" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()} data-testid="settings-shell">
        <aside className="settings-sidebar">
          <div className="settings-brand">
            <h1>Settings</h1>
            <p>AI Workspace control center</p>
          </div>
          <input
            className="settings-search"
            data-testid="settings-search"
            placeholder="Search settings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search settings"
          />
          <nav className="settings-nav" aria-label="Settings sections">
            {visibleSections.map((section) => (
              <button
                key={section.id}
                className={activeSection === section.id ? 'active' : ''}
                onClick={() => setActive(section.id)}
                data-testid={`settings-nav-${section.id}`}
              >
                <span className="settings-nav-icon" aria-hidden>{SECTION_ICONS[section.id]}</span>
                <span>{section.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="settings-main">
          <div className="settings-topline">
            <div>
              <h2>{SECTIONS.find((s) => s.id === activeSection)?.label}</h2>
              <p>{SECTIONS.find((s) => s.id === activeSection)?.description}</p>
            </div>
            <div className="settings-top-actions">
              {message && <span className="settings-saved" data-testid="settings-message">{message}</span>}
              <button className="ghost tiny" onClick={refresh} data-testid="settings-refresh">Refresh</button>
              <button className="ghost tiny" onClick={props.onClose} title="Close (Esc)" data-testid="settings-close">Close</button>
            </div>
          </div>
          {error && <WorkspaceNotice title="Settings error" tone="error" testId="settings-error">{error}</WorkspaceNotice>}

          <div className="settings-scroll" data-testid="settings-panel">

            {/* ── Overview ─────────────────────────────────────────────── */}
            {activeSection === 'overview' && (
              <SettingsSection id="settings-overview" title="Overview" description="Current workspace, provider, and memory health.">
                <div className="settings-info-grid">
                  <InfoCard
                    label="Workspace"
                    value={props.project.name}
                    detail={isGlobalWorkspace ? 'General chat and memory — not tied to a project folder' : props.project.path}
                    tone="info"
                  />
                  <InfoCard
                    label="Knowledge"
                    value={count === null ? 'Checking…' : `${count} ${count === 1 ? 'item' : 'items'}`}
                    detail="Shared memory stored locally in the workspace database"
                    tone="info"
                  />
                  <InfoCard
                    label="Ollama"
                    value={ollama === null ? 'Checking…' : statusText(ollama.connected, 'Connected', 'Not running')}
                    detail={ollama?.defaultModel ?? 'No default model detected'}
                    tone={ollama === null ? 'info' : tone(ollama.connected)}
                  />
                  <InfoCard
                    label="Agents available"
                    value={`${agentCount} of 4`}
                    detail={[codex?.installed ? 'Codex' : null, claude?.installed ? 'Claude Code' : null, hermes?.installed ? 'Hermes' : null, kimi?.installed ? 'Kimi' : null].filter(Boolean).join(', ') || 'None installed'}
                    tone={agentCount > 0 ? 'success' : 'warning'}
                  />
                </div>
                <div className="settings-quick-links">
                  {(['models', 'agents', 'knowledge', 'diagnostics'] as SectionId[]).map((id) => (
                    <button key={id} className="ghost" onClick={() => setActive(id)} data-testid={`settings-quicklink-${id}`}>
                      {SECTIONS.find((s) => s.id === id)?.label} →
                    </button>
                  ))}
                </div>
              </SettingsSection>
            )}

            {/* ── Appearance ───────────────────────────────────────────── */}
            {activeSection === 'appearance' && (
              <SettingsSection id="settings-appearance" title="Appearance" description="Personalize the app without changing the mode accent system.">
                <div className="settings-preview">
                  <div className="settings-preview-panel">
                    <span className="settings-preview-tab">Chat</span>
                    <span className="settings-preview-tab hermes">Hermes</span>
                    <span className="settings-preview-tab claude">Claude Code</span>
                    <p>Preview reflects your current density and text scale selections.</p>
                  </div>
                </div>
                {sectionSettings('appearance').map(renderSetting)}
              </SettingsSection>
            )}

            {/* ── Workspace ────────────────────────────────────────────── */}
            {activeSection === 'workspace' && (
              <SettingsSection id="settings-workspace" title="Workspace" description="Layout behavior and project safety.">
                {sectionSettings('workspace').map(renderSetting)}
                <SettingsRow label="Reset current layout" description="Returns this workspace to its default panel arrangement. Cannot be undone." badge={<span className="settings-mini-badge good">Wired</span>}>
                  <button className="ghost" onClick={props.onResetLayout} disabled={!props.onResetLayout}>Reset layout</button>
                </SettingsRow>
                <SettingsRow label="Current project" description={isGlobalWorkspace ? 'Global Workspace is not tied to a project folder.' : 'Folder-backed project workspace.'}>
                  <span className="settings-mono-value" title={isGlobalWorkspace ? 'Global Workspace' : props.project.path}>
                    {isGlobalWorkspace ? 'Global Workspace' : props.project.path}
                  </span>
                </SettingsRow>
              </SettingsSection>
            )}

            {/* ── Agents ───────────────────────────────────────────────── */}
            {activeSection === 'agents' && (
              <SettingsSection id="settings-agents" title="Agents" description="Agent availability and behavior preferences.">
                <div className="settings-info-grid three">
                  <InfoCard
                    label="Codex"
                    value={statusText(codex?.installed, 'Installed', 'Not installed')}
                    detail={codex?.version ?? codex?.error ?? 'OpenAI Codex CLI'}
                    tone={tone(codex?.installed)}
                  />
                  <InfoCard
                    label="Claude Code"
                    value={statusText(claude?.installed, 'Installed', 'Not installed')}
                    detail={claude?.version ?? claude?.error ?? 'Anthropic Claude Code CLI'}
                    tone={tone(claude?.installed)}
                  />
                  <InfoCard
                    label="Hermes"
                    value={hermes?.connected ? 'Connected' : hermes?.installed ? 'Installed' : 'Setup needed'}
                    detail={hermes?.distro ?? hermes?.error ?? 'WSL2 / remote SSH agent'}
                    tone={hermes?.connected ? 'success' : hermes?.installed ? 'info' : 'warning'}
                  />
                  <InfoCard
                    label="Kimi"
                    value={kimi?.installed ? (kimiAuth?.configured ? 'Ready' : 'Needs auth') : 'Not installed'}
                    detail={kimi?.version ?? kimi?.error ?? 'Moonshot AI Kimi Code CLI (ACP, local)'}
                    tone={kimi?.installed && kimiAuth?.configured ? 'success' : kimi?.installed ? 'info' : 'warning'}
                  />
                </div>
                {sectionSettings('agents').map(renderSetting)}
                {!codex?.installed && (
                  <WorkspaceNotice title="Codex setup" tone="info">
                    Install with <code>npm install -g @openai/codex</code>, then log in with your ChatGPT subscription.
                  </WorkspaceNotice>
                )}
                {!claude?.installed && (
                  <WorkspaceNotice title="Claude Code setup" tone="info">
                    Install with <code>npm install -g @anthropic-ai/claude-code</code> and run <code>claude</code> to log in.
                  </WorkspaceNotice>
                )}
                {!kimi?.installed && (
                  <WorkspaceNotice title="Kimi setup" tone="info">
                    Install with <code>npm install -g @moonshot-ai/kimi-code</code> (Node 22.19+), or the official
                    install script from the docs, then restart AI Workspace. See{' '}
                    <a href="#" onClick={(e) => { e.preventDefault(); window.api.shell.openExternal('https://moonshotai.github.io/kimi-code/en/guides/getting-started.html') }}>
                      getting-started guide
                    </a>.
                  </WorkspaceNotice>
                )}
                <div className="settings-subpanel">
                  <h3>Kimi Authentication</h3>
                  <SettingsRow label="Auth method" description="OAuth device-code login (kimi login) or a Moonshot API key.">
                    <SettingsSelect
                      label="Kimi auth method"
                      value={kimiAuth?.method ?? 'oauth'}
                      options={[{ value: 'oauth', label: 'OAuth login' }, { value: 'apikey', label: 'API key' }]}
                      onChange={(method) => void setKimiAuthMethodChoice(method as KimiAuthMethod)}
                      settingKey="kimi_auth_method"
                      testId="settings-select-kimi-auth-method"
                    />
                  </SettingsRow>
                  {kimiAuth?.method === 'oauth' ? (
                    <div className="settings-action-row">
                      <button className="primary" data-testid="settings-kimi-login" onClick={runKimiLoginFlow} disabled={kimiLoginBusy}>
                        {kimiLoginBusy ? 'Waiting for login…' : 'Log in with Kimi'}
                      </button>
                      <StatusBadge tone={kimiAuth?.configured ? 'success' : 'warning'}>
                        {kimiAuth?.configured ? 'Authenticated' : kimiAuth?.detail ?? 'Not authenticated'}
                      </StatusBadge>
                    </div>
                  ) : (
                    <>
                      <SettingsRow label="Moonshot API key" description="Stored as plaintext in the local database, same as the Ollama Cloud key. Sent to the kimi acp process as an environment variable.">
                        <input
                          type="password"
                          data-testid="settings-kimi-api-key"
                          value={kimiApiKeyInput}
                          onChange={(e) => setKimiApiKeyInput(e.target.value)}
                          placeholder={kimiAuth?.configured ? '••••••••' : 'Paste API key'}
                        />
                      </SettingsRow>
                      <div className="settings-action-row">
                        <button className="primary" onClick={saveKimiApiKey} disabled={!kimiApiKeyInput.trim() || savingKey === 'kimi-api-key'}>
                          {savingKey === 'kimi-api-key' ? 'Saving…' : 'Save key'}
                        </button>
                        {kimiAuth?.configured && <StatusBadge tone="success">Key saved</StatusBadge>}
                      </div>
                    </>
                  )}
                </div>
                {hermesConfig && (
                  <div className="settings-subpanel">
                    <h3>Hermes Connection</h3>
                    <SettingsRow label="Mode" description="Local WSL2 or remote SSH.">
                      <SettingsSelect
                        label="Hermes mode"
                        value={hermesConfig.mode}
                        options={[{ value: 'local', label: 'Local WSL2' }, { value: 'remote', label: 'Remote SSH' }]}
                        onChange={(mode) => setHermesConfig({ ...hermesConfig, mode: mode as RemoteHermesConfig['mode'] })}
                        settingKey="hermes_mode"
                        testId="settings-select-hermes-mode"
                      />
                    </SettingsRow>
                    <SettingsRow label="SSH host" description="Remote mode only. Private key file contents are never read or displayed.">
                      <input value={hermesConfig.sshHost} onChange={(e) => setHermesConfig({ ...hermesConfig, sshHost: e.target.value })} placeholder="hostname or IP" />
                    </SettingsRow>
                    <SettingsRow label="SSH user" description="Remote login username.">
                      <input value={hermesConfig.sshUser} onChange={(e) => setHermesConfig({ ...hermesConfig, sshUser: e.target.value })} placeholder="username" />
                    </SettingsRow>
                    <SettingsRow label="SSH key path" description="Path to private key on disk. Key contents are never read.">
                      <input value={hermesConfig.sshKeyPath} onChange={(e) => setHermesConfig({ ...hermesConfig, sshKeyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" />
                    </SettingsRow>
                    <SettingsRow label="Hermes binary path" description="Path to the Hermes executable inside Linux or the remote host.">
                      <input value={hermesConfig.hermesPath} onChange={(e) => setHermesConfig({ ...hermesConfig, hermesPath: e.target.value })} placeholder="/usr/local/bin/hermes" />
                    </SettingsRow>
                    <div className="settings-action-row">
                      <button className="primary" onClick={saveHermesConfig} disabled={savingKey === 'hermes'}>
                        {savingKey === 'hermes' ? 'Saving…' : 'Save Hermes'}
                      </button>
                      <button className="ghost" onClick={testHermes} disabled={hermesConfig.mode !== 'remote' || savingKey === 'hermes-test'}>
                        {savingKey === 'hermes-test' ? 'Testing…' : 'Test SSH'}
                      </button>
                    </div>
                  </div>
                )}
              </SettingsSection>
            )}

            {/* ── Models ───────────────────────────────────────────────── */}
            {activeSection === 'models' && (
              <SettingsSection id="settings-models" title="Models & Providers" description="Ollama and cloud-provider controls.">
                <div className="settings-info-grid">
                  <InfoCard
                    label="Ollama host"
                    value={ollama?.connected ? 'Reachable' : 'Not running'}
                    detail="Resolved from OLLAMA_HOST environment variable or localhost:11434"
                    tone={tone(ollama?.connected)}
                  />
                  <InfoCard
                    label="Default chat model"
                    value={ollama?.defaultModel ?? 'None'}
                    detail="Used by background tasks and Chat when no model is selected"
                    tone={ollama?.defaultModel ? 'success' : 'warning'}
                  />
                  <InfoCard
                    label="Embedding model"
                    value="nomic-embed-text"
                    detail="Used for Knowledge search vector generation"
                    tone="info"
                  />
                  <InfoCard
                    label="Ollama Cloud key"
                    value={summary?.secrets.ollama_cloud_key?.configured ? 'Configured' : 'Not configured'}
                    detail={summary?.secrets.ollama_cloud_key?.configured ? `Key: ${summary.secrets.ollama_cloud_key.masked ?? '••••'}` : 'No key saved — only local models available'}
                    tone={summary?.secrets.ollama_cloud_key?.configured ? 'success' : 'info'}
                  />
                </div>
                <SettingsRow
                  label="Replace Ollama Cloud key"
                  description="Saved keys are write-only from the renderer. The full key value is never displayed or included in diagnostics."
                >
                  <input
                    type="password"
                    value={cloudKeyInput}
                    onChange={(e) => setCloudKeyInput(e.target.value)}
                    placeholder="Paste new key…"
                    aria-label="Ollama Cloud key"
                    onKeyDown={(e) => e.key === 'Enter' && cloudKeyInput.trim() && saveCloudKey()}
                  />
                  <button className="primary" onClick={() => saveCloudKey()} disabled={!cloudKeyInput.trim() || savingKey === 'ollama_cloud_key'}>
                    {savingKey === 'ollama_cloud_key' ? 'Saving…' : 'Save key'}
                  </button>
                  {summary?.secrets.ollama_cloud_key?.configured && (
                    <button className="ghost" onClick={() => saveCloudKey('')} disabled={savingKey === 'ollama_cloud_key'}>Clear</button>
                  )}
                </SettingsRow>
                {!ollama?.connected && (
                  <WorkspaceNotice title="Ollama not running" tone="warning">
                    Start Ollama and pull a model (e.g. <code>ollama pull llama3.2</code>) to enable chat and research.
                  </WorkspaceNotice>
                )}
              </SettingsSection>
            )}

            {/* ── Knowledge ────────────────────────────────────────────── */}
            {activeSection === 'knowledge' && (
              <SettingsSection id="settings-knowledge" title="Knowledge & Memory" description="One shared memory layer across Chat, Hermes, Claude Code, Codex, and Kimi.">
                <WorkspaceNotice title="How memory works" tone="info">
                  Sessions are temporary. Durable memory is extracted after sessions end and stored in the local database. It is shared across all agents in the same project.
                </WorkspaceNotice>
                <SettingsRow
                  label="Memory items"
                  description={isGlobalWorkspace ? 'Global memory count across all sessions.' : 'Memory items scoped to this project.'}
                >
                  <strong data-testid="settings-memory-count">{count === null ? 'Checking…' : count}</strong>
                </SettingsRow>
                <SettingsRow
                  label={isGlobalWorkspace ? 'Clear global memories' : 'Clear project memories'}
                  description={isGlobalWorkspace
                    ? 'Global memory cannot be bulk-cleared here. Use the Knowledge panel to delete individual items.'
                    : 'Permanently removes all memory for this project. Use Knowledge to delete individual items.'}
                >
                  {isGlobalWorkspace ? (
                    <span className="muted small">Use Knowledge panel for individual deletes.</span>
                  ) : confirmClear ? (
                    <>
                      <button className="danger" onClick={clearMemories} data-testid="settings-confirm-clear">
                        Delete {count ?? ''} {count === 1 ? 'item' : 'items'}
                      </button>
                      <button className="ghost" onClick={() => setConfirmClear(false)}>Cancel</button>
                    </>
                  ) : (
                    <button
                      className="ghost settings-danger-link"
                      onClick={clearMemories}
                      disabled={count === 0}
                      data-testid="settings-clear-memories"
                    >
                      Clear project memories
                    </button>
                  )}
                </SettingsRow>
              </SettingsSection>
            )}

            {/* ── Usage ────────────────────────────────────────────────── */}
            {activeSection === 'usage' && (
              <SettingsSection id="settings-usage" title="Usage" description="Today's message and task counts, per agent. This device only.">
                <WorkspaceNotice title="Counts only, no cost estimates" tone="info">
                  Token counts below are rough estimates (~4 characters per token), not billed usage. Every agent here runs through a subscription CLI login, not metered API billing, so there is nothing to price.
                </WorkspaceNotice>
                <div className="usage-today-list" data-testid="settings-usage-list">
                  {USAGE_AGENTS.map((id) => {
                    const row = usageByAgent[id]
                    const count = row?.message_count ?? 0
                    const tokens = row?.estimated_tokens ?? 0
                    const pct = Math.round((count / maxUsageCount) * 100)
                    const unit = id === 'chat' ? (count === 1 ? 'message' : 'messages') : (count === 1 ? 'task' : 'tasks')
                    return (
                      <div className="usage-row" key={id} data-testid={`settings-usage-row-${id}`}>
                        <div className="usage-row-head">
                          <span className="usage-row-label">{USAGE_LABELS[id]}</span>
                          <span className="usage-row-count">
                            {count} {unit}
                            {id === 'chat' && count > 0 ? ` · ~${tokens.toLocaleString()} tokens` : ''}
                          </span>
                        </div>
                        <div className="usage-row-bar"><div className="usage-row-bar-fill" style={{ width: `${pct}%` }} /></div>
                      </div>
                    )
                  })}
                  {usage === null && <p className="muted small">Loading today's usage…</p>}
                </div>
              </SettingsSection>
            )}

            {/* ── Research ─────────────────────────────────────────────── */}
            {activeSection === 'research' && (
              <SettingsSection id="settings-research" title="Research" description="Deep research defaults and search backend configuration.">
                {sectionSettings('research').map(renderSetting)}
                <WorkspaceNotice title="SearXNG required for web research" tone="info">
                  Run a local SearXNG instance or point to a remote one. Without it, Research falls back to local Knowledge only.
                </WorkspaceNotice>
              </SettingsSection>
            )}

            {/* ── Editor & Terminal ─────────────────────────────────────── */}
            {activeSection === 'editor' && (
              <SettingsSection id="settings-editor" title="Editor & Terminal" description="Local editor and shell defaults.">
                {sectionSettings('editor').map(renderSetting)}
                <WorkspaceNotice title="Project folder required" tone="warning">
                  Terminal, Codex, Claude Code, Hermes, and Kimi need a folder-backed project. Global Workspace intentionally blocks project shell access.
                </WorkspaceNotice>
              </SettingsSection>
            )}

            {/* ── Privacy ──────────────────────────────────────────────── */}
            {/* Web Companion */}
            {activeSection === 'web' && (
              <SettingsSection id="settings-web" title="Web Companion" description="Optional mobile Chat access for your private network.">
                <div className="settings-info-grid">
                  <InfoCard
                    label="Server"
                    value={webCompanion?.running ? 'Running' : webCompanion?.enabled ? 'Stopped' : 'Disabled'}
                    detail={webCompanion?.error ?? (webCompanion?.running ? webCompanion.localUrl : 'Off by default')}
                    tone={webCompanion?.running ? 'success' : webCompanion?.enabled ? 'warning' : 'info'}
                  />
                  <InfoCard
                    label="Bind address"
                    value={webCompanion?.bindHost ?? '127.0.0.1'}
                    detail={webCompanion?.hostMode === 'private' ? 'Visible on private network interfaces.' : 'Localhost only.'}
                    tone={webCompanion?.hostMode === 'private' ? 'warning' : 'info'}
                  />
                  <InfoCard
                    label="Access token"
                    value={webCompanion?.tokenConfigured ? 'Configured' : 'Not generated'}
                    detail={webCompanion?.tokenMasked ?? 'Generate a token before connecting.'}
                    tone={webCompanion?.tokenConfigured ? 'success' : 'warning'}
                  />
                </div>

                <WorkspaceNotice title="Security boundary" tone="warning">
                  The Web Companion exposes Chat only. It does not expose Terminal, Editor writes, Codex, Claude Code, Hermes, Kimi, arbitrary filesystem browsing, raw settings, environment variables, or database access.
                </WorkspaceNotice>

                <SettingsRow
                  label="Enable Web Companion"
                  description="Starts a small authenticated server owned by the Electron main process. It is disabled by default."
                >
                  <SettingsToggle
                    label="Enable Web Companion"
                    checked={webCompanion?.enabled === true}
                    onChange={(enabled) => configureWeb({ enabled })}
                  />
                </SettingsRow>

                <SettingsRow
                  label="Network access"
                  description="Use localhost for same-machine testing. Private network mode binds to all interfaces for Tailscale or LAN use."
                >
                  <SettingsSelect
                    label="Web Companion network access"
                    value={webCompanion?.hostMode ?? 'local'}
                    options={[
                      { value: 'local', label: 'Localhost only' },
                      { value: 'private', label: 'Private network / Tailscale' },
                    ]}
                    onChange={(hostMode) => configureWeb({ hostMode: hostMode as WebCompanionStatus['hostMode'] })}
                    settingKey="web_companion_host_mode"
                    testId="settings-select-web-companion-host-mode"
                  />
                </SettingsRow>

                <SettingsRow
                  label="Port"
                  description="Allowed range: 1024-65535. Changing the port restarts the companion server if it is enabled."
                >
                  {savingKey === 'web-companion' && <span className="settings-saving">Saving...</span>}
                  <NumberStepper
                    min={1024}
                    max={65535}
                    value={webCompanion?.port ?? 8765}
                    onChange={(port) => configureWeb({ port })}
                    label="Web Companion port"
                    testId="settings-number-web-companion-port"
                  />
                </SettingsRow>

                <SettingsRow
                  label="Web URL"
                  description="Open this URL from a browser. Private-network URLs appear only when private mode is selected."
                >
                  <button className="ghost" onClick={() => copyText(webCompanion?.localUrl ?? 'http://127.0.0.1:8765', 'Web URL')}>
                    Copy local URL
                  </button>
                  {webCompanion?.hostMode === 'private' && webCompanion.privateUrls[0] && (
                    <button className="ghost" onClick={() => copyText(webCompanion.privateUrls[0], 'Private-network URL')}>
                      Copy private URL
                    </button>
                  )}
                </SettingsRow>

                <SettingsRow
                  label="Access token"
                  description="Tokens are required for all project, session, chat, and Knowledge APIs. Regeneration shows the new token once."
                >
                  <button className="primary" onClick={regenerateWebToken} disabled={savingKey === 'web-token'}>
                    {savingKey === 'web-token' ? 'Regenerating...' : webCompanion?.tokenConfigured ? 'Regenerate token' : 'Generate token'}
                  </button>
                </SettingsRow>

                {newWebToken && (
                  <SettingsRow
                    label="New token"
                    description="Use this token on the login screen. It will not be shown again after Settings refreshes."
                  >
                    <input className="settings-mono-value" value={newWebToken} readOnly aria-label="New Web Companion token" />
                    <button className="ghost" onClick={() => copyText(newWebToken, 'Access token')}>Copy token</button>
                  </SettingsRow>
                )}

                {webCompanion?.hostMode === 'private' && (
                  <WorkspaceNotice title="Private network warning" tone="warning">
                    Anyone who can reach this port and has the token can read Chat sessions and send messages. Use this only on networks you trust, such as your own Tailscale tailnet.
                  </WorkspaceNotice>
                )}
              </SettingsSection>
            )}

            {activeSection === 'privacy' && (
              <SettingsSection id="settings-privacy" title="Privacy & Security" description="Local-first storage and secret visibility.">
                <div className="settings-privacy-grid">
                  <WorkspaceNotice title="Local-first storage" tone="info">
                    Projects, sessions, memory, settings, and agent summaries are stored in a single SQLite database on your local machine. Nothing is sent to external servers except agent CLI calls you initiate.
                  </WorkspaceNotice>
                  <WorkspaceNotice title="Secret storage warning" tone="warning">
                    Ollama Cloud keys, Hermes SSH paths, and Kimi API keys are stored as plaintext in the local database. This app does not currently use encrypted storage. Do not use this workspace on a shared machine with sensitive keys.
                  </WorkspaceNotice>
                </div>
                <SettingsRow
                  label="Ollama Cloud key status"
                  description="The full key value is never read back into Settings or copied into diagnostics."
                >
                  <StatusBadge tone={summary?.secrets.ollama_cloud_key?.configured ? 'success' : 'warning'}>
                    {summary?.secrets.ollama_cloud_key?.configured ? `Configured (${summary.secrets.ollama_cloud_key.masked})` : 'Not configured'}
                  </StatusBadge>
                </SettingsRow>
                <SettingsRow
                  label="Data location"
                  description="The database file containing all workspace data."
                >
                  <span className="settings-mono-value muted small">Shown in Diagnostics</span>
                </SettingsRow>
              </SettingsSection>
            )}

            {/* ── Shortcuts ────────────────────────────────────────────── */}
            {activeSection === 'shortcuts' && (
              <SettingsSection id="settings-shortcuts" title="Keyboard Shortcuts" description="Customize workspace and composer keyboard shortcuts.">
                <ShortcutsEditor onSaved={showMessage} />
              </SettingsSection>
            )}

            {/* ── Diagnostics ──────────────────────────────────────────── */}
            {activeSection === 'diagnostics' && (
              <SettingsSection id="settings-diagnostics" title="Diagnostics" description="Runtime facts safe to copy into a bug report. Secrets are never included.">
                <div className="settings-action-row">
                  <button
                    className="primary"
                    onClick={loadDiagnostics}
                    disabled={savingKey === 'diagnostics'}
                    data-testid="settings-load-diagnostics"
                  >
                    {savingKey === 'diagnostics' ? 'Building…' : 'Build diagnostics'}
                  </button>
                  <button
                    className="ghost"
                    onClick={() => copyText(diagnosticsText(), 'Diagnostics')}
                    disabled={!diagnostics}
                    data-testid="settings-copy-diagnostics"
                  >
                    Copy diagnostics
                  </button>
                </div>
                {diagnostics && (
                  <pre className="settings-diagnostics" data-testid="settings-diagnostics-report">{diagnosticsText()}</pre>
                )}
                {!diagnostics && (
                  <WorkspaceNotice title="No report yet" tone="info">
                    Click "Build diagnostics" to collect runtime state. The report includes app version, database counts, and provider availability — never secrets.
                  </WorkspaceNotice>
                )}
              </SettingsSection>
            )}

            {/* ── Advanced ─────────────────────────────────────────────── */}
            {activeSection === 'advanced' && (
              <SettingsSection id="settings-advanced" title="Advanced" description="Careful tools for layout and settings review.">
                <SettingsRow
                  label="Export settings summary"
                  description="Copies settings metadata and masked secret status only. Full key values are never included."
                >
                  <button
                    className="ghost"
                    onClick={() => copyText(exportText(), 'Settings summary')}
                    data-testid="settings-export"
                  >
                    Copy settings summary
                  </button>
                </SettingsRow>
                <SettingsRow
                  label="Reset current layout"
                  description="Closes all panels and returns the workspace to the default single-panel chat layout."
                >
                  <button
                    className="ghost"
                    onClick={props.onResetLayout}
                    disabled={!props.onResetLayout}
                    data-testid="settings-reset-layout"
                  >
                    Reset layout
                  </button>
                </SettingsRow>
                <SettingsRow
                  label="Import settings"
                  description="Loads setting values from an exported JSON file. Only known settings are applied; keys and other secrets are never imported."
                >
                  <button
                    className="ghost"
                    onClick={importSettings}
                    disabled={savingKey === 'settings-import'}
                    data-testid="settings-import"
                  >
                    {savingKey === 'settings-import' ? 'Importing…' : 'Import settings…'}
                  </button>
                </SettingsRow>
                <div className="settings-subpanel">
                  <h3>Setup</h3>
                  <SettingsRow
                    label="Show setup wizard on next launch"
                    description="Re-runs the first-launch tool detection wizard the next time the app starts."
                  >
                    <SettingsToggle
                      label="Show setup wizard on next launch"
                      testId="settings-show-setup-wizard"
                      checked={showWizardNextLaunch}
                      onChange={async (next) => {
                        try {
                          await window.api.setup.markComplete(!next)
                          setShowWizardNextLaunch(next)
                          showMessage(next ? 'Setup wizard will run on next launch' : 'Setup wizard stays hidden')
                        } catch (e: any) {
                          setError(String(e?.message ?? e))
                        }
                      }}
                    />
                  </SettingsRow>
                </div>
                <WorkspaceNotice title="Dangerous operations" tone="warning">
                  Layout resets close all open panels. Credential clears remove stored keys. These actions cannot be undone from within Settings.
                </WorkspaceNotice>
              </SettingsSection>
            )}

          </div>
        </main>
      </div>
    </div>
  )
}
