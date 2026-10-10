// Host stats: the /signal/usage route, the /stats response, the status-line settings and persistence.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { request } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createServer } from 'node:http'
import { apply } from '../lib/index.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-wt-stats-'))
after(() => {
  for (const host of hosts) host.stop()
  rmSync(root, { recursive: true, force: true })
})
const hosts = []
let n = 0

function fakeHandle() {
  const output = new EventEmitter()
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  return { output, done, pid: 4242, write() {}, resize() {}, signalForeground() {}, terminate() { finish({ exitCode: null }) } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (predicate, ms = 5000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await predicate()) return true
    await sleep(20)
  }
  return false
}

/** A Claude config dir: stats-cache (one day) and a transcript from after it. */
function claudeConfig({ refreshInterval } = {}) {
  const dir = join(root, `claude${++n}`)
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
  writeFileSync(join(dir, 'stats-cache.json'), JSON.stringify({ version: 5, lastComputedDate: '2020-01-02', modelUsage: { m: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 } } }))
  const line = { type: 'assistant', timestamp: new Date(2020, 0, 3, 5).toISOString(), message: { id: 'a', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } }
  writeFileSync(join(dir, 'projects', 'p', 's.jsonl'), `${JSON.stringify(line)}\n${JSON.stringify(line)}\n`)
  if (refreshInterval !== undefined) writeFileSync(join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'x', refreshInterval } }))
  return dir
}

/** Apply a plugin instance with env overrides held until its async setup finished. */
async function startHost({ env = {}, home = mkdtempSync(join(root, 'home')) } = {}) {
  const saved = {}
  const merged = { DSH_HOME: home, CLAUDE_CONFIG_DIR: claudeConfig(), ...env }
  for (const [key, value] of Object.entries(merged)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  const routes = { http: [], upgrade: [] }
  const spawned = []
  let teardown
  apply({
    webServer: {
      register: (route) => { routes.http.push(route); return () => {} },
      registerUpgrade: (route) => { routes.upgrade.push(route); return () => {} },
    },
    subprocess: { spawnTerminal: async (spec) => { const handle = fakeHandle(); spawned.push({ spec, handle }); return handle } },
    effect: (fn) => { teardown = fn(); return () => {} },
  })
  const call = (path) => new Promise((resolve) => routes.http.find((r) => r.path === path).handler({ method: 'GET' }, { writeHead() {}, end: (p) => resolve(JSON.parse(p)) }))
  const stats = () => call('/api/dsh-web-terminal/stats')
  await stats() // waits for the signal server and settings file
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const http = createServer()
  http.on('upgrade', (req, socket, head) => routes.upgrade.find((r) => r.path === '/terminal/ws').handler(req, socket, head))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const info = await call('/api/dsh-web-terminal/info')
  const settings = JSON.parse(readFileSync(info.agent.claudeSettings, 'utf8'))
  let stopped = false
  const host = {
    home,
    spawned,
    settings,
    stats,
    stop() { if (stopped) return; stopped = true; teardown(); http.close() },
    /** Open a terminal; resolves with its secret once the host has created it. */
    async terminal() {
      const ws = new WebSocket(`ws://127.0.0.1:${http.address().port}/terminal/ws?id=t${++n}`)
      const attached = new Promise((resolve) => ws.on('message', (raw) => JSON.parse(String(raw)).type === 'attached' && resolve()))
      await attached
      return { ws, token: spawned.at(-1).spec.env.DSH_WT_TOKEN }
    },
    /** POST to a signal route as the status-line wrapper would. */
    post(token, body, path = '/signal/usage', raw) {
      const target = new URL(settings.hooks.Stop[0].hooks[0].url)
      return new Promise((resolve, reject) => {
        const req = request({ host: target.hostname, port: target.port, path, method: 'POST', headers: token === undefined ? {} : { 'x-dsh-wt-token': token } }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        })
        req.on('error', reject)
        req.end(raw ?? JSON.stringify(body))
      })
    },
  }
  hosts.push(host)
  return host
}

const limitsBody = (five, seven, cost) => ({
  rate_limits: { five_hour: { used_percentage: five, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 }, seven_day: { used_percentage: seven, resets_at: Math.floor(Date.now() / 1000) + 3 * 86400 } },
  cost: { total_cost_usd: cost },
})

test('the settings file installs the status-line wrapper pointing at /signal/usage', async () => {
  const host = await startHost({ env: { CLAUDE_CONFIG_DIR: claudeConfig({ refreshInterval: 7 }) } })
  const line = host.settings.statusLine
  assert.equal(line.type, 'command')
  assert.match(line.command, /^node "[^"\\]*\/lib\/statusline\.js" http:\/\/127\.0\.0\.1:\d+\/signal\/usage$/)
  assert.equal(line.refreshInterval, 7, "the user's own interval is kept")
  assert.ok(host.settings.hooks.Stop, 'hooks unchanged')
  assert.deepEqual((await host.stats()).statusLine, { enabled: true, reason: null })
})

