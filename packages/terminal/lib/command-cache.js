// dsh-web-terminal — cached PATH lookups (host half).
//
// The info route asks where each agent CLI lives on every page load. A lookup spawns `where.exe` /
// `which`, so a found path is kept for the life of the host (like the ssh client), and a missing one
// is looked for again only after `missRetryMs`, in case it gets installed meanwhile. Concurrent
// lookups of one name share a single spawn.

/**
 * @param options.resolve - (name) => Promise<string|undefined>: the real lookup.
 * @param options.missRetryMs - how long "not found" is believed.
 * @param options.now - clock (ms), injectable for tests.
 */
export function createCommandCache({ resolve, missRetryMs = 30_000, now = Date.now }) {
  /** name -> {path} once found, {missedAt} after a miss, {running} while a lookup is in flight. */
  const entries = new Map()
  return {
    /** The command's path, or undefined when it is not on PATH. */
    async find(name) {
      const entry = entries.get(name)
      if (entry?.path !== undefined) return entry.path
      if (entry?.running !== undefined) return entry.running
      if (entry?.missedAt !== undefined && now() - entry.missedAt < missRetryMs) return undefined
      const running = Promise.resolve()
        .then(() => resolve(name))
        .catch(() => undefined)
        .then((path) => {
          entries.set(name, path === undefined ? { missedAt: now() } : { path })
          return path
        })
      entries.set(name, { running })
      return running
    },
    /** Forget every answer (the next lookup asks again). */
    clear() {
      entries.clear()
    },
  }
}
