// File operations below a confined root: tree, quick-open list, read, atomic write.
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { EditorError, fromFsError } from './errors.js'
import { resolveInside, splitRelative } from './confine.js'

export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_WRITE_BYTES = 4 * 1024 * 1024
export const BINARY_SNIFF = 8 * 1024
export const MAX_TREE_ENTRIES = 20_000
export const MAX_LIST_FILES = 50_000
const WALK_SKIP = new Set(['node_modules', '.git', 'dist', 'build'])
const hasNul = (buffer, length = buffer.length) => buffer.subarray(0, Math.min(length, BINARY_SNIFF)).includes(0)

/** Directory listing, directories first. */
export async function listTree(rootReal, dir) {
  const segments = splitRelative(dir, { allowEmpty: true })
  const abs = await resolveInside(rootReal, segments)
  let dirents
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true })
  } catch (error) {
    throw fromFsError(error)
  }
  const entries = []
  for (const dirent of dirents) {
    if (dirent.name === '.git') continue
    if (entries.length >= MAX_TREE_ENTRIES) break
    let stat
    try {
      stat = await fs.lstat(join(abs, dirent.name))
    } catch {
      continue
    }
    const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file'
    entries.push({ name: dirent.name, type, size: type === 'dir' ? 0 : stat.size, mtime: stat.mtimeMs })
  }
  const rank = (e) => (e.type === 'dir' ? 0 : 1)
  entries.sort((a, b) => rank(a) - rank(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.name < b.name ? -1 : 1))
  return { entries, abs }
}

/** Non-git quick-open walk; never follows symlinks, skips heavy folders. */
export async function walkFiles(rootReal, cap = MAX_LIST_FILES) {
  const files = []
  let truncated = false
  const stack = ['']
  while (stack.length > 0 && !truncated) {
    const rel = stack.pop()
    let dirents
    try {
      dirents = await fs.readdir(join(rootReal, rel), { withFileTypes: true })
    } catch {
      continue
    }
    dirents.sort((a, b) => (a.name < b.name ? 1 : -1))
    for (const dirent of dirents) {
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`
      if (dirent.isDirectory()) {
        if (!WALK_SKIP.has(dirent.name)) stack.push(childRel)
      } else if (dirent.isFile() || dirent.isSymbolicLink()) {
        if (files.length >= cap) {
          truncated = true
          break
        }
        files.push(childRel)
      }
    }
  }
  files.sort()
  return { files, truncated }
}

/** Classify a buffer (already limited to MAX_FILE_BYTES). */
export function decodeText(buffer) {
  if (hasNul(buffer)) return { binary: true, content: null }
  try {
    return { binary: false, content: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  } catch {
    return { binary: true, content: null }
  }
}

/** `crlf` when the first line break is CRLF. */
export function detectEol(text) {
  const i = text.indexOf('\n')
  return i > 0 && text[i - 1] === '\r' ? 'crlf' : 'lf'
}

/** Read one file for the editor. */
export async function readFile(rootReal, rel) {
  const abs = await resolveInside(rootReal, splitRelative(rel))
  let handle
  try {
    handle = await fs.open(abs, 'r')
  } catch (error) {
    throw fromFsError(error)
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new EditorError(400, 'not-file', 'Not a regular file')
    if (stat.size > MAX_FILE_BYTES) return { content: null, mtime: stat.mtimeMs, size: stat.size, binary: false, tooLarge: true, eol: 'lf' }
    const buffer = Buffer.alloc(stat.size)
    let read = 0
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    const data = buffer.subarray(0, read)
    const { binary, content } = decodeText(data)
    return { content, mtime: stat.mtimeMs, size: stat.size, binary, tooLarge: false, eol: content === null ? 'lf' : detectEol(content) }
  } catch (error) {
    throw fromFsError(error)
  } finally {
    await handle.close().catch(() => {})
  }
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      // Windows: the target may be briefly held open by a scanner or watcher.
      if (attempt < 5 && (error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES')) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
        continue
      }
      throw error
    }
  }
}

/**
 * Atomic write with an optimistic mtime check.
 * @param expectedMtime - mtime the client last saw; null creates a new file (409 when it exists).
 */
export async function writeFile(rootReal, rel, content, expectedMtime) {
  if (typeof content !== 'string') throw new EditorError(400, 'bad-request', 'content must be a string')
  if (expectedMtime !== null && (typeof expectedMtime !== 'number' || !Number.isFinite(expectedMtime))) {
    throw new EditorError(400, 'bad-request', 'expectedMtime must be a number or null')
  }
  const data = Buffer.from(content, 'utf8')
  if (data.length > MAX_WRITE_BYTES) throw new EditorError(413, 'too-large', 'Content too large')
  const abs = await resolveInside(rootReal, splitRelative(rel))
  let existing
  try {
    existing = await fs.stat(abs)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw fromFsError(error)
  }
  if (existing !== undefined) {
    if (!existing.isFile()) throw new EditorError(400, 'not-file', 'Not a regular file')
    if (expectedMtime === null || existing.mtimeMs !== expectedMtime) {
      throw new EditorError(409, 'conflict', 'File changed on disk', { mtime: existing.mtimeMs })
    }
  } else if (expectedMtime !== null) {
    throw new EditorError(409, 'conflict', 'File no longer exists', { mtime: null })
  }
  const dir = dirname(abs)
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (error) {
    throw fromFsError(error)
  }
  const temp = join(dir, `.${basename(abs).slice(0, 80)}.${randomBytes(6).toString('hex')}.dsh-tmp`)
  let handle
  try {
    handle = await fs.open(temp, 'wx', existing === undefined ? 0o644 : existing.mode & 0o777)
    await handle.writeFile(data)
    await handle.sync().catch(() => {})
    await handle.close()
    handle = undefined
    if (existing === undefined) {
      // Create-only: a hard link fails if somebody created the file meanwhile.
      try {
        await fs.link(temp, abs)
      } catch (error) {
        if (error?.code === 'EEXIST') {
          const now = await fs.stat(abs).catch(() => undefined)
          throw new EditorError(409, 'conflict', 'File already exists', { mtime: now?.mtimeMs ?? null })
        }
        await renameWithRetry(temp, abs)
      }
      await fs.rm(temp, { force: true })
    } else {
      await renameWithRetry(temp, abs)
    }
    const stat = await fs.stat(abs)
    return { mtime: stat.mtimeMs, size: stat.size }
  } catch (error) {
    throw fromFsError(error)
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}
