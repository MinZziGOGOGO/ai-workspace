import { useEffect, useRef, useState } from 'react'
import anime, { cleanupMotion, type MotionHandle } from '../motion'
import type { Project, ToolDetection } from '../types'
import CloudSpeedNudge, { useSlowLocalNudge } from './CloudSpeedNudge'

// First-run setup wizard (full-screen modal). Detects the installed AI tools,
// explains what each one does, optionally creates a first project, and records
// completion in app_meta so it only shows once. All detection runs in the main
// process; this component only orchestrates the steps and animation.

const TOTAL_STEPS = 5

type ToolKey = keyof ToolDetection

interface ToolMeta {
  key: ToolKey
  label: string
  foundDetail: string
  missingDetail: string
  installCommand?: string
  installUrl?: string
}

const TOOLS: ToolMeta[] = [
  {
    key: 'claudeCode',
    label: 'Claude Code',
    foundDetail: 'AI code agent for your projects. Uses your Claude subscription CLI.',
    missingDetail: 'AI code agent for your projects. Install with:',
    installCommand: 'npm install -g @anthropic-ai/claude-code'
  },
  {
    key: 'codex',
    label: 'Codex',
    foundDetail: "OpenAI's code generation. Uses your ChatGPT subscription CLI.",
    missingDetail: "OpenAI's code generation. Install with:",
    installCommand: 'npm install -g @openai/codex'
  },
  {
    key: 'ollama',
    label: 'Ollama',
    foundDetail: 'Run local AI models. Available at http://localhost:11434',
    missingDetail: 'Run local AI models. Install from:',
    installUrl: 'https://ollama.com/download'
  },
  {
    key: 'hermes',
    label: 'Hermes',
    foundDetail: 'Your autonomous agent framework.',
    missingDetail: 'Your autonomous agent framework. Install from:',
    installUrl: 'https://github.com/NousResearch/hermes-agent'
  },
  {
    key: 'kimi',
    label: 'Kimi',
    foundDetail: "Moonshot AI's coding agent (Kimi Code CLI).",
    missingDetail: 'Install with npm, or the official script (PowerShell: irm https://code.kimi.com/kimi-code/install.ps1 | iex), then see:',
    installCommand: 'npm install -g @moonshot-ai/kimi-code',
    installUrl: 'https://moonshotai.github.io/kimi-code/en/guides/getting-started.html'
  }
]

const EMPTY_DETECTION: ToolDetection = {
  claudeCode: { installed: false },
  codex: { installed: false },
  kimi: { installed: false },
  ollama: { installed: false },
  hermes: { installed: false }
}

