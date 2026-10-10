import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseStatus } from '../lib/git.js'
import { cleanup, git, startHost, tempDir, tempRepo, write } from './helpers/harness.mjs'

after(cleanup)

async function setup(files) {
  const repo = tempRepo(files)
  const host = await startHost()
  await host.register(repo)
  return { host, repo }
}
const statusOf = async (host, repo) => (await host.get('/git/status', { root: repo })).json
const entry = (status, path) => status.files.find((f) => f.path === path)

test('parseStatus: ordinary, rename with origPath, conflict, untracked, spaces, branch info', () => {
  const out = [
    '# branch.oid abc',
    '# branch.head feature/x',
    '# branch.upstream origin/feature/x',
    '# branch.ab +2 -3',
    '1 .M N... 100644 100644 100644 aaa bbb dir/my file.txt',
    '1 A. N... 000000 100644 100644 000 bbb added.txt',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt',
    'old name.txt',
    'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
    '? untracked.txt',
    '! ignored.txt',
    '',
  ].join('\0')
  const parsed = parseStatus(out)
  assert.equal(parsed.branch, 'feature/x')
  assert.deepEqual([parsed.ahead, parsed.behind], [2, 3])
  assert.deepEqual(parsed.files, [
    { path: 'dir/my file.txt', index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false, conflicted: false },
    { path: 'added.txt', index: 'A', worktree: ' ', staged: true, unstaged: false, untracked: false, conflicted: false },
    { path: 'new name.txt', origPath: 'old name.txt', index: 'R', worktree: ' ', staged: true, unstaged: false, untracked: false, conflicted: false },
    { path: 'conflict.txt', index: 'U', worktree: 'U', staged: false, unstaged: false, untracked: false, conflicted: true },
    { path: 'untracked.txt', index: '?', worktree: '?', staged: false, unstaged: false, untracked: true, conflicted: false },
  ])
})

test('parseStatus: a sub-folder root only sees its own entries, root-relative', () => {
  const out = ['# branch.head main', '1 .M N... 1 1 1 a b sub/in.txt', '1 .M N... 1 1 1 a b other/out.txt', '? sub/deep/new.txt', ''].join('\0')
  assert.deepEqual(parseStatus(out, 'sub/').files.map((f) => f.path), ['in.txt', 'deep/new.txt'])
})

test('status: modified, staged, both, untracked, deleted, renamed, branch', async () => {
  const { host, repo } = await setup({ 'mod.txt': '1\n', 'staged.txt': '1\n', 'both.txt': '1\n', 'del.txt': '1\n', 'mv.txt': 'moved content that is long enough\n' })
  write(repo, { 'mod.txt': '2\n', 'staged.txt': '2\n', 'both.txt': '2\n', 'new.txt': 'n\n', 'dir/deep.txt': 'd\n' })
  git(repo, 'add', 'staged.txt', 'both.txt')
  write(repo, { 'both.txt': '3\n' })
  rmSync(join(repo, 'del.txt'))
  git(repo, 'mv', 'mv.txt', 'renamed.txt')
  const status = await statusOf(host, repo)
  assert.equal(status.ok, true)
  assert.equal(status.branch, 'main')
  assert.deepEqual([status.ahead, status.behind], [0, 0])
  assert.deepEqual(
    [entry(status, 'mod.txt').index, entry(status, 'mod.txt').worktree, entry(status, 'mod.txt').unstaged, entry(status, 'mod.txt').staged],
    [' ', 'M', true, false],
  )
  assert.deepEqual([entry(status, 'staged.txt').staged, entry(status, 'staged.txt').unstaged], [true, false])
  assert.deepEqual([entry(status, 'both.txt').staged, entry(status, 'both.txt').unstaged], [true, true])
  assert.deepEqual([entry(status, 'del.txt').worktree, entry(status, 'del.txt').unstaged], ['D', true])
  assert.equal(entry(status, 'new.txt').untracked, true)
  assert.equal(entry(status, 'dir/deep.txt').untracked, true, 'untracked files are listed individually')
  const renamed = entry(status, 'renamed.txt')
  assert.deepEqual([renamed.origPath, renamed.index, renamed.staged], ['mv.txt', 'R', true])
  assert.ok(Array.isArray(status.files))
})

