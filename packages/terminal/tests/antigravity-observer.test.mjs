import test from 'node:test'
import assert from 'node:assert/strict'
import { createAntigravityObserver } from '../lib/providers/antigravity.js'

const b64 = (s) => Buffer.from(s).toString('base64')
const osc = (body, end = '\x07') => `\x1b]7501;${body}${end}`
const run = (chunks) => {
  const o = createAntigravityObserver()
  return chunks.flatMap((c) => o.feed(c))
}
const ID = 'd68c6b12-644d-4dea-93aa-b1ead1117390'

test('maps every state', () => {
  const out = run([
    osc('state=idle:app=antigravity'),
    osc('state=working:app=antigravity'),
    osc(`state=blocked:kind=permission:app=antigravity:msg=${b64('Approve RunCommand: echo hi')}`),
    osc(`state=done:app=antigravity:msg=${b64('ok')}`),
    osc('state=failed:app=antigravity'),
  ])
  assert.deepEqual(out.map((s) => s.state), ['idle', 'working', 'needs-you', 'finished', 'failed'])
  assert.equal(out[2].detail, 'Approve RunCommand: echo hi')
  assert.equal(out[3].detail, 'ok')
})

test('a sequence split at every byte boundary gives one signal', () => {
  const text = `before${osc(`state=blocked:kind=permission:app=antigravity:msg=${b64('Trust this folder?')}`)}after`
  for (let i = 1; i < text.length; i++) {
    const out = run([text.slice(0, i), text.slice(i)])
    assert.equal(out.length, 1, `split at ${i}`)
    assert.equal(out[0].detail, 'Trust this folder?')
  }
})

test('ST terminator, bad base64, unknown state and garbage are tolerated', () => {
  assert.equal(run([osc('state=working:app=antigravity', '\x1b\\')])[0].state, 'working')
  assert.equal(run([osc('state=done:msg=!!!notbase64')])[0].detail, '')
  assert.deepEqual(run([osc('state=sleeping:app=antigravity'), osc('nonsense'), '\x1b]7501;\x07']), [])
})

test('an unterminated sequence over the cap is dropped', () => {
  const o = createAntigravityObserver()
  assert.deepEqual(o.feed(`\x1b]7501;state=done:msg=${'A'.repeat(70_000)}`), [])
  assert.deepEqual(o.feed(osc('state=working:app=antigravity')).map((s) => s.state), ['working'])
})

test('the exit hint is found across chunks and colour codes', () => {
  const hint = `Resume with -c (or command below):\r\nagy --conversation=${ID}\r\n`
  for (let i = 1; i < hint.length; i++) {
    assert.deepEqual(run([hint.slice(0, i), hint.slice(i)]), [{ state: 'ended', detail: '', session: ID }], `split at ${i}`)
  }
  const colored = `Resume with -c (or command below):\r\n\x1b[1magy\x1b[0m --conversation=${ID}\r\n`
  assert.equal(run([colored])[0].session, ID)
})

test('ordinary output yields nothing', () => {
  assert.deepEqual(run(['hello world\r\n', 'PS C:\\> ']), [])
})

test('an exit hint followed by an unterminated sequence in the same chunk is still found', () => {
  const o = createAntigravityObserver()
  const first = o.feed(`Resume with -c (or command below):\r\nagy --conversation=${ID}\r\n\x1b]7501;state=idle:app=antig`)
  assert.deepEqual(first, [{ state: 'ended', detail: '', session: ID }])
  // the open sequence is still completed by the next chunk
  assert.deepEqual(o.feed('ravity\x07').map((s) => s.state), ['idle'])
})

test('an exit hint with no newline after it is found when the stream ends', () => {
  const o = createAntigravityObserver()
  assert.deepEqual(o.feed(`Resume with -c (or command below):\r\n\x1b[2magy --conversation=${ID}\x1b[0m`), [])
  assert.deepEqual(o.end(), [{ state: 'ended', detail: '', session: ID }])
  assert.deepEqual(o.end(), [], 'the tail is consumed once')
})

test('end() on ordinary or empty output yields nothing', () => {
  const o = createAntigravityObserver()
  assert.deepEqual(o.end(), [])
  o.feed('Resume reading the --conversation= flag docs')
  assert.deepEqual(o.end(), [])
})
