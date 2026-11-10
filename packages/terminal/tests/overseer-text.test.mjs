// Overseer: raw terminal output -> plain text (lib/overseer/text.js).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RAW_WINDOW, reduceNoise, scrollbackText, terminalLines } from '../lib/overseer/text.js'

test('colours, titles, hyperlinks and modes are stripped; text stays', () => {
  const raw = '\x1b]0;my title\x07\x1b[?25l\x1b[1;32mgreen\x1b[0m and \x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\ \x1b(Bplain\r\n'
  assert.deepEqual(terminalLines(raw), ['green and link plain'])
})

test('carriage return overwrites: a progress bar keeps its last state', () => {
  assert.deepEqual(terminalLines('downloading 10%\rdownloading 55%\rdownloading 100%\r\ndone\r\n'), ['downloading 100%', 'done'])
  // A shorter overwrite keeps the tail of the longer line, as a terminal shows it, unless the line is erased.
  assert.deepEqual(terminalLines('abcdef\rXY\n'), ['XYcdef'])
  assert.deepEqual(terminalLines('abcdef\r\x1b[KXY\n'), ['XY'])
  assert.deepEqual(terminalLines('abc\b\bZ\n'), ['aZc'])
})

test('cursor jumps and clears start new lines; erase-line drops the old text', () => {
  assert.deepEqual(terminalLines('one\x1b[2;1Htwo\x1b[1Athree'), ['one', 'two', 'three'])
  assert.deepEqual(terminalLines('old text\x1b[2Knew text\n'), ['new text'])
  assert.deepEqual(terminalLines('a\x1b[2Jb\n'), ['a', 'b'])
})

test('C1 controls and lone escapes do not leak; surrogate pairs survive', () => {
  assert.deepEqual(terminalLines('x\x07y\x00z \u{1F600}\x1b=\n'), ['xyz \u{1F600}'])
})

test('redraw noise: repeated frame lines keep only their latest copy, decoration and blank runs go', () => {
  const frame = ['╭────╮', '│ > prompt │', '╰────╯', '✻ Thinking…', '', '']
  const lines = ['$ claude', ...frame, ...frame, ...frame, 'Done: wrote file']
  const out = reduceNoise(lines)
  assert.equal(out.filter((l) => l === '✻ Thinking…').length, 1)
  assert.equal(out.filter((l) => l === '│ > prompt │').length, 1)
  assert.ok(!out.includes('╭────╮'), 'pure box drawing is dropped')
  assert.equal(out.at(-1), 'Done: wrote file')
  assert.ok(!out.some((l, i) => l === '' && out[i + 1] === ''), 'no blank runs')
})

test('scrollbackText keeps the newest lines within the cap and says when it cut', () => {
  const raw = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\r\n')
  const small = scrollbackText(raw, 100)
  assert.ok(small.text.length <= 100)
  assert.ok(small.text.endsWith('line 499'))
  assert.equal(small.truncated, true)
  const all = scrollbackText('hello\r\nworld\r\n', 1000)
  assert.deepEqual(all, { text: 'hello\nworld', truncated: false })
  assert.deepEqual(scrollbackText('', 100), { text: '', truncated: false })
})

test('only the end of a huge replay is read, starting at a line boundary', () => {
  const raw = `${'\x1b[31m'.repeat(10)}${'x'.repeat(RAW_WINDOW)}\nnewest line\n`
  const out = scrollbackText(raw, 50)
  assert.equal(out.text, 'newest line')
  assert.equal(out.truncated, true)
})
