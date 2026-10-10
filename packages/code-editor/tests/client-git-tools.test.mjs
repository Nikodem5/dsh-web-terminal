// Client state of the git tools (git-tools.ts through EditorStore): commit box, confirm gates, error display,
// branch picker, sync, history, read-only history diffs.
//
//   node --test tests/client-git-tools.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/client/api.ts'
import { EditorStore } from '../src/client/store.ts'
import { relativeDate, subjectTooLong } from '../src/client/git-tools.ts'
import { FakeHost, FakeSocket, MemoryStorage, gitFile, makeApi, until } from './helpers/fake.mjs'

const BRANCHES = {
  current: 'main', detached: false, head: null, upstream: 'origin/main', upstreamRemote: 'origin', ahead: 2, behind: 1, remotes: ['origin'],
  local: [{ name: 'main', hash: 'a', upstream: 'origin/main', upstreamRemote: 'origin', current: true }, { name: 'dev', hash: 'b', upstream: null, upstreamRemote: null, current: false }],
  remote: [{ name: 'origin/topic', remote: 'origin', short: 'topic', hash: 'c', local: false }],
}

/** makeApi plus the git tool routes, scripted through `script`. */
function toolsApi(o = {}) {
  const api = makeApi(o)
  const script = { branches: structuredClone(BRANCHES), last: { hash: 'h1', message: 'old message', hasUpstream: true, pushed: false }, fail: {}, commits: [], ...o.script }
  const log = (...c) => api.calls.push(c)
  const maybeFail = (name) => { const e = script.fail[name]; if (e) { delete script.fail[name]; throw e } }
  Object.assign(api, {
    script,
    async gitCommit(root, opts) { log('gitCommit', root, opts); maybeFail('commit'); return { hash: 'abcdef1234567', summary: opts.message.split('\n')[0] } },
    async gitLastCommit(root) { log('gitLastCommit', root); maybeFail('last'); return script.last },
    async gitBranches(root) { log('gitBranches', root); maybeFail('branches'); return structuredClone(script.branches) },
    async gitCheckout(root, branch, create) { log('gitCheckout', root, branch, create); maybeFail('checkout'); return { branch: branch.replace(/^origin\//, '') } },
    async gitLog(root, opts) { log('gitLog', root, opts); maybeFail('log'); const all = script.commits; return { commits: all.slice(opts.skip, opts.skip + opts.limit), hasMore: all.length > opts.skip + opts.limit } },
    async gitCommitInfo(root, hash) { log('gitCommitInfo', root, hash); return { hash, author: 'A', email: 'a@x', date: 0, message: 'subject\n\nbody', parent: null, files: script.files ?? [{ status: 'M', path: 'src/b.ts' }, { status: 'R', path: 'n.txt', origPath: 'o.txt' }], truncated: false } },
    async gitShow(root, hash, path, origPath) { log('gitShow', root, hash, path, origPath); maybeFail('show'); return script.show ?? { original: 'OLD', modified: 'NEW', binary: false, tooLarge: false } },
    async gitFetch(root) { log('gitFetch', root); maybeFail('fetch'); return { summary: 'fetched' } },
    async gitPull(root) { log('gitPull', root); maybeFail('pull'); return { summary: 'pulled' } },
    async gitPush(root, remote) { log('gitPush', root, remote); maybeFail('push'); return { summary: 'pushed', setUpstream: remote !== undefined, remote: remote ?? null, branch: 'main' } },
  })
  return api
}

async function setup(o = {}) {
  FakeSocket.reset()
  const api = toolsApi(o)
  const confirms = []
  const answers = o.answers ?? []
  const store = new EditorStore({
    api, storage: new MemoryStorage(), Socket: FakeSocket, gitDelayMs: 1, wsDelay: () => 5, selectPanel: () => {},
    confirm: (m) => { confirms.push(m); return answers.length > 0 ? answers.shift() : true },
  })
  store.attachHost(new FakeHost())
  await store.setWorkspaces(o.workspaces ?? ['/w/proj'])
  await until(() => store.getState().git.status !== null || store.getState().repos.list !== null, 'git status')
  return { api, store, tools: store.gitTools, confirms, answers }
}
const calls = (api, name) => api.calls.filter((c) => c[0] === name)
const mk = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ hash: String(i).padStart(40, 'a'), short: `a${i}`, author: 'A', email: 'a@x', date: 1, subject: `c${i}`, refs: [], ...extra }))

