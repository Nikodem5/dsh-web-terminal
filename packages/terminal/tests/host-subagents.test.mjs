// Sub-agent frames of the host half, with a fake PTY: the `subagents` frame, the `attached` field,
// throttling, retention and session end.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'

const testHome = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-home-subagents')
process.env.DSH_HOME = testHome
// Fast knobs, read when the plugin is applied.
process.env.DSH_WT_SUBAGENT_RETAIN_MS = '600'
process.env.DSH_WT_SUBAGENT_THROTTLE_MS = '300'
process.env.DSH_WT_SUBAGENT_SWEEP_MS = '50'

function fakeHandle() {
  const output = new EventEmitter()
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  return {
    output, done, pid: 4242,
    write() {}, resize() {}, signalForeground() {},
    terminate() { finish({ exitCode: null }) },
    exit(exitCode) { finish({ exitCode }) },
  }
}

const routes = { http: [], upgrade: [] }
const spawned = []
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
const freshId = () => `s${Date.now()}x${++seq}`

function connect(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/ws?${query}`)
    const frames = []
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
    ws.on('open', () => resolve({ ws, frames }))
    ws.on('error', reject)
  })
}

const until = async (predicate, ms = 3000) => {
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

let cachedSettings
async function settings() {
  if (cachedSettings) return cachedSettings
  const { agent } = await infoOf()
  cachedSettings = JSON.parse(readFileSync(agent.claudeSettings, 'utf8'))
  return cachedSettings
}

/** POST to the plugin's signal server as a Claude hook / the status line would. */
async function post(path, token, body) {
  const target = new URL((await settings()).hooks.Stop[0].hooks[0].url)
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port, path, method: 'POST', headers: { 'x-dsh-wt-token': token } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

const tokenOf = () => spawned.at(-1).spec.env.DSH_WT_TOKEN
const framesOf = (frames) => frames.filter((f) => f.type === 'subagents')
const lastTasks = (frames) => framesOf(frames).at(-1)?.tasks
const task = (over = {}) => ({ id: 'ag1', agentType: 'Explore', status: 'running', description: 'Look', label: 'Look', startTime: 1000, model: 'claude-haiku-5-5', contextWindowSize: 1000000, tokenCount: 5, ...over })

async function session() {
  const c = await connect(`id=${freshId()}`)
  await until(() => c.frames.some((f) => f.type === 'attached'))
  return { ...c, token: tokenOf() }
}

test('the settings file carries the SessionStart command hook, the sub-agent hooks and the sub-agent status line', async () => {
  const s = await settings()
  assert.equal(s.hooks.SessionStart[0].hooks[0].type, 'command')
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /^node ".*hook-post\.js" http:\/\/127\.0\.0\.1:\d+\/signal\/claude$/)
  assert.equal(s.hooks.SubagentStart[0].hooks[0].type, 'http')
  assert.equal(s.hooks.SubagentStop[0].hooks[0].type, 'http')
  assert.match(s.subagentStatusLine.command, /statusline\.js" --subagents http:\/\/127\.0\.0\.1:\d+\/signal\/subagents$/)
})

test('attached carries an empty subagents list for a new terminal', async () => {
  const { frames, ws } = await session()
  assert.deepEqual(frames[0].subagents, [])
  ws.close()
})

test('status-line tasks and hooks reach the browser as a subagents frame; stop makes it completed with endedAt', async () => {
  const { frames, ws, token } = await session()
  assert.equal(await post('/signal/claude', token, { hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'Explore' }), 204)
  assert.ok(await until(() => lastTasks(frames)?.length === 1))
  assert.equal(lastTasks(frames)[0].status, 'running')
  assert.equal(await post('/signal/subagents', token, { tasks: [task({ tokenCount: 42 })] }), 204)
  assert.ok(await until(() => lastTasks(frames)?.[0].tokenCount === 42))
  assert.deepEqual(Object.keys(lastTasks(frames)[0]).sort(), ['agentType', 'contextWindowSize', 'description', 'endedAt', 'id', 'label', 'model', 'startTime', 'status', 'tokenCount'])
  assert.equal(lastTasks(frames)[0].model, 'claude-haiku-5-5')
  await post('/signal/claude', token, { hook_event_name: 'SubagentStop', agent_id: 'ag1', agent_type: 'Explore' })
  assert.ok(await until(() => lastTasks(frames)?.[0].status === 'completed'))
  const done = lastTasks(frames)[0]
  assert.equal(typeof done.endedAt, 'number')
  assert.equal(done.agentType, 'Explore')
  assert.ok(!frames.some((f) => f.type === 'agent'), 'sub-agent events say nothing about the agent state')
  ws.close()
})

test('a burst of status-line posts is throttled to a few frames, ending on the newest numbers', async () => {
  const { frames, ws, token } = await session()
  const start = Date.now()
  for (let i = 1; i <= 30; i++) await post('/signal/subagents', token, { tasks: [task({ tokenCount: i })] })
  const elapsed = Date.now() - start
  assert.ok(await until(() => lastTasks(frames)?.[0].tokenCount === 30))
  const count = framesOf(frames).length
  assert.ok(count < 30 && count <= Math.ceil(elapsed / 300) + 2, `${count} frames in ${elapsed} ms`)
  ws.close()
})

test('a reattach replays the list in attached', async () => {
  const id = freshId()
  const first = await connect(`id=${id}`)
  await until(() => first.frames.some((f) => f.type === 'attached'))
  await post('/signal/subagents', tokenOf(), { tasks: [task()] })
  await until(() => lastTasks(first.frames)?.length === 1)
  first.ws.close()
  const second = await connect(`id=${id}`)
  await until(() => second.frames.length > 0)
  assert.equal(second.frames[0].created, false)
  assert.equal(second.frames[0].subagents.length, 1)
  assert.equal(second.frames[0].subagents[0].id, 'ag1')
  second.ws.close()
})

test('a finished sub-agent is dropped from a later frame after the retention', async () => {
  const { frames, ws, token } = await session()
  await post('/signal/claude', token, { hook_event_name: 'SubagentStart', agent_id: 'gone', agent_type: 'Plan' })
  await post('/signal/claude', token, { hook_event_name: 'SubagentStop', agent_id: 'gone', agent_type: 'Plan' })
  assert.ok(await until(() => lastTasks(frames)?.[0]?.status === 'completed'))
  assert.ok(await until(() => lastTasks(frames)?.length === 0), 'dropped after the retention')
  ws.close()
})

test('SessionEnd completes every running sub-agent', async () => {
  const { frames, ws, token } = await session()
  await post('/signal/subagents', token, { tasks: [task({ id: 'x1' }), task({ id: 'x2' })] })
  assert.ok(await until(() => lastTasks(frames)?.length === 2))
  await post('/signal/claude', token, { hook_event_name: 'SessionEnd', session_id: '3f4a3c42-a672-45ff-a7f5-ac6abdc48a8e' })
  assert.ok(await until(() => lastTasks(frames)?.every((a) => a.status === 'completed' && typeof a.endedAt === 'number')))
  assert.ok(frames.some((f) => f.type === 'agent' && f.state === 'ended'), 'the agent state still updates')
  ws.close()
})

test('the shell exiting completes every running sub-agent', async () => {
  const { frames, ws, token } = await session()
  const { handle } = spawned.at(-1)
  await post('/signal/subagents', token, { tasks: [task({ id: 'y1' })] })
  assert.ok(await until(() => lastTasks(frames)?.length === 1))
  handle.exit(0)
  assert.ok(await until(() => lastTasks(frames)?.[0].status === 'completed'))
  ws.close()
})

test('sub-agent posts need the terminal secret', async () => {
  await session()
  assert.equal(await post('/signal/subagents', 'wrong', { tasks: [task()] }), 401)
})
