// The host's provider registry (pure: no host, no I/O).
//
//   node --test tests/providers.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry, registry } from '../lib/providers/index.js'

const fake = (extra = {}) => ({ id: 'fake', label: 'Fake', commands: ['fakecli'], ...extra })

test('Claude Code is built in, found by id and by its command', () => {
  assert.equal(registry.get('claude')?.label, 'Claude Code')
  assert.equal(registry.byCommand('claude')?.id, 'claude')
  assert.deepEqual(registry.list().map((p) => p.id), ['claude', 'antigravity'])
})

test('an unknown id or command is no provider', () => {
  assert.equal(registry.get('gemini'), undefined)
  assert.equal(registry.byCommand('gemini'), undefined)
  assert.equal(registry.route('gemini'), undefined)
})

test('the built-in routes are Claude\'s, byte for byte', () => {
  for (const name of ['claude-edit', 'usage', 'subagents']) assert.equal(registry.route(name)?.provider.id, 'claude', name)
})

test('a registered provider is found by id and command until it is removed', () => {
  const r = createRegistry([fake()])
  assert.equal(r.get('fake')?.label, 'Fake')
  assert.equal(r.byCommand('fakecli')?.id, 'fake')
  const off = r.register(fake({ id: 'other', commands: ['other', 'othercli'] }))
  assert.equal(r.byCommand('othercli')?.id, 'other')
  assert.deepEqual(r.list().map((p) => p.id), ['fake', 'other'])
  off()
  assert.equal(r.get('other'), undefined)
  assert.equal(r.byCommand('othercli'), undefined)
})

test('normalize: the provider adapter reads its payload; unknown ids need a neutral state', () => {
  const r = createRegistry([fake({ adapter: (body) => (body.go ? { state: 'working', detail: '' } : undefined) })])
  assert.deepEqual(r.normalize('fake', { go: true }), { provider: 'fake', state: 'working', detail: '' })
  assert.equal(r.normalize('fake', { stop: true }), undefined)
  assert.deepEqual(r.normalize('fake', { state: 'finished' }), { provider: 'fake', state: 'finished', detail: '' }, 'a neutral body needs no adapter')
  assert.equal(r.normalize('nobody', { go: true }), undefined)
  assert.deepEqual(r.normalize('nobody', { state: 'needs-you', detail: 'x' }), { provider: 'nobody', state: 'needs-you', detail: 'x' })
  assert.equal(r.normalize('nobody', { state: 'bogus' }), undefined)
})

test('a provider without commands, with a bad id or a clashing id or route is refused', () => {
  const r = createRegistry([fake({ routes: { extra: () => {} } })])
  assert.throws(() => r.register(fake({ commands: [] })), /no command/)
  assert.throws(() => r.register(fake({ id: 'Bad Id' })), /invalid provider id/)
  assert.throws(() => r.register(fake()), /collides/)
  assert.throws(() => r.register(fake({ id: 'second', routes: { extra: () => {} } })), /collides/)
  assert.throws(() => r.register(fake({ id: 'third', routes: { fake: () => {} } })), /collides/)
  assert.deepEqual(r.list().map((p) => p.id), ['fake'], 'a refused provider leaves nothing behind')
})
