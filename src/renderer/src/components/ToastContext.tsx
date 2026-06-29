import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

interface Toast { id: number; text: string }
interface ToastCtx { addToast: (text: string) => void }

export const ToastContext = createContext<ToastCtx>({ addToast: () => {} })
export function useToast() { return useContext(ToastContext) }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)

  const addToast = useCallback((text: string) => {
    const id = ++idRef.current
    setToasts(prev => [...prev, { id, text }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000)
  }, [])

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className="toast">{t.text}</div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
