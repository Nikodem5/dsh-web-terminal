// Executes the built client bundle against a stub loader to prove it registers
// the panel into `shell.overlay` with the real React from the profile.
//
//   node smoke-client.mjs

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, 'lib', 'client.js'), 'utf8')

/** Minimal DOM surface the module touches at load time. */
const elements = []
const documentStub = {
  head: { appendChild: (node) => elements.push(node) },
  createElement: () => ({ setAttribute() {}, appendChild() {}, textContent: '' }),
  querySelector: () => null,
}

// React comes from the installed profile, exactly as the page's shared module
// registry supplies it — the bundle must never carry its own copy.
const profileRequire = createRequire(
  pathToFileURL(join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'), 'profiles', 'package.json')).href,
)
const React = await import(pathToFileURL(profileRequire.resolve('react')).href)
const jsxRuntime = await import(pathToFileURL(profileRequire.resolve('react/jsx-runtime')).href)

/** Registrations the bundle makes through the loader's module registry face. */
const registrations = []
const modules = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
}

const sandbox = {
  window: {
    __ModuleLoader__: {
      load(entry) {
        registrations.push(entry)
      },
    },
  },
  document: documentStub,
  fetch: () => Promise.resolve({ ok: false }),
  WebSocket: class {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  addEventListener() {},
  removeEventListener() {},
  console,
  setTimeout,
  clearTimeout,
}

// Evaluate the bundle inside a classic-<script> scope. Crucially, `module` and
// `exports` are NOT provided: in the browser they do not exist either, so the
// bundle must declare its own inside the factory. Providing them here once hid
// a real "module is not defined" failure from this very test.
const runner = new Function(
  'window',
  'document',
  'fetch',
  'WebSocket',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'console',
  'setTimeout',
  'clearTimeout',
  bundle,
)
runner(
  sandbox.window,
  sandbox.document,
  sandbox.fetch,
  sandbox.WebSocket,
  sandbox.requestAnimationFrame,
  sandbox.cancelAnimationFrame,
  sandbox.console,
  sandbox.setTimeout,
  sandbox.clearTimeout,
)

if (registrations.length !== 1) {
  console.error(`FAIL: expected exactly one __ModuleLoader__.load call, saw ${registrations.length}`)
  process.exit(1)
}

const entry = registrations[0]
console.log(`loader id: ${entry.id}`)
if (typeof entry.factory !== 'function') {
  console.error('FAIL: registration has no factory')
  process.exit(1)
}

// Run the factory. A loader registration factory may either return its exports
// or assign `module.exports`; this bundle assigns, so capture what it wrote by
// handing it a module object the way a CommonJS-style loader does — while still
// proving the bundle declares its own `module` (the browser case above already
// covered that, since nothing was injected there).
const passedModule = { exports: {} }
const returned = entry.factory((id) => {
  const mod = modules[id]
  if (mod === undefined) throw new Error(`unexpected require("${id}")`)
  return mod
}, passedModule)
const exportsObject = returned ?? passedModule.exports

console.log(`plugin name: ${exportsObject.name}`)
console.log(`plugin inject: ${JSON.stringify(exportsObject.inject)}`)
if (typeof exportsObject.apply !== 'function') {
  console.error('FAIL: plugin exports no apply()')
  process.exit(1)
}

// Activate against a stub slot registry and record what it registers.
const registrations2 = []
const ctx = {
  slots: {
    inject(key, callback) {
      registrations2.push({ inject: key })
      callback()
      return () => {}
    },
    register(options, component) {
      registrations2.push({ options, component })
      return () => {}
    },
  },
}

exportsObject.apply(ctx)

const injects = registrations2.filter((r) => r.inject !== undefined).map((r) => r.inject)
const regs = registrations2.filter((r) => r.options !== undefined)
const reg = (seat) => regs.find((r) => r.options.name === seat)
console.log(`slots.inject: ${injects.join(', ')}`)
console.log(`slots.register: ${regs.map((r) => JSON.stringify(r.options)).join(' ')}`)

const main = reg('main')
const sidebarEntry = reg('sidebar.panellist')
const bar = reg('conversation.session.header.utilities')
const ok =
  ['main', 'sidebar.panellist', 'conversation.session.header.utilities'].every((k) => injects.includes(k)) &&
  !injects.includes('conversation.view') &&
  typeof main?.options.key === 'string' &&
  // the sidebar entry id must equal the main key, or selectPanel has nothing to show
  sidebarEntry?.options.id === main?.options.key &&
  typeof sidebarEntry?.options.label === 'function' &&
  sidebarEntry.options.label() === 'Terminals' &&
  typeof main?.component === 'function' &&
  typeof sidebarEntry?.component === 'function' &&
  bar?.options.id === 'terminal-stats' &&
  typeof bar?.component === 'function'

if (ok) {
  console.log('PASS: client half registers the sidebar entry, the main page and the header stats bar')
  process.exit(0)
}
console.error('FAIL: unexpected registration shape')
process.exit(1)
