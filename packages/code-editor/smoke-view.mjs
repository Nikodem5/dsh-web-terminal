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
const statusCalls = []
const stageCalls = []
const gitPosts = []
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
  if (route === '/git/repos') {
    const r = u.searchParams.get('root')
    if (r === '/w/multi') return json(200, { ok: true, inside: false, truncated: false, repos: [{ path: '/w/multi/alpha', rel: 'alpha', name: 'alpha' }, { path: '/w/multi/pk/beta', rel: 'pk/beta', name: 'beta' }] })
    if (r === '/w/plain') return json(200, { ok: true, inside: false, truncated: false, repos: [] })
    return json(200, { ok: true, inside: true, truncated: false, repos: [{ path: r, rel: '', name: 'proj' }] })
  }
  if (route === '/git/status') {
    const r = u.searchParams.get('root')
    statusCalls.push(r)
    if (r === '/w/multi/alpha') return json(200, { ok: true, branch: 'dev', ahead: 0, behind: 0, files: [{ path: 'x.ts', index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false, conflicted: false }] })
    if (r === '/w/multi/pk/beta') return json(200, { ok: true, branch: 'main', ahead: 0, behind: 0, files: [] })
    return json(200, status)
  }
  // git tools block
  if (route === '/git/branches') return json(200, { ok: true, current: 'main', detached: false, head: null, upstream: 'origin/main', upstreamRemote: 'origin', ahead: 1, behind: 0, remotes: ['origin'], local: [{ name: 'main', hash: 'abc', upstream: 'origin/main', upstreamRemote: 'origin', current: true }, { name: 'dev', hash: 'abd', upstream: null, upstreamRemote: null, current: false }], remote: [{ name: 'origin/topic', remote: 'origin', short: 'topic', hash: 'abe', local: false }] })
  if (route === '/git/checkout') { gitPosts.push(['checkout', body]); return json(200, { ok: true, branch: body.branch }) }
  if (route === '/git/commit' && init.method === 'POST') { gitPosts.push(['commit', body]); return json(200, { ok: true, hash: 'abcdef1234', summary: 'done' }) }
  if (route === '/git/commit') return json(200, { ok: true, hash: u.searchParams.get('hash'), author: 'A', email: 'a@x', date: Date.now(), message: 'first\n\nbody', parent: null, files: [{ status: 'M', path: 'a.txt' }], truncated: false })
  if (route === '/git/log') return json(200, { ok: true, hasMore: false, commits: [{ hash: 'a'.repeat(40), short: 'aaaaaaa', author: 'Ann', email: 'a@x', date: Date.now() - 7200_000, subject: 'first', refs: ['main'] }, { hash: 'b'.repeat(40), short: 'bbbbbbb', author: 'Bob', email: 'b@x', date: Date.now() - 86400_000 * 3, subject: 'second', refs: [] }] })
  if (route === '/git/show') return json(200, { ok: true, original: 'old', modified: 'new', binary: false, tooLarge: false })
  if (route === '/git/pull' || route === '/git/push' || route === '/git/fetch') { gitPosts.push([route, body]); return json(200, { ok: true, summary: 'ok', setUpstream: false, remote: null, branch: 'main' }) }
  if (route === '/git/stage') { stageCalls.push(body); return json(200, { ok: true }) }
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

const picks = ['/w/picked', null]
const picker = { available: () => true, pick: async () => picks.shift() ?? null }
const mem = new Map()
const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)) } }
const store = new EditorStore({ api: createApi(), storage, confirm: () => true, gitDelayMs: 1, picker })
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

// Ctrl+E / Ctrl+P from INSIDE the editor element and from the page body (focus outside the Code view)
const editorEl = host.element
check(editorEl.isConnected, 'the fake editor element is mounted in the page')
const quick = () => !!q('[data-ce-quick]')
const closeQuick = async () => { if (quick()) { key(q('[data-ce-quick] input'), { key: 'Escape' }); await until(() => !quick(), 'quick open closed') } }
key(editorEl, { key: 'p', ctrlKey: true })
check(await until(quick, 'quick open from the editor'), 'Ctrl+P dispatched inside the editor element opens quick open')
await closeQuick()
key(editorEl, { key: 'e', ctrlKey: true })
check(await until(quick, 'quick open Ctrl+E'), 'Ctrl+E inside the editor element opens quick open')
await closeQuick()
key(doc.body, { key: 'e', ctrlKey: true })
check(await until(quick, 'quick open from body'), 'Ctrl+E with focus on the page body (outside the view) opens quick open')
key(q('[data-ce-quick] input'), { key: 'e', ctrlKey: true })
check(await until(() => !quick(), 'toggled closed'), 'the key toggles quick open closed from its own input')
key(editorEl, { key: 'w', ctrlKey: true })
check(!quick(), 'Ctrl+W is not bound')
click(q('[data-act=quick-open]'))
check(await until(quick, 'search button'), 'the Search files button opens quick open')
await closeQuick()
check(q('[data-act=quick-open]').textContent.includes('Ctrl+E'), 'the search button shows its shortcut')

