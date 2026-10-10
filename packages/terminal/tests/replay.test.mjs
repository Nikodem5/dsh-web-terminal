// Unit tests for the pure replay trimming helper.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trimReplay } from '../lib/replay.js'

test('text within the limit is returned unchanged', () => {
  assert.equal(trimReplay('hello', 10), 'hello')
  assert.equal(trimReplay('hello', 5), 'hello')
})

test('plain text is cut to exactly the limit', () => {
  assert.equal(trimReplay('abcdefghij', 4), 'ghij')
})

test('a cut inside a CSI sequence moves past its final byte', () => {
  const csi = '\x1b[38;2;255;100;50m'
  const text = `xx${csi}yyyy`
  // Keep 12: lands inside the CSI body.
  const keep = text.length - (2 + 4) // start at "38;2;255;..." interior
  assert.equal(trimReplay(text, keep), 'yyyy')
  // Cut exactly at the ESC keeps the whole sequence.
  assert.equal(trimReplay(text, csi.length + 4), `${csi}yyyy`)
  // Cut right after the sequence is already safe.
  assert.equal(trimReplay(text, 4), 'yyyy')
})

test('a cut inside an OSC (BEL or ST terminated) moves past the terminator', () => {
  const bel = '\x1b]0;window title\x07'
  const st = '\x1b]8;;http://example.test\x1b\\'
  assert.equal(trimReplay(`aa${bel}tail`, 4 + 8), 'tail')
  assert.equal(trimReplay(`aa${st}tail`, 4 + 10), 'tail')
})

test('a cut inside a DCS string moves past ST', () => {
  const dcs = '\x1bPq#0;2;0;0;0\x1b\\'
  assert.equal(trimReplay(`a${dcs}rest`, 4 + 6), 'rest')
})

test('a cut inside a two-character escape moves past it', () => {
  // ESC ( B  (designate charset): cut between "(" and "B".
  assert.equal(trimReplay('xx\x1b(Btail', 5), 'tail')
})

test('a sequence still open at the end of the text is kept whole', () => {
  const text = `${'a'.repeat(50)}\x1b]0;unfinished title`
  const kept = trimReplay(text, 10)
  assert.ok(kept.startsWith('\x1b]0;'))
})

test('a surrogate pair is never split', () => {
  const emoji = '\u{1F600}' // two UTF-16 units
  const text = `${emoji}${emoji}abc`
  // limit 6 cuts between the halves of the first emoji? length 7 -> start 1 = low surrogate.
  const kept = trimReplay(text, text.length - 1)
  assert.equal(kept.charCodeAt(0) >= 0xdc00 && kept.charCodeAt(0) <= 0xdfff, false)
  assert.equal(kept, `${emoji}abc`)
})

test('a sequence completed before the cut does not move it', () => {
  const text = `\x1b[0m${'a'.repeat(30)}`
  assert.equal(trimReplay(text, 10), 'a'.repeat(10))
})
