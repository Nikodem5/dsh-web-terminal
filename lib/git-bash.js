// Git Bash location (Windows).
//
// Git for Windows is not always under `C:\Program Files\Git`: per-user installs live in
// %LOCALAPPDATA%\Programs\Git, Scoop and custom directories are common. A hard-coded path makes
// the shell silently vanish from the picker, so the real one is looked up once and cached.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

/** How long a "not found" answer is reused before Git is looked for again (it may be installed later). */
const MISS_TTL_MS = 30_000

/**
 * Whether a path is the WSL launcher (`System32\bash.exe`), which is not Git Bash and must never be picked.
 * @param file - candidate bash path.
 */
function isWslLauncher(file) {
  return /[\\/](system32|sysnative|windowsapps)[\\/]/i.test(file)
}

/**
 * Derive the Git for Windows root from the path of `git.exe`.
 * `<root>\cmd\git.exe` and `<root>\mingw64\bin\git.exe` (or mingw32) are the layouts Git ships.
 * @param gitExe - absolute path of git.exe.
 * @returns the install root, or undefined for any other layout (e.g. a Scoop shim).
 */
function gitRootFromExe(gitExe) {
  const dir = win32.dirname(gitExe)
  const leaf = win32.basename(dir).toLowerCase()
  if (leaf === 'cmd') return win32.dirname(dir)
  if (leaf === 'bin') {
    const parent = win32.dirname(dir)
    if (/^mingw(32|64)$/i.test(win32.basename(parent))) return win32.dirname(parent)
  }
  return undefined
}

/**
 * Read `InstallPath` of a GitForWindows registry key through `reg query` (no shell involved).
 * @param key - e.g. `HKLM\SOFTWARE\GitForWindows`.
 * @returns the install root, or undefined when the key or value is missing.
 */
function regInstallPath(key) {
  return new Promise((resolve) => {
    try {
      execFile('reg.exe', ['query', key, '/v', 'InstallPath'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        if (error !== null) return resolve(undefined)
        const match = /InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(String(stdout))
        resolve(match === null ? undefined : match[1])
      })
    } catch {
      resolve(undefined)
    }
  })
}

/**
 * Build a cached Git Bash resolver. Dependencies are injectable so the order is testable off-machine.
 * @param deps - env, exists(path), reg(key), which(command); all default to the real machine.
 * @returns `resolve()` (async, cached) and `reset()`.
 */
function createGitBashResolver(deps) {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const reg = deps.reg ?? regInstallPath
  const which = deps.which
  const now = deps.now ?? Date.now
  let cached
  let missAt = -Infinity

  const bashOf = (root) => win32.join(root, 'bin', 'bash.exe')
  const usable = (file) => typeof file === 'string' && file.length > 0 && !isWslLauncher(file) && exists(file)

  async function search() {
    // 1. Explicit override: the owner's word wins, but a path that is not there is ignored, not trusted.
    const override = env.DSH_WT_GIT_BASH
    if (typeof override === 'string' && override.trim().length > 0 && usable(override.trim())) return override.trim()
    // 2. Installer registry keys (machine-wide, then per-user).
    for (const key of ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows']) {
      const root = await reg(key)
      if (typeof root === 'string' && usable(bashOf(root))) return bashOf(root)
    }
    // 3. git.exe on PATH, mapped back to the install root.
    const gitExe = which === undefined ? undefined : await which('git.exe')
    const root = typeof gitExe === 'string' ? gitRootFromExe(gitExe) : undefined
    if (root !== undefined && usable(bashOf(root))) return bashOf(root)
    // 4. Common locations.
    const home = env.USERPROFILE
    const candidates = [
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', 'Git'),
      env.ProgramFiles && win32.join(env.ProgramFiles, 'Git'),
      env['ProgramFiles(x86)'] && win32.join(env['ProgramFiles(x86)'], 'Git'),
      home && win32.join(home, 'scoop', 'apps', 'git', 'current'),
      env.SCOOP && win32.join(env.SCOOP, 'apps', 'git', 'current'),
      'C:\\Program Files\\Git',
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && usable(bashOf(candidate))) return bashOf(candidate)
    }
    return undefined
  }

  let inflight
  return {
    /** @returns the Git Bash path, or undefined when Git for Windows is not installed. */
    resolve() {
      if (cached !== undefined && exists(cached)) return Promise.resolve(cached)
      if (cached === undefined && now() - missAt < MISS_TTL_MS) return Promise.resolve(undefined)
      inflight ??= search()
        .catch(() => undefined)
        .then((found) => {
          cached = found
          if (found === undefined) missAt = now()
          return found
        })
        .finally(() => { inflight = undefined })
      return inflight
    },
    reset() {
      cached = undefined
      missAt = -Infinity
    },
  }
}

export { createGitBashResolver, gitRootFromExe, isWslLauncher }