test('without a user refresh interval the wrapper refreshes every 10 s', async () => {
  const host = await startHost()
  assert.equal(host.settings.statusLine.refreshInterval, 10)
})

test('without node on PATH the status line is left alone and /stats says why', async () => {
  const host = await startHost({ env: { PATH: '' } })
  assert.equal(host.settings.statusLine, undefined)
  assert.ok(host.settings.hooks.Stop)
  assert.deepEqual((await host.stats()).statusLine, { enabled: false, reason: 'node not on PATH' })
})

test('/signal/usage needs a valid secret and a JSON body; /stats reflects what terminals report', async () => {
  const host = await startHost()
  const empty = await host.stats()
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.limits, { fiveHour: null, sevenDay: null, sampledAt: null })
  assert.deepEqual(empty.cost, { totalUsd: 0, terminals: 0 })

  const a = await host.terminal()
  const b = await host.terminal()
  assert.equal(await host.post(undefined, limitsBody(1, 1, 1)), 401)
  assert.equal(await host.post('wrong', limitsBody(1, 1, 1)), 401)
  assert.equal(await host.post(a.token, undefined, '/signal/usage', '{nope'), 400)
  assert.equal(await host.post(a.token, undefined, '/signal/usage', JSON.stringify('x'.repeat(70 * 1024))), 413)
  assert.equal(await host.post(a.token, [1, 2]), 204)
  assert.equal(await host.post(a.token, limitsBody(40, 12, 1.5)), 204)
  assert.equal(await host.post(b.token, limitsBody(41, 12, 2)), 204)

  const stats = await host.stats()
  assert.equal(stats.limits.fiveHour.usedPct, 41)
  assert.equal(stats.limits.sevenDay.usedPct, 12)
  assert.ok(Math.abs(stats.limits.fiveHour.resetsAt - (Date.now() + 3 * 3600_000)) < 5000, 'reset time in ms')
  assert.ok(Math.abs(stats.limits.sampledAt - Date.now()) < 5000)
  assert.ok('outAt' in stats.limits.fiveHour && 'outAt' in stats.limits.sevenDay)
  assert.deepEqual(stats.cost, { totalUsd: 3.5, terminals: 2 })
  assert.deepEqual(stats.statusLine, { enabled: true, reason: null })

  // A destroyed terminal's cost goes away; the account limits stay.
  a.ws.send(JSON.stringify({ type: 'kill' }))
  assert.ok(await until(async () => (await host.stats()).cost.terminals === 1))
  assert.deepEqual((await host.stats()).cost, { totalUsd: 2, terminals: 1 })
  assert.equal((await host.stats()).limits.fiveHour.usedPct, 41)
  b.ws.close()
})

test('usage payloads do not become agent signals', async () => {
  const host = await startHost()
  const t = await host.terminal()
  const frames = []
  t.ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
  assert.equal(await host.post(t.token, { ...limitsBody(5, 5, 1), state: 'needs-you', hook_event_name: 'Stop' }), 204)
  await sleep(100)
  assert.deepEqual(frames.filter((f) => f.type === 'agent'), [])
  t.ws.close()
})

test('/stats totals the tokens from the cache and newer transcripts without blocking', async () => {
  const host = await startHost()
  const first = await host.stats()
  assert.ok(first.tokens === null || typeof first.tokens.total === 'number', 'null until the first scan finishes')
  assert.ok(await until(async () => (await host.stats()).tokens !== null))
  const { tokens } = await host.stats()
  assert.deepEqual({ ...tokens, asOf: 0 }, { total: 100 + 10, input: 11, output: 22, cacheRead: 33, cacheCreation: 44, asOf: 0 })
  assert.ok(Math.abs(tokens.asOf - Date.now()) < 10_000)
})

test('limits and token totals are saved on unload and loaded by the next host', async () => {
  const home = mkdtempSync(join(root, 'persist'))
  const config = claudeConfig()
  const one = await startHost({ home, env: { CLAUDE_CONFIG_DIR: config } })
  const t = await one.terminal()
  await one.post(t.token, limitsBody(33, 8, 1))
  assert.ok(await until(async () => (await one.stats()).tokens !== null))
  one.stop()
  const file = join(home, 'web-terminal', 'usage.json')
  assert.ok(existsSync(file))
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.usage.fiveHour.usedPct, 33)
  assert.equal(saved.tokens.total, 110)

  // A new host with no transcripts at all still shows the saved values.
  const two = await startHost({ home, env: { CLAUDE_CONFIG_DIR: join(root, 'no-such-claude-dir') } })
  const stats = await two.stats()
  assert.equal(stats.limits.fiveHour.usedPct, 33)
  assert.equal(stats.limits.sevenDay.usedPct, 8)
  assert.equal(stats.tokens.total, 110)
  assert.deepEqual(stats.cost, { totalUsd: 0, terminals: 0 }, 'cost is per run and not restored')
})
