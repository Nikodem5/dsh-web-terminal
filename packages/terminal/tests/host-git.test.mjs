// Host: the git header end to end over the real WebSocket route with a real repository.
// A `git-refresh` frame, an attach and an agent signal each bring a `git` frame; ssh terminals get none.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'
import { authed, localReq } from './helpers/local-auth.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-wt-hostgit-'))
const stops = []
after(() => {
  for (const stop of stops) stop()
  rmSync(root, { recursive: true, force: true })
})

let gitOk = true
try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitOk = false }
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, what, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await sleep(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

function fakeHandle() {
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  return { output: new EventEmitter(), done, pid: 4242, write() {}, resize() {}, signalForeground() {}, terminate() { finish({ exitCode: null }) } }
}

async function startHost() {
  const saved = {}
  const env = { DSH_HOME: mkdtempSync(join(root, 'home')), DSH_WT_GIT_GAP_MS: '20', DSH_WT_GIT_INTERVAL_MS: '3600000', CLAUDE_CONFIG_DIR: join(root, 'claude') }
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
  for (const [key, value] of Object.entries(env)) {
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
    on: () => () => {},
    effect: (fn) => { teardown = fn(); return () => {} },
  })
  const call = (path) => new Promise((resolve) => routes.http.find((r) => r.path === path).handler(localReq(), { writeHead() {}, end: (p) => resolve(JSON.parse(p)) }))
  const info = await call('/api/dsh-web-terminal/info')
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const http = createServer()
  http.on('upgrade', (req, socket, head) => routes.upgrade.find((r) => r.path === '/terminal/ws').handler(req, socket, head))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const settings = JSON.parse(readFileSync(info.providers.claude.launch.settingsPath, 'utf8'))
  const host = {
    /** Open a terminal; collects every `git` frame it receives. */
    async open(query) {
      const ws = new WebSocket(`ws://127.0.0.1:${http.address().port}/terminal/ws?${query}&cols=80&rows=24`, authed())
      const gits = []
      const attached = new Promise((resolve) => ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw))
        if (frame.type === 'attached') resolve()
        if (frame.type === 'git') gits.push(frame.git)
      }))
      await attached
      return { ws, gits, token: spawned.at(-1).spec.env.DSH_WT_TOKEN }
    },
    signal(token, state) {
      const target = new URL(settings.hooks.Stop[0].hooks[0].url)
      return new Promise((resolve, reject) => {
        const req = request({ host: target.hostname, port: target.port, path: '/signal/claude', method: 'POST', headers: { 'x-dsh-wt-token': token } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
        req.on('error', reject)
        req.end(JSON.stringify({ state }))
      })
    },
  }
  stops.push(() => { teardown(); http.close() })
  return host
}

test('git header over the wire: attach, refresh, agent signal, folders that are not repositories, ssh', { skip: !gitOk }, async () => {
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'trunk')
  writeFileSync(join(repo, 'a.txt'), 'a')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  const plain = join(root, 'plain')
  mkdirSync(plain)
  const host = await startHost()

  // An ssh terminal gets no git frames at all.
  const remote = await host.open(`id=r1&shell=ssh&sshTarget=${encodeURIComponent('me@example.com')}`)
  remote.ws.send(JSON.stringify({ type: 'git-refresh', cwd: repo }))

  // The attach alone brings the branch.
  const local = await host.open(`id=l1&shell=default&cwd=${encodeURIComponent(repo)}`)
  await until(() => local.gits.length >= 1, 'the first git frame')
  assert.deepEqual(local.gits[0], { branch: 'trunk', dirty: false })

  // A command changed the working tree; the browser asks.
  writeFileSync(join(repo, 'new.txt'), 'x')
  local.ws.send(JSON.stringify({ type: 'git-refresh', cwd: repo }))
  await until(() => local.gits.at(-1)?.dirty === true, 'dirty after a refresh')

  // The agent finishes after committing: its signal alone refreshes.
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'second')
  assert.equal(await host.signal(local.token, 'finished'), 204)
  await until(() => local.gits.at(-1)?.dirty === false, 'clean after the agent signal')

  // cd into a folder that is not a repository: the chip goes away.
  local.ws.send(JSON.stringify({ type: 'git-refresh', cwd: plain }))
  await until(() => local.gits.at(-1) === null, 'null outside a repository')

  // A relative or junk folder is ignored (the answer stays the same, no crash).
  local.ws.send(JSON.stringify({ type: 'git-refresh', cwd: '../../etc' }))
  local.ws.send(JSON.stringify({ type: 'git-refresh', cwd: 12 }))
  local.ws.send(JSON.stringify({ type: 'git-refresh' }))

  // The ssh socket heard nothing, the whole time.
  assert.deepEqual(remote.gits, [])
  remote.ws.close()
  local.ws.close()
})