test('helpers: relativeDate and subjectTooLong', () => {
  const now = 1_000_000_000_000
  assert.equal(relativeDate(now - 5_000, now), 'just now')
  assert.equal(relativeDate(now - 90_000, now), '2 minutes ago')
  assert.equal(relativeDate(now - 3 * 3600_000, now), '3 hours ago')
  assert.equal(relativeDate(now - 86400_000, now), '1 day ago')
  assert.match(relativeDate(now - 90 * 86400_000, now), /^\d{4}-\d\d-\d\d$/)
  assert.equal(subjectTooLong('x'.repeat(72)), false)
  assert.equal(subjectTooLong(`${'x'.repeat(73)}\nshort`), true)
  assert.equal(subjectTooLong(`short\n${'x'.repeat(200)}`), false)
})

test('commit: empty message and nothing to commit are refused locally, without calling the host', async () => {
  const { api, tools } = await setup()
  assert.equal(await tools.commit(''), false)
  assert.match(tools.draft('').error, /message/)
  tools.setMessage('', 'hello')
  assert.equal(tools.draft('').error, null, 'typing clears the error')
  assert.equal(await tools.commit(''), false)
  assert.match(tools.draft('').error, /Nothing to commit/)
  assert.equal(calls(api, 'gitCommit').length, 0)
})

test('commit: staged files commit without a confirm; the draft resets, status refreshes, a notice is shown', async () => {
  const status = { branch: 'main', ahead: 0, behind: 0, files: [gitFile('s.ts', { index: 'A', worktree: ' ', staged: true, unstaged: false })] }
  const { api, store, tools, confirms } = await setup({ status })
  tools.setMessage('', 'feat: add s\n\nlong body')
  const before = calls(api, 'gitStatus').length
  assert.equal(await tools.commit(''), true)
  assert.deepEqual(calls(api, 'gitCommit')[0], ['gitCommit', '/w/proj', { message: 'feat: add s\n\nlong body', amend: false, all: false }])
  assert.equal(confirms.length, 0)
  assert.deepEqual([tools.draft('').message, tools.draft('').busy, tools.draft('').error], ['', false, null])
  assert.ok(calls(api, 'gitStatus').length > before, 'CHANGES is refreshed')
  assert.match(store.getState().notice.text, /Committed abcdef1: feat: add s/)
})

test('commit: nothing staged but tracked changes -> confirm gate, then git commit -a; declining does nothing', async () => {
  const status = { branch: 'main', ahead: 0, behind: 0, files: [gitFile('a.txt'), gitFile('b.txt'), gitFile('new.txt', { index: '?', worktree: '?', untracked: true, unstaged: false })] }
  const { api, tools, confirms, answers } = await setup({ status, answers: [false, true] })
  tools.setMessage('', 'all of it')
  assert.equal(await tools.commit(''), false)
  assert.equal(confirms.length, 1)
  assert.match(confirms[0], /Nothing is staged/)
  assert.match(confirms[0], /2 modified tracked files/)
  assert.match(confirms[0], /Untracked files are not included/)
  assert.equal(calls(api, 'gitCommit').length, 0)
  assert.equal(tools.draft('').message, 'all of it', 'the message survives a declined confirm')
  assert.equal(await tools.commit(''), true)
  assert.equal(calls(api, 'gitCommit')[0][2].all, true)
})

