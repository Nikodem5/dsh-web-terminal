// Protocol tests for the host half, using a fake PTY instead of a real shell:
// fast, deterministic, and independent of the OS. The real-PTY round trip stays
// in smoke-host.mjs.
//
//   npm test   (or: node --test tests/*.test.mjs)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'

/** A subprocess handle that records what the plugin does to it. */
function fakeHandle() {
  const output = new EventEmitter()
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  return {
    output,
    done,
    pid: 4242,
    written: [],
    resized: [],
    signals: [],
    terminated: false,
    write(data) { this.written.push(data) },
    resize(cols, rows) { this.resized.push([cols, rows]) },
    signalForeground(signal) { this.signals.push(signal) },
    terminate() { this.terminated = true; finish({ exitCode: null }) },
    emit(text) { output.emit('data', Buffer.from(text)) },
    exit(exitCode) { finish({ exitCode }) },
  }
}

const routes = { http: [], upgrade: [] }
const spawned = []
let failNextSpawn = false
let teardown
let server
let port

before(async () => {
  apply({
    webServer: {
      register: (route) => { routes.http.push(route); return () => {} },
      registerUpgrade: (route) => { routes.upgrade.push(route); return () => {} },
    },
    subprocess: {
      spawnTerminal: async (spec) => {
        if (failNextSpawn) {
          failNextSpawn = false
          throw new Error('boom')
        }
        const handle = fakeHandle()
        spawned.push({ spec, handle })
        return handle
      },
    },
    effect: (fn) => { teardown = fn(); return () => {} },
  })
  const upgrade = routes.upgrade.find((r) => r.path === '/terminal/ws')
  server = createServer()
  server.on('upgrade', (req, socket, head) => upgrade.handler(req, socket, head))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(() => {
  if (typeof teardown === 'function') teardown()
  server.close()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const freshId = () => `t${Date.now()}x${++seq}`

/** Connect and collect frames; resolves after the socket opens. */
function connect(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/ws?${query}`)
    const frames = []
    const closed = new Promise((res) => ws.on('close', (code) => res(code)))
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
    ws.on('open', () => resolve({ ws, frames, closed }))
    ws.on('error', reject)
  })
}

const until = async (predicate, ms = 2000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (predicate()) return true
    await sleep(10)
  }
  return false
}

const infoOf = () =>
  new Promise((resolve) => {
    const info = routes.http.find((r) => r.path === '/api/dsh-web-terminal/info')
    info.handler({ method: 'GET' }, { writeHead() {}, end: (payload) => resolve(JSON.parse(payload)) })
  })

test('connecting without an id is refused', async () => {
  const { closed } = await connect('cols=80&rows=24')
  assert.equal(await closed, 1008)
})

test('a new session spawns a shell, reports attached first, and forwards output', async () => {
  const id = freshId()
  const { ws, frames } = await connect(`id=${id}&cols=100&rows=30&cwd=${encodeURIComponent(process.cwd())}`)
  assert.ok(await until(() => frames.length > 0))
  assert.equal(frames[0].type, 'attached')
  assert.equal(frames[0].created, true)
  const { spec, handle } = spawned.at(-1)
  assert.equal(spec.cols, 100)
  assert.equal(spec.rows, 30)
  assert.equal(spec.cwd, process.cwd())
  handle.emit('hello')
  assert.ok(await until(() => frames.some((f) => f.type === 'data' && f.data === 'hello')))
  ws.close()
})

test('input, resize and signal frames reach the PTY; malformed frames are ignored', async () => {
  const id = freshId()
  const { ws, frames } = await connect(`id=${id}`)
  await until(() => frames.length > 0)
  const { handle } = spawned.at(-1)
  ws.send('not json')
  ws.send(JSON.stringify(null))
  ws.send(JSON.stringify({ type: 'input', data: 42 }))
  ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }))
  ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 43 }))
  ws.send(JSON.stringify({ type: 'signal', signal: 'SIGINT' }))
  assert.ok(await until(() => handle.signals.length === 1))
  assert.deepEqual(handle.written, ['ls\r'])
  assert.deepEqual(handle.resized, [[132, 43]])
  assert.deepEqual(handle.signals, ['SIGINT'])
  ws.close()
})

test('resize dimensions are clamped to what a PTY accepts', async () => {
  const id = freshId()
  const { ws, frames } = await connect(`id=${id}`)
  await until(() => frames.length > 0)
  const { handle } = spawned.at(-1)
  ws.send(JSON.stringify({ type: 'resize', cols: 99999, rows: 99999 }))
  assert.ok(await until(() => handle.resized.length === 1))
  assert.deepEqual(handle.resized[0], [500, 200])
  ws.close()
})

test('the shell outlives its socket and a reattach replays scrollback without respawning', async () => {
  const id = freshId()
  const first = await connect(`id=${id}`)
  await until(() => first.frames.length > 0)
  const before = spawned.length
  const { handle } = spawned.at(-1)
  handle.emit('line one\r\n')
  await until(() => first.frames.some((f) => f.type === 'data'))
  first.ws.close()
  await first.closed
  assert.equal(handle.terminated, false)

  const second = await connect(`id=${id}`)
  await until(() => second.frames.length > 0)
  assert.equal(spawned.length, before)
  assert.equal(second.frames[0].type, 'attached')
  assert.equal(second.frames[0].created, false)
  assert.equal(second.frames[0].replay, 'line one\r\n')
  second.ws.close()
})

test('a second connection supersedes the first, which can no longer type', async () => {
  const id = freshId()
  const first = await connect(`id=${id}`)
  await until(() => first.frames.length > 0)
  const { handle } = spawned.at(-1)
  const second = await connect(`id=${id}`)
  assert.equal(await first.closed, 4000)
  first.ws.send?.(JSON.stringify({ type: 'input', data: 'stale' }))
  second.ws.send(JSON.stringify({ type: 'input', data: 'fresh' }))
  assert.ok(await until(() => handle.written.includes('fresh')))
  assert.ok(!handle.written.includes('stale'))
  second.ws.close()
})

test('UTF-8 characters split across PTY chunks are not mangled', async () => {
  const id = freshId()
  const { ws, frames } = await connect(`id=${id}`)
  await until(() => frames.length > 0)
  const { handle } = spawned.at(-1)
  const bytes = Buffer.from('é', 'utf8')
  handle.output.emit('data', bytes.subarray(0, 1))
  handle.output.emit('data', bytes.subarray(1))
  assert.ok(await until(() => frames.some((f) => f.type === 'data')))
  assert.equal(frames.filter((f) => f.type === 'data').map((f) => f.data).join(''), 'é')
  ws.close()
})

test('scrollback kept for replay is bounded', async () => {
  const id = freshId()
  const first = await connect(`id=${id}`)
  await until(() => first.frames.length > 0)
  const { handle } = spawned.at(-1)
  handle.emit('x'.repeat(300_000))
  handle.emit('y'.repeat(300_000))
  await until(() => first.frames.filter((f) => f.type === 'data').length === 2)
  first.ws.close()
  await first.closed
  const second = await connect(`id=${id}`)
  await until(() => second.frames.length > 0)
  const { replay } = second.frames[0]
  assert.equal(replay.length, 400_000)
  assert.ok(replay.endsWith('y'.repeat(1000)))
  second.ws.close()
})

test('a process exit is reported live and on reattach', async () => {
  const id = freshId()
  const first = await connect(`id=${id}`)
  await until(() => first.frames.length > 0)
  const { handle } = spawned.at(-1)
  handle.exit(3)
  assert.ok(await until(() => first.frames.some((f) => f.type === 'exit' && f.exitCode === 3)))
  first.ws.close()
  await first.closed
  const second = await connect(`id=${id}`)
  await until(() => second.frames.length > 0)
  assert.equal(second.frames[0].exited, true)
  assert.equal(second.frames[0].exitCode, 3)
  second.ws.close()
})

test('kill ends the session and terminates the process; close only detaches', async () => {
  const keep = await connect(`id=${freshId()}`)
  await until(() => keep.frames.length > 0)
  const keepHandle = spawned.at(-1).handle
  keep.ws.send(JSON.stringify({ type: 'close' }))
  await keep.closed
  assert.equal(keepHandle.terminated, false)

  const id = freshId()
  const doomed = await connect(`id=${id}`)
  await until(() => doomed.frames.length > 0)
  const handle = spawned.at(-1).handle
  doomed.ws.send(JSON.stringify({ type: 'kill' }))
  assert.ok(await until(() => handle.terminated))
  assert.ok(!(await infoOf()).sessions.some((s) => s.id === id))
})

test('a failing spawn reports an error frame and closes the socket', async () => {
  const before = spawned.length
  failNextSpawn = true
  const { frames, closed } = await connect(`id=${freshId()}`)
  assert.equal(await closed, 1011)
  assert.ok(frames.some((f) => f.type === 'error' && /could not start terminal: boom/.test(f.message)))
  assert.equal(spawned.length, before)
})

test('/info lists live sessions and platform shells', async () => {
  const id = freshId()
  const { ws, frames } = await connect(`id=${id}&cwd=${encodeURIComponent(process.cwd())}`)
  await until(() => frames.length > 0)
  const info = await infoOf()
  assert.equal(info.ok, true)
  assert.equal(info.maxSessions, 24)
  assert.equal(typeof info.claude.available, 'boolean')
  assert.ok(Array.isArray(info.shells))
  assert.ok(info.sessions.some((s) => s.id === id && s.exited === false))
  ws.close()
})
