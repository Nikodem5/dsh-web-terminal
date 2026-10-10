import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { networkEnv, outputText, parseNameStatus } from '../lib/git-tools.js'
import { cleanup, git, startHost, tempDir, tempRepo, waitFor, write } from './helpers/harness.mjs'

after(cleanup)

/** A repo whose own config has an identity (the host never passes -c user.*), plus a registered host. */
async function setup(files, { remote = false } = {}) {
  const repo = tempRepo(files)
  git(repo, 'config', 'user.name', 'Tester')
  git(repo, 'config', 'user.email', 'tester@example.com')
  git(repo, 'config', 'commit.gpgsign', 'false')
  const host = await startHost()
  await host.register(repo)
  const out = { host, repo }
  if (remote) {
    const bare = tempDir('dsh-ce-bare-')
    git(bare, 'init', '-q', '--bare', '-b', 'main')
    git(repo, 'remote', 'add', 'origin', pathToFileURL(bare).href)
    out.bare = bare
  }
  return out
}
const post = (host, path, body) => host.post(path, body)

/** Another clone of the bare remote (for "someone else pushed"). */
function clone(bare) {
  const dir = tempDir('dsh-ce-clone-')
  git(dir, 'clone', '-q', pathToFileURL(bare).href, '.')
  git(dir, 'config', 'user.name', 'Other')
  git(dir, 'config', 'user.email', 'other@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

test('pure helpers: networkEnv, outputText, parseNameStatus', () => {
  const env = networkEnv({})
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_ASKPASS, '')
  assert.equal(env.GCM_INTERACTIVE, 'never')
  assert.match(env.GIT_SSH_COMMAND, /BatchMode=yes/)
  assert.equal('GIT_SSH_COMMAND' in networkEnv({ GIT_SSH_COMMAND: 'mine' }), false)
  assert.equal(outputText({ stderr: '\n a \n\n b\n', stdout: 'c' }), 'a\nb\nc')
  assert.equal(outputText({ stderr: '', stdout: '' }), 'git failed')
  assert.deepEqual(parseNameStatus(['M', 'a.txt', 'R100', 'old.txt', 'new.txt', 'D', 'gone.txt', ''].join('\0')), [
    { status: 'M', path: 'a.txt' },
    { status: 'R', path: 'new.txt', origPath: 'old.txt' },
    { status: 'D', path: 'gone.txt' },
  ])
})

test('commit: staged changes, multi-line message, summary and hash; the git WS frame is sent', async () => {
  const { host, repo } = await setup({ 'a.txt': '1\n' })
  const socket = await host.socket(repo)
  await socket.opened
  await waitFor(() => socket.frames.length > 0)
  write(repo, { 'a.txt': '2\n', 'b.txt': 'b\n' })
  git(repo, 'add', 'a.txt')
  const before = socket.frames.filter((f) => f.type === 'git').length
  const result = await post(host, '/git/commit', { root: repo, message: 'second\n\nbody line\n' })
  assert.equal(result.status, 200)
  assert.equal(result.json.summary, 'second')
  assert.equal(result.json.hash, git(repo, 'rev-parse', 'HEAD').trim())
  assert.equal(git(repo, 'log', '-1', '--format=%B').trim(), 'second\n\nbody line')
  // b.txt stayed out of the commit
  assert.equal(git(repo, 'show', '--name-only', '--format=', 'HEAD').trim(), 'a.txt')
  await waitFor(() => socket.frames.filter((f) => f.type === 'git').length > before, { label: 'git frame' })
})

test('commit: nothing staged -> clear error; all:true commits tracked changes only; empty message refused', async () => {
  const { host, repo } = await setup({ 'a.txt': '1\n' })
  const nothing = await post(host, '/git/commit', { root: repo, message: 'x' })
  assert.equal(nothing.status, 409)
  assert.equal(nothing.json.code, 'nothing-to-commit')
  write(repo, { 'a.txt': '2\n', 'untracked.txt': 'u\n' })
  const empty = await post(host, '/git/commit', { root: repo, message: '   ' })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.code, 'empty-message')
  const bad = await post(host, '/git/commit', { root: repo, message: 5 })
  assert.equal(bad.status, 400)
  const all = await post(host, '/git/commit', { root: repo, message: 'all tracked', all: true })
  assert.equal(all.status, 200)
  assert.equal(git(repo, 'show', '--name-only', '--format=', 'HEAD').trim(), 'a.txt')
  assert.match(git(repo, 'status', '--porcelain'), /\?\? untracked\.txt/)
})

