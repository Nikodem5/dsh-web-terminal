// /info feeds the help panel's diagnostics: plugin version and where `node` and `claude` were found.
// The ctx is strict like cordis': reading anything that was not injected throws.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { apply } from '../lib/index.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-wt-info-'))
process.env.DSH_HOME = home
// The wrapper needs `node`; make sure the one running this test is on PATH, whatever the shell was.
process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`
const stops = []
after(() => {
  for (const stop of stops) stop()
  rmSync(home, { recursive: true, force: true })
})

function strictCtx(base) {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

function info() {
  const routes = []
  apply(strictCtx({
    webServer: { register: (r) => { routes.push(r); return () => {} }, registerUpgrade: () => () => {} },
    subprocess: { spawnTerminal: async () => { throw new Error('unused') } },
    effect: (fn) => { stops.push(fn()); return () => {} },
  }))
  const route = routes.find((r) => r.path === '/api/dsh-web-terminal/info')
  return new Promise((resolve) => route.handler({ method: 'GET' }, { writeHead() {}, end: (payload) => resolve(JSON.parse(payload)) }))
}

test('/info reports the plugin version from package.json', async () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const body = await info()
  assert.equal(body.ok, true)
  assert.equal(body.version, version)
})

test('/info reports where node was found', async () => {
  const body = await info()
  assert.equal(body.node.available, true)
  assert.equal(typeof body.node.path, 'string')
  assert.ok(body.node.path.length > 0)
  assert.equal(typeof body.claude.available, 'boolean', 'claude is still reported')
})