test('commit: host errors (hook, identity) are shown in the box and the message is kept', async () => {
  const status = { branch: 'main', ahead: 0, behind: 0, files: [gitFile('s.ts', { index: 'M', worktree: ' ', staged: true, unstaged: false })] }
  const { api, tools } = await setup({ status })
  api.script.fail.commit = new ApiError('hook says no', 500, 'git')
  tools.setMessage('', 'blocked')
  assert.equal(await tools.commit(''), false)
  assert.equal(tools.draft('').error, 'hook says no')
  assert.equal(tools.draft('').message, 'blocked')
  assert.equal(tools.draft('').busy, false)
  api.script.fail.commit = new ApiError('Git does not know who you are. Run: git config --global user.name', 409, 'identity')
  assert.equal(await tools.commit(''), false)
  assert.match(tools.draft('').error, /user\.name/)
})

test('commit: a second commit while one is running is ignored', async () => {
  const status = { branch: 'main', ahead: 0, behind: 0, files: [gitFile('s.ts', { index: 'M', worktree: ' ', staged: true, unstaged: false })] }
  const { api, tools } = await setup({ status })
  let release
  api.gitCommit = (root, opts) => { api.calls.push(['gitCommit', root, opts]); return new Promise((r) => { release = () => r({ hash: 'a'.repeat(40), summary: 's' }) }) }
  tools.setMessage('', 'slow')
  const first = tools.commit('')
  assert.equal(tools.draft('').busy, true)
  assert.equal(await tools.commit(''), false)
  release()
  assert.equal(await first, true)
  assert.equal(calls(api, 'gitCommit').length, 1)
})

test('amend: checking prefills the last message; unchecking removes an untouched prefill; no commits -> error', async () => {
  const { api, tools } = await setup()
  await tools.setAmend('', true)
  assert.deepEqual([tools.draft('').amend, tools.draft('').message, tools.draft('').pushed], [true, 'old message', false])
  await tools.setAmend('', false)
  assert.deepEqual([tools.draft('').amend, tools.draft('').message], [false, ''])
  tools.setMessage('', 'my own text')
  await tools.setAmend('', true)
  assert.equal(tools.draft('').message, 'my own text', 'typed text is never overwritten')
  await tools.setAmend('', false)
  assert.equal(tools.draft('').message, 'my own text')
  api.script.last = { hash: null, message: '', hasUpstream: false, pushed: false }
  await tools.setAmend('', true)
  assert.equal(tools.draft('').amend, false)
  assert.match(tools.draft('').error, /no commit to amend/)
})

test('amend: a commit already on the upstream branch needs a confirm; declining keeps everything', async () => {
  const { api, tools, confirms, answers } = await setup({ answers: [false, true] })
  api.script.last = { hash: 'h1', message: 'shared', hasUpstream: true, pushed: true }
  await tools.setAmend('', true)
  assert.equal(tools.draft('').pushed, true)
  assert.equal(await tools.commit(''), false)
  assert.match(confirms[0], /already on its upstream/)
  assert.match(confirms[0], /force push/)
  assert.equal(calls(api, 'gitCommit').length, 0)
  assert.equal(tools.draft('').amend, true)
  assert.equal(await tools.commit(''), true)
  assert.deepEqual(calls(api, 'gitCommit')[0][2], { message: 'shared', amend: true, all: false })
  assert.equal(answers.length, 0)
})

test('branch picker: loads, switches (refresh + close), shows git refusals without closing, creates', async () => {
  const { api, store, tools } = await setup()
  await tools.openPicker('')
  assert.equal(tools.getState().picker.info.current, 'main')
  api.script.fail.checkout = new ApiError('error: Your local changes to the following files would be overwritten by checkout: a.txt', 500, 'git')
  assert.equal(await tools.checkout('', 'dev'), false)
  assert.match(tools.getState().picker.error, /would be overwritten/)
  assert.equal(tools.getState().picker.busy, false)
  assert.equal(await tools.checkout('', 'dev'), true)
  assert.equal(tools.getState().picker, null)
  assert.deepEqual(calls(api, 'gitCheckout').map((c) => c.slice(1)), [['/w/proj', 'dev', false], ['/w/proj', 'dev', false]])
  assert.match(store.getState().notice.text, /Switched to "dev"/)
  await tools.openPicker('')
  assert.equal(await tools.checkout('', '   ', true), false)
  assert.match(tools.getState().picker.error, /branch name/)
  assert.equal(await tools.checkout('', ' feat/x ', true), true)
  assert.deepEqual(calls(api, 'gitCheckout').at(-1).slice(1), ['/w/proj', 'feat/x', true])
  await tools.openPicker('')
  assert.equal(await tools.checkout('', 'origin/topic'), true, 'remote branches check out as tracking branches')
  assert.equal(calls(api, 'gitCheckout').at(-1)[2], 'origin/topic')
})