test('commit: amend rewrites the last commit; last-commit reports message and pushed state', async () => {
  const { host, repo, bare } = await setup({ 'a.txt': '1\n' }, { remote: true })
  const before = await host.get('/git/last-commit', { root: repo })
  assert.equal(before.json.message, 'init')
  assert.equal(before.json.hasUpstream, false)
  assert.equal(before.json.pushed, false)
  const pushed = await post(host, '/git/push', { root: repo })
  assert.equal(pushed.status, 200, JSON.stringify(pushed.json))
  assert.equal((await host.get('/git/last-commit', { root: repo })).json.pushed, true)
  write(repo, { 'a.txt': '2\n' })
  git(repo, 'add', 'a.txt')
  const unpushed = await post(host, '/git/commit', { root: repo, message: 'local only' })
  assert.equal(unpushed.status, 200)
  const last = await host.get('/git/last-commit', { root: repo })
  assert.deepEqual([last.json.message, last.json.hasUpstream, last.json.pushed], ['local only', true, false])
  const count = git(repo, 'rev-list', '--count', 'HEAD').trim()
  const amended = await post(host, '/git/commit', { root: repo, message: 'better message', amend: true })
  assert.equal(amended.status, 200)
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), count)
  assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'better message')
  // amend without a message keeps it
  const kept = await post(host, '/git/commit', { root: repo, message: '', amend: true })
  assert.equal(kept.status, 200)
  assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'better message')
  assert.ok(bare)
})

test('commit: a failing hook surfaces its output', async () => {
  const { host, repo } = await setup({ 'a.txt': '1\n' })
  const hook = join(repo, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  write(repo, { 'a.txt': '2\n' })
  git(repo, 'add', 'a.txt')
  const result = await post(host, '/git/commit', { root: repo, message: 'blocked' })
  assert.equal(result.status, 500)
  assert.match(result.json.error, /hook says no/)
  assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'init')
})

test('commit: missing user.name/email -> identity error with instructions', async () => {
  const repo = tempRepo({ 'a.txt': '1\n' })
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'user.useConfigOnly', 'true')
  const host = await startHost()
  await host.register(repo)
  write(repo, { 'a.txt': '2\n' })
  git(repo, 'add', 'a.txt')
  const keep = { ...process.env }
  const nothing = join(tempDir('dsh-ce-cfg-'), 'none')
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[k]
  process.env.GIT_CONFIG_GLOBAL = nothing
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  try {
    const result = await post(host, '/git/commit', { root: repo, message: 'who am i' })
    assert.equal(result.status, 409)
    assert.equal(result.json.code, 'identity')
    assert.match(result.json.error, /user\.name/)
  } finally {
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) {
      if (keep[k] === undefined) delete process.env[k]
      else process.env[k] = keep[k]
    }
  }
})

