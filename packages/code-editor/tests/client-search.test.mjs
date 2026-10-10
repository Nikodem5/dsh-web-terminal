import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { SEARCH_DEBOUNCE_MS, SearchController, splitPreview } from '../src/client/search-state.ts'
import { EditorStore } from '../src/client/store.ts'
import { createApi, ApiError } from '../src/client/api.ts'
import { actionFor, matchShortcut, pageAction } from '../src/client/shortcuts.ts'
import { FakeHost, FakeSocket, MemoryStorage, makeApi, sleep, until } from './helpers/fake.mjs'

const m = (line, col, length = 3, preview = 'say foo here', at = 4) => ({ line, col, length, preview, at })
const FILES = [
  { path: 'src/a.ts', matches: [m(1, 5), m(7, 9)] },
  { path: 'README.md', matches: [m(3, 1)] },
]

/** A search API whose answers the test releases by hand. */
function deferredApi() {
  const calls = []
  return {
    calls,
    search(root, query, signal) {
      return new Promise((resolve, reject) => {
        const call = { root, query: { ...query }, signal, resolve: (value) => resolve(value), reject }
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        calls.push(call)
      })
    },
  }
}

const result = (results, extra = {}) => ({ results, truncated: false, timedOut: false, took: 1, ...extra })

function controller(api, extra = {}) {
  const opened = []
  const c = new SearchController({
    api, root: () => '/w/proj', debounceMs: 20, open: async (path, match) => { opened.push([path, match.line, match.col, match.length]) }, ...extra,
  })
  return { c, opened }
}

test('the default debounce is 300 ms', () => {
  assert.equal(SEARCH_DEBOUNCE_MS, 300)
})

test('typing is debounced: one request after the last keystroke', async () => {
  const api = deferredApi()
  const { c } = controller(api)
  c.setText({ q: 'f' })
  c.setText({ q: 'fo' })
  c.setText({ q: 'foo' })
  assert.equal(api.calls.length, 0)
  await until(() => api.calls.length === 1, 'the debounced request')
  await sleep(50)
  assert.equal(api.calls.length, 1)
  assert.equal(api.calls[0].query.q, 'foo')
  assert.equal(api.calls[0].root, '/w/proj')
  assert.equal(c.getState().status, 'loading')
  api.calls[0].resolve(result(FILES))
  await until(() => c.getState().status === 'done', 'results')
  assert.equal(c.getState().total, 3)
})

test('a newer search aborts the stale one and its late answer is ignored', async () => {
  const api = deferredApi()
  const { c } = controller(api)
  c.setText({ q: 'one' })
  await until(() => api.calls.length === 1, 'first request')
  c.setText({ q: 'two' })
  await until(() => api.calls.length === 2, 'second request')
  assert.equal(api.calls[0].signal.aborted, true)
  assert.equal(api.calls[1].signal.aborted, false)
  api.calls[1].resolve(result([{ path: 'b.txt', matches: [m(1, 1)] }]))
  await until(() => c.getState().status === 'done', 'second answer')
  api.calls[0].resolve(result(FILES)) // too late: already aborted and superseded
  await sleep(20)
  assert.deepEqual(c.getState().results.map((f) => f.path), ['b.txt'])
})

test('toggles search immediately, an empty query clears without a request', async () => {
  const api = deferredApi()
  const { c } = controller(api)
  c.setText({ q: 'foo' })
  c.setFlag('regex', true)
  await until(() => api.calls.length === 1, 'immediate request')
  assert.equal(api.calls[0].query.regex, true)
  api.calls[0].resolve(result(FILES))
  await until(() => c.getState().total === 3, 'results')
  c.setText({ q: '' })
  await until(() => c.getState().status === 'idle', 'cleared')
  assert.equal(api.calls.length, 1)
  assert.deepEqual(c.getState().results, [])
  c.setFlag('word', true)
  c.setFlag('caseSensitive', true)
  await sleep(10)
  assert.equal(api.calls.length, 1, 'nothing to search for')
})

test('include / exclude travel with the query; errors are shown, a later search recovers', async () => {
  const api = deferredApi()
  const { c } = controller(api)
  c.setText({ q: 'x', include: '*.ts', exclude: 'dist' })
  await until(() => api.calls.length === 1, 'request')
  assert.equal(api.calls[0].query.include, '*.ts')
  assert.equal(api.calls[0].query.exclude, 'dist')
  api.calls[0].reject(new ApiError('Invalid regular expression', 400, 'bad-pattern'))
  await until(() => c.getState().status === 'error', 'error state')
  assert.match(c.getState().error, /Invalid regular expression/)
  c.setText({ q: 'xy' })
  await until(() => api.calls.length === 2, 'retry')
  api.calls[1].resolve(result(FILES, { truncated: true, timedOut: true }))
  await until(() => c.getState().status === 'done', 'recovered')
  assert.equal(c.getState().error, null)
  assert.equal(c.getState().truncated, true)
  assert.equal(c.getState().timedOut, true)
})

