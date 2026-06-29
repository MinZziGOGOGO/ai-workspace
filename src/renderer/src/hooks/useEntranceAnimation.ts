import { useCallback, useEffect, useRef } from 'react'
import { motionDurations, motionEasings, prefersReducedMotion } from '../motion'

export function useEntranceAnimation<T extends HTMLElement>(
  options: {
    y?: number
    x?: number
    scale?: number
    duration?: number
    delay?: number
  } = {}
) {
  const animationRef = useRef<Animation | null>(null)

  const ref = useCallback((node: T | null) => {
    animationRef.current?.cancel()
    animationRef.current = null
    if (!node || prefersReducedMotion() || document.documentElement.dataset.reducedMotion === 'true') return

    const y = options.y ?? 6
    const x = options.x ?? 0
    const scale = options.scale ?? 1
    animationRef.current = node.animate(
      [
        { opacity: 0, transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})` },
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
      ],
      {
        duration: options.duration ?? motionDurations.normal,
        delay: options.delay ?? 0,
        easing: motionEasings.calmOut,
        fill: 'both',
      }
    )
  }, [options.delay, options.duration, options.scale, options.x, options.y])

  useEffect(() => () => animationRef.current?.cancel(), [])

  return ref
}