test('branches: listing, create (validated), switch, git refusing a dirty switch', async () => {
  const { host, repo } = await setup({ 'a.txt': 'base\n' })
  let list = (await host.get('/git/branches', { root: repo })).json
  assert.equal(list.current, 'main')
  assert.deepEqual(list.local.map((b) => b.name), ['main'])
  assert.equal(list.detached, false)

  for (const bad of ['', 'has space', 'a..b', '-x', 'x.lock', 'a~1', '@{u}', 'ok\u0001', 'trailing/']) {
    const r = await post(host, '/git/checkout', { root: repo, branch: bad, create: true })
    assert.equal(r.status, 400, `branch ${JSON.stringify(bad)}`)
    assert.equal(r.json.code, 'bad-branch')
  }
  const made = await post(host, '/git/checkout', { root: repo, branch: 'feature/x', create: true })
  assert.equal(made.status, 200)
  assert.equal(git(repo, 'branch', '--show-current').trim(), 'feature/x')
  assert.equal((await post(host, '/git/checkout', { root: repo, branch: 'feature/x', create: true })).status, 500) // already exists: git's message
  write(repo, { 'a.txt': 'on feature\n' })
  git(repo, 'commit', '-qam', 'feature change')
  assert.equal((await post(host, '/git/checkout', { root: repo, branch: 'main' })).status, 200)
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8').replace(/\r/g, ''), 'base\n')
  // dirty tree that conflicts with the target: git refuses, the message is shown, nothing is stashed
  write(repo, { 'a.txt': 'dirty\n' })
  const refused = await post(host, '/git/checkout', { root: repo, branch: 'feature/x' })
  assert.equal(refused.status, 500)
  assert.match(refused.json.error, /overwritten|local changes/i)
  assert.equal(git(repo, 'branch', '--show-current').trim(), 'main')
  assert.equal(git(repo, 'stash', 'list').trim(), '')
  assert.equal((await post(host, '/git/checkout', { root: repo, branch: 'nope' })).json.code, 'no-branch')
  list = (await host.get('/git/branches', { root: repo })).json
  assert.deepEqual(list.local.map((b) => [b.name, b.current]), [['feature/x', false], ['main', true]])
})

test('branches: remote branches are listed and checked out as tracking branches; ahead/behind from upstream', async () => {
  const { host, repo, bare } = await setup({ 'a.txt': '1\n' }, { remote: true })
  assert.equal((await post(host, '/git/push', { root: repo })).status, 200)
  const other = clone(bare)
  git(other, 'checkout', '-q', '-b', 'topic')
  write(other, { 't.txt': 't\n' })
  git(other, 'add', '-A')
  git(other, 'commit', '-qm', 'topic work')
  git(other, 'push', '-q', 'origin', 'topic')
  assert.equal((await post(host, '/git/fetch', { root: repo })).status, 200)
  const list = (await host.get('/git/branches', { root: repo })).json
  assert.deepEqual(list.remotes, ['origin'])
  assert.deepEqual(list.remote.map((r) => [r.name, r.remote, r.short, r.local]), [['origin/main', 'origin', 'main', true], ['origin/topic', 'origin', 'topic', false]])
  assert.equal(list.upstream, 'origin/main')
  assert.deepEqual([list.ahead, list.behind], [0, 0])
  const out = await post(host, '/git/checkout', { root: repo, branch: 'origin/topic' })
  assert.equal(out.status, 200, JSON.stringify(out.json))
  assert.equal(out.json.branch, 'topic')
  const after = (await host.get('/git/branches', { root: repo })).json
  assert.equal(after.current, 'topic')
  assert.equal(after.upstream, 'origin/topic')
  assert.ok(existsSync(join(repo, 't.txt')))
})

test('log: paging, hasMore, refs, file history, limits, empty repo', async () => {
  const { host, repo } = await setup({ 'a.txt': '0\n' })
  for (let i = 1; i <= 6; i++) {
    write(repo, { 'a.txt': `${i}\n`, ...(i === 3 ? { 'other.txt': 'o\n' } : {}) })
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', `commit ${i}`)
  }
  git(repo, 'tag', 'v1')
  const p1 = (await host.get('/git/log', { root: repo, limit: '3' })).json
  assert.deepEqual(p1.commits.map((c) => c.subject), ['commit 6', 'commit 5', 'commit 4'])
  assert.equal(p1.hasMore, true)
  assert.ok(p1.commits[0].refs.includes('main'))
  assert.ok(p1.commits[0].refs.includes('tag: v1'))
  assert.equal(p1.commits[0].author, 'T')
  assert.match(p1.commits[0].hash, /^[0-9a-f]{40}$/)
  assert.ok(Math.abs(p1.commits[0].date - Date.now()) < 600_000)
  const p2 = (await host.get('/git/log', { root: repo, limit: '3', skip: '3' })).json
  assert.deepEqual(p2.commits.map((c) => c.subject), ['commit 3', 'commit 2', 'commit 1'])
  assert.equal(p2.hasMore, true)
  const p3 = (await host.get('/git/log', { root: repo, limit: '3', skip: '6' })).json
  assert.deepEqual(p3.commits.map((c) => c.subject), ['init'])
  assert.equal(p3.hasMore, false)
  assert.equal((await host.get('/git/log', { root: repo })).json.commits.length, 7) // default page is 50
  const file = (await host.get('/git/log', { root: repo, path: 'other.txt' })).json
  assert.deepEqual(file.commits.map((c) => c.subject), ['commit 3'])
  for (const query of [{ limit: '0' }, { limit: '201' }, { limit: 'x' }, { skip: '-1' }, { skip: '1.5' }]) {
    assert.equal((await host.get('/git/log', { root: repo, ...query })).status, 400, JSON.stringify(query))
  }
  assert.equal((await host.get('/git/log', { root: repo, path: '../x' })).status, 403)
  assert.equal((await host.get('/git/log', { root: repo, path: '.git/config' })).status, 403)

  const fresh = tempDir('dsh-ce-empty-')
  git(fresh, 'init', '-q', '-b', 'main')
  await host.register(fresh)
  assert.deepEqual((await host.get('/git/log', { root: fresh })).json, { ok: true, commits: [], hasMore: false })
  const notGit = tempDir('dsh-ce-plain-')
  await host.register(notGit)
  assert.equal((await host.get('/git/log', { root: notGit })).json.code, 'not-git')
})

