// Git tools beyond status/stage: commit, branches, history, sync (fetch / pull / push).
// Same rules as git.js: execFile only (never a shell), `--` before paths, literal pathspecs, timeouts, and git must
// never wait for a prompt (GIT_TERMINAL_PROMPT=0 is set by git(); the sync commands also silence askpass helpers, GCM and ssh).
import { EditorError } from './errors.js'
import { checkPaths, blob, git, requireRepo } from './git.js'

export const SYNC_TIMEOUT_MS = 120_000
export const LOG_PAGE = 50
export const LOG_MAX_LIMIT = 200
const MAX_MESSAGE = 100_000
const MAX_COMMIT_FILES = 2000
const HASH = /^[0-9a-f]{4,40}$/
const US = '\x1f'
const RS = '\x1e'

/** Environment for commands that talk to a remote: no prompt of any kind (terminal, askpass, credential manager, ssh). */
export function networkEnv(base = process.env) {
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' }
  if (!base.GIT_SSH_COMMAND && !base.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  return env
}

const AUTH = /terminal prompts disabled|could not read (username|password)|authentication failed|permission denied \(|host key verification failed|invalid credentials|http basic: access denied|the requested url returned error: 40[13]/i
const IDENTITY = /author identity unknown|committer identity unknown|please tell me who you are|unable to auto-detect email|empty ident name|no email was given|user\.useconfigonly/i

/** Readable git output: the non-empty lines of stderr then stdout, capped. */
export function outputText(result, maxLines = 8, maxChars = 700) {
  const lines = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  const text = lines.slice(0, maxLines).join('\n')
  return text === '' ? 'git failed' : text.slice(0, maxChars)
}

/** Turn a failed git result into an EditorError with a clear message. */
export function classify(result) {
  const text = outputText(result)
  const raw = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
  if (IDENTITY.test(raw)) {
    return new EditorError(409, 'identity', 'Git does not know who you are. Run: git config --global user.name "Your Name" and git config --global user.email "you@example.com"')
  }
  if (AUTH.test(raw)) return new EditorError(409, 'auth-required', 'Authentication required - run git in a terminal (credentials are never asked for here).')
  if (/nothing (added )?to commit|no changes added to commit/i.test(raw)) {
    return new EditorError(409, 'nothing-to-commit', 'Nothing to commit. Stage some changes first.')
  }
  return new EditorError(500, 'git', text)
}

const ok = (result) => {
  if (result.code !== 0) throw classify(result)
  return result
}

/** A sync command: long timeout, no prompts; a timeout becomes a readable error. */
async function net(root, args) {
  try {
    return await git(args, { cwd: root, timeout: SYNC_TIMEOUT_MS, env: networkEnv() })
  } catch (error) {
    if (error instanceof EditorError && error.code === 'timeout') throw new EditorError(504, 'timeout', `git timed out after ${SYNC_TIMEOUT_MS / 1000} s`)
    throw error
  }
}

export function checkHash(hash) {
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new EditorError(400, 'bad-request', 'hash must be 4..40 lowercase hex characters')
  return hash
}

const toInt = (value, fallback, min, max, label) => {
  if (value === '' || value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new EditorError(400, 'bad-request', `${label} must be an integer in ${min}..${max}`)
  return n
}

async function hasHead(root) {
  return (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, timeout: 5000 })).code === 0
}

async function remoteNames(root) {
  const result = ok(await git(['remote'], { cwd: root, timeout: 5000 }))
  return result.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
}

async function currentBranch(root) {
  const result = await git(['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: root, timeout: 5000 })
  return result.code === 0 ? result.stdout.trim() : null
}

const defaultRemote = (remotes) => (remotes.includes('origin') ? 'origin' : (remotes[0] ?? null))

// ---- commit -------------------------------------------------------------------------------------------------------

/** `git commit` of the index (`all`: `-a`, i.e. also tracked working tree changes). Hooks run; their failure is reported. */
export async function commit(root, { message, amend = false, all = false }) {
  await requireRepo(root)
  if (typeof message !== 'string') throw new EditorError(400, 'bad-request', 'message must be a string')
  if (message.includes('\0') || message.length > MAX_MESSAGE) throw new EditorError(400, 'bad-request', 'message is invalid or too long')
  const text = message.replace(/\r\n/g, '\n').trim()
  if (text === '' && amend !== true) throw new EditorError(400, 'empty-message', 'Enter a commit message')
  const args = ['commit', ...(all === true ? ['-a'] : []), ...(amend === true ? ['--amend'] : []), ...(text === '' ? ['--no-edit'] : ['-m', text])]
  ok(await git(args, { cwd: root, timeout: SYNC_TIMEOUT_MS }))
  const head = ok(await git(['log', '-1', `--format=%H${US}%s`], { cwd: root, timeout: 5000 }))
  const [hash = '', summary = ''] = head.stdout.replace(/\n$/, '').split(US)
  return { hash, summary }
}

/** The last commit's message, and whether it already exists on the upstream branch (amending would rewrite shared history). */
export async function lastCommit(root) {
  await requireRepo(root)
  if (!(await hasHead(root))) return { hash: null, message: '', hasUpstream: false, pushed: false }
  const head = ok(await git(['log', '-1', `--format=%H${US}%B`], { cwd: root, timeout: 5000 }))
  const at = head.stdout.indexOf(US)
  const hash = head.stdout.slice(0, at)
  const message = head.stdout.slice(at + 1).replace(/\s+$/, '')
  const upstream = await git(['rev-parse', '--verify', '-q', '@{u}'], { cwd: root, timeout: 5000 })
  if (upstream.code !== 0) return { hash, message, hasUpstream: false, pushed: false }
  const contained = await git(['merge-base', '--is-ancestor', 'HEAD', '@{u}'], { cwd: root, timeout: 10_000 })
  return { hash, message, hasUpstream: true, pushed: contained.code === 0 }
}

// ---- branches -----------------------------------------------------------------------------------------------------

export async function branches(root) {
  await requireRepo(root)
  const remotes = await remoteNames(root)
  const format = ['%(refname)', '%(objectname:short)', '%(upstream)', '%(upstream:short)', '%(HEAD)', '%(upstream:remotename)'].join('%09')
  const refs = ok(await git(['for-each-ref', `--format=${format}`, '--sort=refname', 'refs/heads', 'refs/remotes'], { cwd: root }))
  const local = []
  const remote = []
  for (const line of refs.stdout.split(/\r?\n/)) {
    if (line === '') continue
    const [ref, hash, upstreamRef, upstreamShort, head, upstreamRemote] = line.split('\t')
    if (ref.startsWith('refs/heads/')) {
      local.push({ name: ref.slice(11), hash, upstream: upstreamShort || null, upstreamRef: upstreamRef || null, upstreamRemote: upstreamRemote || null, current: head === '*' })
    } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
      const name = ref.slice(13)
      const owner = remotes.filter((r) => name.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] ?? name.split('/')[0]
      remote.push({ name, remote: owner, short: name.slice(owner.length + 1), hash })
    }
  }
  const names = new Set(local.map((b) => b.name))
  for (const r of remote) r.local = names.has(r.short)
  const current = await currentBranch(root)
  const detached = current === null
  let head = null
  if (detached && (await hasHead(root))) head = (await git(['rev-parse', '--short', 'HEAD'], { cwd: root, timeout: 5000 })).stdout.trim() || null
  const cur = local.find((b) => b.name === current)
  let ahead = null
  let behind = null
  if (cur?.upstreamRef) {
    const counts = await git(['rev-list', '--left-right', '--count', `HEAD...${cur.upstreamRef}`], { cwd: root, timeout: 10_000 })
    const m = counts.code === 0 ? /^(\d+)\s+(\d+)/.exec(counts.stdout.trim()) : null
    if (m !== null) {
      ahead = Number(m[1])
      behind = Number(m[2])
    }
  }
  return { current, detached, head, upstream: cur?.upstream ?? null, upstreamRemote: cur?.upstreamRemote ?? null, ahead, behind, local, remote, remotes }
}

/** Validate a branch name with git itself. A leading '-' is refused first (it would be read as an option / @{-n}). */
export async function checkBranchName(root, name) {
  if (typeof name !== 'string' || name === '' || name.length > 255 || name.startsWith('-') || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new EditorError(400, 'bad-branch', 'Invalid branch name')
  }
  const result = await git(['check-ref-format', '--branch', name], { cwd: root, timeout: 5000 })
  if (result.code !== 0 || result.stdout.trim() !== name) throw new EditorError(400, 'bad-branch', `"${name}" is not a valid branch name`)
  return name
}

/**
 * Switch to a local branch, check a remote branch out as a tracking branch (`origin/x`), or create a branch from HEAD.
 * Git decides about uncommitted changes; its refusal is reported as is (no stash, no force).
 */
export async function checkout(root, { branch, create = false }) {
  await requireRepo(root)
  await checkBranchName(root, branch)
  if (create === true) {
    ok(await git(['checkout', '-b', branch], { cwd: root, timeout: 30_000 }))
    return { branch }
  }
  const isLocal = (await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root, timeout: 5000 })).code === 0
  if (isLocal) {
    ok(await git(['checkout', branch, '--'], { cwd: root, timeout: 30_000 }))
    return { branch }
  }
  const isRemote = (await git(['show-ref', '--verify', '--quiet', `refs/remotes/${branch}`], { cwd: root, timeout: 5000 })).code === 0
  if (!isRemote) throw new EditorError(404, 'no-branch', `Branch "${branch}" does not exist`)
  ok(await git(['checkout', '--track', branch, '--'], { cwd: root, timeout: 30_000 }))
  return { branch: (await currentBranch(root)) ?? branch }
}

