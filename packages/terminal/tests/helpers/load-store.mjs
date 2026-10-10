// Test harness: loads the client store (TypeScript importing xterm) under jsdom.
//
// Importing this module installs jsdom globals; `loadStore()` bundles the store with
// esbuild into memory and imports it. `FakeWebSocket` stands in for the host: it records
// every frame the client sends and lets a test push host frames back.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const { JSDOM } = createRequire(import.meta.url)('jsdom')

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:19387/', pretendToBeVisual: true })
export const { window } = dom
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
window.HTMLCanvasElement.prototype.getContext = () => null
window.fetch = () => Promise.resolve({ ok: false })
window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }

/**
 * A controllable WebSocket. It is open from the start; every instance is kept in
 * `FakeWebSocket.instances` (oldest first) so a test can reach the socket a runtime made.
 */
export class FakeWebSocket {
  static OPEN = 1
  static instances = []
  /** The most recently created socket. */
  static get last() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  }
  static reset() {
    FakeWebSocket.instances = []
  }

  constructor(url) {
    this.url = url
    this.readyState = 1
    /** Frames the client sent, parsed. */
    this.sent = []
    FakeWebSocket.instances.push(this)
  }
  send(data) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
  }
  /** Deliver a frame from the host to the client. */
  push(frame) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }
  /** The connection drops (host gone, network) and the client's onclose fires. */
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

for (const [key, value] of Object.entries({
  window,
  document: window.document,
  localStorage: window.localStorage,
  navigator: window.navigator,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  WebSocket: FakeWebSocket,
  ResizeObserver: window.ResizeObserver,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

/** Bundle and import the store from memory; no file is written anywhere. */
export async function loadStore({ fresh = false } = {}) {
  const result = await build({
    entryPoints: [join(root, 'src', 'client', 'terminal-store.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: 'store.mjs',
    write: false,
    logLevel: 'silent',
  })
  // A data: URL imports once; a comment makes the code unique so a test can get its own module state.
  const code = result.outputFiles[0].text + (fresh ? ' // fresh ' + Math.random() : '')
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}