test('log: default page size is 50', async () => {
  const { host, repo } = await setup({ 'a.txt': '0\n' })
  // 55 commits without 55 processes: fast-import
  const lines = []
  for (let i = 1; i <= 54; i++) {
    lines.push('commit refs/heads/main', `mark :${i}`, `committer T <t@example.com> ${1700000000 + i} +0000`, `data ${`c${i}`.length}`, `c${i}`, i === 1 ? 'from refs/heads/main^0' : `from :${i - 1}`, '')
  }
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: lines.join('\n'), windowsHide: true })
  const page = (await host.get('/git/log', { root: repo })).json
  assert.equal(page.commits.length, 50)
  assert.equal(page.hasMore, true)
  assert.equal((await host.get('/git/log', { root: repo, skip: '50' })).json.commits.length, 5)
})

test('commit files and show: statuses, rename, delete, root commit, parent vs commit', async () => {
  const { host, repo } = await setup({ 'keep.txt': 'keep\n', 'gone.txt': 'gone\n', 'old name.txt': 'a rather long body so the rename is detected\nsecond line\nthird line\n', 'edit.txt': 'v1\n' })
  const rootHash = git(repo, 'rev-parse', 'HEAD').trim()
  write(repo, { 'edit.txt': 'v2\n', 'added.txt': 'new\n' })
  rmSync(join(repo, 'gone.txt'))
  git(repo, 'mv', 'old name.txt', 'new name.txt')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'many changes\n\nthe body')
  const hash = git(repo, 'rev-parse', 'HEAD').trim()

  const info = (await host.get('/git/commit', { root: repo, hash })).json
  assert.equal(info.hash, hash)
  assert.equal(info.message, 'many changes\n\nthe body')
  assert.equal(info.parent, rootHash)
  const by = Object.fromEntries(info.files.map((f) => [f.path, f]))
  assert.equal(by['edit.txt'].status, 'M')
  assert.equal(by['added.txt'].status, 'A')
  assert.equal(by['gone.txt'].status, 'D')
  assert.equal(by['new name.txt'].status, 'R')
  assert.equal(by['new name.txt'].origPath, 'old name.txt')

  const edit = (await host.get('/git/show', { root: repo, hash, path: 'edit.txt' })).json
  assert.deepEqual([edit.original, edit.modified, edit.binary], ['v1\n', 'v2\n', false])
  const added = (await host.get('/git/show', { root: repo, hash, path: 'added.txt' })).json
  assert.deepEqual([added.original, added.modified], [null, 'new\n'])
  const gone = (await host.get('/git/show', { root: repo, hash, path: 'gone.txt' })).json
  assert.deepEqual([gone.original, gone.modified], ['gone\n', null])
  const renamed = (await host.get('/git/show', { root: repo, hash, path: 'new name.txt', origPath: 'old name.txt' })).json
  assert.equal(renamed.original, renamed.modified)
  assert.notEqual(renamed.original, null)

  const first = (await host.get('/git/commit', { root: repo, hash: rootHash })).json
  assert.equal(first.parent, null)
  assert.equal(first.files.length, 4, JSON.stringify(first.files))
  assert.ok(first.files.every((f) => f.status === 'A'))
  const rootShow = (await host.get('/git/show', { root: repo, hash: rootHash, path: 'keep.txt' })).json
  assert.deepEqual([rootShow.original, rootShow.modified], [null, 'keep\n'])
  // abbreviated hashes work
  assert.equal((await host.get('/git/commit', { root: repo, hash: hash.slice(0, 8) })).json.hash, hash)
})