// ---- history ------------------------------------------------------------------------------------------------------

/** One page of the history of HEAD (or of a file when `path` is given, following renames). */
export async function log(root, { skip, limit, path } = {}) {
  await requireRepo(root)
  const n = toInt(limit, LOG_PAGE, 1, LOG_MAX_LIMIT, 'limit')
  const from = toInt(skip, 0, 0, 1_000_000, 'skip')
  if (!(await hasHead(root))) return { commits: [], hasMore: false }
  const format = ['%H', '%h', '%an', '%ae', '%at', '%D', '%s'].join(US) + RS
  const args = ['log', `--skip=${from}`, `--max-count=${n + 1}`, '--decorate=short', `--format=${format}`, '--no-color']
  if (path !== undefined && path !== '') args.push('--follow', '--', path)
  const result = ok(await git(args, { cwd: root }))
  const commits = []
  for (const record of result.stdout.split(RS)) {
    const text = record.replace(/^\n+/, '')
    if (text === '') continue
    const [hash, short, author, email, at, refs, subject] = text.split(US)
    commits.push({
      hash, short, author, email, date: Number(at) * 1000, subject: subject ?? '',
      refs: (refs ?? '').split(', ').map((r) => r.trim()).filter((r) => r !== '').map((r) => r.replace(/^HEAD -> /, '')),
    })
  }
  return { commits: commits.slice(0, n), hasMore: commits.length > n }
}

