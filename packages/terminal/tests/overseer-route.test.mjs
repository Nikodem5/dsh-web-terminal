// Overseer routes on the real host half (lib/index.js) with a fake PTY and a fake `llm`:
// streaming, abort on client disconnect, llm / default model absent, hidden terminals, auth,
// and the transcript path recorded from the terminal's own hook signal.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'
import { authHeaders, authed, localReq } from './helpers/local-auth.mjs'

const home = mkdtempSync(join(tmpdir(), 'dsh-wt-overseer-route-'))
process.env.DSH_HOME = join(home, 'dsh')
const claudeDir = join(home, 'claude')
mkdirSync(join(claudeDir, 'projects', 'p'), { recursive: true })
process.env.CLAUDE_CONFIG_DIR = claudeDir

function fakeHandle() {
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  return { output: new EventEmitter(), done, pid: 4242, write() { throw new Error('the Overseer must never write to a terminal') }, resize() {}, signalForeground() {}, terminate() { finish({ exitCode: null }) } }
}

/** A fake model service: records each call and streams what `script` yields. */
const llm = {
  calls: [],
  script: async function* () {
    yield { type: 'text-delta', index: 0, text: 'T1 is ' }
    yield { type: 'text-delta', index: 0, text: 'running tests [T1].' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
  stream(options) {
    this.calls.push(options)
    return this.script(options)
  },
}
const services = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-1', reasoningEffort: 'low' }) } }

const routes = []
const upgrades = []
const spawned = []
let teardown
let server
let port

before(async () => {
  apply({
    webServer: {
      register: (route) => { routes.push(route); return () => {} },
      registerUpgrade: (route) => { upgrades.push(route); return () => {} },
    },
    subprocess: { spawnTerminal: async (spec) => { const handle = fakeHandle(); spawned.push({ spec, handle }); return handle } },
    get: (name) => services[name],
    on: () => () => {},
    effect: (fn) => { teardown = fn(); return () => {} },
  })
  server = createServer((req, res) => {
    const route = routes.find((r) => r.path === req.url)
    if (route === undefined) { res.writeHead(404); return res.end() }
    route.handler(req, res)
  })
  server.on('upgrade', (req, socket, head) => upgrades[0].handler(req, socket, head))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(() => {
  teardown?.()
  server.close()
  rmSync(home, { recursive: true, force: true })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (check, what, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = check()
    if (v) return v
    await sleep(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** Open a terminal and give it some output; returns its session id and spawn record. */
async function terminal(id, output) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/ws?id=${id}&shell=cmd&cols=80&rows=24`, authed())
  await new Promise((resolve, reject) => { ws.on('message', resolve); ws.on('error', reject) })
  const record = spawned.at(-1)
  record.handle.output.emit('data', Buffer.from(output))
  return { ws, record }
}

/** POST JSON to a route; resolves {status, type, body, events}. `onRes` gets the live response. */
function post(path, body, { headers = authHeaders(), onRes } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, (res) => {
      onRes?.(res, req)
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        const type = String(res.headers['content-type'] ?? '')
        const events = type.includes('text/event-stream')
          ? text.split('\n\n').filter((p) => p.includes('data:')).map((p) => ({ event: /event: (\S+)/.exec(p)?.[1], data: JSON.parse(p.slice(p.indexOf('data:') + 5)) }))
          : []
        resolve({ status: res.statusCode, type, body: type.includes('json') ? JSON.parse(text) : text, events })
      })
      res.on('error', (e) => (req.destroyed ? resolve({ aborted: true }) : reject(e)))
      res.on('aborted', () => resolve({ aborted: true }))
    })
    req.on('error', (e) => (req.destroyed ? resolve({ aborted: true }) : reject(e)))
    req.end(JSON.stringify(body))
  })
}

const ASK = '/api/dsh-web-terminal/overseer/ask'
const HIDDEN = '/api/dsh-web-terminal/overseer/hidden'

test('an answer streams as server-sent events, with fresh context and the default model', async () => {
  await terminal('ta1-0', 'running npm test\r\nOPENAI_API_KEY=supersecretvalue123\r\n')
  llm.calls.length = 0
  const res = await post(ASK, { question: 'what is terminal 1 doing?', terminals: [{ id: 'ta1-0', num: 1, name: 'api tests' }, { id: 'not-a-session-0', num: 2, name: 'ghost' }] })
  assert.equal(res.status, 200)
  assert.ok(res.type.includes('text/event-stream'))
  assert.deepEqual(res.events.map((e) => e.event), ['meta', 'delta', 'delta', 'done'])
  assert.equal(res.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), 'T1 is running tests [T1].')
  assert.deepEqual(res.events[0].data.model, { provider: 'fake', model: 'fake-1' })
  assert.deepEqual(res.events[0].data.terminals.map((t) => t.num), [1], 'a terminal the host does not know is dropped')
  assert.equal(res.events.at(-1).data.reason, 'stop')
  const call = llm.calls[0]
  assert.equal(call.provider, 'fake')
  assert.equal(call.model, 'fake-1')
  assert.equal(call.reasoningEffort, 'low')
  assert.equal(call.tools, undefined, 'the model gets no tools')
  assert.ok(call.signal instanceof AbortSignal)
  const sent = call.messages.at(-1).content[0].text
  assert.ok(sent.includes('[T1] "api tests"'))
  assert.ok(sent.includes('running npm test'))
  assert.ok(!sent.includes('supersecretvalue123'), 'redacted before sending')
  assert.ok(sent.endsWith('Question: what is terminal 1 doing?'))
})

test('a follow-up sends earlier turns as history and rebuilds the context', async () => {
  const { record } = await terminal('ta2-0', 'first state\r\n')
  record.handle.output.emit('data', Buffer.from('second state\r\n'))
  llm.calls.length = 0
  await post(ASK, { question: 'and now?', history: [{ question: 'before?', answer: 'it was idle' }], terminals: [{ id: 'ta2-0', num: 1, name: 'x' }] })
  const msgs = llm.calls[0].messages
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user'])
  assert.equal(msgs[1].content[0].text, 'it was idle')
  assert.ok(msgs[2].content[0].text.includes('second state'))
})

test('closing the request aborts the model call', async () => {
  await terminal('ta3-0', 'busy\r\n')
  let seen
  llm.script = async function* (options) {
    seen = options.signal
    yield { type: 'text-delta', index: 0, text: 'partial' }
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
  }
  try {
    const result = await post(ASK, { question: 'long one', terminals: [{ id: 'ta3-0', num: 1, name: 'x' }] }, {
      onRes: (res, req) => res.once('data', () => req.destroy()),
    })
    assert.ok(result.aborted === true || result.status === 200)
    await until(() => seen?.aborted === true, 'the model call to be aborted')
  } finally {
    llm.script = async function* () {
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
})

test('a client that leaves while the context is being built never reaches the model', async () => {
  // createOverseer directly, with a transcript read that stays pending until the test lets it finish.
  const { createOverseer } = await import('../lib/overseer/index.js')
  const { Readable } = await import('node:stream')
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let reading = false
  const streamed = []
  const sessions = new Map([['tx1-0', { cwd: 'C:\\w', shellId: 'default', exited: false, replay: 'out\r\n', transcript: { path: 'C:\\t.jsonl' } }]])
  const model = { stream: (options) => { streamed.push(options); return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() } }
  const service = (name) => (name === 'llm' ? model : { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) })
  const overseer = createOverseer({ sessions, service, dir: join(home, 'overseer-abort'), readTranscript: async () => { reading = true; await gate; return undefined } })
  try {
    const ask = (aborted) => {
      const req = Readable.from([Buffer.from(JSON.stringify({ question: 'what now?', terminals: [{ id: 'tx1-0', num: 1, name: 'x' }] }))])
      req.method = 'POST'
      const res = new EventEmitter()
      Object.assign(res, { writableEnded: false, destroyed: false, written: [], writeHead() {}, write(chunk) { this.written.push(chunk) }, end() { this.writableEnded = true } })
      return { res, done: overseer.askHandler(req, res) }
    }
    const left = ask()
    await until(() => reading, 'the context build to start')
    left.res.destroyed = true
    left.res.emit('close') // the client disconnected (or pressed Stop) mid-build
    release()
    await left.done
    assert.equal(streamed.length, 0, 'the model is not called for a request nobody waits for')
    assert.deepEqual(left.res.written, [], 'and nothing is written to the dead socket')
    // A client that stays gets its answer as before.
    reading = false
    const stays = ask()
    await stays.done
    assert.equal(streamed.length, 1)
    assert.ok(stays.res.written.some((c) => c.startsWith('event: done')))
  } finally {
    overseer.dispose()
  }
})

test('a model error is reported as an error event', async () => {
  await terminal('ta4-0', 'x\r\n')
  const saved = llm.script
  llm.script = async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE' } } }
  }
  try {
    const res = await post(ASK, { question: 'q', terminals: [{ id: 'ta4-0', num: 1, name: 'x' }] })
    const error = res.events.find((e) => e.event === 'error')
    assert.equal(error.data.error, 'rate limited')
    assert.equal(res.events.at(-1).data.reason, 'error')
  } finally {
    llm.script = saved
  }
})

test('no llm service, or no default model: a clear JSON answer, no model call', async () => {
  const saved = { ...services }
  try {
    delete services.llm
    const a = await post(ASK, { question: 'q', terminals: [] })
    assert.equal(a.body.ok, false)
    assert.equal(a.body.code, 'no-llm')
    services.llm = llm
    services.agentDefaultModel = { currentSelection: () => ({ provider: '', model: '' }) }
    const b = await post(ASK, { question: 'q', terminals: [] })
    assert.equal(b.body.code, 'no-model')
    delete services.agentDefaultModel
    const c = await post(ASK, { question: 'q', terminals: [] })
    assert.equal(c.body.code, 'no-model')
  } finally {
    Object.assign(services, saved)
  }
  const bad = await post(ASK, { question: '   ' })
  assert.equal(bad.status, 400)
})

test('a hidden terminal is never sent, whether the host or the request hides it; the list persists', async () => {
  await terminal('tvisible-0', 'VISIBLE OUTPUT\r\n')
  await terminal('tsecret-3', 'SECRET OUTPUT\r\n')
  await terminal('tother-0', 'OTHER OUTPUT\r\n')
  const hide = await post(HIDDEN, { id: 'tsecret', hidden: true })
  assert.deepEqual(hide.body, { ok: true, hidden: ['tsecret'] })
  const saved = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'web-terminal', 'overseer.json'), 'utf8'))
  assert.deepEqual(saved.hidden, ['tsecret'])
  llm.calls.length = 0
  const terminals = [{ id: 'tvisible-0', num: 1, name: 'v' }, { id: 'tsecret-3', num: 2, name: 's' }, { id: 'tother-0', num: 3, name: 'o' }]
  await post(ASK, { question: 'q', terminals, hidden: ['tother'] })
  const sent = llm.calls[0].messages.at(-1).content[0].text
  assert.ok(sent.includes('VISIBLE OUTPUT'))
  assert.ok(!sent.includes('SECRET OUTPUT'), 'hidden by the host list, even though the client listed it')
  assert.ok(!sent.includes('OTHER OUTPUT'), 'hidden by the request')
  assert.ok(!sent.includes('"s"'))
  const shown = await post(HIDDEN, { id: 'tsecret', hidden: false })
  assert.deepEqual(shown.body.hidden, [])
  assert.equal((await post(HIDDEN, { id: '../x', hidden: true })).status, 400)
})

test('the routes refuse a request without the access token', async () => {
  const res = await post(ASK, { question: 'q' }, { headers: {} })
  assert.equal(res.status, 401)
  const hidden = await post(HIDDEN, { id: 'x', hidden: true }, { headers: {} })
  assert.equal(hidden.status, 401)
})

test('the transcript path from the terminal\'s own hook is used for its condensed conversation', async () => {
  await terminal('ttr-0', 'claude screen\r\n')
  const token = spawned.at(-1).spec.env.DSH_WT_TOKEN
  const transcript = join(claudeDir, 'projects', 'p', 'conv.jsonl')
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: 'please pick a cache strategy' } })}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Decided: LRU with TTL' }] } })}\n`)
  const info = await new Promise((resolve) => routes.find((r) => r.path === '/api/dsh-web-terminal/info').handler(localReq(), { writeHead() {}, end: (p) => resolve(JSON.parse(p)) }))
  const settings = JSON.parse(readFileSync(info.providers.claude.launch.settingsPath, 'utf8'))
  const url = new URL(settings.hooks.Stop[0].hooks[0].url)
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'x-dsh-wt-token': token } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end(JSON.stringify({ hook_event_name: 'Stop', session_id: '0123abcd-0000-4000-8000-000000000000', transcript_path: transcript }))
  })
  assert.equal(status, 204)
  llm.calls.length = 0
  await post(ASK, { question: 'what did T1 decide?', terminals: [{ id: 'ttr-0', num: 1, name: 'claude' }] })
  const sent = llm.calls[0].messages.at(-1).content[0].text
  assert.ok(sent.includes('USER: please pick a cache strategy'))
  assert.ok(sent.includes('AGENT: Decided: LRU with TTL'))
})