test('commit/show: binary files are flagged and hash input is validated', async () => {
  const { host, repo } = await setup({ 'a.txt': '1\n' })
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'binary')
  const hash = git(repo, 'rev-parse', 'HEAD').trim()
  const shown = (await host.get('/git/show', { root: repo, hash, path: 'bin.dat' })).json
  assert.deepEqual([shown.binary, shown.original, shown.modified], [true, null, null])

  const bad = ['', 'abc', 'ABCDEF1234', 'zzzz1234', '--help', '-p', 'HEAD', 'main', `${hash}0`, 'abcd efgh', 'abcd^', 'abcd;ls', '../..', `${hash.slice(0, 8)}\n`]
  for (const value of bad) {
    for (const route of ['/git/commit', '/git/show']) {
      const r = await host.get(route, { root: repo, hash: value, path: 'a.txt' })
      assert.equal(r.status, 400, `${route} hash ${JSON.stringify(value)}`)
    }
  }
  assert.equal((await host.get('/git/commit', { root: repo, hash: 'deadbeef' })).status, 404)
  assert.equal((await host.get('/git/show', { root: repo, hash, path: '../secret' })).status, 403)
  assert.equal((await host.get('/git/show', { root: repo, hash, path: '.git/HEAD' })).status, 403)
})

test('sync: push sets the upstream for a new branch, fetch/pull fast-forward, ahead/behind', async () => {
  const { host, repo, bare } = await setup({ 'a.txt': '1\n' }, { remote: true })
  const first = await post(host, '/git/push', { root: repo })
  assert.equal(first.status, 200, JSON.stringify(first.json))
  assert.equal(first.json.setUpstream, true)
  assert.equal(first.json.remote, 'origin')
  assert.equal(first.json.branch, 'main')
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/main')
  assert.equal(git(bare, 'rev-parse', 'main').trim(), git(repo, 'rev-parse', 'HEAD').trim())

  // a second push uses the plain command
  write(repo, { 'a.txt': '2\n' })
  git(repo, 'commit', '-qam', 'local 2')
  let list = (await host.get('/git/branches', { root: repo })).json
  assert.deepEqual([list.ahead, list.behind], [1, 0])
  const again = await post(host, '/git/push', { root: repo })
  assert.equal(again.status, 200)
  assert.equal(again.json.setUpstream, false)
  assert.equal(git(bare, 'rev-parse', 'main').trim(), git(repo, 'rev-parse', 'HEAD').trim())

  // someone else pushes: fetch shows behind, pull fast-forwards
  const other = clone(bare)
  write(other, { 'b.txt': 'remote\n' })
  git(other, 'add', '-A')
  git(other, 'commit', '-qm', 'remote 1')
  git(other, 'push', '-q', 'origin', 'main')
  assert.equal((await post(host, '/git/fetch', { root: repo })).status, 200)
  list = (await host.get('/git/branches', { root: repo })).json
  assert.deepEqual([list.ahead, list.behind], [0, 1])
  const pulled = await post(host, '/git/pull', { root: repo })
  assert.equal(pulled.status, 200, JSON.stringify(pulled.json))
  assert.ok(existsSync(join(repo, 'b.txt')))
  list = (await host.get('/git/branches', { root: repo })).json
  assert.deepEqual([list.ahead, list.behind], [0, 0])
})

