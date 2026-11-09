// Test harness: renders the real Terminals page (terminals-view.tsx) under jsdom with React.
//
// Imports load-store.mjs first (jsdom globals, FakeWebSocket), adds what react-dom needs, then bundles
// the view with esbuild into memory. The bundle carries its own React and its own copy of the store, so
// `loadView()` returns both the page and the store API it renders from.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { window } from './load-store.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const client = join(here, '..', '..', 'src', 'client')

globalThis.IS_REACT_ACT_ENVIRONMENT = false
window.Element.prototype.setPointerCapture = () => {}
window.Element.prototype.attachEvent = () => {}
window.Element.prototype.detachEvent = () => {}
window.document.oninput = null
for (const k of ['HTMLIFrameElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true })
}
// jsdom has no layout: give elements a size so the terminal windows fit.
Object.defineProperty(window.Element.prototype, 'clientWidth', { get() { return 600 }, configurable: true })
Object.defineProperty(window.Element.prototype, 'clientHeight', { get() { return 300 }, configurable: true })

const ENTRY = `
import * as React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
export * from './terminal-store.ts'
export { TerminalsView } from './terminals-view.tsx'
export { React, flushSync, createRoot }
`

/** Bundle the page and import it; `{ React, createRoot, flushSync, TerminalsView, ...store }`. */
export async function loadView() {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: client, sourcefile: 'view-entry.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    logLevel: 'silent',
    absWorkingDir: join(here, '..', '..'),
    define: { 'process.env.NODE_ENV': '"development"' },
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

export { window }
export const requireFromHere = createRequire(import.meta.url)
