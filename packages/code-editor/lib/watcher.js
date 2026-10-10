// One watcher per root, shared by every socket of that root. Frames: changed / git (see API.md).
//
// Windows and macOS: a single recursive fs.watch on the root.
// Linux (and wherever a recursive watch cannot be created): a non-recursive watch on the root, on `.git`, and on every
// directory the client has expanded (touchDir), plus a poll of `git status` every `pollMs` that raises a git frame.
// Limit: on that path, edits inside a folder the client never expanded are only noticed through the git poll.
import { watch } from 'node:fs'
import { join } from 'node:path'
import { statusSignature } from './git.js'

export const MAX_CHANGED_PER_FRAME = 500
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)

/**
 * @param options.debounceMs - flush window after the first event (150).
 * @param options.idleMs - keep a watcher this long after the last socket left (30 000).
 * @param options.pollMs - git status poll interval in fallback mode (2000).
 * @param options.mode - 'recursive' | 'fallback' (default by platform).
 */
export function createWatchers({ debounceMs = 150, idleMs = 30_000, pollMs = 2000, mode = process.platform === 'linux' ? 'fallback' : 'recursive' } = {}) {
  /** key -> entry */
  const entries = new Map()
  let disposed = false

  function broadcast(entry, frame) {
    for (const listener of [...entry.listeners]) {
      try {
        listener(frame)
      } catch {}
    }
  }

  function flush(entry) {
    entry.timer = null
    const git = entry.git
    const overflow = entry.overflow
    const paths = [...entry.pending]
    entry.git = false
    entry.overflow = false
    entry.pending.clear()
    if (overflow) broadcast(entry, { type: 'changed', paths: [], overflow: true })
    else if (paths.length > 0) broadcast(entry, { type: 'changed', paths })
    if (git) broadcast(entry, { type: 'git' })
  }

  function schedule(entry) {
    if (entry.timer === null && !disposed) {
      entry.timer = setTimeout(() => flush(entry), debounceMs)
      entry.timer.unref?.()
    }
  }

  function onEvent(entry, baseRel, filename) {
    if (filename === null || filename === undefined) {
      entry.overflow = true
      schedule(entry)
      return
    }
    const name = String(filename).replace(/\\/g, '/')
    const rel = baseRel === '' ? name : `${baseRel}/${name}`
    const segments = rel.split('/').filter((s) => s !== '' && s !== '.')
    if (segments.length === 0) return
    const gitAt = segments.indexOf('.git')
    if (gitAt >= 0) {
      if (gitAt === 0 && segments.length === 2 && (segments[1] === 'index' || segments[1] === 'HEAD')) {
        entry.git = true
        schedule(entry)
      }
      return
    }
    if (segments.includes('node_modules') || rel.endsWith('.dsh-tmp')) return
    if (!entry.overflow) {
      entry.pending.add(segments.join('/'))
      if (entry.pending.size > MAX_CHANGED_PER_FRAME) {
        entry.pending.clear()
        entry.overflow = true
      }
    }
    schedule(entry)
  }

  function watchDir(entry, rel, recursive) {
    const key = rel
    if (entry.dirs.has(key) || disposed) return
    let watcher
    try {
      watcher = watch(rel === '' ? entry.root : join(entry.root, ...rel.split('/')), { recursive, persistent: false }, (_event, filename) => onEvent(entry, rel, filename))
    } catch (error) {
      if (recursive) return false
      return // a directory that vanished or cannot be watched
    }
    watcher.on('error', () => {
      try {
        watcher.close()
      } catch {}
      entry.dirs.delete(key)
      entry.overflow = true
      schedule(entry)
    })
    entry.dirs.set(key, watcher)
    return true
  }

  function start(entry) {
    if (mode === 'recursive' && watchDir(entry, '', true) !== false) return
    entry.fallback = true
    watchDir(entry, '', false)
    if (entry.isGit) watchDir(entry, '.git', false)
    if (entry.isGit && pollMs > 0) {
      let busy = false
      const tick = async () => {
        if (busy || entry.listeners.size === 0) return
        busy = true
        try {
          const signature = await statusSignature(entry.root)
          if (signature !== null) {
            if (entry.signature !== undefined && entry.signature !== signature) {
              entry.git = true
              schedule(entry)
            }
            entry.signature = signature
          }
        } catch {
        } finally {
          busy = false
        }
      }
      entry.poll = setInterval(tick, pollMs)
      entry.poll.unref?.()
      tick() // baseline right away, so the first edit after connecting is noticed
    }
  }

  function stop(entry) {
    clearTimeout(entry.timer)
    clearTimeout(entry.idle)
    clearInterval(entry.poll)
    for (const watcher of entry.dirs.values()) {
      try {
        watcher.close()
      } catch {}
    }
    entry.dirs.clear()
    entries.delete(entry.key)
  }

  return {
    /**
     * Subscribe a socket to a root.
     * @param root - real path of the root.
     * @param isGit - whether to watch `.git` and poll status in fallback mode.
     * @param listener - receives frames.
     * @returns a function that unsubscribes (the watcher lingers `idleMs`).
     */
    acquire(root, isGit, listener) {
      if (disposed) return () => {}
      const key = norm(root)
      let entry = entries.get(key)
      if (entry === undefined) {
        entry = { key, root, isGit, listeners: new Set(), dirs: new Map(), pending: new Set(), overflow: false, git: false, timer: null, idle: null, poll: null, fallback: false, signature: undefined }
        entries.set(key, entry)
        start(entry)
      }
      clearTimeout(entry.idle)
      entry.idle = null
      entry.listeners.add(listener)
      const current = entry
      return () => {
        current.listeners.delete(listener)
        if (current.listeners.size === 0 && current.idle === null && !disposed) {
          current.idle = setTimeout(() => {
            if (current.listeners.size === 0) stop(current)
          }, idleMs)
          current.idle.unref?.()
        }
      }
    },
    /** Fallback mode: start watching a directory the client expanded. No-op in recursive mode. */
    touchDir(root, rel) {
      const entry = entries.get(norm(root))
      if (entry === undefined || !entry.fallback || rel === '') return
      watchDir(entry, rel.split('/').filter(Boolean).join('/'), false)
    },
    /** A git frame for everyone on the root (after stage/unstage/discard/write). */
    notifyGit(root) {
      const entry = entries.get(norm(root))
      if (entry !== undefined) broadcast(entry, { type: 'git' })
    },
    /** For tests and diagnostics. */
    stats: () => [...entries.values()].map((e) => ({ root: e.root, listeners: e.listeners.size, dirs: [...e.dirs.keys()], fallback: e.fallback, polled: e.signature !== undefined, idle: e.idle !== null })),
    dispose() {
      disposed = true
      for (const entry of [...entries.values()]) stop(entry)
    },
  }
}
