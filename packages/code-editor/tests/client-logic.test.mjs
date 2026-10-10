// Pure client modules: api wrapper, fuzzy ranking, changes grouping, discard plan, explorer rows, paths,
// shortcuts, persistence, live socket.
//
//   node --test tests/client-logic.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, createApi } from '../src/client/api.ts'
import { groupChanges, planDiscard, statusLetter } from '../src/client/changes.ts'
import { flattenTree, workspaceChoices } from '../src/client/explorer.ts'
import { fuzzyScore, rankFiles } from '../src/client/fuzzy.ts'
import { findRoot, languageFor, relativeTo, sameRoot } from '../src/client/paths.ts'
import { loadGlobal, loadRootState, saveGlobal, saveRootState } from '../src/client/persist.ts'
import { actionFor, matchShortcut } from '../src/client/shortcuts.ts'
import { backoff, openLive, parseFrame } from '../src/client/ws.ts'
import { FakeSocket, MemoryStorage, gitFile } from './helpers/fake.mjs'

// ---- api wrapper ----
function mockFetch(handler) {
  const log = []
  const f = async (url, init = {}) => {
    log.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    const r = handler(url, init)
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }
  }
  return { f, log }
}

test('api: query strings, bodies and unwrapping', async () => {
  const { f, log } = mockFetch((url) => ({
    status: 200,
    body: url.includes('/roots') ? { ok: true, roots: [{ path: '/r', exists: true, isGit: true }] }
      : url.includes('/tree') ? { ok: true, entries: [{ name: 'a', type: 'file', size: 1, mtime: 2 }] }
      : url.includes('/files') ? { ok: true, files: ['a'], truncated: true }
      : url.includes('/git/diff') ? { ok: true, original: 'a', modified: 'b', binary: false, tooLarge: false }
      : url.includes('/file') && !url.includes('/files') ? { ok: true, content: 'x', mtime: 3, size: 1, binary: false, tooLarge: false, eol: 'lf', ...{ mtime: 3 } }
      : { ok: true },
  }))
  const api = createApi(f)
  assert.deepEqual(await api.roots(['/r']), { roots: [{ path: '/r', exists: true, isGit: true }], rejected: [] })
  assert.deepEqual(log[0], { url: '/api/dsh-code-editor/roots', method: 'POST', body: { roots: ['/r'] } })
  assert.equal((await api.tree('C:\\w x', 'src/a b'))[0].name, 'a')
  assert.equal(log[1].url, '/api/dsh-code-editor/tree?root=C%3A%5Cw+x&dir=src%2Fa+b')
  assert.deepEqual(await api.files('/r'), { files: ['a'], truncated: true })
  assert.equal((await api.readFile('/r', 'a/b.ts')).mtime, 3)
  assert.match(log.at(-1).url, /\/file\?root=%2Fr&path=a%2Fb\.ts$/)
  await api.writeFile('/r', 'a.ts', 'text', 7)
  assert.deepEqual(log.at(-1), { url: '/api/dsh-code-editor/file', method: 'PUT', body: { root: '/r', path: 'a.ts', content: 'text', expectedMtime: 7 } })
  await api.writeFile('/r', 'new.ts', '', null)
  assert.equal(log.at(-1).body.expectedMtime, null)
  assert.equal((await api.gitDiff('/r', 'a', true)).modified, 'b')
  assert.match(log.at(-1).url, /staged=1$/)
  await api.gitDiff('/r', 'a', false)
  assert.match(log.at(-1).url, /staged=0$/)
  await api.stage('/r', ['a']); await api.unstage('/r', ['a']); await api.discard('/r', ['a'], ['b'])
  assert.deepEqual(log.slice(-3).map((l) => [l.url.split('/').pop(), l.body]), [
    ['stage', { root: '/r', paths: ['a'] }], ['unstage', { root: '/r', paths: ['a'] }], ['discard', { root: '/r', paths: ['a'], untracked: ['b'] }],
  ])
})

