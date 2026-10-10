// Test doubles: an in-memory host API, a fake editor host (no Monaco), a memory storage.

import { ApiError } from '../../src/client/api.ts'

export class MemoryStorage {
  constructor() { this.m = new Map() }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null }
  setItem(k, v) { this.m.set(k, String(v)) }
}

/** A fake EditorHost: models are plain strings; `type()` simulates the user typing. */
export class FakeHost {
  constructor() {
    this.element = { remove() {}, style: {} }
    this.models = new Map()
    this.eols = new Map()
    this.shown = null
    this.diffShown = null
    this.revealed = null
    this.inline = false
    this.dark = null
    this.cb = { change: () => {}, cursor: () => {}, key: () => {} }
  }
  showFile(id, text) {
    if (!this.models.has(id)) { this.models.set(id, text.replace(/\r\n/g, '\n')); this.eols.set(id, text.includes('\r\n') ? 'crlf' : 'lf') }
    this.shown = id; this.diffShown = null
    return this.models.get(id)
  }
  showDiff(id, original, modified, language, inline) { this.diffShown = { id, original, modified, language, inline }; this.shown = null }
  showNone() { this.shown = null; this.diffShown = null }
  getValue(id) { return this.models.has(id) ? this.models.get(id) : null }
  setValue(id, text) { if (!this.models.has(id)) return false; this.models.set(id, text); this.cb.change(id); return true }
  hasModel(id) { return this.models.has(id) }
  getEol(id) { return this.eols.get(id) ?? 'lf' }
  disposeModel(id) { this.models.delete(id) }
  reveal(line, col) { this.revealed = { line, col } }
  setTheme(d) { this.dark = d }
  setInline(i) { this.inline = i }
  layout() {}
  focus() {}
  onChange(cb) { this.cb.change = cb }
  onCursor(cb) { this.cb.cursor = cb }
  onKey(cb) { this.cb.key = cb }
  dispose() {}
  // test helpers
  type(id, text) { this.models.set(id, text); this.cb.change(id) }
}

/**
 * An in-memory implementation of the host API. `fs` maps relative path -> { content, mtime }. Every call is
 * logged in `calls`. Set `failNext[name] = error` to make the next call of that name throw.
 */
export function makeApi(opts = {}) {
  const fs = new Map(Object.entries(opts.files ?? { 'a.txt': { content: 'hello\n', mtime: 1 } }))
  const calls = []
  const failNext = {}
  let status = opts.status ?? { branch: 'main', ahead: 0, behind: 0, files: [] }
  const dirs = opts.tree ?? {
    '': [{ name: 'src', type: 'dir', size: 0, mtime: 1 }, { name: 'a.txt', type: 'file', size: 6, mtime: 1 }],
    src: [{ name: 'b.ts', type: 'file', size: 3, mtime: 1 }],
  }
  const api = {
    calls, fs, failNext, dirs,
    setStatus(s) { status = s },
    async roots(roots) { calls.push(['roots', roots]); return { roots: roots.map((p) => ({ path: p, exists: !String(p).includes('missing'), isGit: true })), rejected: [] } },
    async tree(root, dir) { calls.push(['tree', root, dir]); if (failNext.tree) { const e = failNext.tree; failNext.tree = null; throw e } if (!(dir in dirs)) throw new ApiError('no such dir', 404); return dirs[dir] },
    async files(root) { calls.push(['files', root]); return { files: [...fs.keys()], truncated: false } },
    async readFile(root, path) {
      calls.push(['readFile', root, path])
      if (failNext.readFile) { const e = failNext.readFile; failNext.readFile = null; throw e }
      const f = fs.get(path)
      if (!f) throw new ApiError('not found', 404)
      return { content: f.content, mtime: f.mtime, size: f.content.length, binary: !!f.binary, tooLarge: !!f.tooLarge, eol: f.content.includes('\r\n') ? 'crlf' : 'lf' }
    },
    async writeFile(root, path, content, expectedMtime) {
      calls.push(['writeFile', root, path, content, expectedMtime])
      const f = fs.get(path)
      if (f && f.mtime !== expectedMtime) throw new ApiError('changed on disk', 409, 'conflict', { mtime: f.mtime })
      const mtime = (f?.mtime ?? 0) + 10
      fs.set(path, { content, mtime })
      return { mtime, size: content.length }
    },
    async gitStatus(root) {
      calls.push(['gitStatus', root])
      if (opts.notGit) throw new ApiError('not a git repository', 409, 'not-git')
      return JSON.parse(JSON.stringify(status))
    },
    async gitDiff(root, path, staged) { calls.push(['gitDiff', root, path, staged]); return { original: staged ? 'HEAD ' + path : 'INDEX ' + path, modified: staged ? 'INDEX ' + path : 'WORK ' + path, binary: false, tooLarge: false } },
    async stage(root, paths) { calls.push(['stage', root, paths]) },
    async unstage(root, paths) { calls.push(['unstage', root, paths]) },
    async discard(root, paths, untracked) { calls.push(['discard', root, paths, untracked]) },
    async resolve(path) { calls.push(['resolve', path]); return opts.resolve ? opts.resolve(path) : null },
    wsUrl(root) { return 'ws://test/code-editor/ws?root=' + encodeURIComponent(root) },
  }
  return api
}

export class FakeSocket {
  static all = []
  static reset() { FakeSocket.all = [] }
  constructor(url) { this.url = url; this.closed = false; this.onopen = this.onmessage = this.onclose = this.onerror = null; FakeSocket.all.push(this) }
  close() { this.closed = true }
  open() { this.onopen?.() }
  push(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  drop() { this.onclose?.() }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function until(check, what = 'condition', timeout = 3000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await sleep(5)
  }
  throw new Error('timed out waiting for ' + what)
}

export const gitFile = (path, o = {}) => ({ path, index: '.', worktree: 'M', staged: false, unstaged: true, untracked: false, conflicted: false, ...o })
