// Git status in the header: the porcelain parser, the host-side scheduler (fake git runner, so no
// repository is needed), a run against real git, and the client's half.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitHeader, parseStatus, STATUS_ARGS, usableCwd } from '../lib/git-header.js'
import { FakeWebSocket, loadStore, quiesceStores, window } from './helpers/load-store.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, what, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await sleep(5)
  }
  assert.fail(`timed out waiting for ${what}`)
}

// ── parser ──

test('parseStatus: branch, clean or dirty, detached, no commits yet', () => {
  assert.deepEqual(parseStatus('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n'), { branch: 'main', dirty: false })
  assert.deepEqual(parseStatus('# branch.oid abc\n# branch.head main\n1 .M N... 100644 100644 100644 a b src/x.js\n'), { branch: 'main', dirty: true })
  assert.equal(parseStatus('# branch.head main\n? new.txt\n').dirty, true, 'untracked counts')
  assert.equal(parseStatus('# branch.head main\nu UU N... 1 2 3 4 a b c f\n').dirty, true)
  assert.equal(parseStatus('# branch.head main\n2 R. N... 1 2 3 4 5 R100 new\told\n').dirty, true)
  assert.deepEqual(parseStatus('# branch.oid 0123456789abcdef\n# branch.head (detached)\n'), { branch: '0123456', dirty: false, detached: true })
  assert.deepEqual(parseStatus('# branch.oid (initial)\n# branch.head main\n'), { branch: 'main', dirty: false })
  assert.equal(parseStatus(''), undefined)
  assert.equal(parseStatus('fatal: not a git repository'), undefined)
})

test('the status call does not take git locks or run the fsmonitor hook', () => {
  assert.ok(STATUS_ARGS.includes('--no-optional-locks'))
  assert.ok(STATUS_ARGS.includes('core.fsmonitor=false'))
})

test('usableCwd accepts only an absolute, plain, bounded path', () => {
  assert.equal(usableCwd(process.cwd()), true)
  assert.equal(usableCwd('relative/dir'), false)
  assert.equal(usableCwd(''), false)
  assert.equal(usableCwd(42), false)
  assert.equal(usableCwd(`${process.cwd()}\0x`), false)
  assert.equal(usableCwd(join(process.cwd(), 'a'.repeat(2000))), false)
})

// ── scheduler ──

const ABS = process.cwd()

/** A header wired to a scripted git: `answers` maps a folder to what git prints for it. */
function rig(opts = {}) {
  const sent = []
  const calls = []
  const answers = new Map()
  let inflight = 0
  let peak = 0
  const header = createGitHeader({
    which: opts.which ?? (async () => 'git'),
    send: (session, frame) => sent.push({ session, frame }),
    attached: (session) => session.attached !== false,
    run: async (file, args, { cwd }) => {
      calls.push({ file, args, cwd })
      inflight++
      peak = Math.max(peak, inflight)
      await (opts.delay ? sleep(opts.delay) : Promise.resolve())
      inflight--
      const answer = answers.get(cwd)
      return answer === undefined ? { code: 128, stdout: '' } : { code: 0, stdout: typeof answer === 'function' ? answer() : answer }
    },
    minGapMs: 15,
    intervalMs: opts.intervalMs ?? 3_600_000,
    missingRetryMs: opts.missingRetryMs ?? 60_000,
    ...opts.config,
  })
  return { header, sent, calls, answers, get peak() { return peak } }
}
const session = (over = {}) => ({ shellId: 'default', cwd: ABS, exited: false, ws: {}, ...over })
const frames = (r) => r.sent.map((s) => s.frame.git)

test('a request runs git once in the folder and sends the branch', async () => {
  const r = rig()
  r.answers.set(ABS, '# branch.oid a\n# branch.head main\n')
  const s = session()
  r.header.request(s)
  await until(() => r.sent.length === 1, 'the frame')
  assert.deepEqual(frames(r), [{ branch: 'main', dirty: false }])
  assert.equal(r.sent[0].frame.type, 'git')
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].cwd, ABS)
  r.header.dispose()
})

test('an unchanged answer is not sent again, a changed one is', async () => {
  const r = rig()
  let dirty = false
  r.answers.set(ABS, () => `# branch.head main\n${dirty ? '? x\n' : ''}`)
  const s = session()
  r.header.request(s)
  await until(() => r.sent.length === 1, 'first frame')
  r.header.request(s)
  await until(() => r.calls.length === 2, 'second run')
  await sleep(30)
  assert.equal(r.sent.length, 1, 'same answer: nothing to send')
  dirty = true
  r.header.request(s)
  await until(() => r.sent.length === 2, 'changed frame')
  assert.equal(frames(r)[1].dirty, true)
  r.header.dispose()
})