// closing the active tab with Ctrl+F4
const tabsBefore = qa('.ce-tab').length
key(editorEl, { key: 'F4', ctrlKey: true })
check(await until(() => qa('.ce-tab').length === tabsBefore - 1, 'tab closed'), 'Ctrl+F4 closes the active tab')

// splitters: drag, clamp, persist, double-click reset, keyboard
const side = q('.ce-side')
const mouse = (el, type, init) => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }))
const saved = () => JSON.parse(mem.get('dsh-code-editor:v1:global')).layout
check(side.style.width === '280px', 'default sidebar width is 280px')
const bar = q('[data-split=sidebar]')
mouse(bar, 'mousedown', { clientX: 280 })
mouse(doc, 'mousemove', { clientX: 400 })
check(await until(() => side.style.width === '400px', 'drag width'), 'dragging the splitter resizes the sidebar')
mouse(doc, 'mousemove', { clientX: 50 })
check(await until(() => side.style.width === '200px', 'min width'), 'the width is clamped to the minimum')
mouse(doc, 'mouseup', {})
mouse(doc, 'mousemove', { clientX: 500 })
check(side.style.width === '200px', 'moves after mouseup are ignored')
mouse(bar, 'mousedown', { clientX: 200 }); mouse(doc, 'mousemove', { clientX: 333 }); mouse(doc, 'mouseup', {})
check(await until(() => saved().sidebar === 333, 'persisted width'), 'the width is persisted')
bar.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
check(await until(() => side.style.width === '280px', 'reset'), 'double-click resets the sidebar width')
bar.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
check(await until(() => side.style.width === '296px', 'nudge'), 'ArrowRight nudges the splitter')
const hbar = q('[data-split=sections]')
check(!!hbar, 'a splitter sits between EXPLORER and CHANGES')
hbar.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
check(await until(() => saved().exFrac === 0.54, 'frac'), 'the explorer/changes split is persisted')
hbar.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
check(await until(() => saved().exFrac === 0.5, 'frac reset'), 'double-click resets the split')
click(q('[data-sec=EXPLORER] .ce-sec-h'))
check(await until(() => q('[data-sec=EXPLORER]').dataset.open === 'false' && !q('[data-split=sections]'), 'collapsed'), 'sections collapse (and the inner splitter goes away)')
click(q('[data-sec=EXPLORER] .ce-sec-h'))
await until(() => q('[data-sec=EXPLORER]').dataset.open === 'true', 'expanded')

// file icons in explorer and tabs
check(q('[role=treeitem][data-path="a.txt"] svg[data-icon]')?.dataset.icon === 'text', 'explorer rows have a file-type icon')
const dirRow = q('[role=treeitem][data-path="src"]')
check(dirRow.querySelector('svg.ce-folder')?.dataset.icon === (dirRow.getAttribute('aria-expanded') === 'true' ? 'folder-open' : 'folder'), 'folders have an open / closed icon matching their state')
check(!!q('.ce-tab svg[data-icon]'), 'tabs have an icon')