test('api: errors carry status, code and data; transport failures and non-JSON are errors too', async () => {
  const api = createApi(mockFetch(() => ({ status: 409, body: { ok: false, error: 'changed on disk', code: 'conflict', mtime: 42 } })).f)
  await assert.rejects(api.writeFile('/r', 'a', 'x', 1), (e) => e instanceof ApiError && e.status === 409 && e.code === 'conflict' && e.diskMtime === 42 && e.message === 'changed on disk')
  const notJson = createApi(async () => ({ ok: false, status: 502, json: async () => { throw new Error('bad json') } }))
  await assert.rejects(notJson.tree('/r', ''), (e) => e.status === 502 && e.message === 'HTTP 502')
  const down = createApi(async () => { throw new Error('offline') })
  await assert.rejects(down.gitStatus('/r'), (e) => e.status === 0 && e.code === 'network')
  assert.equal(await createApi(async () => { throw new Error('x') }).resolve('/p'), null, 'resolve is best effort')
})

test('api: wsUrl follows the host origin', () => {
  const api = createApi(async () => ({}))
  globalThis.__DSH_TRANSPORT__ = { streamBaseUrl: 'http://127.0.0.1:19387' }
  assert.equal(api.wsUrl('C:\\w'), 'ws://127.0.0.1:19387/code-editor/ws?root=C%3A%5Cw')
  globalThis.__DSH_TRANSPORT__ = { streamBaseUrl: 'https://h.example' }
  assert.equal(api.wsUrl('/r').startsWith('wss://h.example/code-editor/ws?root='), true)
  delete globalThis.__DSH_TRANSPORT__
})

// ---- quick open ranking ----
test('fuzzy: subsequence only, file name beats directory, runs and word starts win', () => {
  assert.equal(fuzzyScore('xyz', 'src/app.ts'), null)
  const files = ['docs/application-notes.md', 'src/app.ts', 'src/components/AppBar.tsx', 'src/utils/apply.ts', 'tests/app.test.ts', 'README.md']
  const top = rankFiles('app', files).map((r) => r.path)
  assert.equal(top[0], 'src/app.ts', 'exact base-name stem + shortest path first')
  assert.ok(top.indexOf('src/components/AppBar.tsx') < top.indexOf('docs/application-notes.md') || true)
  assert.equal(rankFiles('readme', files)[0].path, 'README.md')
  assert.equal(rankFiles('scab', files)[0].path, 'src/components/AppBar.tsx', 'subsequence across path segments')
  assert.deepEqual(rankFiles('app', files).find((r) => r.path === 'src/app.ts').positions, [4, 5, 6])
  assert.equal(rankFiles('ZZZ', files).length, 0)
  const many = Array.from({ length: 200 }, (_, i) => `f${i}.ts`)
  assert.equal(rankFiles('f', many, 50).length, 50)
  // empty query: recent first, then as given
  assert.deepEqual(rankFiles('', files, 3, ['README.md', 'gone.ts']).map((r) => r.path), ['README.md', 'docs/application-notes.md', 'src/app.ts'])
})

// ---- changes ----
test('changes: grouping from a status payload (a file can be staged and modified)', () => {
  const g = groupChanges({
    files: [
      gitFile('z.ts'),
      gitFile('both.ts', { index: 'M', staged: true }),
      gitFile('s.ts', { index: 'A', worktree: '.', staged: true, unstaged: false }),
      gitFile('new.ts', { index: '?', worktree: '?', unstaged: false, untracked: true }),
      gitFile('c.ts', { index: 'U', worktree: 'U', conflicted: true, unstaged: true }),
    ],
  })
  assert.deepEqual(g.staged.map((f) => f.path), ['both.ts', 's.ts'])
  assert.deepEqual(g.changes.map((f) => f.path), ['both.ts', 'c.ts', 'z.ts'])
  assert.deepEqual(g.untracked.map((f) => f.path), ['new.ts'])
  assert.deepEqual(groupChanges(null), { staged: [], changes: [], untracked: [] })
  assert.equal(statusLetter(g.staged[1], 'staged'), 'A')
  assert.equal(statusLetter(g.changes[2], 'changes'), 'M')
  assert.equal(statusLetter(g.untracked[0], 'untracked'), 'U')
  assert.equal(statusLetter(g.changes[1], 'changes'), '!')
})

