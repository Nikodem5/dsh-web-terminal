import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, startHost, tempDir, tempRepo, write } from './helpers/harness.mjs'

after(cleanup)

async function setup(files = {}) {
  const host = await startHost()
  const root = tempDir()
  write(root, files)
  await host.register(root)
  return { host, root }
}

test('tree lists dirs first, hides .git, reports size and mtime, does not recurse', async () => {
  const repo = tempRepo({ 'src/deep/x.js': 'x', 'b.txt': 'bb', 'A.txt': 'a' })
  const host = await startHost()
  await host.register(repo)
  const top = await host.get('/tree', { root: repo, dir: '' })
  assert.equal(top.status, 200)
  assert.deepEqual(top.json.entries.map((e) => [e.name, e.type]), [['src', 'dir'], ['A.txt', 'file'], ['b.txt', 'file']])
  const b = top.json.entries.find((e) => e.name === 'b.txt')
  assert.equal(b.size, 2)
  assert.equal(b.mtime, statSync(join(repo, 'b.txt')).mtimeMs)
  const sub = await host.get('/tree', { root: repo, dir: 'src' })
  assert.deepEqual(sub.json.entries.map((e) => e.name), ['deep'])
  assert.equal((await host.get('/tree', { root: repo, dir: 'nope' })).status, 404)
  assert.equal((await host.get('/tree', { root: repo, dir: 'b.txt' })).status, 404)
})

test('files: git roots use ls-files (tracked + untracked, not ignored); plain roots walk and skip heavy dirs', async () => {
  const repo = tempRepo({ 'a.txt': 'a', '.gitignore': 'ignored.txt\n', 'ignored.txt': 'i' })
  write(repo, { 'new.txt': 'n', 'sub/u.txt': 'u' })
  const host = await startHost()
  await host.register(repo)
  const git = await host.get('/files', { root: repo })
  assert.deepEqual(git.json.files.sort(), ['.gitignore', 'a.txt', 'new.txt', 'sub/u.txt'])
  assert.equal(git.json.truncated, false)

  const plain = tempDir()
  write(plain, { 'k.txt': '1', 'node_modules/p/i.js': '1', 'dist/o.js': '1', 'build/o.js': '1', '.git/config': '1', 'src/m.ts': '1' })
  await host.register(plain)
  const walked = await host.get('/files', { root: plain })
  assert.deepEqual(walked.json.files, ['k.txt', 'src/m.ts'])
})

test('GET file: text, eol, mtime, binary, too large', async () => {
  const { host, root } = await setup({ 'lf.txt': 'a\nb\n', 'crlf.txt': 'a\r\nb\r\n', 'empty.txt': '', 'ünï/ö.txt': 'ö' })
  writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1))
  writeFileSync(join(root, 'limit.txt'), 'y'.repeat(2 * 1024 * 1024))
  writeFileSync(join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
  const lf = await host.get('/file', { root, path: 'lf.txt' })
  assert.equal(lf.status, 200)
  assert.deepEqual({ ...lf.json, mtime: undefined }, { ok: true, content: 'a\nb\n', mtime: undefined, size: 4, binary: false, tooLarge: false, eol: 'lf' })
  assert.equal(lf.json.mtime, statSync(join(root, 'lf.txt')).mtimeMs)
  assert.equal((await host.get('/file', { root, path: 'crlf.txt' })).json.eol, 'crlf')
  assert.equal((await host.get('/file', { root, path: 'empty.txt' })).json.content, '')
  assert.equal((await host.get('/file', { root, path: 'ünï/ö.txt' })).json.content, 'ö')
  const bin = await host.get('/file', { root, path: 'bin.dat' })
  assert.deepEqual([bin.json.binary, bin.json.content, bin.json.tooLarge], [true, null, false])
  const big = await host.get('/file', { root, path: 'big.txt' })
  assert.deepEqual([big.json.tooLarge, big.json.content, big.json.size], [true, null, 2 * 1024 * 1024 + 1])
  assert.equal((await host.get('/file', { root, path: 'limit.txt' })).json.tooLarge, false)
  assert.equal((await host.get('/file', { root, path: 'latin1.txt' })).json.binary, true)
  assert.equal((await host.get('/file', { root, path: 'missing.txt' })).status, 404)
  assert.equal((await host.get('/file', { root, path: 'ünï' })).status, 400)
})

