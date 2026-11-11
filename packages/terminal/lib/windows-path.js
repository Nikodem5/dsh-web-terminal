// Current Windows PATH for shells and lookups (Windows only).
//
// The desktop app inherits its PATH when it launches, and a plain relaunch keeps it, so a CLI installed
// afterwards is on neither the host's lookups nor a new terminal's PATH. The Machine and User PATH values
// are read from the registry with `reg.exe query` (async, never a blocking spawn) and merged behind the
// process PATH: nothing the app or harness put there is displaced, registry entries it lacks are appended.
// Every failure falls back to the process PATH unchanged.

import { execFile as realExecFile } from 'node:child_process'

/** How long a registry read (success or failure) is reused. */
const REG_TTL_MS = 30_000
/** A single `reg query` must answer within this long. */
const REG_TIMEOUT_MS = 3000

const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const USER_KEY = 'HKCU\\Environment'

/**
 * Parse `reg query <key> /v Path` output.
 * @param stdout - reg.exe output: a key line, then `    Path    REG_(EXPAND_)SZ    <value>`.
 * @returns {type, value}, or undefined when no such value line is there.
 */
function parseRegPath(stdout) {
  const match = /^[ \t]+Path[ \t]+(REG_EXPAND_SZ|REG_SZ)(?:[ \t]+(.*?))?[ \t]*$/im.exec(String(stdout).replace(/\r/g, ''))
  return match === null ? undefined : { type: match[1].toUpperCase(), value: match[2] ?? '' }
}

/** Case-insensitive env lookup (Windows variable names are). */
function envLookup(env, name) {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted && typeof value === 'string') return value
  return undefined
}

/**
 * Split a PATH value into entries, expanding `%VAR%` from env when asked.
 * An entry naming an unknown variable is left out.
 */
function entriesOf(value, expand, env) {
  const entries = []
  for (const raw of value.split(';')) {
    let entry = raw.trim()
    if (entry.length === 0) continue
    if (expand) {
      let known = true
      entry = entry.replace(/%([^%]+)%/g, (whole, name) => {
        const found = envLookup(env, name)
        if (found === undefined) known = false
        return found ?? whole
      })
      if (!known) continue
    }
    entries.push(entry)
  }
  return entries
}

/** Comparison form of an entry: case-folded, trailing backslashes ignored. */
const keyOf = (entry) => entry.toLowerCase().replace(/\\+$/, '')

/**
 * Process PATH first, untouched and in order; then registry entries it lacks, in the order given.
 * @param processPath - the process PATH value ('' or undefined for none).
 * @param lists - registry entry lists, earlier lists first.
 */
function mergePath(processPath, lists) {
  const parts = processPath === undefined || processPath === '' ? [] : [processPath]
  const seen = new Set(parts.length === 0 ? [] : processPath.split(';').map((entry) => keyOf(entry.trim())))
  for (const list of lists) {
    for (const entry of list) {
      const key = keyOf(entry)
      if (seen.has(key)) continue
      seen.add(key)
      parts.push(entry)
    }
  }
  return parts.join(';')
}

/** The key PATH lives under in env: `Path`, `PATH`... whichever is there (Windows), else `PATH`. */
function pathKey(env, platform = process.platform) {
  if (platform !== 'win32') return 'PATH'
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
}

/** A copy of env with PATH set under its existing key; other casings of the name are dropped so only one remains. */
function withPath(env, value, platform = process.platform) {
  const key = pathKey(env, platform)
  const out = {}
  let placed = false
  for (const [name, entry] of Object.entries(env)) {
    if (platform === 'win32' ? name.toLowerCase() === 'path' : name === 'PATH') {
      if (!placed) out[key] = value
      placed = true
    } else {
      out[name] = entry
    }
  }
  if (!placed) out[key] = value
  return out
}

/**
 * Create a registry-PATH reader.
 * @param options - overrides for tests: platform, execFile, now, env (the process environment).
 * @returns `merged()` (the merged PATH, or the process PATH on any failure) and `childEnv(base)`.
 */
function createWindowsPath(options = {}) {
  const platform = options.platform ?? process.platform
  const execFile = options.execFile ?? realExecFile
  const now = options.now ?? Date.now
  const env = options.env ?? process.env

  /** `DSH_WT_REGISTRY_PATH=0` (or false/off/no) leaves PATH alone. */
  const disabled = () => /^(0|false|off|no)$/i.test(String(env.DSH_WT_REGISTRY_PATH ?? '').trim())

  /** Registry entries (Machine then User; [] after a failure) and when they were read. */
  let cached
  let readAt = -Infinity
  let inflight = null

  /**
   * One value: its entries, [] for a missing key/value (reg exits 1), undefined for anything else.
   */
  function readKey(key) {
    return new Promise((resolve) => {
      try {
        execFile('reg.exe', ['query', key, '/v', 'Path'], { windowsHide: true, timeout: REG_TIMEOUT_MS }, (error, stdout) => {
          if (error !== null && error !== undefined) return resolve(error.code === 1 ? [] : undefined)
          const parsed = parseRegPath(stdout)
          resolve(parsed === undefined ? undefined : entriesOf(parsed.value, parsed.type === 'REG_EXPAND_SZ', env))
        })
      } catch {
        resolve(undefined)
      }
    })
  }

  async function read() {
    const [machine, user] = await Promise.all([readKey(MACHINE_KEY), readKey(USER_KEY)])
    // Half a registry PATH is not trusted: one failed side means none.
    return machine === undefined || user === undefined ? [] : [machine, user]
  }

  /** Registry entry lists, cached; a failed read is cached like any other until the TTL passes. */
  function registry() {
    if (cached !== undefined && now() - readAt < REG_TTL_MS) return Promise.resolve(cached)
    if (inflight !== null) return inflight
    inflight = read().catch(() => []).then((lists) => {
      cached = lists
      readAt = now()
      inflight = null
      return lists
    })
    return inflight
  }

  /** A PATH value with the registry's extra entries appended (as is off Windows or on failure). */
  async function mergeInto(current) {
    if (platform !== 'win32' || disabled()) return current
    const lists = await registry()
    return lists.length === 0 ? current : mergePath(current, lists)
  }

  return {
    /** @returns the process PATH with the registry's extra entries appended (the process PATH as is off Windows or on failure). */
    merged() {
      return mergeInto(env[pathKey(env, platform)])
    },
    /** @returns a copy of `base` whose PATH is base's merged with the registry's, under the key it already uses. */
    async childEnv(base) {
      const copy = { ...base }
      if (platform !== 'win32' || disabled()) return copy
      const value = await mergeInto(copy[pathKey(copy, platform)])
      return value === undefined ? copy : withPath(copy, value, platform)
    },
  }
}

/**
 * A folder to run `where.exe` from. `where` looks in its current directory before PATH, so run from the host's
 * own cwd it would hand back a binary planted in whatever folder the host was launched in as node, ssh or git.
 * System32 is writable by administrators only and holds none of those names.
 */
function listerCwd(env = process.env) {
  return `${env.SystemRoot || env.windir || 'C:\\Windows'}\\System32`
}

export { listerCwd, createWindowsPath, mergePath, parseRegPath, pathKey, withPath, REG_TTL_MS }
