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
 * @property {() => ({feed: (text: string) => Array<{state: string, detail: string, kind?: string, session?: string}>})} [observe] - Create a parser for one terminal's output, for a provider that reports in the terminal stream instead of hooks. Called once per terminal the client says was started as this provider; `feed` gets each decoded chunk and returns the signals in it (a `kind: 'auth'` signal is held back by the host and dropped if another one follows soon). It must be cheap and must not throw (the host contains it if it does).
 * @property {Record<string, (call: Call, host: HostApi) => void>} [routes] - Extra `/signal/<name>` endpoints this provider owns (not agent states). Names share one namespace with provider ids.
 * @property {() => UsageSource} [usage] - Create this provider's usage numbers for the stats bar (once per host). Its `stats()` is reported under `providers.<id>` by the stats route, and its `serialize()` is saved in usage.json across restarts.
 *
 * @typedef {object} UsageSource
 * @property {(terminalId: string, body: unknown) => boolean} [ingest] - Take one usage payload from a terminal (through `HostApi.ingestUsage`); true when something worth saving changed.
 * @property {(terminalId: string) => void} [removeSession] - Forget a destroyed terminal's per-session numbers.
 * @property {() => object} stats - What the stats route reports for this provider (JSON-safe).
 * @property {() => unknown} serialize - JSON-safe state to keep across restarts.
 * @property {(saved: unknown) => void} restore - Load what `serialize` returned; garbage is ignored.
 * @property {(fn: () => void) => void} [onChange] - Called when state changed outside `ingest` (a background scan), so the host saves it.
 *
 * @typedef {object} PrepareEnv
 * @property {string} dir - Folder for generated files.
 * @property {number} pid - This host process's id.
 * @property {string} base - `http://127.0.0.1:<port>/signal`: where hooks post, without a trailing slash.
 * @property {string|undefined} nodePath - `node` on PATH, for hooks that are commands (undefined when missing).
 * @property {(pid: number) => boolean} pidAlive - Whether a process id is alive, for sweeping files of dead hosts.
 * @property {(command: string) => Promise<string|undefined>} [which] - A command's path on PATH (cached).
 * @property {string|null} [version] - This plugin's version.
 *
 * @typedef {object} Prepared
 * @property {Record<string, unknown>|null} [launch] - What the client needs to start the provider's command, shown in the info route; the client's provider entry knows how to use it (Claude: `{settingsPath}` for `--settings`). `{}` when nothing is needed, null when the files could not be written.
 * @property {Record<string, string>} [env] - Variables added to every terminal's shell, for a provider that reads its hook config from the environment instead of a flag.
 * @property {() => void} [dispose] - Remove what `prepare` wrote.
 * @property {() => (Record<string, unknown>|null)} [launchHint] - The launch hint as of now, for a provider whose hint changes while the host runs (an opt-in); used instead of `launch`.
 * @property {{status: () => object, install: () => Promise<object>, remove: () => Promise<object>}} [integration] - An opt-in integration the user installs and removes from the UI (the integration route); `status().error` is null after a successful action.
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
 * @property {(providerId: string, terminalId: string, body: unknown) => void} ingestUsage - Feed a payload to that provider's usage source.
 * @property {(session: object, signal: {provider: string, state: string, detail: string, kind?: string, session?: string}) => void} applySignal - Make a signal from the provider's own token-authenticated channel the terminal's state; from then on its terminal-output signals are ignored.
 */
import { normalizeSignal } from '../agent-signals.js'
import { claude } from './claude.js'
import { antigravity } from './antigravity.js'

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

/** The host's registry: Claude Code and the Antigravity CLI are built in. */
export const registry = createRegistry([claude, antigravity])
