import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveInside, splitRelative } from '../lib/confine.js'
import { cleanup, tempDir } from './helpers/harness.mjs'

after(cleanup)

const code = (fn) => {
  try {
    fn()
  } catch (error) {
    return error.code
  }
  return undefined
}

test('splitRelative accepts plain relative paths and normalises . and //', () => {
  assert.deepEqual(splitRelative('a/b//./c.txt'), ['a', 'b', 'c.txt'])
  assert.deepEqual(splitRelative('', { allowEmpty: true }), [])
  assert.equal(code(() => splitRelative('')), 'bad-path')
})

test('splitRelative refuses escapes, absolute paths, backslashes, control characters and .git', () => {
  assert.equal(code(() => splitRelative('..')), 'escape')
  assert.equal(code(() => splitRelative('a/../../b')), 'escape')
  assert.equal(code(() => splitRelative('/etc/passwd')), 'escape')
  assert.equal(code(() => splitRelative('C:/Windows/win.ini')), 'escape')
  assert.equal(code(() => splitRelative('c:foo')), 'escape')
  assert.equal(code(() => splitRelative('a\\b')), 'bad-path')
  assert.equal(code(() => splitRelative('a\0b')), 'bad-path')
  assert.equal(code(() => splitRelative('a\nb')), 'bad-path')
  assert.equal(code(() => splitRelative('x'.repeat(1025))), 'bad-path')
  assert.equal(code(() => splitRelative(`${'y'.repeat(256)}`)), 'bad-path')
  assert.equal(code(() => splitRelative('.git/config')), 'forbidden')
  assert.equal(code(() => splitRelative('sub/.GIT/hooks/pre-commit')), 'forbidden')
  assert.equal(code(() => splitRelative(42)), 'bad-path')
  // Encoded tricks are just odd file names; they never act as separators or dots.
  assert.deepEqual(splitRelative('%2e%2e/x'), ['%2e%2e', 'x'])
})

test('resolveInside stays inside the root and appends missing tails', async () => {
  const root = tempDir()
  mkdirSync(join(root, 'd'))
  writeFileSync(join(root, 'd', 'f.txt'), 'x')
  assert.equal(await resolveInside(root, ['d', 'f.txt']), join(root, 'd', 'f.txt'))
  assert.equal(await resolveInside(root, ['d', 'new', 'deep.txt']), join(root, 'd', 'new', 'deep.txt'))
})

test('a symlink or junction pointing outside the root is refused', async () => {
  const root = tempDir()
  const outside = tempDir('dsh-ce-outside-')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  symlinkSync(outside, join(root, 'link'), 'junction')
  await assert.rejects(resolveInside(root, ['link', 'secret.txt']), { code: 'escape' })
  await assert.rejects(resolveInside(root, ['link']), { code: 'escape' })
  // not-yet-existing file below the escaping link
  await assert.rejects(resolveInside(root, ['link', 'new.txt']), { code: 'escape' })
  // git style resolution does not follow the leaf: the link itself is addressable
  assert.equal(await resolveInside(root, ['link'], { followLeaf: false }), join(root, 'link'))
})

test('a file symlink pointing outside is refused when followed', async (t) => {
  const root = tempDir()
  const outside = tempDir('dsh-ce-outside-')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  try {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'peek.txt'), 'file')
  } catch {
    t.skip('file symlinks need privileges on this machine')
    return
  }
  await assert.rejects(resolveInside(root, ['peek.txt']), { code: 'escape' })
})

test('a symlink that stays inside the root is fine', async () => {
  const root = tempDir()
  mkdirSync(join(root, 'real'))
  writeFileSync(join(root, 'real', 'f.txt'), 'x')
  symlinkSync(join(root, 'real'), join(root, 'alias'), 'junction')
  assert.equal(await resolveInside(root, ['alias', 'f.txt']), join(root, 'real', 'f.txt'))
})
