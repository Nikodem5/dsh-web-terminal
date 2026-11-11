// Overseer: Claude transcripts condensed (lib/overseer/transcript.js): what is kept, what is never
// kept (raw tool output), tail-first and incremental reads, and which paths may be read at all.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TAIL_BYTES, allowedTranscript, createCondenser, createTranscriptReader, formatEntries } from '../lib/overseer/transcript.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-wt-overseer-tr-'))
const config = join(root, 'claude')
const project = join(config, 'projects', 'C--work-api')
mkdirSync(project, { recursive: true })
after(() => rmSync(root, { recursive: true, force: true }))

const user = (content, extra = {}) => ({ type: 'user', timestamp: '2026-11-10T10:00:00Z', message: { role: 'user', content }, ...extra })
const assistant = (content, extra = {}) => ({ type: 'assistant', timestamp: '2026-11-10T10:00:01Z', message: { role: 'assistant', content }, ...extra })
const SECRET_OUTPUT = 'RAW TOOL OUTPUT 0xDEADBEEF'

const conversation = [
  { type: 'custom-title', customTitle: 'Fix caching' },
  user('<system-reminder>internal stuff</system-reminder>Please decide on the caching strategy for the api'),
  user('meta prompt', { isMeta: true }),
  assistant([{ type: 'thinking', thinking: 'private chain of thought' }, { type: 'text', text: 'I will look at the cache layer first.' }]),
  assistant([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test -- cache' } }]),
  user([{ type: 'tool_result', tool_use_id: 'tu1', content: SECRET_OUTPUT }]),
  assistant([{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: 'C:\\work\\api\\cache.ts' } }]),
  user([{ type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: SECRET_OUTPUT }] }]),
  assistant([{ type: 'tool_use', id: 'tu3', name: 'Agent', input: { subagent_type: 'Explore', description: 'find cache users', prompt: 'List every caller of the cache' } }]),
  { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'side work inside the sub-agent' }] } },
  user([{ type: 'tool_result', tool_use_id: 'tu3', content: [{ type: 'text', text: 'Found 3 callers: a.ts, b.ts, c.ts' }] }]),
  assistant([{ type: 'text', text: 'Decision: use an LRU cache with a 5 minute TTL.' }]),
  { type: 'api-request-blob', message: { content: [{ type: 'text', text: 'should never show' }] } },
]

test('the condenser keeps prompts, replies, tool one-liners and sub-agent turns; never tool output or thinking', () => {
  const c = createCondenser()
  for (const r of conversation) c.push(r)
  c.push(null)
  c.push('garbage')
  const entries = c.entries()
  const text = formatEntries(entries, 10_000).text
  assert.equal(c.title(), 'Fix caching')
  assert.ok(text.includes('USER: Please decide on the caching strategy for the api'))
  assert.ok(!text.includes('internal stuff'), 'system reminders are dropped from prompts')
  assert.ok(!text.includes('meta prompt'))
  assert.ok(text.includes('AGENT: I will look at the cache layer first.'))
  assert.ok(text.includes('TOOL: Bash: npm test -- cache'))
  assert.ok(text.includes('TOOL: Read: C:\\work\\api\\cache.ts'))
  assert.ok(text.includes('SUBAGENT: started Explore "find cache users" — List every caller of the cache'))
  assert.ok(text.includes('(sub-agent) AGENT: side work inside the sub-agent'))
  assert.ok(text.includes('SUBAGENT REPORT: Explore "find cache users": Found 3 callers'))
  assert.ok(text.includes('AGENT: Decision: use an LRU cache'))
  assert.ok(!text.includes(SECRET_OUTPUT), 'raw tool output never appears')
  assert.ok(!text.includes('private chain of thought'))
  assert.ok(!text.includes('should never show'))
})

test('long texts are capped; formatEntries keeps the newest within the limit', () => {
  const c = createCondenser()
  c.push(assistant([{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'x'.repeat(5000) } }]))
  for (let i = 0; i < 50; i++) c.push(assistant([{ type: 'text', text: `reply ${i} ${'y'.repeat(100)}` }]))
  assert.ok(c.entries()[0].text.length <= 200)
  const out = formatEntries(c.entries(), 500)
  assert.ok(out.text.length <= 500)
  assert.equal(out.truncated, true)
  assert.ok(out.text.includes('reply 49'))
  assert.ok(!out.text.includes('reply 0 '))
})

test('only .jsonl paths inside a Claude config folder may be read', async () => {
  const good = join(project, 'a.jsonl')
  writeFileSync(good, '')
  const outsideDir = join(root, 'elsewhere')
  mkdirSync(outsideDir, { recursive: true })
  const outside = join(outsideDir, 'b.jsonl')
  writeFileSync(outside, '')
  writeFileSync(join(project, 'c.txt'), '')
  assert.ok(await allowedTranscript(good, [config]))
  assert.equal(await allowedTranscript(outside, [config]), undefined)
  assert.equal(await allowedTranscript(join(project, 'c.txt'), [config]), undefined)
  assert.equal(await allowedTranscript(join(project, '..', '..', '..', 'elsewhere', 'b.jsonl'), [config]), undefined, 'dot-dot cannot escape')
  assert.equal(await allowedTranscript('relative/a.jsonl', [config]), undefined)
  assert.equal(await allowedTranscript(join(project, 'missing.jsonl'), [config]), undefined)
  assert.equal(await allowedTranscript(42, [config]), undefined)
})

test('reading is incremental: an append is read on its own, a half-written line waits', async () => {
  const file = join(project, 'inc.jsonl')
  writeFileSync(file, conversation.slice(0, 4).map((r) => JSON.stringify(r)).join('\n') + '\n')
  const reader = createTranscriptReader({ dirs: [config] })
  const first = await reader.read(file)
  assert.equal(first.partial, false)
  const n = first.entries.length
  assert.ok(n >= 2)
  // A line still being written: no newline yet.
  const line = JSON.stringify(assistant([{ type: 'text', text: 'appended reply' }]))
  appendFileSync(file, line.slice(0, 20))
  const second = await reader.read(file)
  assert.equal(second.entries.length, n, 'the half line is not parsed')
  appendFileSync(file, `${line.slice(20)}\n`)
  const third = await reader.read(file)
  assert.equal(third.entries.length, n + 1)
  assert.equal(third.entries.at(-1).text, 'appended reply')
  assert.equal(await reader.read(join(root, 'elsewhere', 'b.jsonl')), undefined, 'a path outside the config folder is refused')
})

test('a large transcript is read tail-first and flagged partial', async () => {
  const file = join(project, 'big.jsonl')
  const filler = JSON.stringify(user('old prompt '.repeat(200)))
  const lines = []
  let size = 0
  while (size < TAIL_BYTES * 1.5) {
    lines.push(filler)
    size += filler.length + 1
  }
  lines.push(JSON.stringify(user('the newest prompt')))
  writeFileSync(file, lines.join('\n') + '\n')
  const reader = createTranscriptReader({ dirs: [config] })
  // The event loop keeps turning while it parses.
  let ticks = 0
  const timer = setInterval(() => ticks++, 0)
  const result = await reader.read(file)
  clearInterval(timer)
  assert.equal(result.partial, true)
  assert.equal(result.entries.at(-1).text, 'the newest prompt')
  assert.ok(result.entries.length < lines.length, 'only the tail was read')
  assert.ok(ticks > 0, 'parsing yielded to the event loop')
})
