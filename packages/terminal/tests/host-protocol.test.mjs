// Protocol tests for the host half, using a fake PTY instead of a real shell:
// fast, deterministic, and independent of the OS. The real-PTY round trip stays
// in smoke-host.mjs.
//
//   npm test   (or: node --test tests/*.test.mjs)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'

// The plugin writes its Claude settings file under DSH_HOME; keep tests out of the real one.
const testHome = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-home')
process.env.DSH_HOME = testHome

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
  rmSync(testHome, { recursive: true, force: true })
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
  rmSync(testHome, { recursive: true, force: true })
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

const until = async (predicate, ms = 20000) => {
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

// ── agent signals ──

/** Read the generated Claude settings file the way `claude --settings` would. */
async function settingsFile() {
  const { agent } = await infoOf()
  assert.ok(agent.claudeSettings, 'info reports the generated settings file')
  return JSON.parse(readFileSync(agent.claudeSettings, 'utf8'))
}

/** POST to the plugin's signal server, at the URL from the settings file, as a Claude hook would. */
async function postSignal({ token, body, path = '/signal/claude', method = 'POST', raw }) {
  const target = new URL((await settingsFile()).hooks.Stop[0].hooks[0].url)
  return new Promise((resolve, reject) => {
    const headers = token === undefined ? {} : { 'x-dsh-wt-token': token }
    const req = request({ host: target.hostname, port: target.port, path, method, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)))
  })
}

/** Secret of the most recently spawned shell, as that shell sees it. */
const latestToken = () => spawned.at(-1).spec.env.DSH_WT_TOKEN

test('/info points at a generated Claude settings file with HTTP hooks', async () => {
  const { agent } = await infoOf()
  assert.ok(existsSync(agent.claudeSettings))
  const hook = (await settingsFile()).hooks.PermissionRequest[0].hooks[0]
  assert.equal(hook.type, 'http')
  assert.match(hook.url, /^http:\/\/127\.0\.0\.1:\d+\/signal\/claude$/)
})

test('every shell gets its own secret in its environment', async () => {
  const a = await connect(`id=${freshId()}`)
  const b = await connect(`id=${freshId()}`)
  await until(() => a.frames.length > 0 && b.frames.length > 0)
  const first = spawned.at(-2).spec.env.DSH_WT_TOKEN
  const second = spawned.at(-1).spec.env.DSH_WT_TOKEN
  assert.match(first, /^[0-9a-f]{48}$/)
  assert.notEqual(first, second)
  a.ws.close()
  b.ws.close()
})

test('a signal with the right secret is pushed to the attached browser', async () => {
  const { ws, frames } = await connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  const status = await postSignal({
    token: latestToken(),
    body: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf x' } },
  })
  assert.equal(status, 204)
  assert.ok(await until(() => frames.some((f) => f.type === 'agent')))
  const agent = frames.find((f) => f.type === 'agent')
  assert.equal(agent.state, 'needs-you')
  assert.equal(agent.provider, 'claude')
  assert.equal(agent.detail, 'Permission: Bash: rm -rf x')
  ws.close()
})

test('the agent state survives a reattach', async () => {
  const id = freshId()
  const first = await connect(`id=${id}`)
  await until(() => first.frames.length > 0)
  await postSignal({ token: latestToken(), body: { hook_event_name: 'Stop' } })
  await until(() => first.frames.some((f) => f.type === 'agent'))
  first.ws.close()
  await first.closed
  const second = await connect(`id=${id}`)
  await until(() => second.frames.length > 0)
  assert.equal(second.frames[0].agent.state, 'finished')
  second.ws.close()
})

test('a signal while no browser is attached is kept for the next attach', async () => {
  const id = freshId()
  const first = await connect(`id=${id}`)
  await until(() => first.frames.length > 0)
  const token = latestToken()
  first.ws.close()
  await first.closed
  assert.equal(await postSignal({ token, body: { hook_event_name: 'UserPromptSubmit' } }), 204)
  const second = await connect(`id=${id}`)
  await until(() => second.frames.length > 0)
  assert.equal(second.frames[0].agent.state, 'working')
  second.ws.close()
})

test('signals without a valid secret are refused and change nothing', async () => {
  const { ws, frames } = await connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  const token = latestToken()
  assert.equal(await postSignal({ body: { hook_event_name: 'Stop' } }), 401)
  assert.equal(await postSignal({ token: 'nope', body: { hook_event_name: 'Stop' } }), 401)
  assert.equal(await postSignal({ token: token.toUpperCase(), body: { hook_event_name: 'Stop' } }), 401)
  await sleep(50)
  assert.ok(!frames.some((f) => f.type === 'agent'))
  ws.close()
})

test('the secret stops working once the shell is killed', async () => {
  const { ws, frames } = await connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  const token = latestToken()
  ws.send(JSON.stringify({ type: 'kill' }))
  await until(() => spawned.at(-1).handle.terminated)
  assert.equal(await postSignal({ token, body: { hook_event_name: 'Stop' } }), 401)
})

test('the signal endpoint rejects wrong methods, paths, bad JSON and oversized bodies', async () => {
  const { ws, frames } = await connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  const token = latestToken()
  assert.equal(await postSignal({ token, method: 'GET' }), 405)
  assert.equal(await postSignal({ token, path: '/elsewhere', body: {} }), 404)
  assert.equal(await postSignal({ token, raw: '{not json' }), 400)
  assert.equal(await postSignal({ token, raw: JSON.stringify({ hook_event_name: 'Stop', pad: 'x'.repeat(70_000) }) }), 413)
  assert.ok(!frames.some((f) => f.type === 'agent'))
  ws.close()
})

test('events that carry no state are accepted but not forwarded', async () => {
  const { ws, frames } = await connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  assert.equal(await postSignal({ token: latestToken(), body: { hook_event_name: 'PreCompact' } }), 204)
  await sleep(50)
  assert.ok(!frames.some((f) => f.type === 'agent'))
  ws.close()
})

test('a provider-neutral signal works for a provider with no adapter', async () => {
  const { ws, frames } = await connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  await postSignal({ token: latestToken(), path: '/signal/codex', body: { state: 'needs-you', detail: 'approve?' } })
  assert.ok(await until(() => frames.some((f) => f.type === 'agent')))
  assert.equal(frames.find((f) => f.type === 'agent').provider, 'codex')
  ws.close()
})

test('an oversized WebSocket message closes the connection', async () => {
  const { ws, closed } = await connect(`id=${freshId()}`)
  ws.send('x'.repeat(2 * 1024 * 1024))
  assert.equal(await closed, 1009)
})

test('the conversation id reaches the browser, and survives a reattach', async () => {
  const id = freshId()
  const session = '3f4a3c42-a672-45ff-a7f5-ac6abdc48a8e'
  const first = await connect(`id=${id}`)
  await until(() => first.frames.length > 0)
  await postSignal({ token: latestToken(), body: { hook_event_name: 'UserPromptSubmit', session_id: session } })
  assert.ok(await until(() => first.frames.some((f) => f.type === 'agent')))
  assert.equal(first.frames.find((f) => f.type === 'agent').session, session)
  first.ws.close()
  await first.closed
  const second = await connect(`id=${id}`)
  await until(() => second.frames.length > 0)
  assert.equal(second.frames[0].agent.session, session)
  second.ws.close()
})
