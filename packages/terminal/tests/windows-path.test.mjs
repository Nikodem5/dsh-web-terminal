// Registry PATH merge: a fake execFile stands in for reg.exe, so nothing here touches the real registry.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWindowsPath, listerCwd, mergePath, parseRegPath, pathKey, withPath, REG_TTL_MS } from '../lib/windows-path.js'

const MACHINE = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const USER = 'HKCU\\Environment'

/** `reg query <key> /v Path` output as reg.exe prints it. */
const regOutput = (hive, type, value) => `\r\n${hive}\r\n    Path    ${type}    ${value}\r\n\r\n`
/** The error execFile reports for a nonzero exit. */
const exitError = (code) => Object.assign(new Error(`exit ${code}`), { code })
const MISSING = exitError(1)

/**
 * A fake execFile answering per key: a string is stdout, an Error fails, a function is called for control.
 * `calls` records [file, args, options].
 */
function fakeExec(answers) {
  const calls = []
  const execFile = (file, args, options, callback) => {
    calls.push([file, args, options])
    const answer = answers[args[1]]
    const run = typeof answer === 'function' ? answer : () => answer
    const result = run(callback)
    if (result === undefined && typeof answer === 'function') return
    if (result instanceof Error) callback(result, '', '')
    else callback(null, result, '')
  }
  return { execFile, calls }
}

function make(answers, extra = {}) {
  const exec = fakeExec(answers)
  const clock = { t: 1_000_000 }
  const env = extra.env ?? { Path: 'C:\\app;C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\me', SystemRoot: 'C:\\Windows' }
  const wp = createWindowsPath({ platform: 'win32', execFile: exec.execFile, now: () => clock.t, env, ...extra })
  return { wp, clock, calls: exec.calls, env }
}

const BOTH = {
  [MACHINE]: regOutput('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'REG_EXPAND_SZ', 'C:\\Windows\\System32;C:\\Tools\\'),
  [USER]: regOutput('HKEY_CURRENT_USER\\Environment', 'REG_EXPAND_SZ', '%USERPROFILE%\\AppData\\Local\\agy\\bin;C:\\Tools'),
}

test('parseRegPath reads REG_SZ and REG_EXPAND_SZ values', () => {
  assert.deepEqual(parseRegPath(regOutput('HKEY_CURRENT_USER\\Environment', 'REG_SZ', 'C:\\a;C:\\b')), { type: 'REG_SZ', value: 'C:\\a;C:\\b' })
  assert.deepEqual(parseRegPath(regOutput('HKEY_CURRENT_USER\\Environment', 'REG_EXPAND_SZ', '%X%\\a')), { type: 'REG_EXPAND_SZ', value: '%X%\\a' })
  // A value name in other casing, and a value with spaces.
  assert.equal(parseRegPath('\r\nHKEY_X\r\n    PATH    REG_SZ    C:\\Program Files\\x;C:\\y\r\n').value, 'C:\\Program Files\\x;C:\\y')
  assert.equal(parseRegPath('\nHKEY_X\n    Path    REG_SZ    C:\\unix\n').value, 'C:\\unix')
})

test('parseRegPath is undefined for unparsable output and an empty value for an empty one', () => {
  assert.equal(parseRegPath(''), undefined)
  assert.equal(parseRegPath('garbage'), undefined)
  assert.equal(parseRegPath('\r\nHKEY_X\r\n    Other    REG_SZ    C:\\a\r\n'), undefined)
  assert.equal(parseRegPath('\r\nHKEY_X\r\n    Path    REG_DWORD    0x1\r\n'), undefined)
  assert.deepEqual(parseRegPath('\r\nHKEY_X\r\n    Path    REG_SZ    \r\n'), { type: 'REG_SZ', value: '' })
})

test('reg.exe is asked for the machine and user Path values, hidden and with a timeout', async () => {
  const { wp, calls } = make(BOTH)
  await wp.merged()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c[0]), ['reg.exe', 'reg.exe'])
  assert.deepEqual(calls.map((c) => c[1]).sort(), [['query', MACHINE, '/v', 'Path'], ['query', USER, '/v', 'Path']].sort())
  for (const call of calls) {
    assert.equal(call[2].windowsHide, true)
    assert.ok(call[2].timeout > 0 && call[2].timeout <= 10_000)
  }
})