test('sync: fetch needs no confirm and shows the summary', async () => {
  const { api, tools, confirms } = await setup()
  assert.equal(await tools.sync('', 'fetch'), true)
  assert.equal(confirms.length, 0)
  assert.equal(tools.syncOf('').info, 'fetched')
  assert.equal(calls(api, 'gitFetch').length, 1)
})

test('sync: pull confirms (repo, branch, remote, ff-only); declining never calls the host', async () => {
  const { api, tools, confirms } = await setup({ answers: [false, true] })
  assert.equal(await tools.sync('', 'pull'), false)
  assert.equal(calls(api, 'gitPull').length, 0)
  assert.equal(tools.syncOf('').busy, null)
  const text = confirms[0]
  assert.match(text, /"proj"/)
  assert.match(text, /branch "main"/)
  assert.match(text, /origin\/main/)
  assert.match(text, /[Ff]ast-forward only/)
  assert.equal(await tools.sync('', 'pull'), true)
  assert.equal(calls(api, 'gitPull').length, 1)
  assert.equal(tools.syncOf('').info, 'pulled')
})

test('sync: push confirms with remote; a branch without upstream pushes with -u to the named remote', async () => {
  const { api, tools, confirms, answers } = await setup({ answers: [false, true, true] })
  assert.equal(await tools.sync('', 'push'), false)
  assert.equal(calls(api, 'gitPush').length, 0)
  assert.match(confirms[0], /Push 2 commits of branch "main" in "proj" to remote "origin" \(origin\/main\)/)
  assert.equal(await tools.sync('', 'push'), true)
  assert.deepEqual(calls(api, 'gitPush')[0].slice(1), ['/w/proj', undefined])
  api.script.branches = { ...BRANCHES, current: 'feature', upstream: null, upstreamRemote: null, ahead: null, behind: null, local: [{ name: 'feature', hash: 'a', upstream: null, upstreamRemote: null, current: true }] }
  assert.equal(await tools.sync('', 'push'), true)
  assert.match(confirms[2], /new branch "feature" of "proj" to remote "origin" and set it as the upstream \(git push -u origin feature\)/)
  assert.deepEqual(calls(api, 'gitPush')[1].slice(1), ['/w/proj', 'origin'])
  assert.equal(answers.length, 0)
})

test('sync: no remote / detached HEAD / no upstream for pull are refused before any confirm; failures show git\'s message', async () => {
  const { api, tools, confirms } = await setup()
  api.script.branches = { ...BRANCHES, remotes: [] }
  assert.equal(await tools.sync('', 'pull'), false)
  assert.match(tools.syncOf('').error, /no remote/)
  api.script.branches = { ...BRANCHES, current: null, detached: true, head: 'abc1234' }
  assert.equal(await tools.sync('', 'push'), false)
  assert.match(tools.syncOf('').error, /detached/)
  api.script.branches = { ...BRANCHES, upstream: null, upstreamRemote: null }
  assert.equal(await tools.sync('', 'pull'), false)
  assert.match(tools.syncOf('').error, /no upstream/)
  assert.equal(confirms.length, 0)
  api.script.branches = structuredClone(BRANCHES)
  api.script.fail.pull = new ApiError('fatal: Not possible to fast-forward, aborting.', 500, 'git')
  assert.equal(await tools.sync('', 'pull'), false)
  assert.equal(tools.syncOf('').error, 'fatal: Not possible to fast-forward, aborting.')
  assert.equal(tools.syncOf('').busy, null)
  api.script.fail.fetch = new ApiError('Authentication required - run git in a terminal', 409, 'auth-required')
  assert.equal(await tools.sync('', 'fetch'), false)
  assert.match(tools.syncOf('').error, /run git in a terminal/)
  assert.equal(calls(api, 'gitPush').length, 0)
})

