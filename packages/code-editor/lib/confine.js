// Root confinement. Every file or git path arrives as a RELATIVE, forward-slash path plus a registered root; this
// module turns it into an absolute path that is guaranteed (modulo races) to stay inside the root's real location.
import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { EditorError } from './errors.js'

export const MAX_PATH_LEN = 1024
export const MAX_SEGMENT_LEN = 255
const CONTROL = /[\u0000-\u001f\u007f]/
const WIN_BAD_CHARS = /[<>:"|?*]/
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const DOT_GIT = /^(\.git|git~\d+)$/i

/** Case-insensitive path comparison on Windows. */
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)

/** Whether `child` is `parent` or inside it (both real, absolute). */
export function isWithin(parent, child) {
  const rel = relative(norm(parent), norm(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Validate a client supplied relative path and split it into segments.
 * @param rel - relative path with forward slashes ('' = the root itself when allowEmpty).
 * @param options.allowEmpty - accept '' (the root).
 * @param options.allowGit - accept `.git` segments (never for client file or git paths).
 * @returns path segments without '' and '.'.
 */
export function splitRelative(rel, { allowEmpty = false, allowGit = false } = {}) {
  if (typeof rel !== 'string') throw new EditorError(400, 'bad-path', 'path must be a string')
  if (rel.length > MAX_PATH_LEN) throw new EditorError(400, 'bad-path', 'path too long')
  if (CONTROL.test(rel)) throw new EditorError(400, 'bad-path', 'path contains control characters')
  if (rel.includes('\\')) throw new EditorError(400, 'bad-path', 'use forward slashes')
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw new EditorError(403, 'escape', 'path must be relative')
  const segments = rel.split('/').filter((s) => s !== '' && s !== '.')
  for (const segment of segments) {
    if (segment === '..') throw new EditorError(403, 'escape', 'path escapes the root')
    if (segment.length > MAX_SEGMENT_LEN) throw new EditorError(400, 'bad-path', 'path segment too long')
    if (process.platform === 'win32') {
      if (WIN_BAD_CHARS.test(segment)) throw new EditorError(403, 'escape', 'illegal character in path')
      if (/[. ]$/.test(segment) || WIN_RESERVED.test(segment)) throw new EditorError(400, 'bad-path', 'reserved path segment')
    }
    if (!allowGit && DOT_GIT.test(segment)) throw new EditorError(403, 'forbidden', '.git is not accessible')
  }
  if (segments.length === 0 && !allowEmpty) throw new EditorError(400, 'bad-path', 'path required')
  return segments
}

/**
 * Resolve segments below a root to an absolute path inside its real location.
 * The deepest existing ancestor is realpath'd, so symlinks and junctions that leave the root are refused with
 * `escape`; missing tails are appended lexically (they cannot be links).
 * @param rootReal - realpath of the registered root.
 * @param segments - from {@link splitRelative}.
 * @param options.followLeaf - resolve a symlink at the final segment too (reads/writes); false for git operations that act on the link itself.
 */
export async function resolveInside(rootReal, segments, { followLeaf = true } = {}) {
  const head = segments.slice()
  const tail = []
  if (!followLeaf && head.length > 0) tail.unshift(head.pop())
  let real
  for (;;) {
    try {
      real = await fs.realpath(join(rootReal, ...head))
      break
    } catch (error) {
      if ((error?.code === 'ENOENT' || error?.code === 'ENOTDIR') && head.length > 0) {
        tail.unshift(head.pop())
        continue
      }
      throw error
    }
  }
  if (!isWithin(rootReal, real)) throw new EditorError(403, 'escape', 'path escapes the root')
  return join(real, ...tail)
}