test('sync: pull is ff-only (diverged -> git message, no merge commit, no rebase); push rejection is reported', async () => {
  const { host, repo, bare } = await setup({ 'a.txt': '1\n' }, { remote: true })
  assert.equal((await post(host, '/git/push', { root: repo })).status, 200)
  const other = clone(bare)
  write(other, { 'remote.txt': 'r\n' })
  git(other, 'add', '-A')
  git(other, 'commit', '-qm', 'remote side')
  git(other, 'push', '-q', 'origin', 'main')
  write(repo, { 'local.txt': 'l\n' })
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'local side')
  const headBefore = git(repo, 'rev-parse', 'HEAD').trim()
  // pull.rebase / pull.ff config must not change the outcome
  git(repo, 'config', 'pull.rebase', 'true')
  const pulled = await post(host, '/git/pull', { root: repo })
  assert.equal(pulled.status, 500)
  assert.match(pulled.json.error, /fast-forward|diverg/i)
  assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), headBefore)
  assert.equal(git(repo, 'rev-list', '--merges', '--count', 'HEAD').trim(), '0')
  const rejected = await post(host, '/git/push', { root: repo })
  assert.equal(rejected.status, 500)
  assert.match(rejected.json.error, /rejected|fetch first|non-fast-forward/i)
})

test('sync: no remote, detached HEAD and unknown remotes are refused with clear codes', async () => {
  const { host, repo } = await setup({ 'a.txt': '1\n' })
  for (const route of ['/git/fetch', '/git/pull', '/git/push']) {
    const r = await post(host, route, { root: repo })
    assert.equal(r.status, 409, route)
    assert.equal(r.json.code, 'no-remote')
  }
  const { host: h2, repo: r2 } = await setup({ 'a.txt': '1\n' }, { remote: true })
  assert.equal((await post(h2, '/git/push', { root: r2, remote: 'evil' })).status, 400)
  assert.equal((await post(h2, '/git/push', { root: r2, remote: '--receive-pack=calc' })).status, 400)
  git(r2, 'checkout', '-q', '--detach')
  assert.equal((await post(h2, '/git/pull', { root: r2 })).json.code, 'detached')
  assert.equal((await post(h2, '/git/push', { root: r2 })).json.code, 'detached')
})

test('network failures are fast and never prompt: unreachable host, and a server demanding credentials', async () => {
  const { host, repo } = await setup({ 'a.txt': '1\n' })
  git(repo, 'config', 'credential.helper', '')
  git(repo, 'remote', 'add', 'origin', 'https://127.0.0.1:9/x.git')
  const t0 = Date.now()
  const down = await post(host, '/git/fetch', { root: repo })
  assert.equal(down.status, 500)
  assert.ok(Date.now() - t0 < 30_000)

  // a server that answers 401 + WWW-Authenticate: git would ask for a username on the terminal
  let requests = 0
  const server = createServer((req, res) => {
    requests++
    res.writeHead(401, { 'www-authenticate': 'Basic realm="x"', 'content-length': '0' }).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    git(repo, 'remote', 'set-url', 'origin', `http://127.0.0.1:${server.address().port}/x.git`)
    git(repo, 'branch', '--set-upstream-to=origin/main', 'main') // may fail without the ref; irrelevant for fetch
  } catch {}
  try {
    for (const route of ['/git/fetch', '/git/push']) {
      const started = Date.now()
      const result = await post(host, route, { root: repo })
      assert.ok(Date.now() - started < 30_000, `${route} must fail fast`)
      assert.equal(result.status, 409, `${route}: ${JSON.stringify(result.json)}`)
      assert.equal(result.json.code, 'auth-required')
      assert.match(result.json.error, /run git in a terminal/)
    }
    assert.ok(requests > 0)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('mutating routes need a registered root, JSON, and the right method', async () => {
  const { host, repo } = await setup({ 'a.txt': '1\n' })
  const other = tempDir('dsh-ce-unregistered-')
  git(other, 'init', '-q', '-b', 'main')
  for (const route of ['/git/commit', '/git/checkout', '/git/fetch', '/git/pull', '/git/push']) {
    assert.equal((await post(host, route, { root: other, message: 'x', branch: 'x' })).status, 403, route)
    assert.equal((await host.get(route, { root: repo })).status, route === '/git/commit' ? 400 : 405, route)
  }
  for (const route of ['/git/log', '/git/branches', '/git/last-commit']) {
    assert.equal((await host.get(route, { root: other })).status, 403, route)
    assert.equal((await post(host, route, { root: repo })).status, 405, route)
  }
})
