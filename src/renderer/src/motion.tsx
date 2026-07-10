import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { animate, createTimeline, spring, stagger, type JSAnimation, type Timeline, type WAAPIAnimation } from 'animejs'

export const motionDurations = {
  instant: 100,
  micro: 140,
  fast: 180,
  normal: 300,
  panel: 460,
  slow: 640,
  cinematic: 780,
} as const

export const motionEasings = {
  calmOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  crispInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  cinematicOut: 'cubic-bezier(0.19, 1, 0.22, 1)',
  softIn: 'cubic-bezier(0.5, 0, 0.9, 0.7)',
} as const

export const motionStagger = {
  tight: 28,
  normal: 42,
  loose: 58,
} as const

export const motionSprings = {
  press: spring({ mass: 1, stiffness: 180, damping: 18, velocity: 0 }),
  settle: spring({ mass: 1, stiffness: 92, damping: 14, velocity: 0 }),
  soft: spring({ mass: 1.1, stiffness: 66, damping: 16, velocity: 0 }),
} as const

type AnimeParams = Record<string, unknown>
type MotionTarget = Parameters<typeof animate>[0]
export type MotionHandle = JSAnimation | Timeline | WAAPIAnimation | null
export type MotionMode = 'full' | 'reduced' | 'off'

function isMotionMode(value: unknown): value is MotionMode {
  return value === 'full' || value === 'reduced' || value === 'off'
}

export function currentMotionMode(): MotionMode {
  if (typeof document === 'undefined') return 'full'
  const mode = document.documentElement.dataset.motion
  return isMotionMode(mode) ? mode : 'full'
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  const mode = currentMotionMode()
  return (
    mode === 'reduced' ||
    mode === 'off' ||
    document.documentElement.dataset.reducedMotion === 'true' ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  )
}

export function applyMotionPreference(preference: MotionMode | boolean, osReduced?: boolean): void {
  if (typeof document === 'undefined') return
  const userMode: MotionMode = typeof preference === 'boolean'
    ? (preference ? 'reduced' : 'full')
    : preference
  const systemReduced = osReduced ?? window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  const effectiveMode: MotionMode = userMode === 'off'
    ? 'off'
    : (userMode === 'reduced' || systemReduced ? 'reduced' : 'full')
  document.documentElement.dataset.motionPreference = userMode
  document.documentElement.dataset.reducedMotion = effectiveMode === 'full' ? 'false' : 'true'
  document.documentElement.dataset.motion = effectiveMode
}

export function stopMotion(anim: MotionHandle | undefined) {
  anim?.pause()
}

export function cleanupMotion(anim: MotionHandle | undefined) {
  if (!anim) return
  if ('revert' in anim && typeof anim.revert === 'function') {
    anim.revert()
    return
  }
  if ('cancel' in anim && typeof anim.cancel === 'function') {
    anim.cancel()
    return
  }
  anim.pause()
}

export default function anime(targets: MotionTarget, params: AnimeParams): MotionHandle {
  if (prefersReducedMotion()) return null
  return animate(targets, params as Parameters<typeof animate>[1])
}

export const springBack = motionSprings.settle

/* Panel open: soft rise + fade (opacity 0→1, scale 0.98→1, y 4→0, 200ms). */
export function revealPanel(el: HTMLElement | null): MotionHandle {
  if (!el || prefersReducedMotion()) return null
  return anime(el, {
    opacity: [0, 1],
    translateY: [4, 0],
    scale: [0.98, 1],
    duration: 200,
    ease: motionEasings.cinematicOut,
  })
}

/* Panel close: quick reverse of revealPanel (120ms). Resolves when done so the
   caller can commit the layout change; null when reduced motion applies. */
export function concealPanel(el: HTMLElement | null): Promise<void> | null {
  if (!el || prefersReducedMotion()) return null
  const anim = anime(el, {
    opacity: [1, 0],
    translateY: [0, 4],
    scale: [1, 0.98],
    duration: 120,
    ease: motionEasings.crispInOut,
  })
  if (!anim) return null
  return anim.then(() => undefined)
}

