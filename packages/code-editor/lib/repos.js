// Nested repository discovery (what VS Code does for a workspace folder that is not itself a repository).
// Scans below a registered root for `.git` entries (a directory, or a file for worktrees and submodules).
// Symlinks and junctions are never followed, so every hit really lives inside the root.
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'

export const MAX_REPO_DEPTH = 4
export const MAX_REPOS = 50
const MAX_DIRS = 20_000
const SKIP = new Set(['node_modules'])

/**
 * Find repositories below `dir`.
 * @param dir - the root folder (display path; results are joined onto it).
 * @param options.maxDepth - folder levels below the root to look at (default 4).
 * @param options.cap - maximum repositories returned (default 50).
 * @returns `{ repos: [{ path, rel, name }], truncated }` sorted by `rel` (forward slashes).
 */
export async function findRepos(dir, { maxDepth = MAX_REPO_DEPTH, cap = MAX_REPOS } = {}) {
  const repos = []
  let truncated = false
  let visited = 0
  let level = [{ abs: dir, rel: '' }]
  for (let depth = 0; level.length > 0 && depth <= maxDepth && !truncated; depth++) {
    const next = []
    for (const { abs, rel } of level) {
      if (++visited > MAX_DIRS) {
        truncated = true
        break
      }
      let entries
      try {
        entries = await fs.readdir(abs, { withFileTypes: true })
      } catch {
        continue
      }
      if (entries.some((e) => e.name === '.git' && (e.isDirectory() || e.isFile()))) {
        if (repos.length >= cap) {
          truncated = true
          break
        }
        repos.push({ path: abs, rel, name: rel === '' ? basename(abs) : basename(rel) })
      }
      entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
      for (const e of entries) {
        if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.') || SKIP.has(e.name)) continue
        next.push({ abs: join(abs, e.name), rel: rel === '' ? e.name : `${rel}/${e.name}` })
      }
    }
    level = next
  }
  repos.sort((a, b) => (a.rel.toLowerCase() < b.rel.toLowerCase() ? -1 : a.rel.toLowerCase() > b.rel.toLowerCase() ? 1 : 0))
  return { repos, truncated }
}
