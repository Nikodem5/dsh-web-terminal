// The set of folders the editor may touch. Registered by the client, persisted, validated again on load.
import { promises as fs, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { isWithin } from './confine.js'

export const MAX_ROOTS = 256
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
const strip = (p) => (p.length > parse(p).root.length ? p.replace(/[\\/]+$/, '') : p)

/** Resolve the data dir (`<dsh home>/code-editor`). */
export function dataDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'code-editor')
}

/**
 * Validate a candidate root.
 * @returns `{ path, real }` or `{ error }` (a short reason).
 */
export async function validateRoot(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 1024 || /[\u0000-\u001f]/.test(candidate)) {
    return { error: 'invalid path' }
  }
  if (!isAbsolute(candidate)) return { error: 'must be absolute' }
  const path = strip(resolve(candidate))
  let real
  try {
    real = await fs.realpath(path)
    if (!(await fs.stat(real)).isDirectory()) return { error: 'not a directory' }
  } catch {
    return { error: 'not an existing directory' }
  }
  if (parse(real).root === real || parse(path).root === path) return { error: 'filesystem roots are refused' }
  let home
  try {
    home = await fs.realpath(homedir())
  } catch {
    home = resolve(homedir())
  }
  // The home folder itself and anything that contains it (C:\Users, /home) are too broad.
  if (isWithin(real, home)) return { error: 'the home folder (or a parent of it) is refused' }
  return { path, real }
}

/** Create the registry; `file` is roots.json. */
export function createRoots(file) {
  /** normalised path -> display path */
  const roots = new Map()
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(saved?.roots)) {
      for (const p of saved.roots.slice(0, MAX_ROOTS)) {
        if (typeof p === 'string' && isAbsolute(p)) roots.set(norm(strip(resolve(p))), strip(resolve(p)))
      }
    }
  } catch {}
  let revalidated = false

  const persist = () => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, `${JSON.stringify({ roots: [...roots.values()] }, null, 2)}\n`)
      renameSync(temp, file)
    } catch {}
  }

  return {
    /** Drop persisted roots that are no longer acceptable (tampered file). A vanished folder is kept (exists=false). */
    async revalidate() {
      if (revalidated) return
      revalidated = true
      for (const [key, path] of [...roots]) {
        const result = await validateRoot(path)
        if (result.error !== undefined && result.error !== 'not an existing directory') roots.delete(key)
      }
    },
    list: () => [...roots.values()],
    /** Register validated roots; returns rejected entries. */
    async register(candidates) {
      const rejected = []
      let changed = false
      for (const candidate of candidates) {
        const result = await validateRoot(candidate)
        if (result.error !== undefined) {
          rejected.push({ path: typeof candidate === 'string' ? candidate.slice(0, 200) : '', reason: result.error })
          continue
        }
        const key = norm(result.path)
        if (!roots.has(key)) {
          if (roots.size >= MAX_ROOTS) {
            rejected.push({ path: result.path, reason: 'too many roots' })
            continue
          }
          roots.set(key, result.path)
          changed = true
        }
      }
      if (changed) persist()
      return rejected
    },
    /** The registered root matching a client supplied string, as { path, real } or undefined. */
    async find(candidate) {
      if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 1024 || /[\u0000-\u001f]/.test(candidate) || !isAbsolute(candidate)) return undefined
      const path = roots.get(norm(strip(resolve(candidate))))
      if (path === undefined) return undefined
      try {
        return { path, real: await fs.realpath(path) }
      } catch {
        return undefined
      }
    },
  }
}