export function runWorkspaceStartup(root: HTMLElement | null): MotionHandle {
  if (!root || prefersReducedMotion()) {
    if (root) root.style.opacity = '1'
    return null
  }
  const topbar = root.querySelector('.topbar')
  const surface = root.querySelector('.workspace-surface')
  const panels = root.querySelectorAll('.workspace-panel-wrap')
  const groups = root.querySelectorAll('.topbar-group, .topbar-right > *')
  const tl = createTimeline({ defaults: { ease: motionEasings.cinematicOut } })
  tl.add(root, {
    opacity: [0, 1],
    duration: 360,
  })
  if (surface) {
    tl.add(surface, {
      opacity: [0, 1],
      duration: motionDurations.slow,
    }, 0)
  }
  if (topbar) {
    tl.add(topbar, {
      opacity: [0, 1],
      translateY: [-12, 0],
      duration: motionDurations.panel,
    }, 70)
  }
  if (groups.length > 0) {
    tl.add(groups, {
      opacity: [0, 1],
      translateY: [-5, 0],
      duration: motionDurations.normal,
      delay: stagger(motionStagger.tight),
    }, 180)
  }
  if (panels.length > 0) {
    tl.add(panels, {
      opacity: [0, 1],
      translateY: [16, 0],
      scale: [0.985, 1],
      duration: motionDurations.slow,
      delay: stagger(motionStagger.normal),
    }, 170)
  }
  return tl
}

export function cascadeItems(targets: Element[] | NodeListOf<Element>, options: { y?: number; duration?: number; delay?: number } = {}): MotionHandle {
  if (prefersReducedMotion()) return null
  return anime(targets as unknown as MotionTarget, {
    opacity: [0, 1],
    translateY: [options.y ?? 8, 0],
    duration: options.duration ?? motionDurations.normal,
    delay: stagger(options.delay ?? motionStagger.tight),
    ease: motionEasings.cinematicOut,
  })
}

export function useEntranceMotion<T extends HTMLElement>(
  variant: 'panel' | 'dropdown' | 'user-message' | 'assistant-message' | 'toast' = 'panel',
  deps: unknown[] = [],
) {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || prefersReducedMotion()) return

    const paramsByVariant: Record<typeof variant, AnimeParams> = {
      panel: { opacity: [0, 1], translateY: [10, 0], scale: [0.985, 1], duration: motionDurations.panel, ease: motionEasings.cinematicOut },
      dropdown: { opacity: [0, 1], translateY: [-6, 0], scale: [0.96, 1], duration: motionDurations.fast, ease: motionEasings.cinematicOut },
      'user-message': { opacity: [0, 1], translateX: [14, 0], translateY: [8, 0], scale: [0.975, 1], duration: motionDurations.normal, ease: motionEasings.cinematicOut },
      'assistant-message': { opacity: [0, 1], translateX: [-12, 0], translateY: [10, 0], scale: [0.985, 1], duration: motionDurations.panel, ease: motionEasings.cinematicOut },
      toast: { opacity: [0, 1], translateY: [22, 0], scale: [0.96, 1], duration: motionDurations.normal, ease: springBack },
    }

    const anim = anime(el, paramsByVariant[variant])
    return () => stopMotion(anim)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return ref
}

export function usePressMotion<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const animRef = useRef<MotionHandle>(null)

  useEffect(() => () => stopMotion(animRef.current), [])

  const pressHandlers = {
    onPointerDown: () => {
      const el = ref.current
      if (!el || prefersReducedMotion()) return
      stopMotion(animRef.current)
      animRef.current = anime(el, { scale: 0.965, duration: motionDurations.instant, ease: 'outQuad' })
    },
    onPointerUp: () => {
      const el = ref.current
      if (!el || prefersReducedMotion()) return
      stopMotion(animRef.current)
      animRef.current = anime(el, { scale: 1, duration: motionDurations.micro, ease: motionSprings.press })
    },
    onPointerLeave: () => {
      const el = ref.current
      if (!el || prefersReducedMotion()) return
      stopMotion(animRef.current)
      animRef.current = anime(el, { scale: 1, duration: motionDurations.micro, ease: motionSprings.press })
    },
    onPointerCancel: () => {
      const el = ref.current
      if (!el || prefersReducedMotion()) return
      stopMotion(animRef.current)
      animRef.current = anime(el, { scale: 1, duration: motionDurations.micro, ease: motionSprings.press })
    },
  }

  return { ref, pressHandlers }
}

