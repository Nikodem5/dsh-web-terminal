// Overseer panel logic (src/client/overseer-state.ts, overseer-markdown.ts): safe answer parsing,
// SSE parsing, the terminal payload (hidden excluded), streaming with a fake host, Stop, the notice
// gate, citations focusing a terminal, and the shortcut entry.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { FakeWebSocket, window } from './helpers/load-store.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let s

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './src/client/terminal-store.ts'; export * from './src/client/overseer-state.ts'; export * from './src/client/overseer-markdown.ts'",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  })
  s = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
})
after(() => {
  s.closeAll()
  window.close()
})
beforeEach(() => {
  s.closeAll()
  s.runtimes.clear()
  window.localStorage.clear()
  FakeWebSocket.reset()
  s.resetOverseer()
})

/** A fetch that answers the ask route with the given SSE chunks (optionally waiting on `gate` before the rest). */
function fakeHost({ chunks = [], json, gate } = {}) {
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined })
    if (String(url).endsWith('/hidden')) return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ ok: true, hidden: requests.at(-1).body?.hidden ? [requests.at(-1).body.id] : [] }) }
    if (json !== undefined) return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => json }
    const enc = new TextEncoder()
    const body = new ReadableStream({
      async start(controller) {
        const signal = init.signal
        const abort = () => controller.error(new DOMException('aborted', 'AbortError'))
        signal?.addEventListener('abort', abort, { once: true })
        for (const [i, chunk] of chunks.entries()) {
          if (gate !== undefined && i === 1) await gate
          if (signal?.aborted) return
          controller.enqueue(enc.encode(chunk))
        }
        if (!signal?.aborted) controller.close()
      },
    })
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body }
  }
  return requests
}
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

test('parseAnswer: light markdown and citations, and no HTML ever becomes markup', () => {
  const blocks = s.parseAnswer('**[T3] "api"** is waiting.\n\n- runs `npm test`\n- see [T1, T2]\n\n```\n<script>alert(1)</script>\n```\n<img src=x onerror=alert(1)>')
  assert.equal(blocks[0].type, 'para')
  assert.deepEqual(blocks[0].inlines[0], { type: 'cite', num: 3 })
  assert.deepEqual(blocks[1].items[0][1], { type: 'code', text: 'npm test' })
  assert.deepEqual(blocks[1].items[1].filter((x) => x.type === 'cite').map((x) => x.num), [1, 2])
  assert.deepEqual(blocks[2], { type: 'code', text: '<script>alert(1)</script>' })
  assert.deepEqual(blocks[3].inlines, [{ type: 'text', text: '<img src=x onerror=alert(1)>' }], 'HTML stays plain text')
  const all = JSON.stringify(blocks)
  assert.ok(!/"type":"(html|raw)"/.test(all))
  // A streaming answer with an open fence still parses.
  assert.equal(s.parseAnswer('```\npartial').at(-1).type, 'code')
})

test('parseSse: complete events and the unfinished rest', () => {
  const { events, rest } = s.parseSse(`${sse('meta', { a: 1 })}${sse('delta', { text: 'hi' })}event: delta\ndata: {"te`)
  assert.deepEqual(events, [{ event: 'meta', data: { a: 1 } }, { event: 'delta', data: { text: 'hi' } }])
  assert.equal(rest, 'event: delta\ndata: {"te')
})

test('the terminal payload numbers terminals as listed and leaves hidden ones out', async () => {
  // Newest first in the list: web is T1, api is T2.
  const a = s.openTerminal({ cwd: 'C:\\work\\api', title: 'api' })
  const b = s.openTerminal({ cwd: 'C:\\work\\web', title: 'web' })
  fakeHost()
  await s.setHiddenFromOverseer(a, true)
  const payload = s.terminalPayload()
  assert.deepEqual(payload.map((t) => t.num), [1])
  assert.equal(payload[0].id, `${b}-0`)
  assert.equal(payload[0].name, 'web')
  assert.ok(s.isHiddenFromOverseer(a))
  assert.deepEqual(JSON.parse(window.localStorage.getItem(s.K_OVERSEER)).hidden, [a], 'persisted')
})

