// SSH terminals, host half: target validation (including injection attempts), the argv, ~/.ssh/config parsing,
// and the spawn through the websocket with a fake PTY (no real connection is ever made).
// The ctx is strict like cordis': reading anything that was not injected throws.
//
//   node --test tests/ssh.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'
import { parseQuickConnect, sshArgs, validateSsh, MAX_COMMAND } from '../lib/ssh-target.js'
import { createSshHosts, parseSshConfig } from '../lib/ssh-config.js'
import { shellSpec } from '../lib/shells.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-wt-ssh-'))
process.env.DSH_HOME = home
const stops = []
after(() => {
  for (const stop of stops) stop()
  rmSync(home, { recursive: true, force: true })
})

const argvOf = (input) => {
  const v = validateSsh(input)
  assert.equal(v.ok, true, JSON.stringify(v))
  return sshArgs(v)
}
const BASE = ['-t', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3']

// ── argv ──

test('argv: an alias', () => {
  assert.deepEqual(argvOf({ host: 'homepc' }), [...BASE, '--', 'homepc'])
})

test('argv: user@host with a port', () => {
  assert.deepEqual(argvOf({ target: 'me@192.168.1.20', port: 2222 }), [...BASE, '-p', '2222', '--', 'me@192.168.1.20'])
  assert.deepEqual(argvOf({ target: 'me@host.lan', port: '22' }), [...BASE, '-p', '22', '--', 'me@host.lan'])
})

test('argv: a remote command is one element after the destination', () => {
  const command = 'cd ~/proj && claude --resume'
  assert.deepEqual(argvOf({ host: 'homepc', command }), [...BASE, '--', 'homepc', command])
  assert.deepEqual(argvOf({ host: 'homepc', command: '   ' }), [...BASE, '--', 'homepc'], 'blank = none')
})

test('argv: IPv6 goes to ssh without brackets, a bare host needs no user', () => {
  assert.deepEqual(argvOf({ target: 'me@[fe80::1]', port: 22 }), [...BASE, '-p', '22', '--', 'me@fe80::1'])
  assert.deepEqual(argvOf({ target: 'example.com' }), [...BASE, '--', 'example.com'])
})

// ── validation ──

test('validation: injection attempts are refused', () => {
  const bad = [
    { host: '-oProxyCommand=calc' },
    { host: '-v' },
    { host: '--' },
    { host: 'host;calc' },
    { host: 'host name' },
    { host: 'host\nname' },
    { host: 'a'.repeat(129) },
    { host: '' },
    { target: '-oProxyCommand=calc' },
    { target: '-oProxyCommand=calc@host' },
    { target: '-v@host' },
    { target: 'me@-oProxyCommand=calc' },
    { target: 'me@host;calc' },
    { target: 'me@host calc' },
    { target: 'me@host\ncalc' },
    { target: 'me@host\r' },
    { target: 'me@@host' },
    { target: 'me@' },
    { target: '@host' },
    { target: 'me@$(calc)' },
    { target: 'me@`calc`' },
    { target: 'me@host|calc' },
    { target: 'me@host&calc' },
    { target: 'me@[::1' },
    { target: 'me@[calc]' },
    { target: 'me@[-o]' },
    { target: 'me@::1' },
    { target: 'ssh://me@host' },
    { target: 'me@host', port: 0 },
    { target: 'me@host', port: 65536 },
    { target: 'me@host', port: -22 },
    { target: 'me@host', port: 22.5 },
    { target: 'me@host', port: '22; calc' },
    { target: 'me@host', port: '0x16' },
    { target: 'me@host', port: ' 22' },
    { host: 'a', target: 'me@b' },
    {},
    null,
  ]
  for (const input of bad) assert.equal(validateSsh(input).ok, false, JSON.stringify(input))
})

test('validation: ordinary targets are accepted', () => {
  for (const input of [{ host: 'home-pc_2.lan' }, { target: 'a.b-c_d@host.example.com' }, { target: 'root@10.0.0.1', port: 65535 }, { target: 'me@[2001:db8::1]', port: 1 }, { host: 'x' }]) {
    assert.equal(validateSsh(input).ok, true, JSON.stringify(input))
  }
})

test('validation: the destination never starts with a dash and a stored request holds only what ssh needs', () => {
  const v = validateSsh({ target: 'me@host', port: '2200', command: ' ls ', extra: 'password=hunter2' })
  assert.deepEqual(v.ssh, { target: 'me@host', port: 2200, command: 'ls' })
  assert.equal(v.destination, 'me@host')
})

test('validation: the remote command is one capped line', () => {
  assert.equal(validateSsh({ host: 'h', command: 'a'.repeat(MAX_COMMAND) }).ok, true)
  assert.equal(validateSsh({ host: 'h', command: 'a'.repeat(MAX_COMMAND + 1) }).ok, false)
  assert.equal(validateSsh({ host: 'h', command: 'ls\nrm -rf x' }).ok, false)
  assert.equal(validateSsh({ host: 'h', command: 'ls\0' }).ok, false)
  assert.equal(validateSsh({ host: 'h', command: ['ls'] }).ok, false)
  assert.equal(validateSsh({ host: 'h', command: 'echo "a b" ; ls | wc' }).ok, true, 'it runs remotely by the user\'s own choice')
})

test('quick connect: user@host[:port] and bracketed IPv6', () => {
  assert.deepEqual(parseQuickConnect('me@host'), { target: 'me@host' })
  assert.deepEqual(parseQuickConnect(' me@host:2222 '), { target: 'me@host', port: 2222 })
  assert.deepEqual(parseQuickConnect('host:22'), { target: 'host', port: 22 })
  assert.deepEqual(parseQuickConnect('me@[::1]:2222'), { target: 'me@[::1]', port: 2222 })
  assert.deepEqual(parseQuickConnect('me@[::1]'), { target: 'me@[::1]' })
  for (const bad of ['', 'me@host:', 'me@host:abc', 'me@host:99999', 'me@::1', 'me@[::1]x', 'me@[::1', '-oProxyCommand=x:1'])
    assert.ok(!('target' in parseQuickConnect(bad)) || validateSsh(parseQuickConnect(bad)).ok === false, bad)
})

test('shellSpec: ssh builds argv only, never integrates, and refuses an invalid request', () => {
  const spec = shellSpec('ssh', { ssh: { target: 'me@host', port: '2222', command: 'tmux a' }, sshFile: '/usr/bin/ssh' })
  assert.deepEqual(spec, { file: '/usr/bin/ssh', args: [...BASE, '-p', '2222', '--', 'me@host', 'tmux a'], integrated: false })
  assert.throws(() => shellSpec('ssh', { ssh: { host: '-oProxyCommand=calc' } }), /alias/)
  assert.throws(() => shellSpec('ssh', {}))
})

// ── ~/.ssh/config ──

test('config: concrete aliases with their display fields; patterns are skipped', () => {
  const hosts = parseSshConfig([
    '# my machines',
    'Host homepc home',
    '  HostName 192.168.1.20',
    '  User me',
    '  Port 2222',
    '  IdentityFile ~/.ssh/id_ed25519',
    'Host *',
    '  ServerAliveInterval 60',
    'Host *.corp web-? !bad ok',
    'host=lower',
    '  hostname = "lower.example"',
    'Match host foo',
    '  User ignored',
    'Host after',
    '  User first',
    '  User second',
    'Host -oProxyCommand=calc sp;ace',
  ].join('\n'))
  assert.deepEqual(hosts, [
    { alias: 'homepc', hostName: '192.168.1.20', user: 'me', port: '2222' },
    { alias: 'home', hostName: '192.168.1.20', user: 'me', port: '2222' },
    { alias: 'ok' },
    { alias: 'lower', hostName: 'lower.example' },
    { alias: 'after', user: 'first' },
  ])
})

test('config: missing file is an empty list', () => {
  assert.deepEqual(createSshHosts({ dir: join(home, 'nope') }).get(), [])
})

test('config: Include (relative to .ssh, globs, ~), depth cap, duplicate aliases, and a cache that follows mtime', () => {
  const dir = join(home, 'ssh1')
  mkdirSync(join(dir, 'conf.d'), { recursive: true })
  writeFileSync(join(dir, 'config'), 'Host first\n  User a\nInclude conf.d/*.conf\nInclude extra\nInclude loop\nHost first\n  User dup\n')
  writeFileSync(join(dir, 'conf.d', 'a.conf'), 'Host fromglob\n  HostName g.example\n  Port 2200\n')
  writeFileSync(join(dir, 'conf.d', 'b.txt'), 'Host skipped\n')
  writeFileSync(join(dir, 'extra'), 'Host fromextra\n')
  writeFileSync(join(dir, 'loop'), 'Include loop\nHost fromloop\n')
  const reader = createSshHosts({ dir, home })
  const first = reader.get()
  assert.deepEqual(first.map((h) => h.alias), ['first', 'fromglob', 'fromextra', 'fromloop'])
  assert.deepEqual(first[1], { alias: 'fromglob', hostName: 'g.example', user: null, port: 2200 })
  assert.deepEqual(first[0], { alias: 'first', hostName: null, user: 'a', port: null })
  assert.equal(reader.get(), first, 'unchanged files: the cached list')
  writeFileSync(join(dir, 'conf.d', 'c.conf'), 'Host fresh\n')
  const later = new Date(Date.now() + 5000)
  utimesSync(join(dir, 'conf.d'), later, later)
  assert.ok(reader.get().some((h) => h.alias === 'fresh'), 'a new file in an included folder is noticed')
  writeFileSync(join(dir, 'config'), 'Host only\n')
  utimesSync(join(dir, 'config'), later, later)
  assert.deepEqual(reader.get().map((h) => h.alias), ['only'])
})

// ── through the websocket and /info ──

function fakeHandle() {
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  return { output: new EventEmitter(), done, pid: 4242, write() {}, resize() {}, signalForeground() {}, terminate() { finish({ exitCode: null }) } }
}

function strictCtx(base) {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

async function host() {
  const routes = []
  const upgrades = []
  const spawned = []
  const teardowns = []
  apply(strictCtx({
    webServer: { register: (r) => { routes.push(r); return () => {} }, registerUpgrade: (r) => { upgrades.push(r); return () => {} } },
    subprocess: { spawnTerminal: async (spec) => { spawned.push(spec); return fakeHandle() } },
    effect: (fn) => { teardowns.push(fn()); return () => {} },
  }))
  const http = createServer()
  http.on('upgrade', (req, socket, head) => upgrades[0].handler(req, socket, head))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  stops.push(() => { for (const t of teardowns) t(); http.close() })
  const connect = (query) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${http.address().port}/terminal/ws?${query}`)
      const frames = []
      const timer = setTimeout(() => reject(new Error('no frame')), 30_000)
      ws.on('message', (raw) => { clearTimeout(timer); frames.push(JSON.parse(String(raw))); resolve({ ws, frames }) })
      ws.on('error', (e) => { clearTimeout(timer); reject(e) })
    })
  const info = () => new Promise((resolve) => routes.find((r) => r.path === '/api/dsh-web-terminal/info').handler({ method: 'GET' }, { writeHead() {}, end: (p) => resolve(JSON.parse(p)) }))
  return { spawned, connect, info }
}

test('websocket: sshHost spawns the ssh client with the argv and no shell string', async () => {
  const { spawned, connect } = await host()
  const { ws, frames } = await connect(`id=ssh1&shell=ssh&sshHost=homepc&sshCommand=${encodeURIComponent('cd ~/proj && claude')}&cols=100&rows=30`)
  assert.equal(frames[0].type, 'attached')
  assert.equal(spawned.length, 1)
  assert.match(spawned[0].argv[0], /ssh(\.exe)?$/i)
  assert.deepEqual(spawned[0].argv.slice(1), [...BASE, '--', 'homepc', 'cd ~/proj && claude'])
  ws.close()
})

test('websocket: sshTarget and sshPort', async () => {
  const { spawned, connect } = await host()
  const { ws } = await connect('id=ssh2&shell=ssh&sshTarget=me%40host.lan&sshPort=2222')
  assert.deepEqual(spawned[0].argv.slice(1), [...BASE, '-p', '2222', '--', 'me@host.lan'])
  ws.close()
})

test('websocket: an invalid or option-like destination spawns nothing and says why', async () => {
  const { spawned, connect } = await host()
  for (const query of ['sshHost=-oProxyCommand%3Dcalc', 'sshTarget=me%40host%3Bcalc', 'sshTarget=me%40host&sshPort=99999', '']) {
    const { ws, frames } = await connect(`id=bad${Math.random().toString(36).slice(2)}&shell=ssh&${query}`)
    assert.equal(frames[0].type, 'error', query)
    assert.match(frames[0].message, /could not start ssh/)
    ws.close()
  }
  assert.equal(spawned.length, 0)
})

test('/info: ssh availability, path and the config hosts, with a strict ctx', async () => {
  const { info } = await host()
  const body = await info()
  assert.equal(typeof body.ssh.available, 'boolean')
  assert.ok(body.ssh.path === null || typeof body.ssh.path === 'string')
  assert.ok(Array.isArray(body.ssh.hosts))
  for (const h of body.ssh.hosts) assert.deepEqual(Object.keys(h).sort(), ['alias', 'hostName', 'port', 'user'])
})
