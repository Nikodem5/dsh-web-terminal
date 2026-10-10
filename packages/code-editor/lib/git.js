// Git integration. Always execFile (never a shell), `--` before paths, literal pathspecs, hard timeouts.
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { EditorError, fromFsError } from './errors.js'
import { resolveInside, splitRelative } from './confine.js'
import { MAX_FILE_BYTES, decodeText } from './files.js'

export const GIT_TIMEOUT_MS = 20_000
const MAX_OUTPUT = 64 * 1024 * 1024
export const MAX_STATUS_FILES = 10_000
export const MAX_GIT_PATHS = 1000
const MAX_CONCURRENT = 6

// Safety flags: no optional index writes (a status must not touch .git/index, or the watcher would loop), literal
// pathspecs (no globs from user paths), and no repo-configured fsmonitor command (an untrusted repo could run code).
const BASE_ARGS = ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off']

let running = 0
const waiting = []
async function slot() {
  if (running >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve))
  running++
}
function release() {
  running--
  waiting.shift()?.()
}

/**
 * Run git. Resolves `{ code, stdout, stderr }` for any exit status; throws EditorError for a missing git, a timeout
 * or oversized output.
 */
export async function git(args, { cwd, buffer = false, timeout = GIT_TIMEOUT_MS, maxBuffer = MAX_OUTPUT } = {}) {
  await slot()
  try {
    return await new Promise((resolve, reject) => {
      execFile(
        'git',
        [...BASE_ARGS, ...args],
        {
          cwd,
          timeout,
          maxBuffer,
          windowsHide: true,
          encoding: buffer ? 'buffer' : 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_PAGER: 'cat' },
        },
        (error, stdout, stderr) => {
          if (error === null) return resolve({ code: 0, stdout, stderr: String(stderr) })
          if (error.code === 'ENOENT') return reject(new EditorError(501, 'no-git', 'git is not installed or not on PATH'))
          if (error.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER_EXCEEDED') return reject(new EditorError(413, 'too-large', 'git output too large'))
          if (error.killed || error.signal) return reject(new EditorError(504, 'timeout', 'git timed out'))
          if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr: String(stderr) })
          reject(new EditorError(500, 'git', 'git failed'))
        },
      )
    })
  } finally {
    release()
  }
}

const firstLine = (text) => String(text).split(/\r?\n/).find((l) => l.trim() !== '')?.trim().slice(0, 300) ?? 'git failed'
function failed(result) {
  return new EditorError(500, 'git', firstLine(result.stderr))
}

/** `{ inside, prefix }` for a root; prefix is the root's path below the work tree top ('' or 'sub/dir/'). */
export async function repoInfo(root) {
  const result = await git(['rev-parse', '--is-inside-work-tree', '--show-prefix'], { cwd: root, timeout: 5000 })
  if (result.code !== 0) return { inside: false, prefix: '' }
  const [inside, prefix = ''] = result.stdout.split('\n')
  return { inside: inside.trim() === 'true', prefix: prefix.trim() }
}

/** The work tree top-level of a folder (`git rev-parse --show-toplevel`, short timeout), or null outside a work tree. */
export async function topLevel(dir) {
  const result = await git(['rev-parse', '--show-toplevel'], { cwd: dir, timeout: 5000 })
  if (result.code !== 0) return null
  const line = result.stdout.split(/\r?\n/)[0].trim()
  return line === '' ? null : line
}

/** Throws 409 not-git unless the root is in a work tree. */
export async function requireRepo(root) {
  const info = await repoInfo(root)
  if (!info.inside) throw new EditorError(409, 'not-git', 'Not a git repository')
  return info
}

/** Staged/unstaged letters: porcelain v2 uses '.' for "none"; we expose a space. */
const letter = (c) => (c === '.' ? ' ' : c)

/**
 * Parse `git status --porcelain=v2 -z --branch` output.
 * @param stdout - raw output.
 * @param prefix - root path below the work tree top; entries outside it are dropped, inside ones made root-relative.
 */
