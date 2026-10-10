// Renders the Code page in jsdom with a mocked fetch and a fake editor host (Monaco cannot run in jsdom) and checks the
// explorer, changes list, tab opening, save -> PUT with expectedMtime, and the 409 conflict bar.
//   node smoke-view.mjs
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const profileRequire = createRequire(
  pathToFileURL(join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'), 'profiles', 'package.json')).href,
)
const { JSDOM } = createRequire(import.meta.url)(process.env.DSH_JSDOM ?? 'jsdom')

const bundle = (await build({
  entryPoints: [join(here, 'tests', 'helpers', 'smoke-entry.ts')], bundle: true, format: 'iife', globalName: '__ce_smoke__', platform: 'browser',
  target: ['es2020'], write: false, jsx: 'automatic', logLevel: 'error', absWorkingDir: here,
  alias: { react: join(here, 'src', 'shims', 'react.cts'), 'react/jsx-runtime': join(here, 'src', 'shims', 'jsx-runtime.cts') },
  plugins: [{ name: 'no-monaco', setup(b) { b.onResolve({ filter: /monaco-adapter/ }, (a) => ({ path: a.path, external: true })) } }],
})).outputFiles[0].text + '\nwindow.__ce_smoke__ = __ce_smoke__;'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:19387/', pretendToBeVisual: true, runScripts: 'outside-only' })
const { window } = dom
let failures = 0
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`); if (!ok) failures++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return true; await sleep(10) }
  check(false, `timed out: ${label}`)
  return false
}

// browser surface
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
window.Element.prototype.attachEvent = () => {}
window.Element.prototype.detachEvent = () => {}
window.HTMLCanvasElement.prototype.getContext = () => null
class FakeWS { constructor(u) { this.url = u; queueMicrotask(() => this.onopen?.()) } close() {} }
window.WebSocket = FakeWS
globalThis.IS_REACT_ACT_ENVIRONMENT = false
globalThis.window = window
globalThis.document = window.document
for (const k of ['HTMLElement', 'HTMLIFrameElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'MutationObserver']) globalThis[k] = window[k]
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
window.document.oninput = null

const domEntry = profileRequire.resolve('react-dom/client')
const domRequire = createRequire(pathToFileURL(domEntry).href)
const React = domRequire('react')
const ReactDOMClient = domRequire('react-dom/client')
const ReactDOM = domRequire('react-dom')
const mods = { react: React, 'react/jsx-runtime': domRequire('react/jsx-runtime') }
window.__ce_require__ = (id) => mods[id]
window.eval(bundle)
const { CodeEditorPage, EditorStore, createApi } = window.__ce_smoke__

// mocked host API
const fs = { 'a.txt': { content: 'hello\n', mtime: 1 }, 'src/b.ts': { content: 'export {}\n', mtime: 1 } }
const puts = []
const status = {
  ok: true, branch: 'main', ahead: 1, behind: 0,
  files: [
    { path: 'a.txt', index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false, conflicted: false },
    { path: 's.ts', index: 'A', worktree: ' ', staged: true, unstaged: false, untracked: false, conflicted: false },
    { path: 'n.ts', index: '?', worktree: '?', staged: false, unstaged: false, untracked: true, conflicted: false },
  ],
}
const json = (code, body) => Promise.resolve({ ok: code < 300, status: code, json: async () => body })
window.fetch = (url, init = {}) => {
  const u = new URL(url, 'http://x')
  const route = u.pathname.replace('/api/dsh-code-editor', '')
  const body = init.body ? JSON.parse(init.body) : {}
  if (route === '/roots') return json(200, { ok: true, roots: body.roots.map((p) => ({ path: p, exists: true, isGit: true })), rejected: [] })
  if (route === '/tree') {
    return json(200, { ok: true, entries: u.searchParams.get('dir') === '' ? [{ name: 'src', type: 'dir', size: 0, mtime: 1 }, { name: 'a.txt', type: 'file', size: 6, mtime: 1 }] : [{ name: 'b.ts', type: 'file', size: 9, mtime: 1 }] })
  }
  if (route === '/files') return json(200, { ok: true, files: Object.keys(fs), truncated: false })
  if (route === '/file' && (init.method ?? 'GET') === 'GET') {
    const f = fs[u.searchParams.get('path')]
    return f ? json(200, { ok: true, content: f.content, mtime: f.mtime, size: 1, binary: false, tooLarge: false, eol: 'lf' }) : json(404, { ok: false, error: 'missing' })
  }
  if (route === '/file') {
    puts.push(body)
    const f = fs[body.path]
    if (f && f.mtime !== body.expectedMtime) return json(409, { ok: false, error: 'changed', code: 'conflict', mtime: f.mtime })
    fs[body.path] = { content: body.content, mtime: (f?.mtime ?? 0) + 1 }
    return json(200, { ok: true, mtime: fs[body.path].mtime, size: body.content.length })
  }
  if (route === '/git/status') return json(200, status)
  if (route === '/git/diff') return json(200, { ok: true, original: 'a', modified: 'b', binary: false, tooLarge: false })
  return json(200, { ok: true })
}

// fake editor host
const models = new Map()
const cb = { change: () => {}, key: () => {} }
const host = {
  element: window.document.createElement('div'),
  showFile(id, text) { if (!models.has(id)) models.set(id, text); host.shown = id; return models.get(id) },
  showDiff(id, o, m) { host.diff = { id, o, m } },
  showNone() {},
  getValue: (id) => models.get(id) ?? null,
  setValue(id, t) { if (!models.has(id)) return false; models.set(id, t); cb.change(id); return true },
  hasModel: (id) => models.has(id),
  getEol: () => 'lf',
  disposeModel: (id) => models.delete(id),
  reveal() {}, setTheme() {}, setInline() {}, layout() {}, focus() {},
  onChange(f) { cb.change = f }, onCursor() {}, onKey(f) { cb.key = f }, dispose() {},
}

const store = new EditorStore({ api: createApi(), storage: null, confirm: () => true, gitDelayMs: 1 })
store.attachHost(host)
const props = { store, useWorkspaces: (sel) => sel({ items: [{ path: '/w/proj', title: 'proj' }] }) }
const root = ReactDOMClient.createRoot(window.document.getElementById('root'))
ReactDOM.flushSync(() => root.render(React.createElement(CodeEditorPage, props)))
const doc = window.document
const q = (s) => doc.querySelector(s)
const qa = (s) => [...doc.querySelectorAll(s)]
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const text = (s) => q(s)?.textContent ?? ''

await until(() => qa('[role=treeitem]').length === 2, 'explorer rows')
check(qa('[role=treeitem]').map((e) => e.dataset.path).join() === 'src,a.txt', 'explorer lists the root entries')
check(q('.ce-select').value === '/w/proj', 'the workspace is the selected root')
await until(() => qa('.ce-grp').length === 3, 'changes groups')
check(qa('.ce-grp').map((e) => e.textContent.split(' ')[0]).join() === 'Staged,Changes,Untracked', 'changes shows Staged / Changes / Untracked')
check(q('[data-sec=CHANGES] .ce-count')?.textContent === '3', 'changes count badge')
check(text('[data-statusbar]').includes('main') && text('[data-statusbar]').includes('↑1'), 'status bar shows branch and ahead')

click(q('[role=treeitem][data-path="a.txt"]'))
await until(() => q('.ce-tab'), 'tab')
check(q('.ce-tab .ce-ttl').textContent === 'a.txt' && host.shown === 'file:a.txt', 'clicking a file opens a tab in the editor')
check(q('.ce-overlay') === null, 'no overlay once the file is shown')

// edit, dirty, save
models.set('file:a.txt', 'hello world\n'); cb.change('file:a.txt')
await until(() => q('.ce-tab .ce-dot'), 'dirty dot')
click(q('[data-act=save]'))
await until(() => puts.length === 1, 'PUT')
check(puts[0].expectedMtime === 1 && puts[0].content === 'hello world\n' && puts[0].path === 'a.txt', 'Save sends PUT with expectedMtime')
check(await until(() => !q('.ce-tab .ce-dot'), 'dirty cleared'), 'the dirty dot clears after saving')

// 409 and the conflict bar
fs['a.txt'] = { content: 'external\n', mtime: 50 }
models.set('file:a.txt', 'mine again\n'); cb.change('file:a.txt')
await until(() => q('[data-act=save]') && !q('[data-act=save]').disabled, 'save enabled')
click(q('[data-act=save]'))
await until(() => q('[data-conflict-bar]'), 'conflict bar')
check(text('[data-conflict-bar]').includes('File changed on disk'), 'a 409 shows the File changed on disk bar')
check(['reload', 'overwrite', 'compare'].every((a) => q(`[data-conflict-bar] [data-act=${a}]`)), 'bar offers Reload / Overwrite / Compare')
click(q('[data-conflict-bar] [data-act=overwrite]'))
await until(() => puts.length === 3 && !q('[data-conflict-bar]'), 'overwrite')
check(puts[2].expectedMtime === 50, 'Overwrite writes against the disk mtime')

// change entry opens a diff tab
click(q('.ce-row[data-group=changes]'))
await until(() => host.diff, 'diff shown')
check(host.diff.id === 'diff:w:a.txt', 'a Changes entry opens the unstaged diff')
check(qa('.ce-tab').length === 2, 'the diff opens in its own tab')

// quick open
const key = (el, init) => el.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
key(q('.ce-sec-h'), { key: 'p', ctrlKey: true })
await until(() => q('[data-ce-quick] input'), 'quick open')
await until(() => qa('.ce-qo-item').length === 2, 'quick open items')
check(qa('.ce-qo-item').length === 2, 'Ctrl+P opens quick open listing files')
key(q('[data-ce-quick] input'), { key: 'Escape' })
check(await until(() => !q('[data-ce-quick]'), 'quick open closed'), 'Escape closes quick open')

root.unmount()
store.dispose()
window.close()
console.log(failures === 0 ? 'all view smoke checks passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