test('status: merge conflicts are flagged', async () => {
  const { host, repo } = await setup({ 'c.txt': 'base\n' })
  git(repo, 'checkout', '-q', '-b', 'feat')
  write(repo, { 'c.txt': 'feat\n' })
  git(repo, 'commit', '-qam', 'feat')
  git(repo, 'checkout', '-q', 'main')
  write(repo, { 'c.txt': 'main\n' })
  git(repo, 'commit', '-qam', 'main')
  try {
    git(repo, 'merge', 'feat')
  } catch {}
  const file = entry(await statusOf(host, repo), 'c.txt')
  assert.deepEqual([file.conflicted, file.staged, file.unstaged], [true, false, false])
})

test('status: repo without commits, and a non-git root is 409 not-git', async () => {
  const repo = tempDir()
  git(repo, 'init', '-q', '-b', 'trunk')
  write(repo, { 'f.txt': 'x' })
  const plain = tempDir()
  const host = await startHost()
  await host.register(repo, plain)
  const status = await statusOf(host, repo)
  assert.equal(status.branch, 'trunk')
  assert.equal(entry(status, 'f.txt').untracked, true)
  const notGit = await host.get('/git/status', { root: plain })
  assert.equal(notGit.status, 409)
  assert.equal(notGit.json.code, 'not-git')
  for (const [route, body] of [['/git/stage', { paths: ['a'] }], ['/git/unstage', { paths: ['a'] }], ['/git/discard', { paths: ['a'], untracked: [] }]]) {
    assert.equal((await host.post(route, { root: plain, ...body })).json.code, 'not-git', route)
  }
  assert.equal((await host.get('/git/diff', { root: plain, path: 'a', staged: '0' })).json.code, 'not-git')
})

test('a root below the git top level sees root-relative paths', async () => {
  const repo = tempRepo({ 'sub/in.txt': '1\n', 'out.txt': '1\n' })
  write(repo, { 'sub/in.txt': '2\n', 'out.txt': '2\n', 'sub/new.txt': 'n' })
  const host = await startHost()
  const sub = join(repo, 'sub')
  await host.register(sub)
  assert.equal((await host.get('/git/status', { root: sub })).json.files.map((f) => f.path).sort().join(), 'in.txt,new.txt')
  const diff = await host.get('/git/diff', { root: sub, path: 'in.txt', staged: '0' })
  assert.deepEqual([diff.json.original, diff.json.modified], ['1\n', '2\n'])
  assert.equal((await host.post('/git/stage', { root: sub, paths: ['in.txt'] })).status, 200)
  assert.equal(git(repo, 'diff', '--cached', '--name-only').trim(), 'sub/in.txt')
})

test('diff: unstaged, staged, untracked, added, deleted, partially staged, binary, too large', async () => {
  const { host, repo } = await setup({ 'm.txt': 'old\n', 'd.txt': 'gone\n', 'both.txt': 'v1\n', 'bin.dat': 'x' })
  const diff = async (path, staged) => (await host.get('/git/diff', { root: repo, path, staged: staged ? '1' : '0' })).json

  write(repo, { 'm.txt': 'new\n' })
  assert.deepEqual(pick(await diff('m.txt', false)), { original: 'old\n', modified: 'new\n', binary: false, tooLarge: false })
  assert.deepEqual(pick(await diff('m.txt', true)), { original: 'old\n', modified: 'old\n', binary: false, tooLarge: false })
  git(repo, 'add', 'm.txt')
  assert.deepEqual(pick(await diff('m.txt', true)), { original: 'old\n', modified: 'new\n', binary: false, tooLarge: false })
  assert.deepEqual(pick(await diff('m.txt', false)), { original: 'new\n', modified: 'new\n', binary: false, tooLarge: false })

  write(repo, { 'untracked.txt': 'u\n' })
  assert.deepEqual(pick(await diff('untracked.txt', false)), { original: null, modified: 'u\n', binary: false, tooLarge: false })

  write(repo, { 'added.txt': 'a\n' })
  git(repo, 'add', 'added.txt')
  assert.deepEqual(pick(await diff('added.txt', true)), { original: null, modified: 'a\n', binary: false, tooLarge: false })
  assert.deepEqual(pick(await diff('added.txt', false)), { original: 'a\n', modified: 'a\n', binary: false, tooLarge: false })

  rmSync(join(repo, 'd.txt'))
  assert.deepEqual(pick(await diff('d.txt', false)), { original: 'gone\n', modified: null, binary: false, tooLarge: false })
  git(repo, 'rm', '-q', '--cached', 'd.txt')
  assert.deepEqual(pick(await diff('d.txt', true)), { original: 'gone\n', modified: null, binary: false, tooLarge: false })

  write(repo, { 'both.txt': 'v2\n' })
  git(repo, 'add', 'both.txt')
  write(repo, { 'both.txt': 'v3\n' })
  assert.deepEqual(pick(await diff('both.txt', true)), { original: 'v1\n', modified: 'v2\n', binary: false, tooLarge: false })
  assert.deepEqual(pick(await diff('both.txt', false)), { original: 'v2\n', modified: 'v3\n', binary: false, tooLarge: false })

  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
  assert.deepEqual(pick(await diff('bin.dat', false)), { original: null, modified: null, binary: true, tooLarge: false })

  writeFileSync(join(repo, 'huge.txt'), 'z'.repeat(2 * 1024 * 1024 + 5))
  assert.deepEqual(pick(await diff('huge.txt', false)), { original: null, modified: null, binary: false, tooLarge: true })

  // nonexistent everywhere
  assert.deepEqual(pick(await diff('nothing.txt', false)), { original: null, modified: null, binary: false, tooLarge: false })
  // staged diff for a path without HEAD entry nor index entry
  assert.equal((await host.get('/git/diff', { root: repo, path: 'm.txt', staged: '2' })).status, 400)
})