export function parseStatus(stdout, prefix = '') {
  const tokens = stdout.split('\0')
  let branch = null
  let ahead = 0
  let behind = 0
  const files = []
  let truncated = false
  const rel = (p) => {
    if (prefix === '') return p
    return p.startsWith(prefix) ? p.slice(prefix.length) : undefined
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '') continue
    if (token.startsWith('# ')) {
      const [, key, ...rest] = token.split(' ')
      if (key === 'branch.head') branch = rest.join(' ')
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(rest.join(' '))
        if (m !== null) {
          ahead = Number(m[1])
          behind = Number(m[2])
        }
      }
      continue
    }
    const kind = token[0]
    let entry
    if (kind === '1') {
      const parts = splitFields(token, 9)
      entry = { path: parts[8], xy: parts[1] }
    } else if (kind === '2') {
      const parts = splitFields(token, 10)
      const orig = tokens[++i]
      entry = { path: parts[9], origPath: orig, xy: parts[1] }
    } else if (kind === 'u') {
      const parts = splitFields(token, 11)
      entry = { path: parts[10], xy: parts[1], conflicted: true }
    } else if (kind === '?') {
      entry = { path: token.slice(2), untracked: true }
    } else {
      continue // '!' ignored entries and anything unknown
    }
    const path = rel(entry.path)
    if (path === undefined || path === '') continue
    if (files.length >= MAX_STATUS_FILES) {
      truncated = true
      continue
    }
    const origPath = entry.origPath === undefined ? undefined : rel(entry.origPath)
    let file
    if (entry.untracked === true) {
      file = { path, index: '?', worktree: '?', staged: false, unstaged: false, untracked: true, conflicted: false }
    } else {
      const [x, y] = [entry.xy[0], entry.xy[1]]
      const conflicted = entry.conflicted === true
      file = {
        path,
        index: letter(x),
        worktree: letter(y),
        staged: !conflicted && x !== '.',
        unstaged: !conflicted && y !== '.',
        untracked: false,
        conflicted,
      }
      if (origPath !== undefined) file.origPath = origPath
    }
    files.push(file)
  }
  return { branch, ahead, behind, files, truncated }
}

/** Split into `count` space separated fields, the last one keeping its spaces. */
function splitFields(text, count) {
  const out = []
  let from = 0
  for (let n = 0; n < count - 1; n++) {
    const at = text.indexOf(' ', from)
    if (at < 0) break
    out.push(text.slice(from, at))
    from = at + 1
  }
  out.push(text.slice(from))
  return out
}

/** Full status for a root. */
export async function status(root) {
  const { prefix } = await requireRepo(root)
  const result = await git(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], { cwd: root })
  if (result.code !== 0) throw failed(result)
  return parseStatus(result.stdout, prefix)
}

/** Tracked files plus untracked-but-not-ignored, relative to the root. */
export async function listFiles(root, cap) {
  const result = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
  if (result.code !== 0) throw failed(result)
  const seen = new Set()
  const files = []
  let truncated = false
  for (const name of result.stdout.split('\0')) {
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    if (files.length >= cap) {
      truncated = true
      break
    }
    files.push(name)
  }
  return { files, truncated }
}

/** Validate client paths for a git operation (the leaf is the link itself, never followed). */
export async function checkPaths(rootReal, paths, { required = true } = {}) {
  if (!Array.isArray(paths) || paths.length > MAX_GIT_PATHS || (required && paths.length === 0)) {
    throw new EditorError(400, 'bad-request', `paths must be an array of 1..${MAX_GIT_PATHS} strings`)
  }
  const out = []
  for (const path of paths) {
    const segments = splitRelative(path)
    await resolveInside(rootReal, segments, { followLeaf: false })
    out.push(segments.join('/'))
  }
  return out
}

export async function stage(root, paths) {
  await requireRepo(root)
  const result = await git(['add', '--', ...paths], { cwd: root })
  if (result.code !== 0) throw failed(result)
}

export async function unstage(root, paths) {
  await requireRepo(root)
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, timeout: 5000 })
  if (head.code !== 0) {
    // No commit yet: there is no HEAD to restore from, so drop the paths from the index instead.
    const result = await git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...paths], { cwd: root })
    if (result.code !== 0) throw failed(result)
    return
  }
  let result = await git(['restore', '--staged', '--', ...paths], { cwd: root })
  if (result.code !== 0) result = await git(['reset', '-q', 'HEAD', '--', ...paths], { cwd: root })
  if (result.code !== 0) throw failed(result)
}

/**
 * Discard working-tree changes. `untracked` entries are deleted only if they are currently listed as untracked
 * files by git; directories are never removed.
 */
