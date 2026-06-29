export const motionDurations = {
  instant: 100,
  fast: 150,
  normal: 220,
  slow: 320,
} as const

export const motionEasings = {
  calmOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  crispInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const

export const motionStagger = {
  tight: 24,
  normal: 34,
  loose: 44,
} as const

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function applyMotionPreference(userReduced: boolean, osReduced = prefersReducedMotion()): void {
  if (typeof document === 'undefined') return
  const reduced = userReduced || osReduced
  document.documentElement.dataset.reducedMotion = reduced ? 'true' : 'false'
  document.documentElement.dataset.motion = reduced ? 'reduced' : 'full'
}
