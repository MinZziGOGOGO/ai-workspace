import { useEffect, useState } from 'react'
import { applyMotionPreference, prefersReducedMotion, type MotionMode } from '../motion'

function normalizeMotionMode(values: Record<string, string | null> | null): MotionMode {
  const mode = values?.ui_motion_mode
  if (mode === 'reduced' || mode === 'off') return mode
  if (values?.ui_reduced_motion === 'true') return 'reduced'
  return 'full'
}

export function useMotionPreference() {
  const [reduced, setReduced] = useState(() => prefersReducedMotion())

  useEffect(() => {
    let cancelled = false
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')

    function sync(userMode: MotionMode, osReduced: boolean) {
      if (cancelled) return
      const next = userMode === 'off' || userMode === 'reduced' || osReduced
      setReduced(next)
      applyMotionPreference(userMode, osReduced)
    }

    window.api.settings
      .getMany(['ui_motion_mode', 'ui_reduced_motion'])
      .then((values) => sync(normalizeMotionMode(values), media?.matches ?? prefersReducedMotion()))
      .catch(() => sync('full', media?.matches ?? prefersReducedMotion()))

    const onMediaChange = (event: MediaQueryListEvent) => {
      window.api.settings
        .getMany(['ui_motion_mode', 'ui_reduced_motion'])
        .then((values) => sync(normalizeMotionMode(values), event.matches))
        .catch(() => sync('full', event.matches))
    }

    media?.addEventListener('change', onMediaChange)
    return () => {
      cancelled = true
      media?.removeEventListener('change', onMediaChange)
    }
  }, [])

  return { reduced }
}