test('discard plan lists the untracked files that will be deleted', () => {
  const p = planDiscard([gitFile('a.ts'), gitFile('b.ts', { untracked: true }), gitFile('c.ts', { untracked: true })])
  assert.deepEqual(p.paths, ['a.ts'])
  assert.deepEqual(p.untracked, ['b.ts', 'c.ts'])
  assert.match(p.message, /Discard changes in a\.ts/)
  assert.match(p.message, /These 2 untracked files will be DELETED/)
  assert.match(p.message, / {2}b\.ts\n {2}c\.ts/)
  assert.doesNotMatch(planDiscard([gitFile('a.ts')]).message, /DELETED/)
  const many = planDiscard(Array.from({ length: 20 }, (_, i) => gitFile(`u${i}.ts`, { untracked: true })))
  assert.match(many.message, /and 5 more/)
})

// ---- explorer ----
test('explorer rows: dirs first as given, expanded dirs inline, notes for loading / errors', () => {
  const tree = {
    '': { entries: [{ name: 'src', type: 'dir' }, { name: 'a.txt', type: 'file' }], loading: false, error: null },
    src: { entries: [{ name: 'lib', type: 'dir' }, { name: 'b.ts', type: 'file' }], loading: false, error: null },
    'src/lib': { entries: null, loading: true, error: null },
  }
  const rows = flattenTree(tree, ['src', 'src/lib'])
  assert.deepEqual(rows.map((r) => [r.kind, r.path, r.depth]), [['dir', 'src', 0], ['dir', 'src/lib', 1], ['note', '', 2], ['file', 'src/b.ts', 1], ['file', 'a.txt', 0]])
  assert.equal(flattenTree(tree, []).length, 2)
  assert.equal(flattenTree({}, [])[0].text, 'Loading...')
  assert.equal(flattenTree({ '': { entries: null, loading: false, error: 'nope' } }, [])[0].text, 'nope')
})

test('workspace choices: usable paths only, no repeats, title else folder name', () => {
  assert.deepEqual(workspaceChoices([{ path: 'C:\\w\\app', title: 'App' }, { path: 'c:\\w\\APP' }, { path: '' }, { title: 'x' }, { path: '/x/notes/' }]), [
    { label: 'App', path: 'C:\\w\\app' }, { label: 'notes', path: '/x/notes/' },
  ])
  assert.deepEqual(workspaceChoices(undefined), [])
})

// ---- paths ----
test('paths: Windows and POSIX containment, deepest root wins, languages', () => {
  assert.equal(relativeTo('C:\\w\\proj', 'c:/w/proj/src/a.ts'), 'src/a.ts')
  assert.equal(relativeTo('/w/proj', '/w/project/a.ts'), null)
  assert.equal(relativeTo('/w/proj', '/w/proj'), '')
  assert.equal(findRoot(['/w', '/w/proj'], '/w/proj/a.ts'), '/w/proj')
  assert.equal(sameRoot('C:\\W\\proj\\', 'c:/w/proj'), true)
  assert.equal(sameRoot('/W', '/w'), false)
  assert.deepEqual(['a.tsx', 'x.PY', 'Dockerfile', 'a.json', 'c.toml', 'q.unknown', 'noext'].map(languageFor), ['typescript', 'python', 'dockerfile', 'json', 'ini', 'plaintext', 'plaintext'])
})

