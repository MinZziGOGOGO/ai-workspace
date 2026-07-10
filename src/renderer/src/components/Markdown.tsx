import { useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import anime, { stopMotion, prefersReducedMotion, type MotionHandle } from '../motion'

// Shared rich-text renderer for assistant/agent messages across all three tabs
// (Chat, Hermes, Claude Code). Renders GFM markdown — headings, emphasis, lists,
// tables, blockquotes, inline code — and turns fenced code blocks into a
// CodeBlock with a language label + copy button. Backend untouched: this only
// reformats the message string that already flows through the tabs.

// A fenced code block: header bar (language + copy) over a syntax-highlighted body.
function CodeBlock(props: { language: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const lang = props.language || 'text'

  const codeAnimRef = useRef<MotionHandle>(null)
  useEffect(() => {
    const el = wrapRef.current
    if (!el || prefersReducedMotion()) return
    codeAnimRef.current = anime(el, { translateY: [8, 0], duration: 200, ease: 'outExpo' })
    return () => stopMotion(codeAnimRef.current)
  }, [])

  useEffect(() => {
    const wrap = wrapRef.current
    const btn = btnRef.current
    if (!wrap || !btn) return

    // Sticky copy button while the block's top edge sits above the 40px
    // header line but the block is still on screen. A fine threshold array
    // makes the observer fire continuously as the block scrolls past that
    // line — no per-block scroll listeners on the chat scroller (those
    // accumulate one handler per code block in long sessions).
    const thresholds = Array.from({ length: 21 }, (_, i) => i / 20)
    const observer = new IntersectionObserver((entries) => {
      const rect = entries[entries.length - 1].boundingClientRect
      if (rect.top < 40 && rect.bottom > 40) {
        btn.classList.add('sticky-copy')
      } else {
        btn.classList.remove('sticky-copy')
      }
    }, { rootMargin: '-40px 0px 0px 0px', threshold: thresholds })
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable — silently no-op */
    }
  }

  return (
    <div className="code-block code-block-wrap" ref={wrapRef}>
      <div className="code-block-head">
        <span className="code-block-lang">{lang}</span>
        <button
          ref={btnRef}
          className="code-copy"
          onClick={copy}
          title="Copy code to clipboard"
          aria-label="Copy code"
        >
          {copied ? '✓ Copied!' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={lang}
        style={oneDark}
        PreTag="div"
        customStyle={{
          margin: 0,
          padding: '10px 12px',
          background: 'transparent',
          fontSize: '12px',
          lineHeight: 1.6
        }}
        codeTagProps={{ style: { fontFamily: 'var(--font-mono)', fontSize: '12px' } }}
      >
        {props.value}
      </SyntaxHighlighter>
    </div>
  )
}

const PROMPT_TITLE_RE = /^\s*(?:#{1,3}\s*)?(?:Claude Code Prompt|Codex Prompt):[^\n]+/i
const SINGLE_FENCE_RE = /^\s*```([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)\n```\s*$/

function promptMarkdownSource(source: string): { markdown: string; copyText: string } | null {
  if (PROMPT_TITLE_RE.test(source)) return { markdown: source, copyText: source }

  const singleFence = source.match(SINGLE_FENCE_RE)
  if (!singleFence) return null

  const language = singleFence[1].toLowerCase()
  const body = singleFence[2]
  if (!['', 'text', 'txt', 'markdown', 'md'].includes(language)) return null
  if (!PROMPT_TITLE_RE.test(body)) return null

  return { markdown: body, copyText: body }
}

function PromptOutputCard(props: { markdown: string; copyText: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.copyText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable - silently no-op */
    }
  }

  return (
    <div className="prompt-output-card" data-testid="prompt-output-card">
      <div className="prompt-output-head">
        <span className="prompt-output-label">Prompt</span>
        <button
          className="prompt-output-copy"
          data-testid="copy-full-prompt"
          onClick={copy}
          title="Copy the full prompt"
          aria-label="Copy full prompt"
        >
          {copied ? 'Copied' : 'Copy full prompt'}
        </button>
      </div>
      <div className="prompt-output-body">
        <MarkdownBody>{props.markdown}</MarkdownBody>
      </div>
    </div>
  )
}

const components: Components = {
  code({ node, className, children, ...rest }) {
    const match = /language-(\w+)/.exec(className || '')
    // react-markdown v10 dropped the `inline` flag; treat a node as a block when
    // it carries a language class, spans multiple source lines, or contains a
    // newline. Everything else is inline code.
    const multiline =
      (node?.position && node.position.start.line !== node.position.end.line) ||
      String(children).includes('\n')
    if (match || multiline) {
      return <CodeBlock language={match?.[1] ?? ''} value={String(children).replace(/\n$/, '')} />
    }
    return (
      <code className="md-inline-code" {...rest}>
        {children}
      </code>
    )
  },
  // The CodeBlock owns its own container; passthrough avoids an invalid <pre><div>.
  pre({ children }) {
    return <>{children}</>
  },
  // External links open in the user's browser, not inside the Electron window.
  a({ children, href, ...rest }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
        {children}
      </a>
    )
  }
}

function MarkdownBody(props: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {props.children}
      </ReactMarkdown>
    </div>
  )
}

export default function Markdown(props: { children: string }) {
  const prompt = promptMarkdownSource(props.children)
  if (prompt) {
    return <PromptOutputCard markdown={prompt.markdown} copyText={prompt.copyText} />
  }

  return (
    <MarkdownBody>{props.children}</MarkdownBody>
  )
}