async function assertCommit(root, hash) {
  checkHash(hash)
  const found = await git(['rev-parse', '--verify', '-q', `${hash}^{commit}`], { cwd: root, timeout: 5000 })
  if (found.code !== 0) throw new EditorError(404, 'no-commit', 'No such commit')
}

const firstParent = async (root, hash) => {
  const result = await git(['rev-parse', '--verify', '-q', `${hash}^1`], { cwd: root, timeout: 5000 })
  return result.code === 0 ? result.stdout.trim() : null
}

/** Parse `diff-tree --name-status -z` output into `[{ status, path, origPath? }]`. */
export function parseNameStatus(stdout) {
  const tokens = stdout.split('\0')
  const files = []
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i]
    if (status === '') continue
    const letter = status[0]
    if (letter === 'R' || letter === 'C') {
      const origPath = tokens[++i]
      const path = tokens[++i]
      if (path !== undefined) files.push({ status: letter, path, origPath })
    } else {
      const path = tokens[++i]
      if (path !== undefined) files.push({ status: letter, path })
    }
  }
  return files
}

/** Metadata and changed files of a commit (against its first parent; a root commit against the empty tree). */
export async function commitInfo(root, hash) {
  await requireRepo(root)
  await assertCommit(root, hash)
  const meta = ok(await git(['log', '-1', `--format=%H${US}%an${US}%ae${US}%at${US}%B`, '--no-color', hash], { cwd: root, timeout: 10_000 }))
  const [full, author, email, at, ...rest] = meta.stdout.split(US)
  const message = rest.join(US).replace(/\s+$/, '')
  const parent = await firstParent(root, hash)
  const args = parent === null ? ['diff-tree', '--root', '--no-commit-id', '-r', '-z', '--name-status', '-M', hash] : ['diff-tree', '-r', '-z', '--name-status', '-M', parent, hash]
  const tree = ok(await git(args, { cwd: root }))
  const all = parseNameStatus(tree.stdout)
  return { hash: full, author, email, date: Number(at) * 1000, message, parent, files: all.slice(0, MAX_COMMIT_FILES), truncated: all.length > MAX_COMMIT_FILES }
}

