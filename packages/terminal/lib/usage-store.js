// dsh-web-terminal — every provider's usage numbers and their file (host half).
//
// Each provider with a `usage` factory (see providers/index.js) gets one source. This module only
// routes payloads to them, collects their `stats()` for the stats route, and keeps usage.json:
//   { version: 2, providers: { <id>: <source.serialize()> } }
// A version 1 file (Claude only: { usage, tokens }) is read as Claude's.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param options.providers - the registered providers (each may have `usage`).
 * @param options.dir - the plugin's data folder; usage.json lives there.
 * @param options.saveMs - minimum time between two saves (a forced save ignores it).
 * @param options.now - clock (ms).
 */
export function createUsageStore({ providers, dir, saveMs = 30_000, now = Date.now }) {
  /** @type {Map<string, import('./providers/index.js').UsageSource>} */
  const sources = new Map()
  let dirty = false
  let lastSave = 0
  const file = join(dir, 'usage.json')

  for (const provider of providers) {
    if (typeof provider.usage !== 'function') continue
    try {
      const source = provider.usage()
      sources.set(provider.id, source)
      source.onChange?.(() => { dirty = true })
    } catch {
      // A provider whose usage cannot start leaves the others alone.
    }
  }

  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    const byId = saved?.version === 2 ? saved.providers : { claude: { usage: saved?.usage, tokens: saved?.tokens } }
    if (byId !== null && typeof byId === 'object') {
      for (const [id, source] of sources) {
        try { source.restore(byId[id]) } catch {}
      }
    }
  } catch {}

  return {
    /** Hand a payload to one provider's source. */
    ingest(providerId, terminalId, body) {
      const source = sources.get(providerId)
      if (source?.ingest === undefined) return
      try {
        if (source.ingest(terminalId, body)) dirty = true
      } catch {}
    },
    /** A terminal was destroyed: drop its per-session numbers everywhere. */
    removeSession(terminalId) {
      for (const source of sources.values()) {
        try { source.removeSession?.(terminalId) } catch {}
      }
    },
    /** `{ <id>: stats }` for every provider that has a source. */
    stats() {
      const out = {}
      for (const [id, source] of sources) {
        try { out[id] = source.stats() } catch { out[id] = null }
      }
      return out
    },
    /** Write usage.json if something changed (and the last save is old enough, unless forced); atomic. */
    save(force = false) {
      if (!dirty || (!force && now() - lastSave < saveMs)) return
      dirty = false
      lastSave = now()
      try {
        const providersOut = {}
        for (const [id, source] of sources) {
          try { providersOut[id] = source.serialize() } catch {}
        }
        mkdirSync(dir, { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify({ version: 2, providers: providersOut }))
        renameSync(tmp, file)
      } catch {}
    },
  }
}
