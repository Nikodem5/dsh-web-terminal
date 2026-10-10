// The page logic (store.ts) against an in-memory host API and a fake editor host: roots, explorer, tabs,
// dirty / save / conflict state machine, live frames, git changes, persistence and the cross-plugin open request.
//
//   node --test tests/client-store.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/client/api.ts'
import { EditorStore } from '../src/client/store.ts'
import { FakeHost, FakeSocket, MemoryStorage, gitFile, makeApi, sleep, until } from './helpers/fake.mjs'

async function setup(o = {}) {
  FakeSocket.reset()
  const api = makeApi(o)
  const storage = o.storage ?? new MemoryStorage()
  const confirms = []
  const panel = { n: 0 }
  const store = new EditorStore({
    api, storage, picker: o.picker, Socket: FakeSocket, gitDelayMs: 1, wsDelay: () => 5, selectPanel: () => { panel.n++ },
    confirm: (m) => { confirms.push(m); return o.confirm ?? true },
  })
  const host = new FakeHost()
  store.attachHost(host)
  if (o.workspaces !== false) {
    await store.setWorkspaces(o.workspaces ?? ['/w/proj'])
    await until(() => store.getState().tree[''] && !store.getState().tree[''].loading, 'root tree')
  }
  return { api, store, host, storage, confirms, panel, sock: () => FakeSocket.all[FakeSocket.all.length - 1] }
}
const calls = (api, name) => api.calls.filter((c) => c[0] === name)

test('workspaces are registered and the first becomes the root; explorer loads lazily', async () => {
  const { api, store } = await setup({ workspaces: ['/w/proj', '/w/other'] })
  assert.deepEqual(calls(api, 'roots')[0][1], ['/w/proj', '/w/other'])
  assert.equal(store.getState().root, '/w/proj')
  assert.deepEqual(store.getState().tree[''].entries.map((e) => e.name), ['src', 'a.txt'])
  assert.equal(store.getState().tree.src, undefined, 'subfolders are not loaded until expanded')
  await store.toggleDir('src')
  assert.deepEqual(store.getState().tree.src.entries.map((e) => e.name), ['b.ts'])
  assert.deepEqual(store.getState().expanded, ['src'])
  await store.toggleDir('src')
  assert.deepEqual(store.getState().expanded, [])
})

test('opening a file loads it into the editor, clean; typing marks it dirty; saving PUTs with expectedMtime', async () => {
  const { api, store, host } = await setup()
  await store.openFile('a.txt')
  const t = store.tab('file:a.txt')
  assert.equal(t.loaded, true)
  assert.equal(host.shown, 'file:a.txt')
  assert.equal(host.getValue('file:a.txt'), 'hello\n')
  assert.equal(t.dirty, false)
  host.type('file:a.txt', 'hello world\n')
  assert.equal(store.tab('file:a.txt').dirty, true)
  assert.equal(await store.save(), true)
  assert.deepEqual(calls(api, 'writeFile')[0], ['writeFile', '/w/proj', 'a.txt', 'hello world\n', 1])
  const after = store.tab('file:a.txt')
  assert.equal(after.dirty, false)
  assert.equal(after.mtime, 11, 'the returned mtime is the next expectedMtime')
  host.type('file:a.txt', 'again\n')
  await store.save()
  assert.equal(calls(api, 'writeFile')[1][4], 11)
  host.type('file:a.txt', 'hello world\n')
  assert.equal(store.tab('file:a.txt').dirty, true, 'typing back to a different text than the saved one is dirty')
})

test('409 on save raises the conflict; Overwrite writes with the disk mtime; Reload takes the disk text', async () => {
  const { api, store, host } = await setup()
  await store.openFile('a.txt')
  host.type('file:a.txt', 'mine\n')
  api.fs.set('a.txt', { content: 'theirs\n', mtime: 5 })
  assert.equal(await store.save(), false)
  assert.deepEqual(store.tab('file:a.txt').conflict, { mtime: 5, deleted: false })
  assert.equal(store.tab('file:a.txt').dirty, true, 'my edits are kept')
  // Overwrite
  assert.equal(await store.overwrite('file:a.txt'), true)
  assert.equal(calls(api, 'writeFile').at(-1)[4], 5)
  assert.equal(api.fs.get('a.txt').content, 'mine\n')
  assert.equal(store.tab('file:a.txt').conflict, null)
  // Reload
  host.type('file:a.txt', 'more of mine\n')
  api.fs.set('a.txt', { content: 'disk again\n', mtime: 30 })
  await store.save()
  assert.ok(store.tab('file:a.txt').conflict)
  await store.reload('file:a.txt')
  assert.equal(host.getValue('file:a.txt'), 'disk again\n')
  const t = store.tab('file:a.txt')
  assert.equal(t.dirty, false)
  assert.equal(t.conflict, null)
  assert.equal(t.mtime, 30)
})

