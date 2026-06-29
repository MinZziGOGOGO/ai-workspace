import { useEffect, useState } from 'react'
import { applyMotionPreference, prefersReducedMotion } from '../motion'

export function useMotionPreference() {
  const [reduced, setReduced] = useState(() => prefersReducedMotion())

  useEffect(() => {
    let cancelled = false
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')

    function sync(userReduced: boolean, osReduced: boolean) {
      if (cancelled) return
      const next = userReduced || osReduced
      setReduced(next)
      applyMotionPreference(userReduced, osReduced)
    }

    window.api.settings
      .get('ui_reduced_motion')
      .then((value) => sync(value === 'true', media?.matches ?? prefersReducedMotion()))
      .catch(() => sync(false, media?.matches ?? prefersReducedMotion()))

    const onMediaChange = (event: MediaQueryListEvent) => {
      window.api.settings
        .get('ui_reduced_motion')
        .then((value) => sync(value === 'true', event.matches))
        .catch(() => sync(false, event.matches))
    }

    media?.addEventListener('change', onMediaChange)
    return () => {
      cancelled = true
      media?.removeEventListener('change', onMediaChange)
    }
  }, [])

  return { reduced }
}