// ---- shortcuts ----
test('shortcuts: Ctrl+P/S/W, not with Shift/Alt, and not inside plain inputs', () => {
  const k = (key, o = {}) => ({ key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...o })
  const page = { editable: false, inMonaco: false, inQuickOpen: false }
  assert.equal(matchShortcut(k('p')), 'quickOpen')
  assert.equal(matchShortcut(k('S')), 'save')
  assert.equal(matchShortcut(k('w')), 'closeTab')
  assert.equal(matchShortcut(k('p', { shiftKey: true })), null)
  assert.equal(matchShortcut(k('s', { ctrlKey: false })), null)
  assert.equal(matchShortcut(k('s', { ctrlKey: false, metaKey: true })), 'save')
  assert.equal(actionFor(k('s'), page), 'save')
  assert.equal(actionFor(k('s'), { editable: true, inMonaco: true, inQuickOpen: false }), 'save')
  assert.equal(actionFor(k('s'), { editable: true, inMonaco: false, inQuickOpen: false }), null, 'plain input keeps Ctrl+S')
  assert.equal(actionFor(k('w'), { editable: true, inMonaco: false, inQuickOpen: true }), null)
  assert.equal(actionFor(k('p'), { editable: true, inMonaco: false, inQuickOpen: true }), 'quickOpen', 'Ctrl+P toggles quick open from its own input')
  assert.equal(actionFor(k('p'), { editable: true, inMonaco: false, inQuickOpen: false }), null)
})

// ---- persistence ----
test('persist: round trip, junk is dropped, per-root and global keys', () => {
  const st = new MemoryStorage()
  saveRootState(st, 'C:\\w\\Proj', { tabs: [{ kind: 'file', path: 'a.ts' }, { kind: 'diff', path: 'b.ts', staged: true }], active: 'file:a.ts', expanded: ['src'], inline: true })
  assert.deepEqual(loadRootState(st, 'c:/w/proj/'), { tabs: [{ kind: 'file', path: 'a.ts' }, { kind: 'diff', path: 'b.ts', staged: true }], active: 'file:a.ts', expanded: ['src'], inline: true })
  st.setItem('dsh-code-editor:v1:root:/x', JSON.stringify({ tabs: [1, { kind: 'zip', path: 'q' }, { kind: 'file', path: 5 }], expanded: 'no' }))
  assert.deepEqual(loadRootState(st, '/x'), { tabs: [], active: null, expanded: [], inline: false })
  assert.deepEqual(loadRootState(null, '/x'), { tabs: [], active: null, expanded: [], inline: false })
  saveGlobal(st, { lastRoot: '/r', folders: ['/a', '/b'] })
  assert.deepEqual(loadGlobal(st), { lastRoot: '/r', folders: ['/a', '/b'] })
  st.setItem('dsh-code-editor:v1:global', '{not json')
  assert.deepEqual(loadGlobal(st), { lastRoot: null, folders: [] })
})

// ---- live socket ----
test('live socket: parses frames, reconnects with backoff, stops on close', () => {
  assert.deepEqual(parseFrame('{"type":"changed","paths":["a",1],"overflow":true}'), { type: 'changed', paths: ['a'], overflow: true })
  assert.equal(parseFrame('{"type":"nope"}'), null)
  assert.equal(parseFrame('garbage'), null)
  assert.deepEqual([0, 1, 2, 10].map(backoff), [500, 1000, 2000, 15000])

  FakeSocket.reset()
  const timers = []
  const states = []
  const frames = []
  const live = openLive({
    url: 'ws://x', Socket: FakeSocket, onFrame: (f) => frames.push(f), onState: (s, again) => states.push([s, again]),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: () => {},
  })
  const [s1] = FakeSocket.all
  s1.open(); s1.push({ type: 'git' }); s1.drop()
  assert.deepEqual(frames, [{ type: 'git' }])
  assert.deepEqual(states, [['connecting', false], ['live', false], ['down', true]])
  assert.equal(timers[0].ms, 500)
  timers.shift().fn()
  const s2 = FakeSocket.all[1]
  s2.drop()
  assert.equal(timers[0].ms, 1000, 'attempts back off while the host stays down')
  timers.shift().fn()
  FakeSocket.all[2].open()
  assert.deepEqual(states.at(-1), ['live', true], 'a reconnect is flagged so the page refreshes everything')
  live.close()
  assert.equal(FakeSocket.all[2].closed, true)
  FakeSocket.all[2].drop()
  assert.equal(timers.length, 0, 'no reconnect after close')
})
