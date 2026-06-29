import { useEffect, useRef, useState } from 'react'

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error?: string; message?: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionEventLike = {
  results: {
    length: number
    [index: number]: {
      isFinal: boolean
      length: number
      [index: number]: { transcript: string }
    }
  }
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
}

function appendText(base: string, addition: string): string {
  const text = addition.trim()
  if (!text) return base
  const prefix = base.trimEnd()
  return prefix ? `${prefix} ${text}` : text
}

export default function VoiceInputButton(props: {
  testId: string
  value: string
  onChange(value: string): void
  disabled?: boolean
  label?: string
}) {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const baseTextRef = useRef('')
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setSupported(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition))
    return () => {
      recognitionRef.current?.abort()
      recognitionRef.current = null
    }
  }, [])

  function stop() {
    recognitionRef.current?.stop()
    setListening(false)
  }

  function start() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition || props.disabled) return
    setError('')
    baseTextRef.current = props.value

    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-US'
    recognition.onresult = (event) => {
      let finalText = ''
      let interimText = ''
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i]
        const transcript = Array.from({ length: result.length }, (_, j) => result[j]?.transcript ?? '').join(' ')
        if (result.isFinal) finalText += ` ${transcript}`
        else interimText += ` ${transcript}`
      }
      props.onChange(appendText(baseTextRef.current, `${finalText} ${interimText}`))
    }
    recognition.onerror = (event) => {
      setError(event.message || event.error || 'Voice input failed.')
      setListening(false)
    }
    recognition.onend = () => setListening(false)
    recognitionRef.current = recognition
    setListening(true)
    try {
      recognition.start()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Voice input failed.')
      setListening(false)
    }
  }

  const unavailable = !supported || props.disabled
  const title = !supported
    ? 'Voice input unavailable.'
    : error || (listening ? 'Stop voice input' : 'Start voice input')

  return (
    <button
      type="button"
      className={`voice-input-btn ${listening ? 'listening' : ''}`}
      data-testid={props.testId}
      aria-label={props.label ?? 'Voice input'}
      aria-pressed={listening}
      disabled={unavailable}
      title={title}
      onClick={listening ? stop : start}
    >
      {listening ? 'Listening' : 'Mic'}
    </button>
  )
}
