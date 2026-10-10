// The hosts listed in ~/.ssh/config, for the SSH picker. Read-only: the file is never written, and only
// aliases plus HostName / User / Port (for display) are kept. Nothing secret is read (IdentityFile and
// ProxyCommand lines are ignored).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isAlias } from './ssh-target.js'

const MAX_DEPTH = 4
const MAX_FILES = 50
const MAX_HOSTS = 500
const MAX_BYTES = 512 * 1024

/** `Keyword value` or `Keyword=value`, the value possibly quoted. */
const LINE = /^([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/

function unquote(value) {
  const v = value.trim()
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v
}

/** Split a `Host` / `Include` argument list on spaces, honouring double quotes. */
function words(value) {
  return [...value.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
}

/**
 * Parse ssh_config text into its concrete hosts. Patterns (`*`, `?`, `!`) are skipped: they name no machine.
 * Like ssh, the first value given for a keyword wins. `Match` blocks and settings outside any `Host` are ignored.
 * @param text - file contents.
 * @param onInclude - called with each `Include` argument, in file order; returns hosts from it (already parsed).
 * @returns `{alias, hostName?, user?, port?}[]`, in file order.
 */
export function parseSshConfig(text, onInclude = () => []) {
  const hosts = []
  let current = []
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const m = LINE.exec(line)
    if (m === null) continue
    const key = m[1].toLowerCase()
    const value = m[2]
    if (key === 'host') {
      current = []
      for (const pattern of words(value)) {
        if (/[*?!]/.test(pattern) || !isAlias(pattern)) continue
        const entry = { alias: pattern }
        current.push(entry)
        hosts.push(entry)
      }
    } else if (key === 'match') {
      current = []
    } else if (key === 'include') {
      for (const arg of words(value)) hosts.push(...onInclude(arg))
    } else if (key === 'hostname' || key === 'user' || key === 'port') {
      const field = key === 'hostname' ? 'hostName' : key
      const v = unquote(value)
      for (const entry of current) if (entry[field] === undefined && v.length > 0 && v.length <= 255) entry[field] = v
    }
  }
  return hosts
}

/** Does a file name match a glob made of literals, `*` and `?` (the only wildcards supported). */
function globMatch(pattern, name) {
  const literal = pattern.replace(/[.+^$(){}|[\]\\]/g, '\\$&')
  return new RegExp(`^${literal.replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(name)
}

/**
 * A reader for one ssh config directory that re-reads only when a file it used changed.
 * @param options.dir - the `.ssh` folder (tests point it at a temp folder); includes resolve against it.
 * @param options.home - for `~/` in an Include.
 */
export function createSshHosts({ dir = join(homedir(), '.ssh'), home = homedir() } = {}) {
  let cache
  const mtime = (path) => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return -1
    }
  }

  /** Read the config and everything it includes; `deps` lists every path whose mtime decides freshness. */
  function load() {
    const deps = new Map()
    let files = 0
    const watch = (path) => deps.set(path, mtime(path))
    function readFile(path, depth) {
      watch(path)
      if (files >= MAX_FILES) return []
      files++
      let text
      try {
        if (statSync(path).size > MAX_BYTES) return []
        text = readFileSync(path, 'utf8')
      } catch {
        return []
      }
      return parseSshConfig(text, (arg) => (depth >= MAX_DEPTH ? [] : expand(arg).flatMap((file) => readFile(file, depth + 1))))
    }
    /** Files an Include argument names: relative to the .ssh folder, `~/` allowed, `*` and `?` in the last segment. */
    function expand(arg) {
      const expanded = arg.startsWith('~/') ? join(home, arg.slice(2)) : arg
      const full = isAbsolute(expanded) ? expanded : resolve(dir, expanded)
      const slash = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'))
      const folder = full.slice(0, slash)
      const base = full.slice(slash + 1)
      if (!/[*?]/.test(base)) return [full]
      watch(folder)
      try {
        return readdirSync(folder).filter((name) => globMatch(base, name)).sort().map((name) => join(folder, name))
      } catch {
        return []
      }
    }
    const all = readFile(join(dir, 'config'), 0)
    const seen = new Set()
    const hosts = []
    for (const h of all) {
      if (seen.has(h.alias) || hosts.length >= MAX_HOSTS) continue
      seen.add(h.alias)
      hosts.push({ alias: h.alias, hostName: h.hostName ?? null, user: h.user ?? null, port: h.port !== undefined && /^\d{1,5}$/.test(h.port) ? Number(h.port) : null })
    }
    return { hosts, deps }
  }

  return {
    /** The current host list; never throws (a missing or unreadable config is an empty list). */
    get() {
      try {
        if (cache !== undefined && [...cache.deps].every(([path, time]) => mtime(path) === time)) return cache.hosts
        cache = load()
        return cache.hosts
      } catch {
        return []
      }
    },
  }
}