function pick({ original, modified, binary, tooLarge }) {
  return { original, modified, binary, tooLarge }
}

test('diff in a repo without commits: staged original is null', async () => {
  const repo = tempDir()
  git(repo, 'init', '-q', '-b', 'main')
  write(repo, { 'f.txt': 'x\n' })
  git(repo, 'add', 'f.txt')
  const host = await startHost()
  await host.register(repo)
  const diff = (await host.get('/git/diff', { root: repo, path: 'f.txt', staged: '1' })).json
  assert.deepEqual([diff.original, diff.modified], [null, 'x\n'])
})

test('stage / unstage', async () => {
  const { host, repo } = await setup({ 'a.txt': '1\n', 'gone.txt': '1\n' })
  write(repo, { 'a.txt': '2\n', 'n.txt': 'new\n' })
  rmSync(join(repo, 'gone.txt'))
  const staged = await host.post('/git/stage', { root: repo, paths: ['a.txt', 'n.txt', 'gone.txt'] })
  assert.deepEqual(staged.json, { ok: true })
  let status = await statusOf(host, repo)
  assert.deepEqual(['a.txt', 'n.txt', 'gone.txt'].map((p) => entry(status, p).staged), [true, true, true])
  const unstaged = await host.post('/git/unstage', { root: repo, paths: ['a.txt', 'n.txt', 'gone.txt'] })
  assert.equal(unstaged.status, 200)
  status = await statusOf(host, repo)
  assert.deepEqual(['a.txt', 'gone.txt'].map((p) => [entry(status, p).staged, entry(status, p).unstaged]), [[false, true], [false, true]])
  assert.equal(entry(status, 'n.txt').untracked, true)
})

test('unstage works in a repo with no commits (falls back to dropping from the index)', async () => {
  const repo = tempDir()
  git(repo, 'init', '-q', '-b', 'main')
  write(repo, { 'f.txt': 'x\n' })
  const host = await startHost()
  await host.register(repo)
  await host.post('/git/stage', { root: repo, paths: ['f.txt'] })
  assert.equal(entry(await statusOf(host, repo), 'f.txt').staged, true)
  assert.equal((await host.post('/git/unstage', { root: repo, paths: ['f.txt'] })).status, 200)
  assert.equal(entry(await statusOf(host, repo), 'f.txt').untracked, true)
  assert.equal(readFileSync(join(repo, 'f.txt'), 'utf8'), 'x\n')
})

