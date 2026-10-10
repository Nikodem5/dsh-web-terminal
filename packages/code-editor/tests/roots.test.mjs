import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { cleanup, startHost, tempDir, tempRepo } from './helpers/harness.mjs'

after(cleanup)

test('registers existing absolute dirs, reports isGit, persists to roots.json', async () => {
  const host = await startHost()
  const plain = tempDir()
  const repo = tempRepo()
  const result = await host.register(plain, repo)
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  const byPath = Object.fromEntries(result.json.roots.map((r) => [r.path, r]))
  assert.deepEqual(byPath[plain], { path: plain, exists: true, isGit: false })
  assert.deepEqual(byPath[repo], { path: repo, exists: true, isGit: true })
  const saved = JSON.parse(readFileSync(join(host.dir, 'roots.json'), 'utf8'))
  assert.deepEqual(saved.roots.sort(), [plain, repo].sort())
})

test('refuses filesystem roots, the home folder, parents of home, relative paths, files and missing dirs', async () => {
  const host = await startHost()
  const file = join(tempDir(), 'f.txt')
  writeFileSync(file, 'x')
  const candidates = [parse(process.cwd()).root, '/', homedir(), dirname(homedir()), 'relative/dir', file, join(tempDir(), 'missing'), '', 'a\0b', 5]
  const result = await host.post('/roots', { roots: candidates })
  assert.equal(result.status, 200)
  assert.deepEqual(result.json.roots, [])
  assert.equal(result.json.rejected.length, candidates.length)
  const reasons = result.json.rejected.map((r) => r.reason)
  assert.ok(reasons.some((r) => r.includes('filesystem roots')))
  assert.ok(reasons.some((r) => r.includes('home folder')))
})

test('a subfolder of the home folder is accepted (only home itself and its parents are refused)', async () => {
  const host = await startHost()
  const dir = tempDir() // lives under the OS temp dir, which on Windows is inside the home folder
  assert.equal((await host.register(dir)).json.roots.length, 1)
})

test('requests for unregistered roots are 403 root; missing root is 400', async () => {
  const host = await startHost()
  const dir = tempDir()
  const unregistered = await host.get('/tree', { root: dir, dir: '' })
  assert.equal(unregistered.status, 403)
  assert.equal(unregistered.json.code, 'root')
  assert.equal((await host.get('/tree', { dir: '' })).status, 400)
  assert.equal((await host.get('/tree', { root: 'relative', dir: '' })).status, 403)
  await host.register(dir)
  assert.equal((await host.get('/tree', { root: dir, dir: '' })).status, 200)
  // a sibling or a parent of a registered root is not the registered root
  assert.equal((await host.get('/tree', { root: dirname(dir), dir: '' })).status, 403)
  assert.equal((await host.get('/tree', { root: join(dir, 'sub'), dir: '' })).status, 403)
  // a trailing separator or `..` detour resolves to the same registered root
  assert.equal((await host.get('/tree', { root: `${dir}/`, dir: '' })).status, 200)
})

test('roots survive a restart (union for the host lifetime, persisted)', async () => {
  const dir = tempDir('dsh-ce-data-')
  const root = tempDir()
  const first = await startHost({ dir })
  await first.register(root)
  await first.stop()
  const second = await startHost({ dir })
  assert.equal((await second.get('/tree', { root, dir: '' })).status, 200)
  const other = tempDir()
  const list = await second.register(other)
  assert.deepEqual(list.json.roots.map((r) => r.path).sort(), [other, root].sort())
})

test('a tampered roots.json cannot smuggle in the home folder or relative paths; vanished dirs show exists=false', async () => {
  const dir = tempDir('dsh-ce-data-')
  const gone = tempDir()
  const good = tempDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'roots.json'), JSON.stringify({ roots: [homedir(), 'rel', parse(homedir()).root, good, gone, 7] }))
  rmSync(gone, { recursive: true, force: true })
  const host = await startHost({ dir })
  assert.equal((await host.get('/tree', { root: homedir(), dir: '' })).status, 403)
  const list = await host.register()
  const paths = list.json.roots.map((r) => r.path).sort()
  assert.deepEqual(paths, [good, resolve(gone)].sort())
  assert.equal(list.json.roots.find((r) => r.path === resolve(gone)).exists, false)
  assert.ok(!existsSync(join(host.dir, 'roots.json.tmp')))
})