test('Compare opens a disk-vs-mine diff tab; resolving it keeps mine or the disk version', async () => {
  const { api, store, host } = await setup()
  await store.openFile('a.txt')
  host.type('file:a.txt', 'mine\n')
  api.fs.set('a.txt', { content: 'theirs\n', mtime: 7 })
  await store.save()
  await store.compare('file:a.txt')
  assert.equal(store.getState().active, 'cmp:a.txt')
  assert.deepEqual(host.diffShown && [host.diffShown.original, host.diffShown.modified], ['theirs\n', 'mine\n'])
  await store.resolveCompare('cmp:a.txt', 'mine')
  assert.equal(store.tab('cmp:a.txt'), undefined)
  assert.equal(api.fs.get('a.txt').content, 'mine\n')
  assert.equal(store.getState().active, 'file:a.txt')
  // and the other way
  host.type('file:a.txt', 'again mine\n')
  api.fs.set('a.txt', { content: 'theirs 2\n', mtime: 50 })
  await store.save()
  await store.compare('file:a.txt')
  await store.resolveCompare('cmp:a.txt', 'disk')
  assert.equal(host.getValue('file:a.txt'), 'theirs 2\n')
  assert.equal(store.tab('file:a.txt').dirty, false)
})

test('closing a dirty tab asks first; clean tabs close silently; the neighbour becomes active', async () => {
  const { store, host, confirms } = await setup({ files: { 'a.txt': { content: 'a', mtime: 1 }, 'b.txt': { content: 'b', mtime: 1 }, 'c.txt': { content: 'c', mtime: 1 } } })
  await store.openFile('a.txt'); await store.openFile('b.txt'); await store.openFile('c.txt')
  assert.deepEqual(store.getState().tabs.map((t) => t.path), ['a.txt', 'b.txt', 'c.txt'])
  host.type('file:b.txt', 'bb')
  await store.activate('file:b.txt')
  const asked = confirms.length
  const res = { confirm: false }
  store.deps.confirm = (m) => { confirms.push(m); return res.confirm }
  assert.equal(store.closeTab('file:b.txt'), false, 'declined')
  assert.ok(store.tab('file:b.txt'))
  assert.equal(confirms.length, asked + 1)
  assert.match(confirms.at(-1), /unsaved/)
  res.confirm = true
  assert.equal(store.closeTab('file:b.txt'), true)
  assert.equal(store.tab('file:b.txt'), undefined)
  assert.equal(host.hasModel('file:b.txt'), false, 'model disposed')
  assert.equal(store.getState().active, 'file:c.txt')
  const n = confirms.length
  store.closeTab('file:c.txt')
  assert.equal(confirms.length, n, 'a clean tab closes without asking')
  assert.equal(store.getState().active, 'file:a.txt')
  store.closeTab('file:a.txt')
  assert.equal(store.getState().active, null)
})

test('live frames: a clean open tab reloads silently; a dirty one gets the conflict bar; our own save is ignored', async () => {
  const { api, store, host, sock } = await setup()
  await store.openFile('a.txt')
  const s = sock()
  s.open()
  s.push({ type: 'hello', root: '/w/proj' })
  // external change, tab clean
  api.fs.set('a.txt', { content: 'external\n', mtime: 4 })
  s.push({ type: 'changed', paths: ['a.txt'] })
  await until(() => host.getValue('file:a.txt') === 'external\n', 'silent reload')
  assert.equal(store.tab('file:a.txt').dirty, false)
  assert.equal(store.tab('file:a.txt').mtime, 4)
  // our own save echoes a changed frame with the same mtime: no reload, no conflict
  host.type('file:a.txt', 'mine\n')
  await store.save()
  const reads = calls(api, 'readFile').length
  s.push({ type: 'changed', paths: ['a.txt'] })
  await until(() => calls(api, 'readFile').length > reads, 'echo read')
  await sleep(10)
  assert.equal(store.tab('file:a.txt').conflict, null)
  assert.equal(host.getValue('file:a.txt'), 'mine\n')
  // external change while dirty
  host.type('file:a.txt', 'dirty edit\n')
  api.fs.set('a.txt', { content: 'external 2\n', mtime: 99 })
  s.push({ type: 'changed', paths: ['a.txt'] })
  await until(() => store.tab('file:a.txt').conflict, 'conflict bar')
  assert.equal(store.tab('file:a.txt').conflict.mtime, 99)
  assert.equal(host.getValue('file:a.txt'), 'dirty edit\n', 'my buffer is untouched')
  // deleted on disk while dirty
  api.fs.delete('a.txt')
  s.push({ type: 'changed', paths: ['a.txt'] })
  await until(() => store.tab('file:a.txt').conflict?.deleted === true, 'deleted marker')
})