test('git argument safety: names that look like options or globs are literal paths', async () => {
  const names = process.platform === 'win32' ? ['--force', '-n', '[ab].txt'] : ['--force', '-n', '*.txt', '[ab].txt']
  const files = { 'a.txt': 'a\n', 'b.txt': 'b\n' }
  for (const n of names) files[n] = 'x\n'
  const { host, repo } = await setup({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
  for (const n of names) writeFileSync(join(repo, n), 'x\n')
  write(repo, { 'a.txt': 'changed\n' })
  const result = await host.post('/git/stage', { root: repo, paths: names })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  const status = await statusOf(host, repo)
  assert.equal(entry(status, 'a.txt').staged, false, 'a glob must not stage a.txt')
  for (const n of names) assert.equal(entry(status, n).staged, true, n)
})

test('discard: restores tracked files and deletes only listed untracked files', async () => {
  const { host, repo } = await setup({ 'a.txt': 'orig\n', 'keep/inner.txt': 'k\n' })
  write(repo, { 'a.txt': 'edited\n', 'u.txt': 'u\n', 'dir/x.txt': 'x\n' })
  const result = await host.post('/git/discard', { root: repo, paths: ['a.txt'], untracked: ['u.txt'] })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'orig\n')
  assert.equal(existsSync(join(repo, 'u.txt')), false)
  assert.equal(existsSync(join(repo, 'dir/x.txt')), true)

  // a tracked, clean file is not "untracked": refused, file stays
  const tracked = await host.post('/git/discard', { root: repo, paths: [], untracked: ['keep/inner.txt'] })
  assert.equal(tracked.status, 409)
  assert.equal(tracked.json.code, 'not-untracked')
  assert.equal(existsSync(join(repo, 'keep/inner.txt')), true)

  // a directory is never deleted, even when its files are untracked
  const dir = await host.post('/git/discard', { root: repo, paths: [], untracked: ['dir'] })
  assert.equal(dir.status, 409)
  assert.equal(existsSync(join(repo, 'dir/x.txt')), true)

  // an ignored file is not listed as untracked
  write(repo, { '.gitignore': 'ign.txt\n', 'ign.txt': 'i\n' })
  const ignored = await host.post('/git/discard', { root: repo, paths: [], untracked: ['ign.txt'] })
  assert.equal(ignored.status, 409)
  assert.equal(existsSync(join(repo, 'ign.txt')), true)

  assert.equal((await host.post('/git/discard', { root: repo, paths: [], untracked: [] })).status, 400)
})

test('discard: a failed batch deletes nothing (untracked names validated before any change)', async () => {
  const { host, repo } = await setup({ 'a.txt': 'orig\n' })
  write(repo, { 'u1.txt': 'u\n' })
  const result = await host.post('/git/discard', { root: repo, paths: [], untracked: ['u1.txt', 'a.txt'] })
  assert.equal(result.status, 409)
  assert.equal(existsSync(join(repo, 'u1.txt')), true)
})

test('discard restores a deleted tracked file', async () => {
  const { host, repo } = await setup({ 'a.txt': 'orig\n' })
  rmSync(join(repo, 'a.txt'))
  assert.equal((await host.post('/git/discard', { root: repo, paths: ['a.txt'], untracked: [] })).status, 200)
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'orig\n')
})

test('git routes validate paths: escapes, absolute, .git, symlink to outside, bad shapes', async () => {
  const outside = tempDir('dsh-ce-outside-')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  const { host, repo } = await setup({ 'a.txt': 'a\n' })
  symlinkSync(outside, join(repo, 'link'), 'junction')
  const evil = ['../x', '/etc/passwd', join(outside, 'secret.txt'), '.git/config', 'link/secret.txt', 'a\0', '..']
  for (const route of ['/git/stage', '/git/unstage']) {
    for (const path of evil) {
      const res = await host.post(route, { root: repo, paths: [path] })
      assert.ok([400, 403].includes(res.status), `${route} ${JSON.stringify(path)} -> ${res.status}`)
    }
    assert.equal((await host.post(route, { root: repo, paths: [] })).status, 400)
    assert.equal((await host.post(route, { root: repo, paths: 'a.txt' })).status, 400)
    assert.equal((await host.post(route, { root: repo, paths: new Array(1001).fill('a.txt') })).status, 400)
  }
  for (const path of evil) {
    assert.ok([400, 403].includes((await host.post('/git/discard', { root: repo, paths: [], untracked: [path] })).status), path)
    assert.ok([400, 403].includes((await host.get('/git/diff', { root: repo, path, staged: '0' })).status), path)
  }
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret')
  assert.equal((await host.post('/git/stage', { root: tempDir(), paths: ['a.txt'] })).json.code, 'root')
})

test('diff does not read through a symlink that leaves the root', async () => {
  const outside = tempDir('dsh-ce-outside-')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  const { host, repo } = await setup({ 'a.txt': 'a\n' })
  symlinkSync(outside, join(repo, 'link'), 'junction')
  const res = await host.get('/git/diff', { root: repo, path: 'link/secret.txt', staged: '0' })
  assert.equal(res.status, 403)
  assert.equal(JSON.stringify(res.json).includes('secret"'), false)
})

test('mkdir/rename inside the repo then status reflects the move', async () => {
  const { host, repo } = await setup({ 'x.txt': 'content that is long enough to detect renames\n' })
  mkdirSync(join(repo, 'd'))
  renameSync(join(repo, 'x.txt'), join(repo, 'd/y.txt'))
  git(repo, 'add', '-A')
  const status = await statusOf(host, repo)
  assert.equal(entry(status, 'd/y.txt').origPath, 'x.txt')
})
