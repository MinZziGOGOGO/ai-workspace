import type { ReactNode } from 'react'
import { useEntranceAnimation } from '../hooks/useEntranceAnimation'

export function MotionPresence({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  const ref = useEntranceAnimation<HTMLDivElement>()
  return (
    <div ref={ref} className={`motion-presence${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}
