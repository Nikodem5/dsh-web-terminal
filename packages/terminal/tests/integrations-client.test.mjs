// The opt-in Antigravity integration, client half: the launch rewrite, the state the help panel shows, and
// the one Install / Remove request (a fake host).
//
//   node --test tests/integrations-client.test.mjs

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { loadStore, window } from './helpers/load-store.mjs'

let s
before(async () => {
  s = await loadStore()
})
after(() => {
  s.closeAll()
  window.close()
})

const ID = 'd68c6b12-644d-4dea-93aa-b1ead1117390'

test('agy gets --settings when the host has a settings file, before any resume flag; never twice', () => {
  const agy = s.providerById('antigravity')
  const hint = { settingsPath: 'C:\\Users\\me\\.dsh\\web-terminal\\agy-settings-1.json' }
  assert.equal(agy.launch('agy', hint), 'agy --settings "C:/Users/me/.dsh/web-terminal/agy-settings-1.json"')
  assert.equal(agy.launch('agy', hint, ID), `agy --settings "C:/Users/me/.dsh/web-terminal/agy-settings-1.json" --conversation ${ID}`)
  assert.equal(agy.launch('agy -c', hint, ID), 'agy --settings "C:/Users/me/.dsh/web-terminal/agy-settings-1.json" -c', 'a chosen conversation is kept')
  assert.equal(agy.launch('agy --settings x.json', hint), 'agy --settings x.json')
  assert.equal(agy.launch('agy', {}), 'agy', 'off: as typed')
  assert.equal(agy.launch('npm test', hint), 'npm test')
})

test('parseIntegration and describeIntegration', () => {
  assert.equal(s.parseIntegration(null), undefined)
  assert.equal(s.parseIntegration({ enabled: 'yes' }), undefined)
  const off = s.parseIntegration({ enabled: false, pluginInstalled: false, busy: false, reason: null, error: null })
  assert.deepEqual(s.describeIntegration(off), { value: 'not installed (status from terminal output only)', bad: false })
  assert.deepEqual(s.describeIntegration({ ...off, enabled: true, pluginInstalled: true }), { value: 'installed (hooks plugin and status line)', bad: false })
  assert.equal(s.describeIntegration({ ...off, enabled: true, reason: 'node not on PATH' }).bad, true)
  assert.match(s.describeIntegration({ ...off, error: 'agy plugin install failed' }).value, /last change failed: agy plugin install failed$/)
  assert.equal(s.describeIntegration(undefined).value, 'unknown (host has not answered)')
})

test('runIntegration posts one action, keeps the new state and refreshes the host probe', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body })
    if (url.endsWith('/integration')) {
      const status = { enabled: true, pluginInstalled: true, busy: false, reason: null, error: null }
      return { ok: true, status: 200, json: async () => ({ ok: true, status, integrations: { antigravity: status } }) }
    }
    return { ok: true, json: async () => ({ providers: { antigravity: { available: true, path: 'agy', launch: { settingsPath: 'C:/x.json' } } } }) }
  }
  try {
    const result = await s.runIntegration('antigravity', 'install')
    assert.equal(result.enabled, true)
    assert.equal(s.getIntegrations().antigravity.pluginInstalled, true)
    assert.equal(s.integrationRunning(), null)
    const post = calls.find((c) => c.method === 'POST')
    assert.deepEqual(JSON.parse(post.body), { provider: 'antigravity', action: 'install' })
    assert.ok(calls.some((c) => c.url.endsWith('/info')), 'the host probe is asked again')
    globalThis.fetch = async () => { throw new Error('offline') }
    assert.equal(await s.runIntegration('antigravity', 'remove'), 'offline')
  } finally {
    globalThis.fetch = realFetch
  }
})
