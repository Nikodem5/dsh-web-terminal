import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, git, startHost, tempDir, tempRepo, waitFor, write } from './helpers/harness.mjs'

after(cleanup)

const flat = (frames, type) => frames.filter((f) => f.type === type)
const changedPaths = (frames) => flat(frames, 'changed').flatMap((f) => f.paths)

async function attach(host, root) {
  const socket = await host.socket(root)
  await socket.opened
  await waitFor(() => socket.frames.length > 0, { label: 'hello frame' })
  return socket
}

async function setup(options = {}, make = () => tempRepo({ 'a.txt': 'a\n', 'sub/b.txt': 'b\n' })) {
  let internals
  const host = await startHost({
    ...options,
    probe: (i) => {
      internals = i
    },
  })
  const root = make()
  await host.register(root)
  return { host, root, socket: await attach(host, root), internals }
}

test('recursive mode: file changes arrive as one debounced changed frame with relative paths', async () => {
  const { root, socket } = await setup({ mode: 'recursive', debounceMs: 400 })
  write(root, { 'one.txt': '1', 'sub/deep/two.txt': '2' })
  await waitFor(() => changedPaths(socket.frames).includes('sub/deep/two.txt'), { label: 'changed frame' })
  const frames = flat(socket.frames, 'changed')
  assert.equal(frames.length, 1, 'both writes land in one debounce window')
  assert.ok(frames[0].paths.includes('one.txt'))
  assert.ok(frames[0].paths.every((p) => !p.includes('\\') && !p.startsWith('/')))
  assert.equal(new Set(frames[0].paths).size, frames[0].paths.length, 'paths are de-duplicated')
})

test('recursive mode: more than 500 paths in one window become an overflow frame', async () => {
  const { root, socket } = await setup({ mode: 'recursive', debounceMs: 2500 }, () => tempDir())
  mkdirSync(join(root, 'many'))
  for (let i = 0; i < 600; i++) writeFileSync(join(root, 'many', `f${i}.txt`), String(i))
  await waitFor(() => flat(socket.frames, 'changed').length > 0, { timeout: 30_000, label: 'overflow frame' })
  assert.deepEqual(flat(socket.frames, 'changed')[0], { type: 'changed', paths: [], overflow: true })
})

test('recursive mode: .git internals are ignored except index and HEAD, which produce a git frame', async () => {
  const { root, socket } = await setup({ mode: 'recursive' })
  write(root, { '.git/some-internal-file': 'x', '.git/refs/heads/zzz': 'x' })
  write(root, { 'marker.txt': 'm' })
  await waitFor(() => changedPaths(socket.frames).includes('marker.txt'), { label: 'marker' })
  assert.ok(changedPaths(socket.frames).every((p) => !p.startsWith('.git')), changedPaths(socket.frames).join())
  assert.equal(flat(socket.frames, 'git').length, 0)
  git(root, 'add', 'marker.txt') // rewrites .git/index
  await waitFor(() => flat(socket.frames, 'git').length > 0, { label: 'git frame from .git/index' })
  assert.ok(changedPaths(socket.frames).every((p) => !p.startsWith('.git')))
  const before = flat(socket.frames, 'git').length
  git(root, 'commit', '-q', '-m', 'm') // rewrites index and the branch ref
  await waitFor(() => flat(socket.frames, 'git').length > before, { label: 'git frame after commit' })
})

test('node_modules and our own temp files are not reported; saved files are', async () => {
  const { host, root, socket } = await setup({ mode: 'recursive' }, () => tempDir())
  write(root, { 'node_modules/pkg/index.js': 'x' })
  const saved = await host.put('/file', { root, path: 'saved.txt', content: 'hi', expectedMtime: null })
  assert.equal(saved.status, 200)
  await waitFor(() => changedPaths(socket.frames).includes('saved.txt'), { label: 'saved.txt' })
  const paths = changedPaths(socket.frames)
  assert.ok(paths.every((p) => !p.includes('node_modules') && !p.endsWith('.dsh-tmp')), paths.join())
})