test('changed frames refresh only the loaded parent directories; overflow reloads all', async () => {
  const { api, store, sock } = await setup()
  await store.toggleDir('src')
  const s = sock()
  s.open()
  const n = () => calls(api, 'tree').length
  const before = n()
  s.push({ type: 'changed', paths: ['src/new.ts'] })
  await until(() => n() === before + 1, 'src refresh')
  assert.equal(calls(api, 'tree').at(-1)[2], 'src')
  const b2 = n()
  s.push({ type: 'changed', paths: ['deep/er/x.ts'] })
  await sleep(30)
  assert.equal(n(), b2, 'an unloaded directory is not fetched')
  s.push({ type: 'changed', paths: [], overflow: true })
  await until(() => n() >= b2 + 2, 'overflow reload')
})

test('git frames and the socket: refresh status; reconnect refreshes everything', async () => {
  const { api, store, sock } = await setup({ status: { branch: 'main', ahead: 1, behind: 0, files: [gitFile('a.txt')] } })
  const s = sock()
  s.open()
  await until(() => store.getState().git.status, 'initial status')
  assert.equal(store.getState().live, 'live')
  api.setStatus({ branch: 'dev', ahead: 0, behind: 2, files: [] })
  s.push({ type: 'git' })
  await until(() => store.getState().git.status.branch === 'dev', 'git frame refresh')
  // drop and reconnect
  s.drop()
  assert.equal(store.getState().live, 'down')
  await until(() => FakeSocket.all.length === 2, 'reconnect attempt')
  const reads = calls(api, 'gitStatus').length
  FakeSocket.all[1].open()
  assert.equal(store.getState().live, 'live')
  await until(() => calls(api, 'gitStatus').length > reads, 'refresh after reconnect')
})

test('a non-git folder shows notGit; stage / unstage / stage all hit the API and refresh', async () => {
  const ng = await setup({ notGit: true })
  await until(() => ng.store.getState().git.notGit, 'not-git flag')
  const files = [
    gitFile('m.ts'),
    gitFile('s.ts', { index: 'M', worktree: '.', staged: true, unstaged: false }),
    gitFile('u.ts', { index: '?', worktree: '?', staged: false, unstaged: false, untracked: true }),
  ]
  const { api, store } = await setup({ status: { branch: 'main', ahead: 0, behind: 0, files } })
  await until(() => store.getState().git.status, 'status')
  await store.stage(['m.ts'])
  assert.deepEqual(calls(api, 'stage')[0], ['stage', '/w/proj', ['m.ts']])
  await store.unstage(['s.ts'])
  assert.deepEqual(calls(api, 'unstage')[0], ['unstage', '/w/proj', ['s.ts']])
  await store.stageAll()
  assert.deepEqual(calls(api, 'stage')[1][2].sort(), ['m.ts', 'u.ts'])
  await store.unstageAll()
  assert.deepEqual(calls(api, 'unstage')[1][2], ['s.ts'])
})

test('discard confirms, lists untracked files, and sends tracked and untracked separately; cancel does nothing', async () => {
  const files = [gitFile('m.ts'), gitFile('u1.ts', { untracked: true, unstaged: false }), gitFile('u2.ts', { untracked: true, unstaged: false })]
  const { api, store, confirms } = await setup({ status: { branch: 'main', ahead: 0, behind: 0, files }, confirm: false })
  assert.equal(await store.discard(files), false)
  assert.equal(calls(api, 'discard').length, 0)
  assert.match(confirms.at(-1), /DELETED/)
  assert.match(confirms.at(-1), /u1\.ts/)
  assert.match(confirms.at(-1), /u2\.ts/)
  store.deps.confirm = (m) => { confirms.push(m); return true }
  assert.equal(await store.discard(files), true)
  assert.deepEqual(calls(api, 'discard')[0], ['discard', '/w/proj', ['m.ts'], ['u1.ts', 'u2.ts']])
})

