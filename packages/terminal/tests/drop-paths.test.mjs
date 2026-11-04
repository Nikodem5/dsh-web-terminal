// Quoting and planning of files dropped on a terminal (src/client/drop-paths.ts).
//
//   node --test tests/drop-paths.test.mjs

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let d
before(async () => {
  const out = await build({ entryPoints: [join(root, 'src', 'client', 'drop-paths.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'silent' })
  d = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
})

test('shell kind from the host shell id', () => {
  assert.equal(d.dropShellKind('powershell', true), 'powershell')
  assert.equal(d.dropShellKind('pwsh', true), 'powershell')
  assert.equal(d.dropShellKind('cmd', true), 'cmd')
  assert.equal(d.dropShellKind('gitbash', true), 'gitbash')
  assert.equal(d.dropShellKind('wsl', true), 'wsl')
  assert.equal(d.dropShellKind('zsh', false), 'posix')
  assert.equal(d.dropShellKind('default', true), 'ambiguous')
  assert.equal(d.dropShellKind('default', false), 'posix')
})

test('PowerShell: single quotes, quotes doubled, $ and backticks stay literal', () => {
  assert.equal(d.quotePath(String.raw`C:\My Files\a.txt`, 'powershell'), String.raw`'C:\My Files\a.txt'`)
  assert.equal(d.quotePath(String.raw`C:\it's $x ` + '`y`.txt', 'powershell'), String.raw`'C:\it''s $x ` + '`y`.txt' + "'")
  assert.equal(d.quotePath('C:\\a\u2019b', 'powershell'), "'C:\\a\u2019\u2019b'")
})

test('cmd: double quotes; a path with % or a quote is refused', () => {
  assert.equal(d.quotePath(String.raw`C:\My Files\a&b.txt`, 'cmd'), String.raw`"C:\My Files\a&b.txt"`)
  assert.equal(d.quotePath(String.raw`C:\%PATH%\a`, 'cmd'), undefined)
  assert.equal(d.quotePath(String.raw`C:\a"b`, 'cmd'), undefined)
})

test('default shell on Windows: only quoting that cmd and PowerShell read alike', () => {
  assert.equal(d.quotePath(String.raw`C:\My Files\a.txt`, 'ambiguous'), String.raw`"C:\My Files\a.txt"`)
  for (const bad of ['C:\\a$b', 'C:\\a`b', 'C:\\a%b', 'C:\\a&b', 'C:\\a!b', 'C:\\a^b', 'C:\\a"b']) assert.equal(d.quotePath(bad, 'ambiguous'), undefined, bad)
})

test('POSIX shells: single quotes, embedded quote closed and escaped, $ literal', () => {
  assert.equal(d.quotePath("/tmp/it's $HOME `id` $(id).txt", 'posix'), "'/tmp/it'\\''s $HOME `id` $(id).txt'")
  assert.equal(d.quotePath('/tmp/a b', 'posix'), "'/tmp/a b'")
})

test('Git Bash and WSL get the path as that shell sees it', () => {
  assert.equal(d.quotePath(String.raw`C:\Users\Me Me\x.txt`, 'gitbash'), "'/c/Users/Me Me/x.txt'")
  assert.equal(d.quotePath(String.raw`D:\a`, 'wsl'), "'/mnt/d/a'")
  assert.equal(d.quotePath(String.raw`\\server\share\f`, 'gitbash'), undefined)
})

test('control characters are never pasted (newline would run it, ESC could end a bracketed paste)', () => {
  for (const shell of ['powershell', 'cmd', 'posix', 'gitbash', 'wsl', 'ambiguous']) {
    for (const bad of ['/a\nb', '/a\rb', '/a\x1bb', '/a\x00b', '/a\u2028b']) assert.equal(d.quotePath(bad, shell), undefined, `${shell} ${JSON.stringify(bad)}`)
  }
  assert.equal(d.quotePath('', 'posix'), undefined)
})

test('plan: items space-separated, no newline, unknown paths skipped', () => {
  const plan = d.planDrop(['/a b', undefined, '/c', '/x\ny'], 'posix')
  assert.equal(plan.text, "'/a b' '/c' ")
  assert.equal(plan.skipped, 2)
  assert.ok(!/[\r\n]/.test(plan.text))
  assert.deepEqual(d.planDrop([undefined], 'posix'), { text: '', skipped: 1 })
  assert.deepEqual(d.planDrop([], 'posix'), { text: '', skipped: 0 })
})
