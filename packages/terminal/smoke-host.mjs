// End-to-end smoke test for the host half (development only).
//
// Loads lib/index.js against a stub cordis context, then runs the plugin's own
// registered routes on a real HTTP server with the real local subprocess
// provider: the PTY is genuinely spawned and we assert that
//   1. a command round-trips through the WebSocket (and a resize frame is accepted),
//   2. reconnecting with the same id reattaches to the surviving shell and replays scrollback,
//   3. /info lists the live session, and a `kill` frame ends it.

import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { apply, name, inject } from './lib/index.js'

/** The real local subprocess provider, loaded from the installed profile. */
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const PROVIDER = process.env.DSH_SUBPROCESS_LOCAL
  ?? pathToFileURL(join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js')).href

// No installed profile (fresh checkout, CI) means there is no real PTY provider to test against.
const LocalSubprocessRuntime = await import(PROVIDER).then(
  (mod) => mod.default,
  (err) => {
    console.log(`SKIP: local subprocess provider not loadable (${PROVIDER}): ${err.message}`)
    console.log('Set DSH_HOME or DSH_SUBPROCESS_LOCAL to a profile that has @deepseek-ai/dsh-subprocess-local.')
    process.exit(0)
  },
)
const provider = new LocalSubprocessRuntime({
  // Minimal cordis-shaped context: the provider is a Service, so it only needs
  // the reflect hook the base class registers itself through, plus the small
  // surface its constructor touches.
  reflect: { provide() {}, get: () => undefined },
  get: () => undefined,
  effect: (fn) => fn(),
  logger: console,
  on: () => () => {},
  inject: () => {},
})

/** Stub host context: records routes, forwards PTY work to the real provider. */
const registered = { http: [], upgrade: [], disposers: [] }
const ctx = {
  webServer: {
    register(route) {
      registered.http.push(route)
      return () => registered.disposers.push(route.path)
    },
    registerUpgrade(route) {
      registered.upgrade.push(route)
      return () => registered.disposers.push(route.path)
    },
  },
  subprocess: { spawnTerminal: (spec) => provider.spawnTerminal(spec) },
  effect(fn) {
    registered.teardown = fn()
    return () => {}
  },
}

apply(ctx)

console.log(`name=${name}  inject=${JSON.stringify(inject)}`)
console.log(`http: ${registered.http.map((r) => `${r.kind} ${r.path}`).join(', ') || '(none)'}`)
console.log(`upgrade: ${registered.upgrade.map((r) => r.path).join(', ') || '(none)'}`)

const info = registered.http.find((r) => r.path === '/api/dsh-web-terminal/info')
const upgrade = registered.upgrade.find((r) => r.path === '/terminal/ws')
if (info === undefined || upgrade === undefined) {
  console.error('FAIL: expected routes were not registered')
  process.exit(1)
}

/** Call the /info handler with a minimal response stub. */
function getInfo() {
  return new Promise((resolve) => {
    info.handler({ method: 'GET' }, { writeHead() {}, end(payload) { resolve(JSON.parse(payload)) } })
  })
}

const probe = await getInfo()
console.log(`GET /info -> shells=${JSON.stringify(probe.shells)} claude=${probe.claude.available}`)

// Real server: the harness's webserver does exactly this for upgrade routes.
const server = createServer()
server.on('upgrade', (req, socket, head) => upgrade.handler(req, socket, head))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const marker = `dshwt${Date.now()}`
const sessionId = `smoke${Date.now()}`
const base = `ws://127.0.0.1:${port}/terminal/ws?id=${sessionId}&cols=100&rows=30`

/** Open one socket; resolve once `until(out)` holds or 30s pass. */
function session(url, onOpen, until) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const out = { text: '', frames: [] }
    const finish = () => {
      clearTimeout(timer)
      resolve({ ws, ...out })
    }
    const timer = setTimeout(finish, 30000)
    ws.on('open', () => onOpen(ws))
    ws.on('message', (raw) => {
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      out.frames.push(frame)
      if (frame.type === 'data') out.text += frame.data
      if (frame.type === 'attached') out.text += frame.replay ?? ''
      if (until(out)) finish()
    })
    ws.on('error', () => finish())
  })
}

// 1) fresh shell: a command round-trips and a resize frame is accepted.
const first = await session(
  base,
  (ws) => setTimeout(() => {
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    ws.send(JSON.stringify({ type: 'input', data: `echo ${marker}\r` }))
  }, 1500),
  (o) => o.text.includes(marker) && /echo/.test(o.text),
)
const echoed = first.text.includes(marker)
console.log(echoed ? 'PASS: marker echoed back through the real PTY' : 'FAIL: marker never came back')
// A long-lived child of the shell, typed as one command line. `node` is on PATH wherever this
// script runs, and the double-quoted body has no characters that PowerShell, cmd or bash/zsh
// treat specially, so one string works in every default shell (unlike `ping -n`/`sleep`).
const LONG_CHILD = 'node -e "setTimeout(function(){},12000)"'
// 1b) a child process under the shell is reported as busy (providers with inspectActivity only).
let activityNote = 'skipped'
let activityOk = true
if (true) {
  const busy = await session(
    base,
    (ws) => setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: LONG_CHILD + '\r' })), 300),
    (o) => o.frames.some((f) => f.type === 'activity' && f.busy === true),
  )
  activityOk = busy.frames.some((f) => f.type === 'activity' && f.busy === true)
  activityNote = activityOk ? 'busy frame received' : 'no busy frame'
  busy.ws.close()
}
console.log(activityOk ? 'PASS: activity — ' + activityNote : 'FAIL: activity — ' + activityNote)

first.ws.close()
await new Promise((r) => setTimeout(r, 500))

// 2) reattach with the same id: the shell outlived its socket and replays scrollback.
const second = await session(base, () => {}, (o) => o.frames.some((f) => f.type === 'attached'))
const replayed = second.text.includes(marker)
console.log(replayed ? 'PASS: reattach replayed scrollback from the surviving shell' : 'FAIL: reattach lost the session')

// 3) /info lists the live session; a kill frame removes it.
const listed = (await getInfo()).sessions.some((s) => s.id === sessionId)
console.log(listed ? 'PASS: /info lists the live session' : 'FAIL: session missing from /info')
second.ws.send(JSON.stringify({ type: 'kill' }))
await new Promise((r) => setTimeout(r, 800))
const gone = !(await getInfo()).sessions.some((s) => s.id === sessionId)
console.log(gone ? 'PASS: kill frame ended the session' : 'FAIL: session survived kill')

const allOk = echoed && replayed && listed && gone && activityOk

if (typeof registered.teardown === 'function') registered.teardown()
console.log(`route disposers invoked: ${registered.disposers.length}`)
server.close()
provider.dispose?.()
process.exit(allOk ? 0 : 1)