test('diff tabs: staged vs unstaged ids and sides; reloaded on a git frame', async () => {
  const { api, store, host, sock } = await setup({ status: { branch: 'main', ahead: 0, behind: 0, files: [gitFile('a.txt')] } })
  await store.openDiff('a.txt', false)
  assert.equal(store.getState().active, 'diff:w:a.txt')
  assert.deepEqual(calls(api, 'gitDiff')[0], ['gitDiff', '/w/proj', 'a.txt', false])
  assert.equal(host.diffShown.original, 'INDEX a.txt')
  assert.equal(host.diffShown.modified, 'WORK a.txt')
  await store.openDiff('a.txt', true)
  assert.equal(store.getState().active, 'diff:s:a.txt')
  assert.equal(host.diffShown.original, 'HEAD a.txt')
  store.setInline(true)
  assert.equal(host.diffShown.inline, true)
  assert.equal(store.getState().inline, true)
  const n = calls(api, 'gitDiff').length
  sock().open()
  sock().push({ type: 'git' })
  await until(() => calls(api, 'gitDiff').length >= n + 2, 'diff tabs refreshed on git frame')
})

test('persistence: tabs, active tab, expanded dirs and diff mode survive a restart; a throwing storage is harmless', async () => {
  const storage = new MemoryStorage()
  const a = await setup({ storage })
  await a.store.toggleDir('src')
  await a.store.openFile('a.txt')
  await a.store.openDiff('a.txt', true)
  a.store.setInline(true)
  await a.store.activate('file:a.txt')
  const b = await setup({ storage })
  await until(() => b.store.getState().tabs.length === 2, 'tabs restored')
  assert.deepEqual(b.store.getState().tabs.map((t) => t.id), ['file:a.txt', 'diff:s:a.txt'])
  assert.equal(b.store.getState().active, 'file:a.txt')
  assert.deepEqual(b.store.getState().expanded, ['src'])
  assert.equal(b.store.getState().inline, true)
  await until(() => b.store.tab('file:a.txt').loaded, 'active tab loaded')
  assert.equal(b.host.shown, 'file:a.txt')
  assert.equal(b.store.tab('diff:s:a.txt').loaded, false, 'inactive tabs load lazily')

  const bad = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  const c = await setup({ storage: bad })
  await c.store.openFile('a.txt')
  assert.equal(c.store.getState().active, 'file:a.txt')
})

test('switching root asks when tabs are dirty and restores that root\'s own state', async () => {
  const { store, host, confirms } = await setup({ workspaces: ['/w/one', '/w/two'] })
  await store.openFile('a.txt')
  host.type('file:a.txt', 'x')
  store.deps.confirm = (m) => { confirms.push(m); return false }
  assert.equal(await store.selectRoot('/w/two'), false)
  assert.equal(store.getState().root, '/w/one')
  store.deps.confirm = () => true
  assert.equal(await store.selectRoot('/w/two'), true)
  assert.equal(store.getState().root, '/w/two')
  assert.deepEqual(store.getState().tabs, [])
  assert.equal(host.hasModel('file:a.txt'), false)
})

test('open request: resolves the registered root, opens at line/col, selects the panel; unknown folders are registered', async () => {
  const { api, store, host, panel } = await setup({ files: { 'src/b.ts': { content: 'one\ntwo\nthree\n', mtime: 1 } } })
  assert.equal(await store.handleOpenRequest({ path: '/w/proj/src/b.ts', line: 2, col: 3 }), true)
  assert.equal(store.getState().active, 'file:src/b.ts')
  assert.deepEqual(host.revealed, { line: 2, col: 3 })
  assert.ok(panel.n >= 1)
  assert.equal(calls(api, 'resolve').length, 0, 'a path under a known root needs no resolving')
  assert.deepEqual(store.getState().expanded, ['src'], 'the explorer reveals the file')
  // outside every root: ask the host (PROPOSED /resolve), fall back to the parent folder
  assert.equal(await store.handleOpenRequest({ path: '/else/where/x.txt' }), true)
  assert.deepEqual(calls(api, 'resolve').at(-1), ['resolve', '/else/where/x.txt'])
  assert.equal(store.getState().root, '/else/where')
  // an explicit root wins
  assert.equal(await store.handleOpenRequest({ path: '/w/proj/a.txt', root: '/w/proj' }), true)
  assert.equal(store.getState().root, '/w/proj')
  // garbage is ignored
  assert.equal(await store.handleOpenRequest({}), false)
  assert.equal(await store.handleOpenRequest(null), false)
})