test('git frames follow stage, unstage, discard and write even without file system activity', async () => {
  const { host, root, socket } = await setup({ mode: 'recursive' })
  const count = () => flat(socket.frames, 'git').length
  let seen = count()
  const next = async (label) => {
    await waitFor(() => count() > seen, { label })
    seen = count()
  }
  write(root, { 'a.txt': 'changed\n' })
  await host.post('/git/stage', { root, paths: ['a.txt'] })
  await next('after stage')
  await host.post('/git/unstage', { root, paths: ['a.txt'] })
  await next('after unstage')
  await host.post('/git/discard', { root, paths: ['a.txt'], untracked: [] })
  await next('after discard')
  const read = await host.get('/file', { root, path: 'sub/b.txt' })
  await host.put('/file', { root, path: 'sub/b.txt', content: 'w', expectedMtime: read.json.mtime })
  await next('after write')
})

test('two sockets on one root share one watcher; it closes idleMs after the last one leaves and on dispose', async () => {
  const { host, root, socket, internals } = await setup({ mode: 'recursive', idleMs: 150 })
  const second = await attach(host, root)
  assert.equal(internals.watchers.stats().length, 1)
  assert.equal(internals.watchers.stats()[0].listeners, 2)
  write(root, { 'x.txt': 'x' })
  await waitFor(() => changedPaths(socket.frames).includes('x.txt') && changedPaths(second.frames).includes('x.txt'), { label: 'both sockets get the frame' })
  socket.close()
  await waitFor(() => internals.watchers.stats()[0]?.listeners === 1, { label: 'first socket gone' })
  assert.equal(internals.watchers.stats().length, 1)
  second.close()
  await waitFor(() => internals.watchers.stats().length === 0, { label: 'idle close' })
  // a new socket re-creates the watcher
  const third = await attach(host, root)
  assert.equal(internals.watchers.stats().length, 1)
  third.close()
  await host.stop()
  assert.equal(internals.watchers.stats().length, 0)
})

test('reconnecting within the idle window reuses the watcher', async () => {
  const { host, root, socket, internals } = await setup({ mode: 'recursive', idleMs: 60_000 })
  socket.close()
  await waitFor(() => internals.watchers.stats()[0]?.listeners === 0, { label: 'listener gone' })
  assert.equal(internals.watchers.stats()[0].idle, true)
  const again = await attach(host, root)
  assert.equal(internals.watchers.stats()[0].idle, false)
  again.close()
})

test('fallback mode (Linux behaviour): root-level changes, expanded dirs only, git poll catches the rest', async () => {
  const { host, root, socket, internals } = await setup({ mode: 'fallback', pollMs: 100 })
  assert.equal(internals.watchers.stats()[0].fallback, true)
  assert.deepEqual(internals.watchers.stats()[0].dirs.sort(), ['', '.git'])
  await waitFor(() => internals.watchers.stats()[0].polled, { label: 'git poll baseline' })
  write(root, { 'top.txt': 't' })
  await waitFor(() => changedPaths(socket.frames).includes('top.txt'), { label: 'root level change' })

  // an unexpanded folder is not watched: the git poll still tells the client that status changed
  await waitFor(() => flat(socket.frames, 'git').length > 0, { label: 'poll saw top.txt' })
  const gitBefore = flat(socket.frames, 'git').length
  write(root, { 'sub/b.txt': 'edited\n' })
  await waitFor(() => flat(socket.frames, 'git').length > gitBefore, { label: 'git frame from poll' })
  assert.ok(!changedPaths(socket.frames).includes('sub/b.txt'))

  // listing a folder (the client expanding it) starts watching it
  await host.get('/tree', { root, dir: 'sub' })
  assert.ok(internals.watchers.stats()[0].dirs.includes('sub'))
  write(root, { 'sub/c.txt': 'c' })
  await waitFor(() => changedPaths(socket.frames).includes('sub/c.txt'), { label: 'expanded dir change' })
})

test('a vanished watched directory does not crash the host', async () => {
  const { host, root, socket } = await setup({ mode: 'fallback', pollMs: 100 })
  await host.get('/tree', { root, dir: 'sub' })
  rmSync(join(root, 'sub'), { recursive: true, force: true })
  write(root, { 'after.txt': 'x' })
  await waitFor(() => changedPaths(socket.frames).includes('after.txt'), { label: 'still alive' })
})