test('grouping, counts, collapsing and the visible list', async () => {
  const api = deferredApi()
  const { c } = controller(api)
  c.setText({ q: 'foo' })
  await until(() => api.calls.length === 1, 'request')
  api.calls[0].resolve(result(FILES))
  await until(() => c.getState().status === 'done', 'results')
  assert.equal(c.getState().total, 3)
  assert.equal(c.getState().results.length, 2)
  assert.deepEqual(c.visible().map((x) => `${x.path}#${x.index}`), ['src/a.ts#0', 'src/a.ts#1', 'README.md#0'])
  c.toggleFile('src/a.ts')
  assert.deepEqual(c.visible().map((x) => `${x.path}#${x.index}`), ['README.md#0'])
  c.toggleFile('src/a.ts')
  assert.equal(c.visible().length, 3)
})

test('stepping wraps and opens the match; Enter opens the selection when the results are current', async () => {
  const api = deferredApi()
  const { c, opened } = controller(api)
  c.setText({ q: 'foo' })
  await until(() => api.calls.length === 1, 'request')
  api.calls[0].resolve(result(FILES))
  await until(() => c.getState().status === 'done', 'results')

  await c.step(1, true)
  assert.deepEqual(opened.at(-1), ['src/a.ts', 1, 5, 3])
  await c.step(1, false) // selection only
  assert.equal(opened.length, 1)
  assert.deepEqual(c.getState().sel, { path: 'src/a.ts', index: 1 })
  await c.step(1, true)
  assert.deepEqual(opened.at(-1), ['README.md', 3, 1, 3])
  await c.step(1, true)
  assert.deepEqual(opened.at(-1), ['src/a.ts', 1, 5, 3], 'wraps to the first')
  await c.step(-1, true)
  assert.deepEqual(opened.at(-1), ['README.md', 3, 1, 3], 'wraps back to the last')

  await c.enter() // results are current and a match is selected: opens it
  assert.equal(opened.length, 5)
  assert.equal(api.calls.length, 1)
  c.setText({ q: 'foob' }) // text changed: Enter searches instead
  void c.enter()
  assert.equal(api.calls.length, 2)
  api.calls[1].resolve(result([]))
  await sleep(5)
  await c.openMatch('src/a.ts', 1)
  assert.equal(opened.length, 5, 'no results any more: nothing opens')
})

test('openMatch selects and opens; reset (root change) drops results and cancels in-flight work', async () => {
  const api = deferredApi()
  const { c, opened } = controller(api)
  c.setText({ q: 'foo' })
  await until(() => api.calls.length === 1, 'request')
  api.calls[0].resolve(result(FILES))
  await until(() => c.getState().status === 'done', 'results')
  await c.openMatch('src/a.ts', 1)
  assert.deepEqual(opened.at(-1), ['src/a.ts', 7, 9, 3])
  assert.deepEqual(c.getState().sel, { path: 'src/a.ts', index: 1 })
  c.setFlag('regex', true)
  await until(() => api.calls.length === 2, 'second request')
  c.reset()
  assert.equal(api.calls[1].signal.aborted, true)
  assert.equal(c.getState().results.length, 0)
  assert.equal(c.getState().status, 'idle')
  assert.equal(c.getState().query.q, 'foo', 'the query text is kept')
})

test('splitPreview marks the match inside the preview', () => {
  assert.deepEqual(splitPreview(m(1, 5)), { before: 'say ', hit: 'foo', after: ' here' })
  assert.deepEqual(splitPreview({ line: 1, col: 1, length: 2, preview: 'abc' }), { before: '', hit: 'ab', after: 'c' })
})

test('the real api wrapper sends the query, the abort signal and decodes the answer', async () => {
  const seen = []
  const api = createApi(async (url, init) => {
    seen.push([url, init])
    return { ok: true, status: 200, json: async () => ({ ok: true, results: FILES, truncated: true, took: 5 }), blob: async () => new Blob(['x']) }
  })
  const ac = new AbortController()
  const r = await api.search('/w/proj', { q: 'a b&c', regex: true, caseSensitive: false, word: true, include: '*.ts', exclude: '' }, ac.signal)
  const url = new URL(seen[0][0], 'http://x')
  assert.equal(url.pathname, '/api/dsh-code-editor/search')
  assert.equal(url.searchParams.get('q'), 'a b&c')
  assert.equal(url.searchParams.get('regex'), '1')
  assert.equal(url.searchParams.get('case'), '0')
  assert.equal(url.searchParams.get('word'), '1')
  assert.equal(url.searchParams.get('include'), '*.ts')
  assert.equal(url.searchParams.has('exclude'), false)
  assert.equal(seen[0][1].signal, ac.signal)
  assert.equal(r.truncated, true)
  assert.equal(r.results.length, 2)
  const blob = await api.raw('/w/proj', 'img/a.png')
  assert.ok(blob instanceof Blob)
  assert.equal(new URL(seen[1][0], 'http://x').searchParams.get('path'), 'img/a.png')
  const bad = createApi(async () => ({ ok: false, status: 415, json: async () => ({}) }))
  await assert.rejects(() => bad.raw('/w/proj', 'x.txt'), (e) => e.status === 415)
})