test('process entries stay first in order; registry entries follow, machine before user, deduped', async () => {
  const { wp } = make(BOTH)
  assert.equal(
    await wp.merged(),
    // Machine: System32 is already there (kept in its place), Tools is new. User: %USERPROFILE% expanded, Tools (no trailing slash) already added.
    'C:\\app;C:\\Windows\\System32;C:\\Tools\\;C:\\Users\\me\\AppData\\Local\\agy\\bin',
  )
})

test('entries compare case-insensitively and ignoring a trailing backslash', () => {
  assert.equal(mergePath('C:\\Foo\\;C:\\bar', [['c:\\FOO', 'c:\\BAR\\', 'C:\\new\\']]), 'C:\\Foo\\;C:\\bar;C:\\new\\')
  // An entry repeated within the process PATH is not collapsed; one repeated within the registry is.
  assert.equal(mergePath('C:\\a;C:\\a', [['C:\\b', 'c:\\B\\']]), 'C:\\a;C:\\a;C:\\b')
})

test('%VAR% references expand from env case-insensitively; an unknown one drops the entry', async () => {
  const { wp } = make({
    [MACHINE]: regOutput('HKEY_LOCAL_MACHINE\\X', 'REG_EXPAND_SZ', '%SYSTEMROOT%\\system32;%NOPE%\\bin;C:\\%NOPE%;%USERPROFILE%\\a\\%systemroot%'),
    [USER]: MISSING,
  }, { env: { Path: 'C:\\app', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\U' } })
  assert.equal(await wp.merged(), 'C:\\app;C:\\Windows\\system32;C:\\U\\a\\C:\\Windows')
})

test('a REG_SZ value is taken literally, a % in it is not expanded', async () => {
  const { wp } = make({ [MACHINE]: regOutput('HKEY_LOCAL_MACHINE\\X', 'REG_SZ', 'C:\\100%\\bin'), [USER]: MISSING }, { env: { Path: 'C:\\app' } })
  assert.equal(await wp.merged(), 'C:\\app;C:\\100%\\bin')
})

test('a missing key or value (reg exit 1) counts as no entries, not as a failure', async () => {
  const { wp } = make({ [MACHINE]: BOTH[MACHINE], [USER]: MISSING })
  assert.equal(await wp.merged(), 'C:\\app;C:\\Windows\\System32;C:\\Tools\\')
})

test('a cache hit inside the TTL makes no second read; after it the registry is read again', async () => {
  const { wp, clock, calls } = make(BOTH)
  await wp.merged()
  clock.t += REG_TTL_MS - 1
  await wp.merged()
  assert.equal(calls.length, 2)
  clock.t += 1
  await wp.merged()
  assert.equal(calls.length, 4)
})

test('the cache holds registry entries, so a changed process PATH is merged fresh', async () => {
  const { wp, env } = make(BOTH)
  await wp.merged()
  env.Path = 'C:\\other'
  assert.equal(await wp.merged(), 'C:\\other;C:\\Windows\\System32;C:\\Tools\\;C:\\Users\\me\\AppData\\Local\\agy\\bin')
})

test('concurrent callers share one in-flight read', async () => {
  const pendingCallbacks = []
  const slow = (callback) => { pendingCallbacks.push(callback) }
  const { wp, calls } = make({ [MACHINE]: slow, [USER]: slow })
  const all = [wp.merged(), wp.merged(), wp.merged()]
  assert.equal(calls.length, 2)
  assert.equal(pendingCallbacks.length, 2)
  pendingCallbacks[0](null, BOTH[MACHINE], '')
  pendingCallbacks[1](null, BOTH[USER], '')
  const results = await Promise.all(all)
  assert.equal(new Set(results).size, 1)
  assert.match(results[0], /agy\\bin$/)
  assert.equal(calls.length, 2)
})

test('an error, a timeout or unparsable output falls back to the process PATH unchanged', async () => {
  const timeout = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null })
  const notFound = Object.assign(new Error('spawn reg.exe ENOENT'), { code: 'ENOENT' })
  for (const bad of [exitError(2), timeout, notFound, 'not reg output', '']) {
    const { wp } = make({ [MACHINE]: BOTH[MACHINE], [USER]: bad })
    // One failed side discards the other too: half a registry PATH is not trusted.
    assert.equal(await wp.merged(), 'C:\\app;C:\\Windows\\System32', String(bad))
  }
})

test('a throwing execFile never rejects', async () => {
  const wp = createWindowsPath({ platform: 'win32', execFile: () => { throw new Error('boom') }, env: { Path: 'C:\\app' } })
  assert.equal(await wp.merged(), 'C:\\app')
})

test('a failed read is cached for the same TTL, then retried', async () => {
  const { wp, clock, calls } = make({ [MACHINE]: exitError(2), [USER]: BOTH[USER] })
  await wp.merged()
  await wp.merged()
  assert.equal(calls.length, 2)
  clock.t += REG_TTL_MS
  await wp.merged()
  assert.equal(calls.length, 4)
})

test('non-Windows makes no call and returns the process PATH untouched', async () => {
  const exec = fakeExec(BOTH)
  const env = { PATH: '/usr/bin:/bin' }
  const wp = createWindowsPath({ platform: 'linux', execFile: exec.execFile, env })
  assert.equal(await wp.merged(), '/usr/bin:/bin')
  assert.equal(exec.calls.length, 0)
  const child = await wp.childEnv({ PATH: '/x', HOME: '/h' })
  assert.deepEqual(child, { PATH: '/x', HOME: '/h' })
  assert.equal(exec.calls.length, 0)
})

test('DSH_WT_REGISTRY_PATH=0 turns the merge off: no call, PATH untouched', async () => {
  const { wp, calls } = make(BOTH, { env: { Path: 'C:\\app', DSH_WT_REGISTRY_PATH: '0' } })
  assert.equal(await wp.merged(), 'C:\\app')
  assert.deepEqual(await wp.childEnv({ Path: 'C:\\x' }), { Path: 'C:\\x' })
  assert.equal(calls.length, 0)
})

test('with no process PATH the registry entries alone are returned', async () => {
  const { wp } = make(BOTH, { env: { USERPROFILE: 'C:\\Users\\me' } })
  assert.equal(await wp.merged(), 'C:\\Windows\\System32;C:\\Tools\\;C:\\Users\\me\\AppData\\Local\\agy\\bin')
})

test('pathKey finds the existing PATH key whatever its casing; withPath leaves exactly one', () => {
  assert.equal(pathKey({ Path: 'x', HOME: 'h' }, 'win32'), 'Path')
  assert.equal(pathKey({ PATH: 'x' }, 'win32'), 'PATH')
  assert.equal(pathKey({ HOME: 'h' }, 'win32'), 'PATH')
  const out = withPath({ Path: 'old', path: 'older', HOME: 'h' }, 'new', 'win32')
  assert.deepEqual(Object.keys(out).filter((k) => k.toLowerCase() === 'path'), ['Path'])
  assert.equal(out.Path, 'new')
  assert.equal(out.HOME, 'h')
})

test('childEnv replaces the PATH under its existing key and does not mutate the input', async () => {
  const { wp } = make(BOTH)
  const base = { Path: 'C:\\app;C:\\Windows\\System32', OTHER: '1' }
  const child = await wp.childEnv(base)
  assert.deepEqual(Object.keys(child).sort(), ['OTHER', 'Path'])
  assert.match(child.Path, /^C:\\app;C:\\Windows\\System32;C:\\Tools\\;/)
  assert.equal(base.Path, 'C:\\app;C:\\Windows\\System32')
})

test('listerCwd is the system folder, never the host cwd', () => {
  assert.equal(listerCwd({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32')
  assert.equal(listerCwd({}), 'C:\\Windows\\System32')
})

test('where.exe run from listerCwd ignores a binary planted in the current directory', { skip: process.platform !== 'win32' }, async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wt-where-'))
  try {
    writeFileSync(join(dir, 'dshplanted.exe'), '')
    const where = (cwd) => spawnSync('where.exe', ['dshplanted'], { cwd, encoding: 'utf8', windowsHide: true })
    assert.equal(where(dir).status, 0, 'where finds it in the cwd: that is the hazard')
    assert.notEqual(where(listerCwd()).status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
