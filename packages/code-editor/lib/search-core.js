// Search in files: the file-reading engines. `walkSearch` (non-git roots) and `locateHits` (turns `git grep` lines into
// exact matches) are CPU-bound with user supplied regular expressions, so search.js runs them in a worker thread it can
// terminate (a catastrophic pattern cannot freeze the host).
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { BINARY_SNIFF } from './files.js'
import { Collector, buildMatcher, byteColToCol, lineMatches, makePreview, pathFilter } from './search-match.js'

export const WALK_SKIP = new Set(['node_modules', '.git', 'dist', 'build'])
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_WALK_FILES = 100_000

/**
 * Depth-first walk below `rootReal` (symlinks are never followed or read), matching line by line.
 * @param emit - called with the groups found so far every few files (the worker forwards them as progress).
 * @returns `{ results, truncated }`
 */
export async function walkSearch(rootReal, params, emit = () => {}) {
  const { re } = buildMatcher(params)
  const accept = pathFilter(params.include, params.exclude)
  const out = new Collector(params.max)
  const stack = ['']
  let seen = 0
  let sent = 0
  walk: while (stack.length > 0) {
    const rel = stack.pop()
    let dirents
    try {
      dirents = await fs.readdir(join(rootReal, rel), { withFileTypes: true })
    } catch {
      continue
    }
    dirents.sort((a, b) => (a.name < b.name ? 1 : -1)) // popped in ascending order
    const files = []
    for (const dirent of dirents) {
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`
      if (dirent.isDirectory()) {
        if (!WALK_SKIP.has(dirent.name)) stack.push(childRel)
      } else if (dirent.isFile()) files.push(childRel)
    }
    files.reverse()
    for (const path of files) {
      if (seen++ > MAX_WALK_FILES) {
        out.truncated = true
        break walk
      }
      if (!accept(path)) continue
      const lines = await readTextLines(join(rootReal, path))
      if (lines === null) continue
      for (let i = 0; i < lines.length; i++) {
        for (const match of lineMatches(lines[i], i + 1, re)) if (!out.add(path, match)) break walk
      }
      if (out.matches > sent) {
        sent = out.matches
        emit(out.results)
      }
    }
  }
  return { results: out.results, truncated: out.truncated }
}

/** The lines of a UTF-8 text file, or null for binary / oversized / unreadable files. */
async function readTextLines(abs) {
  let handle
  try {
    handle = await fs.open(abs, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) return null
    const buffer = Buffer.alloc(stat.size)
    let read = 0
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    const data = buffer.subarray(0, read)
    if (data.subarray(0, BINARY_SNIFF).includes(0)) return null
    return new TextDecoder('utf-8').decode(data).split('\n')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Turn `git grep` hits (`{ path, line, byteCol, text }`, one per matching line) into precise matches (every
 * occurrence in the line, UTF-16 columns, lengths). A line the JavaScript matcher cannot see again (a PCRE/JS
 * difference) keeps git's column with a length of 1.
 */
export function locateHits(hits, params, emit = () => {}) {
  const { re } = buildMatcher(params)
  const out = new Collector(params.max)
  let n = 0
  for (const hit of hits) {
    const text = hit.text.replace(/\r$/, '')
    let found = lineMatches(text, hit.line, re)
    if (found.length === 0) {
      const col = byteColToCol(text, hit.byteCol)
      const { preview, at } = makePreview(text, col - 1, 1)
      found = [{ line: hit.line, col, length: 1, preview, at }]
    }
    for (const match of found) if (!out.add(hit.path, match)) return { results: out.results, truncated: out.truncated }
    if (++n % 200 === 0) emit(out.results)
  }
  return { results: out.results, truncated: out.truncated }
}
