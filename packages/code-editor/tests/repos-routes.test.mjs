// GET /git/repos: nested repository discovery for a root that is not itself a work tree.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { findRepos } from '../lib/repos.js'
import { cleanup, git, startHost, tempDir, tempRepo, write } from './helpers/harness.mjs'

after(cleanup)

/** A plain folder holding repos at several depths, a worktree (".git" is a FILE) and repos that must be skipped. */
function workspace() {
  const dir = tempDir('dsh-ce-ws-')
  const init = (rel) => {
    const abs = join(dir, rel)
    mkdirSync(abs, { recursive: true })
    git(abs, 'init', '-q', '-b', 'main')
    write(abs, { 'f.txt': 'x\n' })
    return abs
  }
  const a = init('plugins/alpha')
  git(a, 'add', '-A')
  git(a, 'commit', '-q', '-m', 'init')
  git(a, 'worktree', 'add', '-q', '-b', 'wt', join(dir, 'plugins', 'alpha-wt'))
  init('beta')
  init('a/b/c/d') // depth 4: included
  init('a/b/c/d/e/f') // below the limit: skipped
  init('node_modules/dep') // skipped
  init('.hidden/repo') // skipped
  return dir
}

test('discovery: nested repos, a worktree .git file, depth limit, skipped folders, sorted', async () => {
  const dir = workspace()
  const host = await startHost()
  await host.register(dir)
  const r = await host.get('/git/repos', { root: dir })
  assert.equal(r.status, 200)
  assert.equal(r.json.inside, false)
  assert.equal(r.json.truncated, false)
  assert.deepEqual(r.json.repos.map((x) => x.rel), ['a/b/c/d', 'beta', 'plugins/alpha', 'plugins/alpha-wt'])
  assert.deepEqual(r.json.repos.map((x) => x.name), ['d', 'beta', 'alpha', 'alpha-wt'])
  assert.equal(r.json.repos[3].path, join(dir, 'plugins', 'alpha-wt'))
})

test('a discovered repo path can be registered and used as the root of the git routes', async () => {
  const dir = workspace()
  const host = await startHost()
  await host.register(dir)
  const { repos } = (await host.get('/git/repos', { root: dir })).json
  const beta = repos.find((x) => x.rel === 'beta')
  assert.equal((await host.register(beta.path)).json.rejected.length, 0)
  write(beta.path, { 'g.txt': 'new\n' })
  const status = (await host.get('/git/status', { root: beta.path })).json
  assert.equal(status.ok, true)
  assert.ok(status.files.some((f) => f.path === 'g.txt' && f.untracked))
  const staged = await host.post('/git/stage', { root: beta.path, paths: ['g.txt'] })
  assert.equal(staged.status, 200)
})

test('a root inside a work tree returns that repo only, scoped to the root (never the top-level)', async () => {
  const repo = tempRepo({ 'sub/a.txt': '1\n', 'sub/nested/x.txt': '1\n' })
  const host = await startHost()
  await host.register(repo, join(repo, 'sub'))
  const top = (await host.get('/git/repos', { root: repo })).json
  assert.deepEqual(top.repos.map((x) => [x.path, x.rel]), [[repo, '']])
  assert.equal(top.inside, true)
  const sub = (await host.get('/git/repos', { root: join(repo, 'sub') })).json
  assert.deepEqual(sub.repos.map((x) => [x.path, x.rel]), [[join(repo, 'sub'), '']])
})

test('a folder without repos is an empty list; unregistered roots are refused; root is required', async () => {
  const dir = tempDir('dsh-ce-empty-')
  write(dir, { 'a.txt': '1\n' })
  const host = await startHost()
  assert.equal((await host.get('/git/repos', { root: dir })).status, 403)
  assert.equal((await host.get('/git/repos', {})).status, 400)
  await host.register(dir)
  const r = await host.get('/git/repos', { root: dir })
  assert.deepEqual([r.json.repos, r.json.inside], [[], false])
})

test('the result is cached for a few seconds; fresh=1 rescans', async () => {
  const dir = tempDir('dsh-ce-cache-')
  write(dir, { 'a.txt': '1\n' })
  const host = await startHost()
  await host.register(dir)
  assert.equal((await host.get('/git/repos', { root: dir })).json.repos.length, 0)
  const late = join(dir, 'late')
  mkdirSync(late)
  git(late, 'init', '-q', '-b', 'main')
  assert.equal((await host.get('/git/repos', { root: dir })).json.repos.length, 0, 'cached')
  assert.equal((await host.get('/git/repos', { root: dir, fresh: '1' })).json.repos.length, 1, 'fresh rescans')
  assert.equal((await host.get('/git/repos', { root: dir })).json.repos.length, 1, 'and refreshes the cache')
})

test('findRepos: the cap truncates, results stay deterministic', async () => {
  const dir = tempDir('dsh-ce-cap-')
  for (const n of ['r1', 'r2', 'r3', 'r4']) {
    mkdirSync(join(dir, n, '.git'), { recursive: true })
  }
  const r = await findRepos(dir, { cap: 3 })
  assert.equal(r.repos.length, 3)
  assert.equal(r.truncated, true)
  assert.deepEqual(r.repos.map((x) => x.rel), ['r1', 'r2', 'r3'])
  const all = await findRepos(dir)
  assert.equal(all.repos.length, 4)
  assert.equal(all.truncated, false)
})