// ---- store integration ---------------------------------------------------------------------------------------------

class HighlightHost extends FakeHost {
  highlight(id, line, col, length) { this.hit = { id, line, col, length } }
  clearHighlight() { this.hit = null }
}

const cleanups = []
after(() => { for (const f of cleanups) f() })

async function openStore(files) {
  const api = makeApi({ files })
  api.search = async (root, query) => ({ results: [{ path: 'a.txt', matches: [m(2, 3)] }], truncated: false, took: 1 })
  const host = new HighlightHost()
  const store = new EditorStore({ api, storage: new MemoryStorage(), confirm: () => true, gitDelayMs: 1, Socket: FakeSocket, wsDelay: () => 5 })
  cleanups.push(() => store.dispose())
  store.attachHost(host)
  await store.setWorkspaces(['/w/proj'])
  return { store, host, api }
}

test('store: a search result opens the file at the match and highlights it', async () => {
  const { store, host } = await openStore({ 'a.txt': { content: 'one\ntwo foo\nthree\n', mtime: 1 } })
  store.search.setText({ q: 'foo' })
  await until(() => store.search.getState().status === 'done', 'search')
  await store.search.openMatch('a.txt', 0)
  assert.equal(store.getState().active, 'file:a.txt')
  assert.deepEqual(host.revealed, { line: 2, col: 3 })
  assert.deepEqual(host.hit, { id: 'file:a.txt', line: 2, col: 3, length: 3 })
  // the shortcut path: F4 steps to the next match and opens it
  host.revealed = null
  store.searchKey('searchNext')
  await until(() => host.revealed !== null, 'F4 reveal')
})

test('store: changing the folder resets the search; searchFiles shows the view', async () => {
  const { store } = await openStore({ 'a.txt': { content: 'x\n', mtime: 1 } })
  store.searchKey('searchFiles')
  assert.equal(store.search.getState().view, 'search')
  assert.equal(store.search.getState().focus, 1)
  store.search.setText({ q: 'foo' })
  await until(() => store.search.getState().status === 'done', 'search')
  await store.openFolder('/w/other')
  assert.equal(store.search.getState().results.length, 0)
})

// ---- shortcuts -----------------------------------------------------------------------------------------------------

const key = (k, o = {}) => ({ key: k, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o })

test('shortcuts: Ctrl+Shift+F / Ctrl+Shift+H search, F4 / Shift+F4 step, existing keys unchanged', () => {
  assert.equal(matchShortcut(key('F', { ctrlKey: true, shiftKey: true })), 'searchFiles')
  assert.equal(matchShortcut(key('H', { ctrlKey: true, shiftKey: true })), 'searchFiles')
  assert.equal(matchShortcut(key('f', { metaKey: true, shiftKey: true })), 'searchFiles')
  assert.equal(matchShortcut(key('Ф', { ctrlKey: true, shiftKey: true, code: 'KeyF' })), 'searchFiles')
  assert.equal(matchShortcut(key('F4')), 'searchNext')
  assert.equal(matchShortcut(key('F4', { shiftKey: true })), 'searchPrev')
  assert.equal(matchShortcut(key('F4', { ctrlKey: true })), 'closeTab')
  assert.equal(matchShortcut(key('F4', { altKey: true })), null)
  assert.equal(matchShortcut(key('f', { ctrlKey: true })), null)
  assert.equal(matchShortcut(key('f', { ctrlKey: true, shiftKey: true, altKey: true })), null)
  assert.equal(matchShortcut(key('e', { ctrlKey: true })), 'quickOpen')
  assert.equal(matchShortcut(key('s', { ctrlKey: true })), 'save')
  // typing in an input of the view: the search keys still work (Ctrl+S would not)
  const input = { editable: true, inMonaco: false, inQuickOpen: false }
  assert.equal(actionFor(key('F', { ctrlKey: true, shiftKey: true }), input), 'searchFiles')
  assert.equal(actionFor(key('F4'), input), 'searchNext')
  assert.equal(actionFor(key('s', { ctrlKey: true }), input), null)
})

test('shortcuts: an editable thing outside the Code view keeps its keys', () => {
  const outsideInput = { tagName: 'INPUT', isContentEditable: false, closest: () => null }
  const view = { contains: () => false }
  assert.equal(pageAction({ ...key('F', { ctrlKey: true, shiftKey: true }), target: outsideInput }, view), null)
  assert.equal(pageAction({ ...key('F', { ctrlKey: true, shiftKey: true }), target: { tagName: 'BODY', closest: () => null } }, view), 'searchFiles')
})