test('a burst of requests becomes one run now and one trailing run, never one git per request', async () => {
  const r = rig({ delay: 5 })
  r.answers.set(ABS, '# branch.head main\n')
  const s = session()
  for (let i = 0; i < 50; i++) r.header.request(s)
  await until(() => r.calls.length >= 2, 'the trailing run')
  await sleep(60)
  assert.equal(r.calls.length, 2)
  r.header.dispose()
})

test('the folder the shell reports is used, and a folder change while git runs is re-checked', async () => {
  const r = rig({ delay: 20 })
  const other = join(ABS, 'sub')
  r.answers.set(ABS, '# branch.head main\n')
  r.answers.set(other, '# branch.head feature/x\n')
  const s = session()
  r.header.request(s)
  r.header.request(s, other)
  await until(() => frames(r).some((g) => g?.branch === 'feature/x'), 'the new folder')
  assert.deepEqual(frames(r).at(-1), { branch: 'feature/x', dirty: false })
  assert.equal(r.calls.at(-1).cwd, other)
  r.header.dispose()
})

test('a folder that is not a repository sends null, and leaving a repository clears the branch', async () => {
  const r = rig()
  const repo = join(ABS, 'repo')
  r.answers.set(repo, '# branch.head main\n')
  const s = session({ cwd: repo })
  r.header.request(s)
  await until(() => r.sent.length === 1, 'repo frame')
  r.header.request(s, join(ABS, 'plain'))
  await until(() => r.sent.length === 2, 'null frame')
  assert.equal(frames(r)[1], null)
  r.header.dispose()
})

test('ssh, exited and relative-folder terminals are never looked at', async () => {
  const r = rig()
  r.answers.set(ABS, '# branch.head main\n')
  r.header.request(session({ shellId: 'ssh' }))
  r.header.attach(session({ shellId: 'ssh' }))
  r.header.signal(session({ shellId: 'ssh' }), 'finished')
  r.header.request(session({ exited: true }))
  r.header.request(session({ cwd: 'relative' }))
  await sleep(60)
  assert.equal(r.calls.length, 0)
  assert.equal(r.sent.length, 0)
  r.header.dispose()
})

test('a request with a bad folder from the browser is ignored, the start folder stays', async () => {
  const r = rig()
  r.answers.set(ABS, '# branch.head main\n')
  const s = session()
  r.header.request(s, 'relative/evil')
  r.header.request(s, `${ABS}\0`)
  r.header.request(s, 7)
  await until(() => r.calls.length >= 1, 'a run')
  assert.ok(r.calls.every((c) => c.cwd === ABS))
  r.header.dispose()
})

test('a working agent does not trigger a look; a quiet one does', async () => {
  const r = rig()
  r.answers.set(ABS, '# branch.head main\n')
  const s = session()
  r.header.signal(s, 'working')
  r.header.signal(s, 'needs-you')
  await sleep(40)
  assert.equal(r.calls.length, 0)
  for (const state of ['finished', 'idle', 'failed', 'ended']) {
    r.header.signal(s, state)
    await until(() => r.calls.length >= 1, `a run for ${state}`)
    r.calls.length = 0
    await sleep(25)
  }
  r.header.dispose()
})

test('attach repeats the last answer at once, then looks again', async () => {
  const r = rig()
  r.answers.set(ABS, '# branch.head main\n')
  const s = session()
  r.header.attach(s)
  await until(() => r.sent.length === 1, 'first')
  r.header.attach(s)
  assert.equal(r.sent.length, 2, 'the cached answer is sent synchronously for the new page')
  r.header.dispose()
})

test('git missing: null is sent, nothing is spawned, and the lookup is retried only after a while', async () => {
  let looked = 0
  const r = rig({ which: async () => { looked++; return undefined }, missingRetryMs: 60_000 })
  const s = session()
  r.header.request(s)
  await until(() => r.sent.length === 1, 'the null frame')
  assert.equal(frames(r)[0], null)
  r.header.request(s)
  r.header.request(s)
  await sleep(60)
  assert.equal(looked, 1, 'not looked up again within the retry window')
  assert.equal(r.calls.length, 0)
  r.header.dispose()
})