test('open request with review opens the diff of a changed file', async () => {
  const files = [gitFile('a.txt')]
  const { store } = await setup({ status: { branch: 'main', ahead: 0, behind: 0, files } })
  await store.handleOpenRequest({ path: '/w/proj/a.txt', review: true })
  assert.equal(store.getState().active, 'diff:w:a.txt')
  await store.handleOpenRequest({ path: '/w/proj/clean.txt', review: true })
  assert.equal(store.getState().active, 'file:clean.txt', 'an unchanged file falls back to the plain file')
})

test('open request uses the harness-reported git top-level when the host resolves one', async () => {
  const { store, api } = await setup({ resolve: (p) => ({ root: '/repo', isGit: true }) })
  await store.handleOpenRequest({ path: '/repo/sub/x.txt' })
  assert.equal(store.getState().root, '/repo')
  assert.ok(calls(api, 'roots').some((c) => c[1].includes('/repo')))
})

test('quick-open file list is cached until a changed frame', async () => {
  const { api, store, sock } = await setup()
  await store.ensureFiles(); await store.ensureFiles()
  assert.equal(calls(api, 'files').length, 1)
  sock().open()
  sock().push({ type: 'changed', paths: ['x'] })
  await sleep(10)
  await store.ensureFiles()
  assert.equal(calls(api, 'files').length, 2)
})

test('binary and too-large files load without an editor model', async () => {
  const { store, host } = await setup({ files: { 'img.png': { content: '', mtime: 1, binary: true }, 'big.txt': { content: '', mtime: 1, tooLarge: true } } })
  await store.openFile('img.png')
  assert.equal(store.tab('file:img.png').binary, true)
  assert.equal(host.hasModel('file:img.png'), false)
  await store.openFile('big.txt')
  assert.equal(store.tab('file:big.txt').tooLarge, true)
})

test('a failed load shows an error on the tab instead of throwing', async () => {
  const { api, store } = await setup()
  api.failNext.readFile = new Error('boom')
  await store.openFile('a.txt')
  assert.equal(store.tab('file:a.txt').error, 'boom')
  assert.equal(store.tab('file:a.txt').loaded, false)
})

test('open request: a folder with review shows the CHANGES view of its root (no file tab), refreshing git', async () => {
  const files = [gitFile('a.txt')]
  const { store, api } = await setup({ status: { branch: 'main', ahead: 0, behind: 0, files } })
  const before = store.getState().changesFocus
  const gitCalls = calls(api, 'gitStatus').length
  assert.equal(await store.handleOpenRequest({ path: '/w/proj', review: true }), true)
  assert.equal(store.getState().root, '/w/proj')
  assert.equal(store.getState().changesFocus, before + 1)
  assert.ok(calls(api, 'gitStatus').length > gitCalls)
  assert.equal(store.getState().active, null, 'a folder opens no file')
  // a sub folder of a known root works too (it lists as a directory)
  assert.equal(await store.handleOpenRequest({ path: '/w/proj/src', review: true }), true)
  assert.equal(store.getState().changesFocus, before + 2)
  // outside every root: /resolve picks the git top-level, which is registered
  const other = await setup({ resolve: () => ({ root: '/repo', isGit: true }) })
  assert.equal(await other.store.handleOpenRequest({ path: '/repo/sub', review: true }), true)
  assert.equal(other.store.getState().root, '/repo')
  assert.deepEqual(calls(other.api, 'resolve').at(-1), ['resolve', '/repo/sub'])
})

// ---- nested repositories, browse, layout ----
const multi = {
  repos: { '/w/proj': { inside: false, truncated: false, repos: [{ path: '/w/proj/alpha', rel: 'alpha', name: 'alpha' }, { path: '/w/proj/pk/beta', rel: 'pk/beta', name: 'beta' }] } },
  statusByRoot: {
    '/w/proj/alpha': { branch: 'dev', ahead: 0, behind: 0, files: [gitFile('x.ts'), gitFile('new.ts', { worktree: '?', unstaged: false, untracked: true })] },
    '/w/proj/pk/beta': { branch: 'main', ahead: 0, behind: 0, files: [gitFile('y.ts', { index: 'M', worktree: ' ', staged: true, unstaged: false })] },
  },
}
const bothLoaded = (store) => Object.values(store.getState().repoGit).length === 2 && Object.values(store.getState().repoGit).every((g) => g.status)

