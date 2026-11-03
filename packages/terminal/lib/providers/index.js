// dsh-web-terminal — agent providers (host half).
//
// A provider is one kind of agent (Claude Code today). The registry is the only place the
// host learns what providers exist: `/signal/<id>` dispatches through it, the info route
// lists it, and the host writes each provider's launch files at start through it.
//
/**
 * What the host needs to know about one provider.
 *
 * @typedef {object} Provider
 * @property {string} id - URL-safe id (`[a-z][a-z0-9-]{0,30}`): the `/signal/<id>` path, the `provider` on its signals and the key in the info route.
 * @property {string} label - Product name for people ("Claude Code").
 * @property {string[]} commands - Executable names to look for on PATH; the first one found is reported.
 * @property {(body: object) => ({state: string, detail: string}|undefined)} [adapter] - The provider's own hook payload -> neutral signal; undefined for an event that says nothing about state. Without one, only bodies that already carry a neutral `state` are accepted.
 * @property {(env: PrepareEnv) => (Prepared|undefined)} [prepare] - Run once when the signal server is listening: write whatever files the provider's hooks need. Absent for a provider that needs none (zero-config).
 * @property {(call: Call, host: HostApi) => boolean} [intercept] - Look at a `/signal/<id>` body before it is read as an agent state; return true when it was consumed.
 * @property {Record<string, (call: Call, host: HostApi) => void>} [routes] - Extra `/signal/<name>` endpoints this provider owns (not agent states). Names share one namespace with provider ids.
 *
 * @typedef {object} PrepareEnv
 * @property {string} dir - Folder for generated files.
 * @property {number} pid - This host process's id.
 * @property {string} base - `http://127.0.0.1:<port>/signal`: where hooks post, without a trailing slash.
 * @property {string|undefined} nodePath - `node` on PATH, for hooks that are commands (undefined when missing).
 * @property {(pid: number) => boolean} pidAlive - Whether a process id is alive, for sweeping files of dead hosts.
 *
 * @typedef {object} Prepared
 * @property {Record<string, unknown>|null} [launch] - What the client needs to start the provider's command, shown in the info route; the client's provider entry knows how to use it (Claude: `{settingsPath}` for `--settings`). `{}` when nothing is needed, null when the files could not be written.
 * @property {Record<string, string>} [env] - Variables added to every terminal's shell, for a provider that reads its hook config from the environment instead of a flag.
 * @property {() => void} [dispose] - Remove what `prepare` wrote.
 * @property {string|null} [statusLineReason] - Why Claude's status-line wrapper is off (null: on). Reported by the stats route.
 *
 * @typedef {object} Call
 * @property {string} id - The terminal's session id.
 * @property {object} session - The host's session record (sub-agents, edits...).
 * @property {unknown} body - The parsed JSON body.
 *
 * @typedef {object} HostApi
 * @property {(session: object) => void} notifySubagents
 * @property {(session: object) => void} notifyEdits
 * @property {(id: string, body: unknown) => void} ingestUsage
 */
import { normalizeSignal } from '../agent-signals.js'
import { claude } from './claude.js'

const ID = /^[a-z][a-z0-9-]{0,30}$/

/**
 * A set of providers.
 * @param initial - the providers to start with.
 */
export function createRegistry(initial = []) {
  /** @type {Map<string, Provider>} */
  const byId = new Map()
  /** Route name -> {provider, handler}. */
  const routes = new Map()
  const taken = (name) => byId.has(name) || routes.has(name)

  /**
   * Add a provider.
   * @returns a function that removes it again.
   */
  const register = (provider) => {
    if (!ID.test(provider.id)) throw new Error(`invalid provider id "${provider.id}"`)
    if (!Array.isArray(provider.commands) || provider.commands.length === 0) throw new Error(`provider "${provider.id}" names no command`)
    const names = Object.keys(provider.routes ?? {})
    if (taken(provider.id) || names.some((name) => !ID.test(name) || taken(name) || name === provider.id)) throw new Error(`provider "${provider.id}" collides with a registered id or route`)
    byId.set(provider.id, provider)
    for (const name of names) routes.set(name, { provider, handler: provider.routes[name] })
    return () => {
      if (byId.get(provider.id) !== provider) return
      byId.delete(provider.id)
      for (const name of names) routes.delete(name)
    }
  }
  for (const provider of initial) register(provider)

  return {
    register,
    /** The provider with this id, or undefined. */
    get: (id) => byId.get(id),
    /** The provider that started with this executable name (`claude`), or undefined. */
    byCommand: (command) => [...byId.values()].find((p) => p.commands.includes(command)),
    /** Every provider, in registration order. */
    list: () => [...byId.values()],
    /** The extra endpoint `/signal/<name>`, or undefined. */
    route: (name) => routes.get(name),
    /**
     * A `/signal/<id>` body as a signal: the provider's adapter reads it, or it is a neutral signal already.
     * An id that is no provider only accepts neutral signals.
     */
    normalize: (id, body) => normalizeSignal(id, body, byId.get(id)?.adapter),
  }
}

/** The host's registry: Claude Code is built in. */
export const registry = createRegistry([claude])