test('PUT file: create, update, conflicts, atomic (no temp files left), mode kept', async () => {
  const { host, root } = await setup({ 'sub/exist.txt': 'old' })
  const created = await host.put('/file', { root, path: 'new/dir/created.txt', content: 'hello', expectedMtime: null })
  assert.equal(created.status, 200)
  assert.equal(readFileSync(join(root, 'new/dir/created.txt'), 'utf8'), 'hello')
  assert.equal(created.json.size, 5)
  assert.equal(created.json.mtime, statSync(join(root, 'new/dir/created.txt')).mtimeMs)

  // creating over an existing file -> 409 with the current mtime
  const clash = await host.put('/file', { root, path: 'new/dir/created.txt', content: 'x', expectedMtime: null })
  assert.equal(clash.status, 409)
  assert.equal(clash.json.code, 'conflict')
  assert.equal(clash.json.mtime, created.json.mtime)
  assert.equal(readFileSync(join(root, 'new/dir/created.txt'), 'utf8'), 'hello')

  // update with the right mtime
  const read = await host.get('/file', { root, path: 'sub/exist.txt' })
  const updated = await host.put('/file', { root, path: 'sub/exist.txt', content: 'new\r\ncontent', expectedMtime: read.json.mtime })
  assert.equal(updated.status, 200)
  assert.equal(readFileSync(join(root, 'sub/exist.txt'), 'utf8'), 'new\r\ncontent')

  // update with a stale mtime
  const stale = await host.put('/file', { root, path: 'sub/exist.txt', content: 'lost', expectedMtime: read.json.mtime })
  assert.equal(stale.status, 409)
  assert.equal(stale.json.mtime, updated.json.mtime)
  assert.equal(readFileSync(join(root, 'sub/exist.txt'), 'utf8'), 'new\r\ncontent')

  // a file changed behind our back
  const bumped = new Date(Date.now() + 5000)
  utimesSync(join(root, 'sub/exist.txt'), bumped, bumped)
  assert.equal((await host.put('/file', { root, path: 'sub/exist.txt', content: 'x', expectedMtime: updated.json.mtime })).status, 409)

  // expecting an mtime of a file that no longer exists
  const gone = await host.put('/file', { root, path: 'ghost.txt', content: 'x', expectedMtime: 123 })
  assert.equal(gone.status, 409)
  assert.equal(gone.json.mtime, null)

  // no temp files left behind
  assert.deepEqual(readdirSync(join(root, 'sub')).filter((n) => n.includes('dsh-tmp')), [])
  assert.deepEqual(readdirSync(join(root, 'new/dir')), ['created.txt'])
})

test('PUT file validates its body', async () => {
  const { host, root } = await setup({ 'f.txt': 'x', 'dir/inner.txt': 'x' })
  const base = { root, path: 'f.txt', content: 'x', expectedMtime: null }
  assert.equal((await host.put('/file', { ...base, content: 5 })).status, 400)
  assert.equal((await host.put('/file', { ...base, expectedMtime: 'now' })).status, 400)
  assert.equal((await host.put('/file', { root, path: 'f.txt', content: 'x' })).status, 400)
  assert.equal((await host.put('/file', { ...base, path: '' })).status, 400)
  assert.equal((await host.put('/file', { ...base, path: 'dir', expectedMtime: statSync(join(root, 'dir')).mtimeMs })).status, 400)
  assert.equal(readFileSync(join(root, 'f.txt'), 'utf8'), 'x')
})

test('unicode content round-trips', async () => {
  const { host, root } = await setup()
  const content = 'zażółć 🙂 日本語\n'
  assert.equal((await host.put('/file', { root, path: 'u.txt', content, expectedMtime: null })).status, 200)
  assert.equal((await host.get('/file', { root, path: 'u.txt' })).json.content, content)
})

test('PUT keeps the file mode on POSIX', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX modes')
  const { host, root } = await setup({ 'run.sh': '#!/bin/sh\n' })
  chmodSync(join(root, 'run.sh'), 0o755)
  const read = await host.get('/file', { root, path: 'run.sh' })
  await host.put('/file', { root, path: 'run.sh', content: 'x', expectedMtime: read.json.mtime })
  assert.equal(statSync(join(root, 'run.sh')).mode & 0o777, 0o755)
})

