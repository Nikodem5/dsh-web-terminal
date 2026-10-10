import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { cleanup, startHost, tempDir, tempRepo, write } from './helpers/harness.mjs'

after(cleanup)

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

test('resolve: a file or folder inside a repo gives the git top-level; nothing is registered', async () => {
  const host = await startHost()
  const repo = tempRepo({ 'src/deep/a.txt': 'x\n' })
  const file = await host.get('/resolve', { path: join(repo, 'src', 'deep', 'a.txt') })
  assert.equal(file.status, 200)
  assert.equal(file.json.ok, true)
  assert.equal(file.json.isGit, true)
  assert.ok(same(file.json.root, repo), `${file.json.root} vs ${repo}`)
  const dir = await host.get('/resolve', { path: join(repo, 'src') })
  assert.ok(same(dir.json.root, repo))
  assert.equal(dir.json.isGit, true)
  // resolving never registers: the root is still unknown
  assert.equal((await host.get('/tree', { root: repo, dir: '' })).status, 403)
  assert.equal((await host.register(file.json.root)).json.roots.length, 1)
  assert.equal((await host.get('/tree', { root: repo, dir: '' })).status, 200)
})

test('resolve: outside a repo the parent folder (file) or the folder itself is the root', async () => {
  const host = await startHost()
  const plain = tempDir()
  write(plain, { 'f.txt': 'x' })
  const file = await host.get('/resolve', { path: join(plain, 'f.txt') })
  assert.ok(same(file.json.root, plain))
  assert.equal(file.json.isGit, false)
  const dir = await host.get('/resolve', { path: plain })
  assert.ok(same(dir.json.root, plain))
})

test('resolve: bad input and refused roots', async () => {
  const host = await startHost()
  assert.equal((await host.get('/resolve', {})).status, 400)
  assert.equal((await host.get('/resolve', { path: 'relative/x' })).status, 400)
  assert.equal((await host.get('/resolve', { path: join(tempDir(), 'missing.txt') })).status, 404)
  const fsRoot = await host.get('/resolve', { path: parse(process.cwd()).root })
  assert.equal(fsRoot.status, 403)
  assert.equal(fsRoot.json.code, 'root')
  assert.equal((await host.get('/resolve', { path: homedir() })).status, 403)
  assert.equal((await host.call('POST', '/resolve', { body: {} })).status, 405)
  assert.equal((await host.get('/resolve', { path: homedir() }, { origin: 'http://evil.example' })).status, 403)
  assert.ok(sep.length === 1)
})