test('sync: busy state blocks a second operation on the same repository and clears afterwards', async () => {
  const { api, tools } = await setup()
  let release
  api.gitFetch = () => new Promise((r) => { release = () => r({ summary: 'slow' }) })
  const first = tools.sync('', 'fetch')
  assert.equal(tools.syncOf('').busy, 'fetch')
  assert.equal(await tools.sync('', 'pull'), false)
  assert.equal(calls(api, 'gitBranches').length, 0)
  release()
  assert.equal(await first, true)
  assert.equal(tools.syncOf('').busy, null)
})

test('history: first page of 50, load more appends, hasMore ends, errors are shown', async () => {
  const { api, tools } = await setup({ script: { commits: mk(120) } })
  await tools.setHistoryOpen(true)
  let h = tools.getState().history
  assert.equal(h.open, true)
  assert.equal(h.commits.length, 50)
  assert.equal(h.hasMore, true)
  assert.deepEqual(calls(api, 'gitLog')[0].slice(1), ['/w/proj', { skip: 0, limit: 50, path: undefined }])
  await tools.loadHistory()
  await tools.loadHistory()
  h = tools.getState().history
  assert.equal(h.commits.length, 120)
  assert.equal(h.hasMore, false)
  assert.deepEqual(calls(api, 'gitLog').map((c) => c[2].skip), [0, 50, 100])
  assert.equal(new Set(h.commits.map((c) => c.hash)).size, 120)
  api.script.fail.log = new ApiError('boom', 500)
  await tools.loadHistory(true)
  assert.equal(tools.getState().history.error, 'boom')
})

