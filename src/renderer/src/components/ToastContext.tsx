import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import anime, { motionDurations, motionEasings, prefersReducedMotion, stopMotion, type MotionHandle } from '../motion'

interface Toast { id: number; text: string; removing: boolean }
interface ToastCtx { addToast: (text: string) => void }

export const ToastContext = createContext<ToastCtx>({ addToast: () => {} })
export function useToast() { return useContext(ToastContext) }

function ToastItem({ text, removing, onRemoved }: { text: string; removing: boolean; onRemoved: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const animRef = useRef<MotionHandle>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (prefersReducedMotion()) { el.style.opacity = '1'; return }
    stopMotion(animRef.current)
    animRef.current = anime(el, {
      translateX: [18, 0],
      translateY: [24, 0],
      scale: [0.96, 1],
      opacity: [0, 1],
      duration: motionDurations.normal,
      ease: motionEasings.cinematicOut,
    })
    return () => stopMotion(animRef.current)
  }, [])

  useEffect(() => {
    if (!removing) return
    const el = ref.current
    if (!el) return
    if (prefersReducedMotion()) { onRemoved(); return }
    stopMotion(animRef.current)
    animRef.current = anime(el, {
      translateX: [0, 12],
      translateY: [0, 8],
      scale: [1, 0.985],
      opacity: [1, 0],
      duration: motionDurations.fast,
      ease: 'outQuad',
      onComplete: onRemoved,
    })
    return () => stopMotion(animRef.current)
  }, [removing, onRemoved])

  return <div ref={ref} className="toast" style={{ opacity: 0 }}>{text}</div>
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, removing: true } : t))
  }, [])

  const addToast = useCallback((text: string) => {
    const id = ++idRef.current
    setToasts(prev => [...prev, { id, text, removing: false }])
    setTimeout(() => removeToast(id), 3000)
  }, [removeToast])

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <ToastItem
            key={t.id}
            text={t.text}
            removing={t.removing}
            onRemoved={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
          />
        ))}
      </div>
    </ToastContext.Provider>
  )
}