// Neutral background pulse — a brief tint that fades out. No accent, no glow.
export function pulseElement(el: HTMLElement | null, color = 'rgba(128, 120, 108, 0.22)'): MotionHandle {
  if (!el || prefersReducedMotion()) return null
  return anime(el, {
    backgroundColor: [color, 'rgba(128, 120, 108, 0)'],
    duration: motionDurations.slow,
    ease: motionEasings.cinematicOut,
  })
}

export function pressElement(event: ReactPointerEvent<HTMLElement>, store?: MotionHandle[]) {
  if (prefersReducedMotion()) return
  const el = event.currentTarget
  const remember = (anim: MotionHandle) => {
    if (!anim || !store) return
    store.push(anim)
    while (store.length > 24) cleanupMotion(store.shift())
  }
  const down = anime(el, { scale: 0.98, duration: motionDurations.instant, ease: 'outQuad' })
  const up = window.setTimeout(() => {
    const back = anime(el, { scale: 1, duration: motionDurations.micro, ease: motionSprings.press })
    remember(back)
  }, 85)
  remember(down)
  window.setTimeout(() => window.clearTimeout(up), 160)
}

export function animateScrollToBottom(el: HTMLElement, immediate = false): MotionHandle {
  const top = Math.max(0, el.scrollHeight - el.clientHeight)
  if (immediate || prefersReducedMotion()) {
    el.scrollTop = top
    return null
  }

  const state = { top: el.scrollTop }
  return anime(state as unknown as MotionTarget, {
    top,
    duration: motionDurations.normal,
    ease: motionEasings.cinematicOut,
    onUpdate: () => {
      el.scrollTop = state.top
    },
  })
}

export function collapseElement(el: HTMLElement): Promise<void> {
  if (prefersReducedMotion()) return Promise.resolve()
  const height = el.scrollHeight
  el.style.maxHeight = `${height}px`
  el.style.overflow = 'hidden'
  const anim = anime(el, {
    opacity: [1, 0],
    maxHeight: [`${height}px`, '0px'],
    duration: motionDurations.fast,
    ease: 'outQuad',
  })
  if (!anim) return Promise.resolve()
  return anim.then(() => undefined)
}

export function AnimatedScaleBar({
  value,
  className,
  unknown = false,
}: {
  value: number
  className: string
  unknown?: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const animRef = useRef<MotionHandle>(null)
  const scaleRef = useRef(Math.max(0, Math.min(1, value)))
  const scale = Math.max(0, Math.min(1, value))
  const style: CSSProperties = {
    width: '100%',
    transform: `scaleX(${scaleRef.current})`,
    transformOrigin: 'left center',
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    stopMotion(animRef.current)
    if (prefersReducedMotion()) {
      el.style.transform = `scaleX(${scale})`
      scaleRef.current = scale
      return
    }
    animRef.current = anime(el, { scaleX: scale, duration: motionDurations.normal, ease: motionSprings.soft })
    scaleRef.current = scale
    return () => stopMotion(animRef.current)
  }, [scale])

  return <div ref={ref} className={`${className}${unknown ? ' unknown' : ''}`} style={style} />
}

export function BreathingDot() {
  const ref = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || prefersReducedMotion()) return
    const anim = anime(el, {
      scale: [1, 1.3, 1],
      opacity: [0.72, 1, 0.72],
      duration: 1500,
      ease: 'inOutSine',
      loop: true,
    })
    return () => stopMotion(anim)
  }, [])

  return <span ref={ref} className="breathing-dot" aria-hidden />
}
