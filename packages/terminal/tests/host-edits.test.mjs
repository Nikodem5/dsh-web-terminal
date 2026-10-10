// "Changed by agent" files: the PostToolUse edit hook, the `edits` frame, the attached replay, clearing
// on destroy. A fake PTY and a strict ctx (reading anything not injected throws, like cordis').

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'
import { EDIT_MATCHER, MAX_EDITS, createEdits, parseEdit } from '../lib/edits.js'
import { buildClaudeSettings } from '../lib/agent-signals.js'

const testHome = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-home-edits')
process.env.DSH_HOME = testHome
process.env.DSH_WT_EDIT_THROTTLE_MS = '200'

const strictCtx = (base) => new Proxy(base, {
  get(target, prop) {
    if (prop in target) return target[prop]
    throw new Error(`cannot get property "${String(prop)}" without inject`)
  },
})

function fakeHandle() {
  const output = new EventEmitter()
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  return { output, done, pid: 4243, write() {}, resize() {}, signalForeground() {}, terminate() { finish({ exitCode: null }) }, exit(exitCode) { finish({ exitCode }) } }
}

const routes = { http: [], upgrade: [] }
const spawned = []
let teardown
let server
let port

before(async () => {
  rmSync(testHome, { recursive: true, force: true })
  apply(strictCtx({
    webServer: {
      register: (route) => { routes.http.push(route); return () => {} },
      registerUpgrade: (route) => { routes.upgrade.push(route); return () => {} },
    },
    subprocess: { spawnTerminal: async (spec) => { const handle = fakeHandle(); spawned.push({ spec, handle }); return handle } },
    effect: (fn) => { teardown = fn(); return () => {} },
  }))
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
const freshId = () => `e${Date.now()}x${++seq}`
const until = async (predicate, ms = 20000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (predicate()) return true
    await sleep(10)
  }
  return false
}

function connect(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/ws?${query}`)
    const frames = []
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
    ws.on('open', () => resolve({ ws, frames }))
    ws.on('error', reject)
  })
}

let cachedSettings
async function settings() {
  if (cachedSettings) return cachedSettings
  const route = routes.http.find((r) => r.path === '/api/dsh-web-terminal/info')
  const { agent } = await new Promise((resolve) => route.handler({ method: 'GET' }, { writeHead() {}, end: (p) => resolve(JSON.parse(p)) }))
  cachedSettings = JSON.parse(readFileSync(agent.claudeSettings, 'utf8'))
  return cachedSettings
}

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
const lastEdits = (frames) => frames.filter((f) => f.type === 'edits').at(-1)?.files
const hook = (tool_name, tool_input, extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name, tool_input, cwd: String.raw`C:\proj`, session_id: 'abcdef12-3456', ...extra })

async function session(id = freshId()) {
  const c = await connect(`id=${id}`)
  await until(() => c.frames.some((f) => f.type === 'attached'))
  return { ...c, id, token: tokenOf() }
}

test('settings: a second PostToolUse group, matched to the editing tools, posts to /signal/claude-edit', async () => {
  const s = await settings()
  assert.equal(s.hooks.PostToolUse.length, 2)
  assert.equal(s.hooks.PostToolUse[0].matcher, undefined, 'the state hook stays unmatched')
  assert.match(s.hooks.PostToolUse[0].hooks[0].url, /\/signal\/claude$/)
  const edit = s.hooks.PostToolUse[1]
  assert.equal(edit.matcher, 'Edit|Write|MultiEdit|NotebookEdit')
  assert.equal(edit.matcher, EDIT_MATCHER)
  assert.match(edit.hooks[0].url, /\/signal\/claude-edit$/)
  assert.equal(edit.hooks[0].type, 'http')
  assert.deepEqual(edit.hooks[0].allowedEnvVars, ['DSH_WT_TOKEN'])
  assert.equal(buildClaudeSettings('http://x/signal/claude').hooks.PostToolUse.length, 1, 'without editUrl nothing is added')
})

test('Edit, Write, MultiEdit and NotebookEdit payloads produce an edits frame; attached starts empty', async () => {
  const { frames, ws, token } = await session()
  assert.deepEqual(frames[0].edits, [])
  assert.equal(await post('/signal/claude-edit', token, hook('Edit', { file_path: String.raw`C:\proj\a.ts` })), 204)
  assert.equal(await post('/signal/claude-edit', token, hook('Write', { file_path: String.raw`C:\proj\b.ts` })), 204)
  assert.equal(await post('/signal/claude-edit', token, hook('MultiEdit', { file_path: String.raw`C:\proj\c.ts` })), 204)
  assert.equal(await post('/signal/claude-edit', token, hook('NotebookEdit', { notebook_path: String.raw`C:\proj\n.ipynb` })), 204)
  assert.ok(await until(() => lastEdits(frames)?.length === 4))
  const files = lastEdits(frames)
  assert.deepEqual(files.map((f) => [f.path, f.tool]), [
    [String.raw`C:\proj\a.ts`, 'Edit'], [String.raw`C:\proj\b.ts`, 'Write'], [String.raw`C:\proj\c.ts`, 'MultiEdit'], [String.raw`C:\proj\n.ipynb`, 'NotebookEdit'],
  ])
  assert.ok(files.every((f) => typeof f.at === 'number'))
  ws.close()
})

test('an edit is not an agent-state change', async () => {
  const { frames, ws, token } = await session()
  await post('/signal/claude-edit', token, hook('Edit', { file_path: String.raw`C:\proj\a.ts` }))
  await until(() => lastEdits(frames)?.length === 1)
  await sleep(50)
  assert.ok(!frames.some((f) => f.type === 'agent'))
  ws.close()
})

test('bad payloads are acknowledged but recorded nowhere', async () => {
  const { frames, ws, token } = await session()
  const bad = [
    hook('Edit', { file_path: 'relative/a.ts' }, { cwd: 'also-relative' }),
    hook('Edit', { file_path: 42 }),
    hook('Edit', {}),
    hook('Edit', null),
    hook('Bash', { command: 'ls', file_path: String.raw`C:\proj\a.ts` }),
    hook('Edit', { file_path: `C:\\proj\\${'x'.repeat(2000)}` }),
    hook('Edit', { file_path: 'C:\\proj\\a\0b' }),
    { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: String.raw`C:\proj\a.ts` } },
    [],
  ]
  for (const body of bad) assert.equal(await post('/signal/claude-edit', token, body), 204)
  await post('/signal/claude-edit', token, hook('Edit', { file_path: String.raw`C:\proj\ok.ts` }))
  assert.ok(await until(() => lastEdits(frames)?.length === 1))
  assert.equal(lastEdits(frames)[0].path, String.raw`C:\proj\ok.ts`)
  assert.equal(await post('/signal/claude-edit', 'wrong-token', hook('Edit', { file_path: String.raw`C:\proj\z.ts` })), 401)
  ws.close()
})

test('a burst is throttled to a few frames ending on the full list', async () => {
  const { frames, ws, token } = await session()
  for (let i = 0; i < 20; i++) await post('/signal/claude-edit', token, hook('Edit', { file_path: `/work/f${i}.ts` }))
  assert.ok(await until(() => lastEdits(frames)?.length === 20))
  assert.ok(frames.filter((f) => f.type === 'edits').length < 20)
  ws.close()
})

test('a reattach replays the list in attached; destroying the terminal clears it', async () => {
  const first = await session()
  await post('/signal/claude-edit', first.token, hook('Write', { file_path: '/work/new.ts' }))
  await until(() => lastEdits(first.frames)?.length === 1)
  first.ws.close()
  const second = await connect(`id=${first.id}`)
  await until(() => second.frames.length > 0)
  assert.equal(second.frames[0].created, false)
  assert.deepEqual(second.frames[0].edits.map((f) => f.path), ['/work/new.ts'])
  second.ws.send(JSON.stringify({ type: 'kill' }))
  await sleep(100)
  assert.equal(await post('/signal/claude-edit', first.token, hook('Edit', { file_path: '/work/late.ts' })), 401, 'the token died with the session')
  const third = await connect(`id=${first.id}`)
  await until(() => third.frames.length > 0)
  assert.equal(third.frames[0].created, true)
  assert.deepEqual(third.frames[0].edits, [])
  third.ws.close()
})

test('parseEdit resolves relative paths against an absolute cwd and normalises', () => {
  assert.deepEqual(parseEdit(hook('Edit', { file_path: 'src/a.ts' })), { path: String.raw`C:\proj\src\a.ts`, tool: 'Edit' })
  assert.deepEqual(parseEdit(hook('Edit', { file_path: 'src/../a.ts' }, { cwd: '/home/me' })), { path: '/home/me/a.ts', tool: 'Edit' })
  assert.deepEqual(parseEdit(hook('Write', { file_path: 'C:/proj/x/../y.ts' })), { path: String.raw`C:\proj\y.ts`, tool: 'Write' })
})

test('the store keeps the newest files and moves a re-edited file to the end', () => {
  const e = createEdits({ now: () => 7, max: 3 })
  for (const n of ['a', 'b', 'c']) e.ingest(hook('Edit', { file_path: `/w/${n}` }, { cwd: '/w' }))
  e.ingest(hook('Edit', { file_path: '/w/a' }, { cwd: '/w' }))
  e.ingest(hook('Edit', { file_path: '/w/d' }, { cwd: '/w' }))
  assert.deepEqual(e.list().map((f) => f.path), ['/w/c', '/w/a', '/w/d'])
  assert.equal(MAX_EDITS, 500)
})
