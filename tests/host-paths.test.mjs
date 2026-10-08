// Host half of clickable paths: /paths (existence + cwd rules) and /open (argv per target).
// No editor is ever launched: opening goes through an injected fake spawn.
//
//   npm test   (or: node --test tests/host-paths.test.mjs)

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { expand, linuxCwd, resolveCandidates } from '../lib/paths.js'
import { OpenError, createOpener, gotoArg, splitTemplate, templateToArgv } from '../lib/open.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-wt-paths-home-'))
process.env.DSH_HOME = home
const work = mkdtempSync(join(tmpdir(), 'dsh-wt-paths-work-'))
mkdirSync(join(work, 'src'))
writeFileSync(join(work, 'src', 'a.ts'), 'x')
writeFileSync(join(work, 'top.md'), 'x')
writeFileSync(join(work, 'run.sh'), 'x')
const teardowns = []
after(() => {
  for (const t of teardowns) t()
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

// ── pure pieces ──

test('expand: relative paths join the cwd, ~ the home, absolute ones stay', () => {
  assert.deepEqual(expand('src/a.ts', { cwd: '/w', home: '/h', platform: 'linux' }), ['/w/src/a.ts'])
  assert.deepEqual(expand('../x', { cwd: '/w/p', home: '/h', platform: 'linux' }), ['/w/x'])
  assert.deepEqual(expand('~/n/a.md', { cwd: '/w', home: '/h', platform: 'linux' }), ['/h/n/a.md'])
  assert.deepEqual(expand('/etc/hosts', { cwd: '/w', home: '/h', platform: 'linux' }), ['/etc/hosts'])
  assert.deepEqual(expand('a.ts', { cwd: undefined, home: '/h', platform: 'linux' }), [], 'no cwd, no guess')
  assert.deepEqual(expand('a\0b', { cwd: '/w', home: '/h', platform: 'linux' }), [])
})

test('expand: Windows slashes, drives, ~ and Git Bash drive paths', () => {
  const ctx = { cwd: 'C:\\w\\p', home: 'C:\\Users\\me', platform: 'win32' }
  assert.deepEqual(expand('src/a.ts', ctx), ['C:\\w\\p\\src\\a.ts'])
  assert.deepEqual(expand('..\\x.ts', ctx), ['C:\\w\\x.ts'])
  assert.deepEqual(expand('D:/a/b.ts', ctx), ['D:\\a\\b.ts'])
  assert.deepEqual(expand('~/n.md', ctx), ['C:\\Users\\me\\n.md'])
  assert.deepEqual(expand('/c/Users/me/a.ts', ctx), ['\\c\\Users\\me\\a.ts', 'C:\\Users\\me\\a.ts'])
})

test('linuxCwd: the deepest recent descendant wins, the shell is the fallback', () => {
  const links = { 10: '/home/me', 11: '/home/me/proj', 12: '/home/me/proj/sub' }
  const kids = { 10: '11', 11: '9 12', 12: '' }
  const readlink = (p) => {
    const pid = Number(/\/proc\/(\d+)\/cwd/.exec(p)[1])
    if (links[pid] === undefined) throw new Error('ESRCH')
    return links[pid]
  }
  const readFile = (p) => {
    const pid = Number(/\/proc\/(\d+)\//.exec(p)[1])
    if (kids[pid] === undefined) throw new Error('ENOENT')
    return `${kids[pid]} \n`
  }
  assert.equal(linuxCwd(10, { readlink, readFile }), '/home/me/proj/sub')
  assert.equal(linuxCwd(10, { readlink, readFile: () => { throw new Error('no children file') } }), '/home/me')
  assert.equal(linuxCwd(99, { readlink, readFile }), undefined)
})

test('resolveCandidates: existing files and folders resolve, the rest are null', async () => {
  const r = await resolveCandidates(['src/a.ts', 'src', 'nope.ts', join(work, 'top.md')], { cwd: work, home: homedir() })
  assert.deepEqual(r.map((x) => [x.candidate, x.path === null ? null : x.path.replace(work, '<w>'), x.isDir]), [
    ['src/a.ts', join('<w>', 'src', 'a.ts'), false],
    ['src', join('<w>', 'src'), true],
    ['nope.ts', null, false],
    [join(work, 'top.md'), join('<w>', 'top.md'), false],
  ])
})

test('splitTemplate: whitespace separates, quotes group, backslashes are literal', () => {
  assert.deepEqual(splitTemplate('ed -g {file}'), ['ed', '-g', '{file}'])
  assert.deepEqual(splitTemplate('"C:\\Program Files\\Ed\\ed.exe"  --goto  \'{file}\''), ['C:\\Program Files\\Ed\\ed.exe', '--goto', '{file}'])
  assert.deepEqual(splitTemplate('ed ""'), ['ed', ''])
  assert.throws(() => splitTemplate('ed "{file}'), OpenError)
})

test('templateToArgv: placeholders go into single arguments, missing line/col follow the rule', () => {
  const file = '/w/my dir/a.ts'
  assert.deepEqual(templateToArgv('myeditor {file}:{line}:{col}', { file, line: 12, col: 5 }), ['myeditor', '/w/my dir/a.ts:12:5'])
  assert.deepEqual(templateToArgv('myeditor {file}:{line}:{col}', { file, line: 12 }), ['myeditor', '/w/my dir/a.ts:12'], 'missing col drops :{col}')
  assert.deepEqual(templateToArgv('myeditor {file}:{line}:{col}', { file }), ['myeditor', '/w/my dir/a.ts'], 'missing line drops both')
  assert.deepEqual(templateToArgv('myeditor {file}:{line}:{col}', { file, col: 5 }), ['myeditor', '/w/my dir/a.ts'], 'a column without a line is ignored')
  assert.deepEqual(templateToArgv('vim +{line} {file}', { file }), ['vim', '+1', '/w/my dir/a.ts'], 'not after a colon: becomes 1')
  assert.deepEqual(templateToArgv('ed --line {line} --col {col} "{file}"', { file, line: 3 }), ['ed', '--line', '3', '--col', '1', '/w/my dir/a.ts'])
  assert.deepEqual(templateToArgv('ed {dir} {file}', { file }), ['ed', '/w/my dir', '/w/my dir/a.ts'])
  assert.deepEqual(templateToArgv('ed {file}', { file: '/w/$(x) ; "q".ts' }), ['ed', '/w/$(x) ; "q".ts'], 'a path is never re-split or interpreted')
  assert.throws(() => templateToArgv('   ', { file }), OpenError)
})

test('gotoArg', () => {
  assert.equal(gotoArg('/a', undefined, undefined), '/a')
  assert.equal(gotoArg('/a', 3, undefined), '/a:3')
  assert.equal(gotoArg('/a', 3, 4), '/a:3:4')
})

// ── opener with a fake spawn ──

function fakeSpawn() {
  const calls = []
  const spawn = (file, args, opts) => {
    calls.push({ file, args, opts })
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  return { spawn, calls }
}

const target = join(work, 'src', 'a.ts')

test('open vscode/cursor on Linux: <editor> -g file:line:col, argv only, detached, no shell', async () => {
  const { spawn, calls } = fakeSpawn()
  const open = createOpener({ spawn, which: async (n) => `/usr/bin/${n}`, platform: 'linux' })
  await open({ path: target, line: 12, col: 5, target: 'vscode' })
  await open({ path: target, line: 7, target: 'cursor' })
  await open({ path: target, target: 'vscode' })
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [
    ['/usr/bin/code', ['-g', `${target}:12:5`]],
    ['/usr/bin/cursor', ['-g', `${target}:7`]],
    ['/usr/bin/code', ['-g', target]],
  ])
  for (const c of calls) {
    assert.equal(c.opts.detached, true)
    assert.equal(c.opts.windowsHide, true)
    assert.equal(c.opts.stdio, 'ignore')
    assert.notEqual(c.opts.shell, true)
  }
})

test('open vscode on Windows: the real Code.exe beside code.cmd is spawned directly', async () => {
  const { spawn, calls } = fakeSpawn()
  const shim = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'
  const exe = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
  const open = createOpener({ spawn, which: async (n) => (n === 'code.cmd' ? shim : undefined), platform: 'win32', exists: (p) => p === exe })
  await open({ path: target, line: 3, col: 1, target: 'vscode' })
  assert.deepEqual([calls[0].file, calls[0].args], [exe, ['-g', `${target}:3:1`]])
})

test('open cursor on Windows: Cursor.exe three levels above cursor.cmd', async () => {
  const { spawn, calls } = fakeSpawn()
  const shim = 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd'
  const exe = 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe'
  const open = createOpener({ spawn, which: async (n) => (n === 'cursor.cmd' ? shim : undefined), platform: 'win32', exists: (p) => p === exe })
  await open({ path: target, line: 3, target: 'cursor' })
  assert.deepEqual([calls[0].file, calls[0].args], [exe, ['-g', `${target}:3`]])
})

test('a Windows .cmd shim with no .exe goes through cmd.exe only with safe arguments', async () => {
  const { spawn, calls } = fakeSpawn()
  const open = createOpener({ spawn, which: async () => 'C:\\bin\\code.cmd', platform: 'win32', exists: () => false })
  await open({ path: target, line: 3, target: 'vscode' })
  assert.equal(calls[0].file, 'cmd.exe')
  assert.equal(calls[0].opts.windowsVerbatimArguments, true)
  assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c'])
  const hostile = join(work, 'a&b.txt')
  writeFileSync(hostile, 'x')
  await assert.rejects(open({ path: hostile, target: 'vscode' }), /special characters/)
  assert.equal(calls.length, 1, 'nothing was spawned for the hostile name')
})

test('open default: explorer.exe / xdg-open / open; scripts and programs are refused', async () => {
  for (const [platform, program] of [['win32', 'explorer.exe'], ['linux', 'xdg-open'], ['darwin', 'open']]) {
    const { spawn, calls } = fakeSpawn()
    const open = createOpener({ spawn, which: async () => undefined, platform })
    await open({ path: join(work, 'top.md'), target: 'default' })
    assert.deepEqual([calls[0].file, calls[0].args], [program, [join(work, 'top.md')]])
  }
  const { spawn, calls } = fakeSpawn()
  const open = createOpener({ spawn, which: async () => undefined, platform: 'linux' })
  await assert.rejects(open({ path: join(work, 'run.sh'), target: 'default' }), /would run it/)
  assert.equal(calls.length, 0)
})

test('a folder opens in the file manager whatever the target', async () => {
  const { spawn, calls } = fakeSpawn()
  const open = createOpener({ spawn, which: async (n) => `/usr/bin/${n}`, platform: 'linux' })
  await open({ path: join(work, 'src'), target: 'vscode' })
  assert.deepEqual([calls[0].file, calls[0].args], ['xdg-open', [join(work, 'src')]])
})

test('open custom: template argv with line/col, no shell', async () => {
  const { spawn, calls } = fakeSpawn()
  const open = createOpener({ spawn, which: async () => undefined, platform: 'linux' })
  await open({ path: target, line: 4, col: 2, target: 'custom', template: 'myeditor --at {file}:{line}:{col}' })
  await open({ path: target, target: 'custom', template: 'myeditor {file}:{line}:{col}' })
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [
    ['myeditor', ['--at', `${target}:4:2`]],
    ['myeditor', [target]],
  ])
})

test('open validation: bad body, unknown target, missing file, template problems', async () => {
  const { spawn, calls } = fakeSpawn()
  const open = createOpener({ spawn, which: async () => undefined, platform: 'linux' })
  await assert.rejects(open(null), /Bad request/)
  await assert.rejects(open({ path: 5, target: 'vscode' }), /Bad path/)
  await assert.rejects(open({ path: target, target: 'rm' }), /Unknown target/)
  await assert.rejects(open({ path: join(work, 'gone.ts'), target: 'vscode' }), /no longer exists/)
  await assert.rejects(open({ path: target, target: 'custom' }), /custom command/)
  await assert.rejects(open({ path: target, target: 'custom', template: 'ed' }), /\{file\}/)
  await assert.rejects(open({ path: target, target: 'custom', template: 'x'.repeat(600) + '{file}' }), /custom command/)
  assert.equal(calls.length, 0)
})

test('a missing editor is a readable error, not a crash', async () => {
  const noWhich = createOpener({ spawn: fakeSpawn().spawn, which: async () => undefined, platform: 'win32', exists: () => false })
  await assert.rejects(noWhich({ path: target, target: 'vscode' }), /VS Code not found on PATH/)
  await assert.rejects(noWhich({ path: target, target: 'cursor' }), /Cursor not found on PATH/)
  const enoent = () => {
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
    return child
  }
  const gone = createOpener({ spawn: enoent, which: async (n) => `/usr/bin/${n}`, platform: 'linux' })
  await assert.rejects(gone({ path: target, target: 'vscode' }), /VS Code not found on PATH/)
  await assert.rejects(gone({ path: target, target: 'custom', template: 'nosuch {file}' }), /Command not found: nosuch/)
})

// ── the routes ──

function startRoutes() {
  const routes = []
  const { spawn, calls } = fakeSpawn()
  let teardown
  apply({
    webServer: { register: (r) => { routes.push(r); return () => {} }, registerUpgrade: () => () => {} },
    subprocess: { spawnTerminal: async () => { throw new Error('unused') } },
    effect: (fn) => { teardown = fn() },
    wtSpawn: spawn,
  })
  teardowns.push(teardown)
  const call = (path, method, body) =>
    new Promise((resolve) => {
      const req = new EventEmitter()
      req.method = method
      const res = {
        writeHead(status) { this.status = status },
        end(payload) { resolve({ status: this.status, body: JSON.parse(payload) }) },
      }
      routes.find((r) => r.path === path).handler(req, res)
      queueMicrotask(() => {
        if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
        req.emit('end')
      })
    })
  return { call, spawned: calls }
}

test('POST /paths: relative against the cwd, nonexistent null, ~ against home', async () => {
  const { call } = startRoutes()
  const r = await call('/api/dsh-web-terminal/paths', 'POST', { terminalId: 'unknown', cwd: work, candidates: ['src/a.ts', 'top.md:1', 'missing.ts', '~/definitely-not-here-xyz'] })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.deepEqual(r.body.results.map((x) => [x.candidate, x.path !== null, x.isDir]), [
    ['src/a.ts', true, false],
    ['top.md:1', false, false],
    ['missing.ts', false, false],
    ['~/definitely-not-here-xyz', false, false],
  ])
  assert.equal(r.body.results[0].path, join(work, 'src', 'a.ts'))
})

test('POST /paths: limits and types', async () => {
  const { call } = startRoutes()
  const url = '/api/dsh-web-terminal/paths'
  assert.equal((await call(url, 'POST', { candidates: Array.from({ length: 51 }, (_, i) => `f${i}.ts`) })).status, 400)
  assert.equal((await call(url, 'POST', { candidates: Array.from({ length: 50 }, (_, i) => `f${i}.ts`), cwd: work })).status, 200)
  assert.equal((await call(url, 'POST', { candidates: [1] })).status, 400)
  assert.equal((await call(url, 'POST', { candidates: 'a.ts' })).status, 400)
  assert.equal((await call(url, 'POST', '{nope')).status, 400)
  assert.equal((await call(url, 'GET')).status, 405)
  const long = await call(url, 'POST', { cwd: work, candidates: ['a'.repeat(2000) + '.ts'] })
  assert.equal(long.body.results[0].path, null, 'an over-long candidate is simply not found')
  const big = await call(url, 'POST', { candidates: ['x'.repeat(200 * 1024)] })
  assert.equal(big.status, 413)
})

test('POST /open: spawns through the fake, returns errors as JSON', async () => {
  const { call, spawned } = startRoutes()
  const url = '/api/dsh-web-terminal/open'
  const ok = await call(url, 'POST', { path: target, line: 2, col: 3, target: 'custom', template: 'myeditor {file}:{line}:{col}' })
  assert.deepEqual(ok.body, { ok: true })
  assert.deepEqual([spawned[0].file, spawned[0].args], ['myeditor', [`${target}:2:3`]])
  const bad = await call(url, 'POST', { path: join(work, 'gone.ts'), target: 'custom', template: 'ed {file}' })
  assert.equal(bad.status, 200)
  assert.deepEqual(bad.body, { ok: false, error: 'That path no longer exists' })
  assert.equal((await call(url, 'POST', '[]')).status, 400)
  assert.equal(spawned.length, 1)
})