test('a root that only contains repositories lists them, registers their paths and loads one status each', async () => {
  const { api, store } = await setup(multi)
  await until(() => bothLoaded(store), 'both statuses')
  const s = store.getState()
  assert.deepEqual(s.repos.list.map((r) => r.rel), ['alpha', 'pk/beta'])
  assert.equal(s.git.notGit, false)
  assert.equal(s.git.status, null, 'the root has no repository of its own')
  assert.deepEqual(calls(api, 'roots').flatMap((c) => c[1]).filter((p) => p.includes('/alpha') || p.includes('beta')).sort(), ['/w/proj/alpha', '/w/proj/pk/beta'], 'nested repo paths are registered as roots')
  assert.deepEqual(calls(api, 'gitStatus').map((c) => c[1]).sort(), ['/w/proj/alpha', '/w/proj/pk/beta'], 'the root itself is never asked for a status')
  assert.equal(store.changeCount(), 3)
  assert.equal(s.repoGit.alpha.status.branch, 'dev')
})

test('per-repository actions use the repository path as root and repo-relative paths', async () => {
  const { api, store } = await setup(multi)
  await until(() => bothLoaded(store), 'both statuses')
  assert.equal(await store.stage(['x.ts'], 'alpha'), true)
  assert.deepEqual(calls(api, 'stage')[0], ['stage', '/w/proj/alpha', ['x.ts']])
  assert.equal(await store.unstage(['y.ts'], 'pk/beta'), true)
  assert.deepEqual(calls(api, 'unstage')[0], ['unstage', '/w/proj/pk/beta', ['y.ts']])
  await store.stageAll('alpha')
  assert.deepEqual(calls(api, 'stage')[1], ['stage', '/w/proj/alpha', ['x.ts', 'new.ts']])
  await store.discard([gitFile('new.ts', { worktree: '?', unstaged: false, untracked: true })], 'alpha')
  assert.deepEqual(calls(api, 'discard')[0], ['discard', '/w/proj/alpha', [], ['new.ts']])
  const betaCalls = () => calls(api, 'gitStatus').filter((c) => c[1] === '/w/proj/pk/beta').length
  const before = betaCalls()
  await store.stage(['x.ts'], 'alpha')
  assert.equal(betaCalls(), before, 'an action refreshes only its own repository')
  assert.equal(await store.stage(['x.ts'], 'gone/repo'), false, 'an unknown repository is refused client-side')
})

test('a nested diff tab keeps a root-relative path and asks the host with the repository root', async () => {
  const { api, store, host } = await setup(multi)
  await until(() => bothLoaded(store), 'both statuses')
  await store.openDiff('alpha/x.ts', false, 'alpha')
  assert.deepEqual(calls(api, 'gitDiff')[0], ['gitDiff', '/w/proj/alpha', 'x.ts', false])
  assert.equal(store.tab('diff:w:alpha/x.ts').repo, 'alpha')
  assert.equal(host.diffShown.id, 'diff:w:alpha/x.ts')
})

test('diff tabs of a nested repository are restored with their repository', async () => {
  const storage = new MemoryStorage()
  const a = await setup({ ...multi, storage })
  await until(() => bothLoaded(a.store), 'both statuses')
  await a.store.openDiff('alpha/x.ts', false, 'alpha')
  a.store.dispose()
  const b = await setup({ ...multi, storage })
  await until(() => b.store.tab('diff:w:alpha/x.ts')?.loaded, 'restored diff tab')
  assert.equal(b.store.tab('diff:w:alpha/x.ts').repo, 'alpha')
  assert.deepEqual(calls(b.api, 'gitDiff')[0], ['gitDiff', '/w/proj/alpha', 'x.ts', false])
})

test('review of a file inside a nested repository opens its diff there', async () => {
  const { api, store } = await setup({ ...multi, tree: { '': [{ name: 'alpha', type: 'dir', size: 0, mtime: 1 }], alpha: [] } })
  await until(() => bothLoaded(store), 'both statuses')
  assert.equal(await store.handleOpenRequest({ path: '/w/proj/alpha/x.ts', review: true }), true)
  assert.equal(store.getState().active, 'diff:w:alpha/x.ts')
  assert.deepEqual(calls(api, 'gitDiff')[0], ['gitDiff', '/w/proj/alpha', 'x.ts', false])
  assert.equal(calls(api, 'gitRepos').some((c) => c[2] === true), true, 'a review rescans for repositories')
})