test('history: selecting a commit lists its files; clicking a file opens a read-only diff tab that is not persisted', async () => {
  const { api, store, tools } = await setup({ script: { commits: mk(3) } })
  await tools.setHistoryOpen(true)
  const hash = tools.getState().history.commits[1].hash
  await tools.selectCommit(hash)
  const h = tools.getState().history
  assert.equal(h.selected, hash)
  assert.deepEqual(h.detail.files.map((f) => f.path), ['src/b.ts', 'n.txt'])
  await tools.openCommitFile(h.detail.files[1])
  assert.deepEqual(calls(api, 'gitShow')[0].slice(1), ['/w/proj', hash, 'n.txt', 'o.txt'])
  const tab = store.tab(store.getState().active)
  assert.equal(tab.kind, 'compare')
  assert.equal(tab.of, null)
  assert.deepEqual(tab.diff, { original: 'OLD', modified: 'NEW' })
  assert.match(tab.title, /^n\.txt \(a/)
  assert.equal(tab.loaded, true)
  // resolveCompare must not do anything to a read-only tab
  await store.resolveCompare(tab.id, 'mine')
  assert.ok(store.tab(tab.id))
  // reopening the same file reuses the tab; clicking the commit again collapses it
  await tools.openCommitFile(h.detail.files[1])
  assert.equal(store.getState().tabs.filter((t) => t.kind === 'compare').length, 1)
  await tools.selectCommit(hash)
  assert.equal(tools.getState().history.selected, null)
})

test('history: binary and oversized files only notify; show errors are reported', async () => {
  const { api, store, tools } = await setup({ script: { commits: mk(1) } })
  await tools.setHistoryOpen(true)
  await tools.selectCommit(tools.getState().history.commits[0].hash)
  const file = tools.getState().history.detail.files[0]
  api.script.show = { original: null, modified: null, binary: true, tooLarge: false }
  await tools.openCommitFile(file)
  assert.match(store.getState().notice.text, /binary file/)
  assert.equal(store.getState().tabs.length, 0)
  api.script.show = { original: null, modified: null, binary: false, tooLarge: true }
  await tools.openCommitFile(file)
  assert.match(store.getState().notice.text, /2 MiB/)
  api.script.show = undefined
  api.script.fail.show = new ApiError('No such commit', 404)
  await tools.openCommitFile(file)
  assert.match(store.getState().notice.text, /No such commit/)
})

test('history: file history filters to one file (repo-relative) and clears', async () => {
  const { api, tools } = await setup({ script: { commits: mk(2) } })
  await tools.fileHistory('src/b.ts')
  assert.deepEqual(calls(api, 'gitLog').at(-1).slice(1), ['/w/proj', { skip: 0, limit: 50, path: 'src/b.ts' }])
  assert.equal(tools.getState().history.path, 'src/b.ts')
  await tools.clearFileFilter()
  assert.equal(calls(api, 'gitLog').at(-1)[2].path, undefined)
  assert.equal(tools.getState().history.path, '')
})

test('history in a folder of repositories: file history picks the nested repository and strips its prefix', async () => {
  const repos = { '/w/multi': { inside: false, truncated: false, repos: [{ path: '/w/multi/alpha', rel: 'alpha', name: 'alpha' }, { path: '/w/multi/pk/beta', rel: 'pk/beta', name: 'beta' }] } }
  const { api, store, tools } = await setup({ repos, workspaces: ['/w/multi'], script: { commits: mk(2) }, statusByRoot: { '/w/multi/alpha': { branch: 'dev', ahead: 0, behind: 0, files: [gitFile('x.ts', { index: 'M', worktree: ' ', staged: true, unstaged: false })] }, '/w/multi/pk/beta': { branch: 'main', ahead: 0, behind: 0, files: [] } } })
  await until(() => Object.keys(store.getState().repoGit).length === 2, 'repo status')
  await tools.fileHistory('pk/beta/deep/x.ts')
  assert.deepEqual(calls(api, 'gitLog').at(-1).slice(1), ['/w/multi/pk/beta', { skip: 0, limit: 50, path: 'deep/x.ts' }])
  assert.equal(tools.getState().history.repo, 'pk/beta')
  await tools.setHistoryRepo('alpha')
  assert.deepEqual(calls(api, 'gitLog').at(-1).slice(1), ['/w/multi/alpha', { skip: 0, limit: 50, path: undefined }])
  await tools.selectCommit(tools.getState().history.commits[0].hash)
  await tools.openCommitFile(tools.getState().history.detail.files[0])
  assert.equal(store.tab(store.getState().active).path, 'alpha/src/b.ts')
  // commit in a nested repo goes to that repo's path
  tools.setMessage('alpha', 'in alpha')
  await tools.commit('alpha')
  assert.equal(calls(api, 'gitCommit').at(-1)[1], '/w/multi/alpha')
})

test('switching folder resets the tools and ignores answers in flight', async () => {
  const { api, store, tools } = await setup({ script: { commits: mk(3) } })
  await tools.setHistoryOpen(true)
  tools.setMessage('', 'draft')
  let release
  api.gitLog = () => new Promise((r) => { release = () => r({ commits: mk(1), hasMore: false }) })
  const pending = tools.loadHistory(true)
  await store.selectRoot('/w/other')
  assert.equal(tools.getState().history.open, false)
  assert.equal(tools.draft('').message, '')
  release()
  await pending
  assert.deepEqual(tools.getState().history.commits, [])
})

test('after a pull or a branch switch the explorer and open files are refreshed too', async () => {
  const { api, tools } = await setup()
  const trees = () => calls(api, 'tree').length
  const t0 = trees()
  await tools.sync('', 'pull')
  await until(() => trees() > t0, 'explorer refresh after pull')
  const t1 = trees()
  await tools.openPicker('')
  await tools.checkout('', 'dev')
  await until(() => trees() > t1, 'explorer refresh after checkout')
})