// git tools: sync bar + commit box, branch picker, history, read-only history diff
check(!!q('[data-commit-box] textarea') && ['fetch', 'pull', 'push'].every((a) => q(`[data-repo-tools] [data-act=${a}]`)), 'CHANGES shows the sync bar and the commit box')
check(q('[data-repo-tools] [data-ab]')?.textContent === '↑1 ↓0', 'the sync bar shows ahead/behind')
const setValue = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new window.Event('input', { bubbles: true })) }
click(q('[data-repo-tools] [data-act=branch]'))
check(await until(() => qa('[data-branch-picker] .ce-qo-item').length === 3, 'branch rows'), 'the branch chip opens the picker with local and remote branches')
check(qa('[data-branch-picker] .ce-qo-item').map((e) => e.dataset.kind).join() === 'local,local,remote', 'picker lists local then remote-only branches')
setValue(q('[data-branch-picker] input'), 'feat/new')
check(await until(() => q('[data-branch-picker] [data-kind=create]'), 'create row'), 'typing an unknown name offers to create it')
key(q('[data-branch-picker] input'), { key: 'Enter' })
check(await until(() => gitPosts.some((p) => p[0] === 'checkout' && p[1].branch === 'feat/new' && p[1].create === true), 'create posted'), 'Enter creates the branch from HEAD')
check(await until(() => !q('[data-branch-picker]'), 'picker closed'), 'the picker closes after switching')
setValue(q('[data-commit-box] textarea'), 'my message')
await until(() => q('[data-act=commit]') && !q('[data-act=commit]').disabled, 'commit enabled')
click(q('[data-act=commit]'))
check(await until(() => gitPosts.some((p) => p[0] === 'commit' && p[1].message === 'my message' && p[1].all === false && p[1].amend === false), 'commit posted'), 'Commit posts the staged commit')
click(q('[data-repo-tools] [data-act=pull]'))
check(await until(() => gitPosts.some((p) => p[0] === '/git/pull'), 'pull'), 'Pull goes through the confirm and posts')
click(q('[data-sec=HISTORY] .ce-sec-h'))
check(await until(() => qa('.ce-hc').length === 2, 'history rows'), 'HISTORY lists commits')
check(q('.ce-hc .ce-ref')?.textContent === 'main' && q('.ce-hc .ce-hmeta').textContent.includes('Ann') && q('.ce-hc .ce-hmeta').textContent.includes('2 hours ago'), 'a history row shows refs, author and relative date')
click(q('.ce-hc .ce-hrow'))
check(await until(() => qa('.ce-hfiles .ce-row').length === 1, 'commit files'), 'selecting a commit lists its files')
click(q('.ce-hfiles .ce-row'))
check(await until(() => host.diff && host.diff.id.startsWith('hist:'), 'history diff'), 'a commit file opens a diff')
check(host.diff.o === 'old' && host.diff.m === 'new', 'the history diff shows parent vs commit')
check(!q('[data-act=keep-mine]') && !!q('[data-readonly]'), 'the history diff tab is read-only')

// Browse...: the native picker, then POST /roots and select
check(!!q('[data-act=browse]'), 'Browse... shows when the picker exists')
click(q('[data-act=browse]'))
check(await until(() => q('.ce-select').value === '/w/picked', 'picked root'), 'Browse... selects the folder the picker returned')
click(q('[data-act=browse]'))
await sleep(30)
check(q('.ce-select').value === '/w/picked', 'cancelling the picker changes nothing')

// root without repos
await store.openFolder('/w/plain')
check(await until(() => q('[data-empty-repos]'), 'no repos note'), 'a folder without repositories says so')
check(text('[data-sec=CHANGES]').includes('No git repository in this folder'), 'empty state text')

// root that only CONTAINS repositories: a collapsible block per repo with its own groups and actions
await store.openFolder('/w/multi')
await until(() => qa('.ce-repo').length === 2, 'repo blocks')
check(qa('.ce-repo').map((e) => e.dataset.repo).join() === 'alpha,pk/beta', 'one block per nested repository')
await until(() => q('.ce-repo[data-repo=alpha]')?.dataset.open === 'true', 'alpha open (has changes)')
check(statusCalls.includes('/w/multi/alpha') && statusCalls.includes('/w/multi/pk/beta'), 'each repository gets its own status request')
check(q('.ce-repo[data-repo="pk/beta"]').dataset.open === 'false', 'a repository without changes starts collapsed')
check(q('[data-sec=CHANGES] .ce-count')?.textContent === '1', 'the section count adds up the repositories')
click(q('.ce-repo[data-repo=alpha] [data-act=stage]'))
check(await until(() => stageCalls.length === 1, 'stage'), 'per-repo stage hits the API')
check(stageCalls[0].root === '/w/multi/alpha' && stageCalls[0].paths.join() === 'x.ts', 'stage uses the repository path as root and a repo-relative path')
click(q('.ce-repo[data-repo=alpha] .ce-row'))
await until(() => host.diff && host.diff.id === 'diff:w:alpha/x.ts', 'nested diff')
check(host.diff?.id === 'diff:w:alpha/x.ts', 'a nested change opens a diff tab keyed by its root-relative path')
click(q('.ce-repo[data-repo=alpha] .ce-repo-h'))
check(await until(() => q('.ce-repo[data-repo=alpha]').dataset.open === 'false', 'collapse repo'), 'a repository block collapses')

root.unmount()
store.dispose()
window.close()
console.log(failures === 0 ? 'all view smoke checks passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
