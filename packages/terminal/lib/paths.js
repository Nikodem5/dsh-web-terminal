// Path validation for clickable terminal paths: turns what the browser spotted in the output into
// real, normalised filesystem paths. Only `stat` is used; file contents are never read.

import { readFileSync, readlinkSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/** At most this many candidates per request, each at most this long. */
export const MAX_CANDIDATES = 50
export const MAX_CANDIDATE_LENGTH = 1024

/**
 * The working directory of a Linux process, or undefined. `/proc/<pid>/cwd` is a symlink the kernel
 * keeps current, so a `cd` in the shell is visible; nowhere else can the host see it (Windows only
 * knows the folder the shell started in).
 */
export function procCwd(pid, readlink = readlinkSync) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    const target = readlink(`/proc/${pid}/cwd`)
    return typeof target === 'string' && target.startsWith('/') ? target : undefined
  } catch {
    return undefined
  }
}

/**
 * Where a Linux terminal "is": the cwd of the deepest recent descendant of the shell (the foreground
 * program, e.g. an agent, whose relative paths are what the screen shows), else the shell's own.
 * `/proc/<pid>/task/<pid>/children` needs CONFIG_PROC_CHILDREN; without it this is just the shell's cwd.
 */
export function linuxCwd(pid, { readlink = readlinkSync, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  let best = procCwd(pid, readlink)
  let current = pid
  for (let depth = 0; depth < 4; depth++) {
    let kids
    try {
      kids = readFile(`/proc/${current}/task/${current}/children`).trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)
    } catch {
      break
    }
    if (kids.length === 0) break
    current = kids[kids.length - 1]
    best = procCwd(current, readlink) ?? best
  }
  return best
}

/** Git Bash / Cygwin write drive paths as /c/Users/x or /cygdrive/c/Users/x. */
function msysToWindows(candidate) {
  const m = /^\/(?:cygdrive\/)?([a-zA-Z])(?:\/(.*))?$/.exec(candidate)
  return m === null ? undefined : `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`
}

/**
 * Absolute paths to try for one browser-side candidate, best first.
 * @returns normalised paths (none when it cannot be made absolute).
 */
export function expand(candidate, { cwd, home, platform = process.platform }) {
  const p = platform === 'win32' ? win32 : posix
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_CANDIDATE_LENGTH || candidate.includes('\0')) return []
  const out = []
  if (candidate === '~' || /^~[\\/]/.test(candidate)) {
    if (home) out.push(p.resolve(home, candidate.slice(2)))
  } else if (p.isAbsolute(candidate)) {
    out.push(p.normalize(candidate))
    const mapped = platform === 'win32' ? msysToWindows(candidate) : undefined
    if (mapped !== undefined) out.push(p.normalize(mapped))
  } else if (cwd) {
    out.push(p.resolve(cwd, candidate))
  }
  return out
}

/**
 * Resolve candidates to existing paths.
 * @returns one `{candidate, path, isDir}` per input, `path: null` when nothing exists.
 */
export async function resolveCandidates(candidates, ctx, statFn = stat) {
  return Promise.all(
    candidates.map(async (candidate) => {
      for (const path of expand(candidate, ctx)) {
        try {
          const info = await statFn(path)
          return { candidate, path, isDir: info.isDirectory() }
        } catch {}
      }
      return { candidate, path: null, isDir: false }
    }),
  )
}