test('a question streams into a turn; follow-ups send history; citations focus the terminal', async () => {
  s.openTerminal({ cwd: 'C:\\work\\web', title: 'web' })
  const a = s.openTerminal({ cwd: 'C:\\work\\api', title: 'api' })
  const requests = fakeHost({ chunks: [sse('meta', { model: { provider: 'p', model: 'm' }, truncated: true, sections: [{ num: 2, depth: 'omitted' }] }), sse('delta', { text: '[T1] is ' }), sse('delta', { text: 'testing.' }), sse('done', { reason: 'stop' })] })
  assert.equal(await s.askOverseer('what is T1 doing?'), undefined, 'nothing is sent before the notice is accepted')
  assert.equal(requests.length, 0)
  s.acceptOverseerNotice()
  const turn = await s.askOverseer('what is T1 doing?')
  assert.equal(turn.status, 'done')
  assert.equal(turn.answer, '[T1] is testing.')
  assert.equal(turn.model, 'p / m')
  assert.equal(turn.truncated, true)
  assert.deepEqual(turn.omitted, [2])
  const ask = requests.at(-1)
  assert.equal(ask.url, s.ASK_URL)
  assert.equal(ask.init.method, 'POST')
  assert.deepEqual(ask.body.terminals.map((t) => t.num), [1, 2])
  assert.equal(ask.body.selected, null)
  // A follow-up carries the earlier turn and the picker's choice.
  s.setOverseerSelection([a])
  await s.askOverseer('and now?')
  assert.deepEqual(requests.at(-1).body.history, [{ question: 'what is T1 doing?', answer: '[T1] is testing.' }])
  assert.deepEqual(requests.at(-1).body.selected, [1])
  // Clicking T1 focuses that window.
  assert.equal(s.focusCited(turn, 1), true)
  assert.equal(s.getFocusId(), a)
  assert.equal(s.focusCited(turn, 9), false)
  s.clearOverseer()
  assert.equal(s.overseer.turns.length, 0)
})

test('Stop ends a streaming answer and keeps what arrived', async () => {
  s.openTerminal({ cwd: 'C:\\work' })
  s.acceptOverseerNotice()
  let release
  const gate = new Promise((r) => { release = r })
  fakeHost({ chunks: [sse('delta', { text: 'partial ' }), sse('delta', { text: 'never' })], gate })
  const pending = s.askOverseer('long?')
  const start = Date.now()
  while (s.overseer.turns.at(-1)?.answer !== 'partial ' && Date.now() - start < 10000) await new Promise((r) => setTimeout(r, 5))
  assert.equal(s.overseer.busy, true)
  s.stopOverseer()
  release()
  const turn = await pending
  assert.equal(turn.status, 'stopped')
  assert.equal(turn.answer, 'partial ')
  assert.equal(s.overseer.busy, false)
})

test('no model service / no default model / model error are distinct states', async () => {
  s.acceptOverseerNotice()
  fakeHost({ json: { ok: false, code: 'no-llm', error: 'No model service' } })
  assert.equal((await s.askOverseer('q')).code, 'no-llm')
  fakeHost({ json: { ok: false, code: 'no-model', error: 'No default model' } })
  assert.equal((await s.askOverseer('q')).code, 'no-model')
  fakeHost({ chunks: [sse('error', { code: 'model-error', error: 'rate limited' }), sse('done', { reason: 'error' })] })
  const t = await s.askOverseer('q')
  assert.equal(t.status, 'error')
  assert.equal(t.error, 'rate limited')
  globalThis.fetch = async () => { throw new TypeError('network down') }
  assert.equal((await s.askOverseer('q')).code, 'network')
})

test('the panel switch persists; the shortcut is a registry chord', () => {
  s.hydrateOverseer()
  s.setOverseerOpen(true)
  assert.equal(JSON.parse(window.localStorage.getItem(s.K_OVERSEER)).open, true)
  const sc = s.SHORTCUTS.find((x) => x.id === 'overseer')
  assert.equal(s.formatShortcut(sc, false), 'Ctrl+Shift+O')
  assert.equal(s.matchShortcut('overseer', { key: 'O', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }), true)
})