test('git missing at first, found later: the retry window lets it work once git is installed', async () => {
  let path
  const r = rig({ which: async () => path, missingRetryMs: 1 })
  r.answers.set(ABS, '# branch.head main\n')
  const s = session()
  r.header.request(s)
  await until(() => r.sent.length === 1, 'null')
  path = 'git'
  await sleep(5)
  r.header.request(s)
  await until(() => r.sent.length === 2, 'branch after install')
  assert.deepEqual(frames(r)[1], { branch: 'main', dirty: false })
  r.header.dispose()
})

test('at most maxConcurrent git processes at a time across terminals', async () => {
  const r = rig({ delay: 25, config: { maxConcurrent: 2, minGapMs: 1 } })
  const sessions = []
  for (let i = 0; i < 8; i++) {
    const cwd = join(ABS, `d${i}`)
    r.answers.set(cwd, `# branch.head b${i}\n`)
    const s = session({ cwd })
    sessions.push(s)
    r.header.request(s)
  }
  await until(() => r.sent.length === 8, 'all frames', 30000)
  assert.equal(r.peak, 2)
  r.header.dispose()
})

test('the slow interval refreshes attached terminals only, and forget stops everything for a terminal', async () => {
  const r = rig({ intervalMs: 20 })
  r.answers.set(ABS, '# branch.head main\n')
  const attached = session()
  const detached = session({ attached: false, cwd: join(ABS, 'other') })
  r.header.request(attached)
  r.header.request(detached)
  await until(() => r.calls.length >= 4, 'interval runs for the attached one')
  assert.ok(r.calls.filter((c) => c.cwd === detached.cwd).length <= 1, 'detached: only its first run')
  assert.equal(r.header.size, 2)
  r.header.forget(attached)
  r.header.forget(detached)
  assert.equal(r.header.size, 0)
  const settled = r.calls.length
  await sleep(120)
  assert.ok(r.calls.length - settled <= 1, 'nothing more after forget (at most a run already in flight)')
  r.header.dispose()
})

test('dispose stops the interval and pending trailing timers', async () => {
  const r = rig({ intervalMs: 10 })
  r.answers.set(ABS, '# branch.head main\n')
  const s = session()
  r.header.request(s)
  r.header.request(s)
  await until(() => r.calls.length >= 1, 'a run')
  r.header.dispose()
  const settled = r.calls.length
  await sleep(80)
  assert.ok(r.calls.length - settled <= 1)
  r.header.request(s)
  await sleep(40)
  assert.ok(r.calls.length - settled <= 1, 'a disposed header ignores requests')
})

// ── real git ──

let gitOk = true
try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitOk = false }
const root = mkdtempSync(join(tmpdir(), 'dsh-wt-git-'))
after(() => rmSync(root, { recursive: true, force: true }))

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
}

/** Ask a real header about one folder and wait for its answer. */
async function realAnswer(cwd) {
  const sent = []
  const header = createGitHeader({ which: async () => 'git', send: (_s, f) => sent.push(f.git), attached: () => true, minGapMs: 1 })
  header.request({ shellId: 'default', cwd, exited: false })
  await until(() => sent.length >= 1, 'a real answer', 30000)
  header.dispose()
  return sent[0]
}

test('real git: branch, clean then dirty, a non-repository, a missing folder', { skip: !gitOk }, async () => {
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'trunk')
  writeFileSync(join(repo, 'a.txt'), 'a')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  assert.deepEqual(await realAnswer(repo), { branch: 'trunk', dirty: false })
  writeFileSync(join(repo, 'b.txt'), 'untracked')
  assert.deepEqual(await realAnswer(repo), { branch: 'trunk', dirty: true })
  git(repo, 'checkout', '-q', '--detach')
  const detached = await realAnswer(repo)
  assert.equal(detached.detached, true)
  assert.match(detached.branch, /^[0-9a-f]{7}$/)
  const plain = join(root, 'plain')
  mkdirSync(plain)
  assert.equal(await realAnswer(plain), null)
  assert.equal(await realAnswer(join(root, 'missing')), null)
})

// ── client half ──

let s
before(async () => {
  s = await loadStore()
})
after(() => {
  quiesceStores()
  s?.closeAll()
  window.close()
})

function runtime(over = {}) {
  return { id: 'w1', ssh: false, git: undefined, cwd: undefined, socket: null, blocks: undefined, ...over }
}

