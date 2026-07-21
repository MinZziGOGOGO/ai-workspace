// Shared syntax highlighter.
//
// `import { Prism } from 'react-syntax-highlighter'` pulls in refractor's entire
// language catalogue — ~200 grammars — and Markdown.tsx sits on the initial
// render path, so every launch paid for grammars like ABAP and Wolfram that this
// app can never ask for. PrismLight ships the core and nothing else, so the set
// below is the app's whole highlighting vocabulary, registered explicitly.
//
// The list is not a guess: it is the union of EditorPanel's LANGUAGE_BY_EXT map
// (the only languages a file can resolve to) and the fence tags that realistically
// show up in agent output. Anything unregistered still renders — Prism just shows
// it unhighlighted rather than failing — so an exotic fence degrades to plain
// text instead of breaking the message.
//
// Grammar dependencies are explicit here too: refractor grammars do not pull
// their own prerequisites in, so e.g. tsx needs jsx + typescript registered
// first, and registration order below matters.

import { PrismLight } from 'react-syntax-highlighter'

import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin'
import lua from 'react-syntax-highlighter/dist/esm/languages/prism/lua'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'

// Base grammars first: the derived ones below reference them by name at
// registration time.
const base: Record<string, any> = {
  bash, c, css, diff, docker, go, ini, java, javascript, json,
  kotlin, lua, markdown, markup, powershell, python, ruby, rust, sql, yaml,
}
for (const [name, syntax] of Object.entries(base)) PrismLight.registerLanguage(name, syntax)

// Derived grammars, registered after their prerequisites.
PrismLight.registerLanguage('cpp', cpp)          // extends c
PrismLight.registerLanguage('csharp', csharp)
PrismLight.registerLanguage('jsx', jsx)          // extends javascript
PrismLight.registerLanguage('typescript', typescript)
PrismLight.registerLanguage('tsx', tsx)          // extends jsx + typescript

// Aliases: the same grammar under the tags people actually type in a fence.
// EditorPanel maps extensions to canonical names itself, but agent output does
// not — ```sh and ```yml are as common as the canonical spellings.
const aliases: Record<string, any> = {
  html: markup, xml: markup, svg: markup,
  js: javascript, mjs: javascript, cjs: javascript,
  ts: typescript,
  py: python, python3: python,
  sh: bash, shell: bash, zsh: bash, console: bash,
  yml: yaml,
  rb: ruby, rs: rust, kt: kotlin,
  'c++': cpp, cs: csharp,
  ps1: powershell, dockerfile: docker,
  md: markdown, patch: diff,
}
for (const [name, syntax] of Object.entries(aliases)) PrismLight.registerLanguage(name, syntax)

export { PrismLight as SyntaxHighlighter }
export { default as oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark'
export { default as oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism/one-light'