test('an empty repository list is "no repository"; a root inside a repo uses it directly; an old host falls back', async () => {
  const none = await setup({ repos: { '/w/proj': { inside: false, truncated: false, repos: [] } } })
  await until(() => none.store.getState().git.notGit, 'notGit')
  assert.equal(none.store.getState().repos.list.length, 0)
  assert.equal(calls(none.api, 'gitStatus').length, 0)

  const single = await setup()
  await until(() => single.store.getState().git.status, 'status')
  assert.deepEqual(single.store.getState().repos.list, [{ path: '/w/proj', rel: '', name: 'proj' }])
  assert.deepEqual(single.store.getState().repoGit, {})

  FakeSocket.reset()
  const old = makeApi({})
  old.gitRepos = async () => { throw new ApiError('Not Found', 404) }
  const store = new EditorStore({ api: old, storage: new MemoryStorage(), Socket: FakeSocket, gitDelayMs: 1, wsDelay: () => 5 })
  store.attachHost(new FakeHost())
  await store.setWorkspaces(['/w/proj'])
  await until(() => store.getState().git.status, 'fallback status')
  assert.equal(store.getState().repos.list[0].rel, '')
})

test('repositories refresh on live git frames; the refresh button rescans', async () => {
  const { api, store, sock } = await setup(multi)
  await until(() => bothLoaded(store), 'both statuses')
  const n = () => calls(api, 'gitStatus').filter((c) => c[1] === '/w/proj/alpha').length
  const before = n()
  sock().open()
  sock().push({ type: 'git' })
  await until(() => n() > before, 'status refresh')
  assert.equal(calls(api, 'gitRepos').every((c) => c[2] === false), true, 'live frames reuse the repository list')
  await store.refreshGit(true)
  assert.equal(calls(api, 'gitRepos').some((c) => c[2] === true), true)
})

test('Browse: the picker result is registered and selected; cancel and an absent picker do nothing', async () => {
  const picks = ['/w/other', null, '']
  const picker = { available: () => true, pick: async () => picks.shift() }
  const { api, store } = await setup({ picker })
  assert.equal(store.canBrowse(), true)
  assert.equal(await store.browse(), true)
  assert.deepEqual(calls(api, 'roots').at(-1)[1], ['/w/other'])
  assert.equal(store.getState().root, '/w/other')
  assert.deepEqual(store.getState().folders, ['/w/other'])
  assert.equal(await store.browse(), false, 'cancelled')
  assert.equal(await store.browse(), false, 'empty answer')
  assert.equal(store.getState().root, '/w/other')

  const absent = await setup()
  assert.equal(absent.store.canBrowse(), false)
  assert.equal(await absent.store.browse(), false)
  const throwing = await setup({ picker: { available: () => true, pick: async () => { throw new Error('boom') } } })
  assert.equal(await throwing.store.browse(), false, 'a failing picker is a cancel')
})

test('layout: defaults, clamping, persistence across stores, no-op writes', async () => {
  const storage = new MemoryStorage()
  const a = await setup({ storage })
  assert.deepEqual(a.store.getState().layout, { sidebar: 280, exFrac: 0.5, exOpen: true, chOpen: true })
  a.store.setLayout({ sidebar: 351, exFrac: 0.3, chOpen: false })
  a.store.setLayout({ sidebar: 99999 })
  assert.equal(a.store.getState().layout.sidebar, 640)
  a.store.setLayout({ sidebar: 351 })
  const writes = []
  const spy = { getItem: (k) => storage.getItem(k), setItem: (k, v) => { writes.push(k); storage.setItem(k, v) } }
  const b = await setup({ storage: spy, workspaces: false })
  assert.deepEqual(b.store.getState().layout, { sidebar: 351, exFrac: 0.3, exOpen: true, chOpen: false })
  const n = writes.length
  b.store.setLayout({ sidebar: 351 })
  assert.equal(writes.length, n, 'an unchanged layout is not written')
  b.store.setLayout({ exFrac: 0 })
  assert.equal(b.store.getState().layout.exFrac, 0.15)
})
