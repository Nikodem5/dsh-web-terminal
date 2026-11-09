// Cached PATH lookups for the info route (pure: the lookup is a fake).
//
//   node --test tests/command-cache.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommandCache } from '../lib/command-cache.js'

function fakeLookup(answers) {
  const calls = []
  return { calls, resolve: async (name) => { calls.push(name); return answers[name] } }
}

test('a found command is looked up once and kept', async () => {
  const lookup = fakeLookup({ agy: 'C:\\agy\\agy.exe' })
  const cache = createCommandCache({ resolve: lookup.resolve })
  for (let i = 0; i < 5; i++) assert.equal(await cache.find('agy'), 'C:\\agy\\agy.exe')
  assert.deepEqual(lookup.calls, ['agy'])
})

test('a missing command is believed for missRetryMs, then looked up again', async () => {
  let clock = 1000
  const answers = {}
  const lookup = fakeLookup(answers)
  const cache = createCommandCache({ resolve: lookup.resolve, missRetryMs: 500, now: () => clock })
  assert.equal(await cache.find('claude'), undefined)
  clock += 499
  assert.equal(await cache.find('claude'), undefined)
  assert.equal(lookup.calls.length, 1)
  clock += 1
  answers.claude = '/usr/bin/claude'
  assert.equal(await cache.find('claude'), '/usr/bin/claude')
  assert.equal(lookup.calls.length, 2)
})

test('concurrent lookups of one name share a single spawn; a throwing lookup reads as missing', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const cache = createCommandCache({ resolve: async () => { calls++; await gate; return '/bin/x' } })
  const all = Promise.all([cache.find('x'), cache.find('x'), cache.find('x')])
  release()
  assert.deepEqual(await all, ['/bin/x', '/bin/x', '/bin/x'])
  assert.equal(calls, 1)
  const broken = createCommandCache({ resolve: async () => { throw new Error('boom') } })
  assert.equal(await broken.find('y'), undefined)
})

test('clear() forgets every answer', async () => {
  const lookup = fakeLookup({ a: '/a' })
  const cache = createCommandCache({ resolve: lookup.resolve })
  await cache.find('a')
  cache.clear()
  await cache.find('a')
  assert.deepEqual(lookup.calls, ['a', 'a'])
})