export async function discard(root, rootReal, paths, untracked) {
  const info = await requireRepo(root)
  const doomed = []
  if (untracked.length > 0) {
    const current = await git(['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: root })
    if (current.code !== 0) throw failed(current)
    const listed = new Set(parseStatus(current.stdout, info.prefix).files.filter((f) => f.untracked).map((f) => f.path))
    for (const path of untracked) {
      if (!listed.has(path)) throw new EditorError(409, 'not-untracked', 'Not an untracked file')
      const abs = await resolveInside(rootReal, splitRelative(path), { followLeaf: false })
      const stat = await fs.lstat(abs).catch(() => undefined)
      if (stat === undefined) continue
      if (stat.isDirectory()) throw new EditorError(400, 'not-file', 'Directories are never deleted')
      doomed.push(abs)
    }
  }
  if (paths.length > 0) {
    const result = await git(['restore', '--worktree', '--', ...paths], { cwd: root })
    if (result.code !== 0) throw failed(result)
  }
  for (const abs of doomed) {
    try {
      await fs.unlink(abs)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw fromFsError(error)
    }
  }
}

/** Read a blob by id into the diff shape: `{ content|null, binary, tooLarge }`. */
async function blob(root, oid) {
  const size = await git(['cat-file', '-s', oid], { cwd: root, timeout: 5000 })
  if (size.code !== 0) return { content: null, binary: false, tooLarge: false }
  if (Number(size.stdout.trim()) > MAX_FILE_BYTES) return { content: null, binary: false, tooLarge: true }
  const result = await git(['cat-file', 'blob', oid], { cwd: root, buffer: true, maxBuffer: MAX_FILE_BYTES + 1024 })
  if (result.code !== 0) return { content: null, binary: false, tooLarge: false }
  return { ...decodeText(result.stdout), tooLarge: false }
}

/** Index entry (stage 0, else the first stage) of a path: `{ oid, mode }` or undefined. */
async function indexEntry(root, path) {
  const result = await git(['ls-files', '--stage', '-z', '--', path], { cwd: root, timeout: 5000 })
  if (result.code !== 0) return undefined
  const entries = result.stdout.split('\0').filter((e) => e !== '').map((e) => /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(e)).filter((m) => m !== null && m[4] === path)
  const entry = entries.find((m) => m[3] === '0') ?? entries[0]
  return entry === undefined || entry[1] === '160000' ? undefined : { oid: entry[2], mode: entry[1] }
}

/** HEAD tree entry of a path or undefined (also when there is no HEAD). */
async function headEntry(root, path) {
  const result = await git(['ls-tree', '-z', 'HEAD', '--', path], { cwd: root, timeout: 5000 })
  if (result.code !== 0) return undefined
  const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(result.stdout.split('\0')[0] ?? '')
  return m === null || m[2] !== 'blob' ? undefined : { oid: m[3], mode: m[1] }
}

/** Working file for a diff (confined, not following links out of the root). */
async function workingFile(rootReal, path) {
  const abs = await resolveInside(rootReal, splitRelative(path))
  let handle
  try {
    handle = await fs.open(abs, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { content: null, binary: false, tooLarge: false, missing: true }
    throw fromFsError(error)
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return { content: null, binary: false, tooLarge: false, missing: true }
    if (stat.size > MAX_FILE_BYTES) return { content: null, binary: false, tooLarge: true }
    const buffer = Buffer.alloc(stat.size)
    const { bytesRead } = stat.size === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, stat.size, 0)
    return { ...decodeText(buffer.subarray(0, bytesRead)), tooLarge: false }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Both sides of a diff for one path. */
export async function diff(root, rootReal, path, staged) {
  await requireRepo(root)
  const segments = splitRelative(path)
  const rel = segments.join('/')
  let original
  let modified
  if (staged) {
    const head = await headEntry(root, rel)
    const index = await indexEntry(root, rel)
    original = head === undefined ? null : await blob(root, head.oid)
    modified = index === undefined ? null : await blob(root, index.oid)
  } else {
    const index = await indexEntry(root, rel)
    const head = index === undefined ? await headEntry(root, rel) : undefined
    const base = index ?? head
    original = base === undefined ? null : await blob(root, base.oid)
    const working = await workingFile(rootReal, rel)
    modified = working.missing === true ? null : working
  }
  const sides = [original, modified]
  const binary = sides.some((s) => s?.binary === true)
  const tooLarge = sides.some((s) => s?.tooLarge === true)
  const hide = binary || tooLarge
  return {
    original: hide ? null : (original?.content ?? null),
    modified: hide ? null : (modified?.content ?? null),
    binary,
    tooLarge,
  }
}

/** A cheap fingerprint of the status for polling. */
export async function statusSignature(root) {
  const result = await git(['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], { cwd: root, timeout: 10_000 })
  return result.code === 0 ? result.stdout : null
}