test('applyGit takes a valid answer, treats null or junk as "no repository", and ignores ssh windows', () => {
  const rt = runtime()
  s.applyGit(rt, { branch: 'main', dirty: true })
  assert.deepEqual(rt.git, { branch: 'main', dirty: true })
  s.applyGit(rt, { branch: 'abc1234', dirty: false, detached: true })
  assert.deepEqual(rt.git, { branch: 'abc1234', dirty: false, detached: true })
  s.applyGit(rt, null)
  assert.equal(rt.git, undefined)
  s.applyGit(rt, { branch: '', dirty: true })
  assert.equal(rt.git, undefined)
  s.applyGit(rt, 'junk')
  assert.equal(rt.git, undefined)
  const remote = runtime({ ssh: true })
  s.applyGit(remote, { branch: 'main', dirty: false })
  assert.equal(remote.git, undefined)
})

test('gitLabel: dirty marker, long names are cut with the full name in the tooltip, nothing without a repository', () => {
  assert.equal(s.gitLabel(undefined), undefined)
  assert.equal(s.gitLabel({ branch: 'main', dirty: false }).text, '⎇ main')
  assert.equal(s.gitLabel({ branch: 'main', dirty: true }).text, '⎇ main ●')
  const long = 'feature/' + 'x'.repeat(60)
  const label = s.gitLabel({ branch: long, dirty: false })
  assert.ok(label.text.length <= 2 + s.BRANCH_SHOWN)
  assert.ok(label.text.endsWith('…'))
  assert.ok(label.title.includes(long))
  assert.match(s.gitLabel({ branch: 'abc1234', dirty: false, detached: true }).title, /Detached HEAD/)
})

test('requestGit sends the shell folder over an open socket, never for ssh or a closed socket', () => {
  const sent = []
  const open = { readyState: 1, send: (d) => sent.push(JSON.parse(d)) }
  s.requestGit(runtime({ socket: open, cwd: 'C:\\repo' }))
  assert.deepEqual(sent, [{ type: 'git-refresh', cwd: 'C:\\repo' }])
  s.requestGit(runtime({ socket: open, ssh: true }))
  s.requestGit(runtime({ socket: { readyState: 3, send: () => assert.fail('closed') } }))
  s.requestGit(runtime())
  assert.equal(sent.length, 1)
})

test('through a real runtime: attach asks, a git frame shows, a finished command at a new prompt asks again, ssh never asks', async () => {
  FakeWebSocket.reset()
  s.closeAll()
  const id = s.openTerminal({ cwd: 'C:\\work' })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  const sock = await until(() => FakeWebSocket.last, 'socket')
  sock.push({ type: 'attached', created: true, replay: '', exited: false, exitCode: null, agent: null })
  await until(() => sock.sent.some((f) => f.type === 'git-refresh'), 'the attach request')
  sock.push({ type: 'git', git: { branch: 'main', dirty: true } })
  assert.deepEqual(rt.git, { branch: 'main', dirty: true })
  sock.push({ type: 'git', git: null })
  assert.equal(rt.git, undefined)
  // A command ran and a new prompt appeared (shell integration marks).
  const before = sock.sent.filter((f) => f.type === 'git-refresh').length
  const mark = (code, data) => sock.push({ type: 'data', data: `\x1b]${code};${data}\x07` })
  mark(633, 'P;Cwd=C:\\work')
  mark(133, 'A')
  mark(133, 'B')
  mark(133, 'C')
  mark(133, 'D;0')
  mark(633, 'P;Cwd=C:\\work\\sub')
  mark(133, 'A')
  await until(() => rt.term.buffer.active !== undefined && sock.sent.filter((f) => f.type === 'git-refresh').length > before, 'a request after the command')
  const asked = sock.sent.filter((f) => f.type === 'git-refresh').at(-1)
  assert.equal(asked.cwd, 'C:\\work\\sub')
  s.disposeRuntime(id, false)

  FakeWebSocket.reset()
  const remoteId = s.openTerminal({ ssh: { host: 'example' } })
  const remote = s.ensureRuntime(s.getWins().find((w) => w.id === remoteId))
  const remoteSock = await until(() => FakeWebSocket.last, 'ssh socket')
  remoteSock.push({ type: 'attached', created: true, replay: '', exited: false, exitCode: null, agent: null })
  await until(() => remote.conn === 'live', 'ssh live')
  assert.equal(remoteSock.sent.some((f) => f.type === 'git-refresh'), false)
  remoteSock.push({ type: 'git', git: { branch: 'main', dirty: false } })
  assert.equal(remote.git, undefined)
  s.disposeRuntime(remoteId, false)
})