async function blobAt(root, rev, path) {
  const entry = await git(['ls-tree', '-z', rev, '--', path], { cwd: root, timeout: 5000 })
  if (entry.code !== 0) return null
  const m = /^(\d+) (\w+) ([0-9a-f]+)\t/s.exec(entry.stdout.split('\0')[0] ?? '')
  return m === null || m[2] !== 'blob' ? null : blob(root, m[3])
}

/** Both sides of a file in a commit: its first parent (at `origPath` for renames) and the commit. Same shape as /git/diff. */
export async function show(root, rootReal, hash, path, origPath) {
  await requireRepo(root)
  await assertCommit(root, hash)
  const [rel] = await checkPaths(rootReal, [path])
  const [relOrig] = origPath === undefined || origPath === '' ? [rel] : await checkPaths(rootReal, [origPath])
  const parent = await firstParent(root, hash)
  const original = parent === null ? null : await blobAt(root, parent, relOrig)
  const modified = await blobAt(root, hash, rel)
  const sides = [original, modified]
  const binary = sides.some((s) => s?.binary === true)
  const tooLarge = sides.some((s) => s?.tooLarge === true)
  const hide = binary || tooLarge
  return { original: hide ? null : (original?.content ?? null), modified: hide ? null : (modified?.content ?? null), binary, tooLarge }
}

// ---- sync ---------------------------------------------------------------------------------------------------------

export async function fetchAll(root) {
  await requireRepo(root)
  const remotes = await remoteNames(root)
  if (remotes.length === 0) throw new EditorError(409, 'no-remote', 'This repository has no remote')
  const result = ok(await net(root, ['fetch', '--all']))
  const text = outputText(result, 3, 300)
  return { summary: text === 'git failed' ? 'Already up to date.' : text }
}

/** `git pull --ff-only --no-rebase`: never a merge commit, never a rebase. */
export async function pull(root) {
  await requireRepo(root)
  const remotes = await remoteNames(root)
  if (remotes.length === 0) throw new EditorError(409, 'no-remote', 'This repository has no remote')
  if ((await currentBranch(root)) === null) throw new EditorError(409, 'detached', 'HEAD is detached: switch to a branch first')
  const result = ok(await net(root, ['pull', '--ff-only', '--no-rebase']))
  const text = outputText(result, 3, 300)
  return { summary: text === 'git failed' ? 'Done.' : text }
}