test('escape attempts on every file route: ..  absolute  encoded  .git  NUL  control characters', async () => {
  const outsideDir = tempDir('dsh-ce-outside-')
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret')
  const { host, root } = await setup({ 'ok.txt': 'ok', '.git/HEAD': 'ref: refs/heads/x\n' })
  const abs = join(outsideDir, 'secret.txt')
  const bad = ['../secret.txt', '..', 'a/../../secret.txt', abs, abs.replace(/\\/g, '/'), '/etc/passwd', 'C:/Windows/win.ini', 'a\\..\\..\\secret.txt', 'ok.txt\0.png', 'ok.txt\n', '.git/HEAD', '.git/hooks/pre-commit']
  for (const path of bad) {
    const read = await host.get('/file', { root, path })
    assert.ok([400, 403, 404].includes(read.status), `GET ${JSON.stringify(path)} -> ${read.status}`)
    assert.notEqual(read.json.content, 'secret', path)
    const wrote = await host.put('/file', { root, path, content: 'pwn', expectedMtime: null })
    assert.ok([400, 403].includes(wrote.status), `PUT ${JSON.stringify(path)} -> ${wrote.status}`)
  }
  // Percent-encoding is never decoded by the host: these are ordinary (odd) names inside the root.
  for (const path of ['%2e%2e/secret.txt', '..%2fsecret.txt']) {
    assert.equal((await host.put('/file', { root, path, content: 'in-root', expectedMtime: null })).status, 200)
  }
  assert.equal(readFileSync(join(root, '%2e%2e', 'secret.txt'), 'utf8'), 'in-root')
  assert.equal(readFileSync(abs, 'utf8'), 'secret')
  assert.equal(readFileSync(join(root, '.git/HEAD'), 'utf8'), 'ref: refs/heads/x\n')
  assert.deepEqual(readdirSync(outsideDir), ['secret.txt'])
  assert.equal((await host.get('/file', { root, path: '../secret.txt' })).json.code, 'escape')
  assert.equal((await host.get('/file', { root, path: abs.replace(/\\/g, '/') })).json.code, 'escape')
  assert.equal((await host.get('/tree', { root, dir: '..' })).json.code, 'escape')
  assert.equal((await host.get('/tree', { root, dir: '.git' })).json.code, 'forbidden')
})

test('a junction / symlink pointing outside the root is refused for tree, read, write and create', async () => {
  const outsideDir = tempDir('dsh-ce-outside-')
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret')
  const { host, root } = await setup({ 'ok.txt': 'ok' })
  symlinkSync(outsideDir, join(root, 'escape'), 'junction')
  const tree = await host.get('/tree', { root, dir: 'escape' })
  assert.equal(tree.status, 403)
  assert.equal(tree.json.code, 'escape')
  const read = await host.get('/file', { root, path: 'escape/secret.txt' })
  assert.equal(read.status, 403)
  assert.equal(read.json.code, 'escape')
  const write = await host.put('/file', { root, path: 'escape/secret.txt', content: 'pwn', expectedMtime: statSync(join(outsideDir, 'secret.txt')).mtimeMs })
  assert.equal(write.status, 403)
  const create = await host.put('/file', { root, path: 'escape/new.txt', content: 'pwn', expectedMtime: null })
  assert.equal(create.status, 403)
  const deep = await host.put('/file', { root, path: 'escape/newdir/new.txt', content: 'pwn', expectedMtime: null })
  assert.equal(deep.status, 403)
  assert.deepEqual(readdirSync(outsideDir), ['secret.txt'])
  assert.equal(readFileSync(join(outsideDir, 'secret.txt'), 'utf8'), 'secret')
  // the link itself is listed as a symlink entry (never followed implicitly)
  const top = await host.get('/tree', { root, dir: '' })
  assert.equal(top.json.entries.find((e) => e.name === 'escape').type, 'symlink')
  // quick open does not walk through it
  const files = await host.get('/files', { root })
  assert.ok(!files.json.files.some((f) => f.startsWith('escape/')))
})

test('a registered root that is itself a junction to elsewhere is confined to its target', async () => {
  const target = tempDir('dsh-ce-target-')
  write(target, { 'in.txt': 'in' })
  const holder = tempDir()
  symlinkSync(target, join(holder, 'viaLink'), 'junction')
  const host = await startHost()
  const root = join(holder, 'viaLink')
  await host.register(root)
  assert.equal((await host.get('/file', { root, path: 'in.txt' })).json.content, 'in')
  assert.equal((await host.get('/file', { root, path: '../x' })).status, 403)
})

test('nested missing dirs are created inside the root and nothing escapes via mkdir', async () => {
  const { host, root } = await setup()
  const result = await host.put('/file', { root, path: 'a/b/c/d.txt', content: 'd', expectedMtime: null })
  assert.equal(result.status, 200)
  mkdirSync(join(root, 'x'), { recursive: true })
  assert.equal(readFileSync(join(root, 'a/b/c/d.txt'), 'utf8'), 'd')
})