// Checklist row on the detection step: pending ○ → found ✓ / missing ✗,
// fading in when its result is revealed.
function ChecklistItem(props: { meta: ToolMeta; status: 'pending' | 'found' | 'notfound'; version?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const animRef = useRef<MotionHandle>(null)
  useEffect(() => {
    if (props.status === 'pending' || !ref.current) return
    animRef.current = anime(ref.current, { opacity: [0, 1], translateX: [-8, 0], duration: 240, ease: 'outQuad' })
    return () => cleanupMotion(animRef.current)
  }, [props.status])

  const icon = props.status === 'found' ? '✓' : props.status === 'notfound' ? '✗' : '○'
  const detail =
    props.status === 'found'
      ? `(${props.version ?? 'installed'})`
      : props.status === 'notfound'
        ? '(not found)'
        : '(checking...)'
  return (
    <div ref={ref} className="setup-wizard-checklist-item" data-testid={`setup-tool-${props.meta.key}`}>
      <span className={`setup-wizard-checklist-icon ${props.status}`} aria-hidden>{icon}</span>
      <span>{props.meta.label}</span>
      <span className="setup-wizard-tool-version">{detail}</span>
    </div>
  )
}

export default function SetupWizard(props: { onComplete: () => void }) {
  const [step, setStep] = useState(1)
  const [detection, setDetection] = useState<ToolDetection | null>(null)
  const [revealed, setRevealed] = useState(0)
  const [projectChoice, setProjectChoice] = useState<'skip' | 'create'>('skip')
  const [createdProject, setCreatedProject] = useState<Project | null>(null)
  const [projectError, setProjectError] = useState('')
  const [copied, setCopied] = useState('')
  const [dontShowAgain, setDontShowAgain] = useState(true)

  const cardRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const directionRef = useRef<'next' | 'back'>('next')
  const cardAnimRef = useRef<MotionHandle>(null)
  const stepAnimRef = useRef<MotionHandle>(null)
  const revealTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  // Card entrance on first load.
  useEffect(() => {
    if (!cardRef.current) return
    cardAnimRef.current = anime(cardRef.current, {
      opacity: [0, 1],
      translateY: [14, 0],
      duration: 300,
      ease: 'outQuad'
    })
    return () => {
      cleanupMotion(cardAnimRef.current)
      for (const t of revealTimersRef.current) clearTimeout(t)
    }
  }, [])

  // Slide between steps: left for next, right for back.
  useEffect(() => {
    if (!contentRef.current) return
    const from = directionRef.current === 'next' ? 24 : -24
    stepAnimRef.current = anime(contentRef.current, {
      opacity: [0, 1],
      translateX: [from, 0],
      duration: 260,
      ease: 'outQuad'
    })
    return () => cleanupMotion(stepAnimRef.current)
  }, [step])

  // Run detection when the detection step is first shown. The main process
  // caps each probe at 2s; this adds a 5s overall ceiling so Next always
  // becomes available even if something wedges.
  const detectStartedRef = useRef(false)
  useEffect(() => {
    if (step !== 2 || detectStartedRef.current) return
    detectStartedRef.current = true
    const timeout = new Promise<ToolDetection>((resolve) =>
      setTimeout(() => resolve(EMPTY_DETECTION), 5000)
    )
    void Promise.race([window.api.setup.detectTools().catch(() => EMPTY_DETECTION), timeout]).then(
      setDetection
    )
  }, [step])

  // Reveal results one at a time so the checklist reads as it fills in.
  useEffect(() => {
    if (!detection) return
    TOOLS.forEach((_tool, i) => {
      revealTimersRef.current.push(setTimeout(() => setRevealed(i + 1), 180 * (i + 1)))
    })
  }, [detection])

  function goNext() {
    directionRef.current = 'next'
    setStep((s) => Math.min(TOTAL_STEPS, s + 1))
  }

  function goBack() {
    directionRef.current = 'back'
    setStep((s) => Math.max(1, s - 1))
  }

  async function copyInstallCommand(meta: ToolMeta) {
    if (!meta.installCommand) return
    try {
      await navigator.clipboard.writeText(meta.installCommand)
      setCopied(meta.key)
      setTimeout(() => setCopied(''), 2000)
    } catch {
      /* clipboard unavailable — command is visible as text anyway */
    }
  }

  async function pickProjectFolder() {
    setProjectError('')
    try {
      const project = await window.api.projects.import()
      if (project) setCreatedProject(project)
    } catch (e: any) {
      setProjectError(String(e?.message ?? e))
    }
  }

  async function finish() {
    try {
      await window.api.setup.markComplete(dontShowAgain)
    } catch {
      /* non-fatal: worst case the wizard shows again next launch */
    }
    props.onComplete()
  }

  const detectionDone = detection !== null && revealed >= TOOLS.length

  // Ollama being installed is only half the story: on a CPU-only box it works
  // but takes minutes per reply. Probe for that once detection has actually
  // found Ollama, and only on the results step where we have room to explain.
  const speedNudge = useSlowLocalNudge(step === 3 && detection?.ollama.installed === true)

  function toolStatus(key: ToolKey): 'pending' | 'found' | 'notfound' {
    const index = TOOLS.findIndex((t) => t.key === key)
    if (!detection || revealed <= index) return 'pending'
    return detection[key].installed ? 'found' : 'notfound'
  }

  return (
    <div className="setup-wizard" data-testid="setup-wizard">
      <div className="setup-wizard-card" ref={cardRef}>
        <div className="setup-wizard-progress" aria-label={`Step ${step} of ${TOTAL_STEPS}`}>
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <span
              key={i}
              className={`setup-wizard-progress-dot ${i + 1 === step ? 'active' : ''} ${i + 1 < step ? 'completed' : ''}`}
            />
          ))}
          <span className="setup-wizard-progress-label">Step {step}/{TOTAL_STEPS}</span>
        </div>

        <div ref={contentRef} data-testid={`setup-wizard-step-${step}`}>
          {step === 1 && (
            <>
              <div className="setup-wizard-icon" aria-hidden>✳</div>
              <h1 className="setup-wizard-heading">Welcome to AI Workspace</h1>
              <p className="setup-wizard-description">
                Let&apos;s set up your AI toolkit. The following steps will detect what you have
                installed and get you ready to work with Claude Code, Hermes, Codex, Kimi, and local models.
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <div className="setup-wizard-icon" aria-hidden>⌕</div>
              <h1 className="setup-wizard-heading">
                {detectionDone ? 'Detection complete' : 'Detecting installed tools...'}
              </h1>
              <div className="setup-wizard-checklist">
                {TOOLS.map((meta) => (
                  <ChecklistItem
                    key={meta.key}
                    meta={meta}
                    status={toolStatus(meta.key)}
                    version={detection?.[meta.key].version}
                  />
                ))}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="setup-wizard-icon" aria-hidden>☰</div>
              <h1 className="setup-wizard-heading">Here&apos;s what we found</h1>
              {speedNudge.show && (
                <CloudSpeedNudge
                  probe={speedNudge.probe}
                  testId="setup-cloud-nudge"
                  onDismiss={speedNudge.dismiss}
                  onConfigured={speedNudge.markConfigured}
                />
              )}
              {TOOLS.map((meta) => {
                const status = detection?.[meta.key] ?? { installed: false }
                return (
                  <div key={meta.key} className="setup-wizard-tool-result" data-testid={`setup-result-${meta.key}`}>
                    <div className="setup-wizard-checklist-item">
                      <span className={`setup-wizard-checklist-icon ${status.installed ? 'found' : 'notfound'}`} aria-hidden>
                        {status.installed ? '✓' : '✗'}
                      </span>
                      <span>{meta.label}</span>
                      {status.installed && status.version && (
                        <span className="setup-wizard-tool-version">{status.version}</span>
                      )}
                    </div>
                    <p className="setup-wizard-description small">
                      {status.installed ? meta.foundDetail : meta.missingDetail}
                      {!status.installed && meta.installCommand && <code> {meta.installCommand}</code>}
                      {!status.installed && meta.installUrl && <code> {meta.installUrl}</code>}
                    </p>
                    {!status.installed && meta.installCommand && (
                      <button className="setup-wizard-tool-cta" onClick={() => copyInstallCommand(meta)}>
                        {copied === meta.key ? 'Copied!' : 'Copy install command'}
                      </button>
                    )}
                    {!status.installed && meta.installUrl && (
                      <button
                        className="setup-wizard-tool-cta"
                        onClick={() => window.api.shell.openExternal(meta.installUrl!)}
                      >
                        Open link
                      </button>
                    )}
                  </div>
                )
              })}
            </>
          )}

          {step === 4 && (
            <>
              <div className="setup-wizard-icon" aria-hidden>▣</div>
              <h1 className="setup-wizard-heading">Ready to create your first project?</h1>
              <p className="setup-wizard-description">
                A project is a folder where your code lives. All AI agents work within projects.
              </p>
              <label className="setup-wizard-option">
                <input
                  type="radio"
                  name="setup-project-choice"
                  checked={projectChoice === 'skip'}
                  onChange={() => setProjectChoice('skip')}
                  data-testid="setup-wizard-skip-project"
                />
                <span>Skip — I&apos;ll create a project later</span>
              </label>
              <label className="setup-wizard-option">
                <input
                  type="radio"
                  name="setup-project-choice"
                  checked={projectChoice === 'create'}
                  onChange={() => setProjectChoice('create')}
                  data-testid="setup-wizard-create-project"
                />
                <span>Create one now</span>
              </label>
              {projectChoice === 'create' && (
                <div className="setup-wizard-project-picker">
                  {createdProject ? (
                    <p className="setup-wizard-description small">
                      Project ready: <strong>{createdProject.name}</strong> ({createdProject.path})
                    </p>
                  ) : (
                    <button className="setup-wizard-btn" onClick={pickProjectFolder} data-testid="setup-wizard-pick-folder">
                      Choose folder…
                    </button>
                  )}
                  {projectError && <p className="setup-wizard-error">{projectError}</p>}
                </div>
              )}
            </>
          )}

          {step === 5 && (
            <>
              <div className="setup-wizard-icon" aria-hidden>✓</div>
              <h1 className="setup-wizard-heading">All set!</h1>
              <p className="setup-wizard-description">
                You&apos;re ready to start. Go to Settings anytime to configure Claude Code, Hermes,
                Codex, or Kimi further.
              </p>
              <label className="setup-wizard-option">
                <input
                  type="checkbox"
                  checked={dontShowAgain}
                  onChange={(e) => setDontShowAgain(e.target.checked)}
                  data-testid="setup-wizard-dont-show"
                />
                <span>Don&apos;t show this again</span>
              </label>
            </>
          )}
        </div>

        <div className="setup-wizard-actions">
          {step > 1 && step < TOTAL_STEPS ? (
            <button className="setup-wizard-btn" onClick={goBack} data-testid="setup-wizard-back">
              Back
            </button>
          ) : (
            <span />
          )}
          {step === 1 && (
            <button className="setup-wizard-btn primary" onClick={goNext} data-testid="setup-wizard-get-started">
              Get started
            </button>
          )}
          {step === 2 && (
            <button
              className="setup-wizard-btn primary"
              onClick={goNext}
              disabled={!detectionDone}
              data-testid="setup-wizard-next"
            >
              Next
            </button>
          )}
          {(step === 3 || step === 4) && (
            <button className="setup-wizard-btn primary" onClick={goNext} data-testid="setup-wizard-next">
              Next
            </button>
          )}
          {step === TOTAL_STEPS && (
            <button className="setup-wizard-btn primary" onClick={finish} data-testid="setup-wizard-start-working">
              Start working
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