/** `git push`; a branch without upstream is pushed with `-u <remote> <branch>` (remote: the given one, else origin, else the only one). */
export async function push(root, { remote } = {}) {
  await requireRepo(root)
  const remotes = await remoteNames(root)
  if (remotes.length === 0) throw new EditorError(409, 'no-remote', 'This repository has no remote')
  const branch = await currentBranch(root)
  if (branch === null) throw new EditorError(409, 'detached', 'HEAD is detached: switch to a branch first')
  const upstream = await git(['rev-parse', '--verify', '-q', '@{u}'], { cwd: root, timeout: 5000 })
  let setUpstream = false
  let args = ['push']
  let target = null
  if (upstream.code !== 0) {
    target = remote === undefined || remote === null || remote === '' ? defaultRemote(remotes) : remote
    if (typeof target !== 'string' || !remotes.includes(target)) throw new EditorError(400, 'bad-request', 'Unknown remote')
    args = ['push', '-u', target, `refs/heads/${branch}:refs/heads/${branch}`]
    setUpstream = true
  }
  const result = ok(await net(root, args))
  const text = outputText(result, 3, 300)
  return { summary: text === 'git failed' ? 'Pushed.' : text, setUpstream, remote: target, branch }
}

// ---- routes -------------------------------------------------------------------------------------------------------

/**
 * The HTTP routes of these tools.
 * @param deps.route - `route(path, handlers)` of index.js.
 * @param deps.rootOf - resolves a registered root (`{ path, real }`).
 * @param deps.changed - called with a root after every mutating operation (sends the `git` WebSocket frame).
 */
export function gitToolRoutes({ route, rootOf, changed }) {
  const param = (url, key) => url.searchParams.get(key) ?? ''
  const busy = new Set()
  /** One mutating operation per repository at a time. */
  const exclusive = async (root, fn) => {
    if (busy.has(root.real)) throw new EditorError(409, 'busy', 'Another git operation is running in this repository')
    busy.add(root.real)
    try {
      return await fn()
    } finally {
      busy.delete(root.real)
      changed(root)
    }
  }
  return [
    route('/git/commit', {
      GET: async ({ url }) => {
        const root = await rootOf(param(url, 'root'))
        return commitInfo(root.path, param(url, 'hash'))
      },
      POST: async ({ body }) => {
        const root = await rootOf(body.root)
        return exclusive(root, () => commit(root.path, { message: body.message, amend: body.amend === true, all: body.all === true }))
      },
    }),
    route('/git/last-commit', { GET: async ({ url }) => lastCommit((await rootOf(param(url, 'root'))).path) }),
    route('/git/branches', { GET: async ({ url }) => branches((await rootOf(param(url, 'root'))).path) }),
    route('/git/checkout', {
      POST: async ({ body }) => {
        const root = await rootOf(body.root)
        return exclusive(root, () => checkout(root.path, { branch: body.branch, create: body.create === true }))
      },
    }),
    route('/git/log', {
      GET: async ({ url }) => {
        const root = await rootOf(param(url, 'root'))
        const path = param(url, 'path')
        const [rel] = path === '' ? [''] : await checkPaths(root.real, [path])
        return log(root.path, { skip: param(url, 'skip'), limit: param(url, 'limit'), path: rel })
      },
    }),
    route('/git/show', {
      GET: async ({ url }) => {
        const root = await rootOf(param(url, 'root'))
        return show(root.path, root.real, param(url, 'hash'), param(url, 'path'), param(url, 'origPath'))
      },
    }),
    route('/git/fetch', { POST: async ({ body }) => { const root = await rootOf(body.root); return exclusive(root, () => fetchAll(root.path)) } }),
    route('/git/pull', { POST: async ({ body }) => { const root = await rootOf(body.root); return exclusive(root, () => pull(root.path)) } }),
    route('/git/push', {
      POST: async ({ body }) => {
        const root = await rootOf(body.root)
        return exclusive(root, () => push(root.path, { remote: body.remote }))
      },
    }),
  ]
}
