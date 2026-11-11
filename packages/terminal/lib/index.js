// dsh-web-terminal — host half.
//
// Gives the harness web GUI a real PTY: one WebSocket route (/terminal/ws)
// bridges a browser xterm.js instance to a native terminal process owned by
// this host process, plus a tiny /api/dsh-web-terminal/info probe the panel
// uses to label itself and decide which agent executables (`claude`...) are on PATH.
//
// Why a plugin and not the built-in PTY tools: `ctx.terminals` (dsh-terminal)
// is owner-fenced to an agent and has no declarative auto-start, so a
// human-driven terminal cannot ride it. This half therefore uses the process
// primitive directly — `ctx.subprocess.spawnTerminal()` — which is exactly the
// "allocate a real PTY" primitive the built-in shell backend itself uses.
//
// Terminal sessions are process-local and tied to their socket: closing the
// socket (or unloading this plugin) terminates the process tree.
//
// Plain ESM on purpose — no build step for the host half.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { TOKEN_ENV, TOKEN_HEADER } from './agent-signals.js'
import { registry } from './providers/index.js'
import { parseExtraOrigins } from './shared/origin.js'
import { checkAccess, exposeToken, refuse, refuseUpgrade, selectProtocol } from './shared/local-auth.js'
import { createGitBashResolver } from './git-bash.js'
import { createSshHosts } from './ssh-config.js'
import { createGitHeader } from './git-header.js'
import { POSIX_SHELLS, WINDOWS_SHELLS, defaultShellSpec, shellSpec } from './shells.js'
import { activityDue, createProcessTable } from './process-table.js'
import { createWindowsPath, listerCwd } from './windows-path.js'
import { trimReplay } from './replay.js'
import { createSubagents } from './subagents.js'
import { createEdits } from './edits.js'
import { OpenError, createOpener } from './open.js'
import { MAX_CANDIDATES, linuxCwd, resolveCandidates } from './paths.js'
import { createCommandCache } from './command-cache.js'
import { createUsageStore } from './usage-store.js'
import { createSelfUpdate } from './self-update.js'
import { safeCall } from './shared/safe-call.js'
import { ASK_PATH, HIDDEN_PATH, createOverseer } from './overseer/index.js'

/** Stable cordis plugin name. */
const name = 'web-terminal'

/** Services required before the terminal surfaces can mount. */
const inject = ['webServer', 'subprocess']

/** The single upgrade path this plugin owns. */
const WS_PATH = '/terminal/ws'
/** The info route the browser half reads before opening a socket. */
const INFO_PATH = '/api/dsh-web-terminal/info'

/** Clickable terminal paths: existence check and open. */
const PATHS_PATH = '/api/dsh-web-terminal/paths'
const OPEN_PATH = '/api/dsh-web-terminal/open'
/** Bodies for those two are tiny; anything bigger is refused. */
const PATH_BODY_LIMIT = 128 * 1024

/** Update from source (GET status, POST start) and the app relaunch that loads the result. */
const UPDATE_PATH = '/api/dsh-web-terminal/update'
const RELAUNCH_PATH = '/api/dsh-web-terminal/relaunch'
/** This package's installed folder (the parent of lib/). */
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/** The stats route the stats bar polls. */
const STATS_PATH = '/api/dsh-web-terminal/stats'
/** Opt-in provider integrations (GET state, POST install / remove). */
const INTEGRATION_PATH = '/api/dsh-web-terminal/integration'
/** Usage state is saved at most this often (ms), and once more on unload. */
const USAGE_SAVE_MS = 30_000

/** Default terminal geometry; the browser re-fits its view without a resize call. */
const DEFAULT_ROWS = 50
const DEFAULT_COLS = 200

/** TERM-to-KILL grace for one terminal session. */
const GRACE_MS = 4000

/** Plugin version for the help panel's diagnostics; null if package.json is not beside lib/. */
const VERSION = (() => {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
})()

/** Number of concurrent terminals allowed; each is a real OS process tree. */
const MAX_SESSIONS = 24

/** Scrollback kept per detached session so a reload can repaint it (characters). */
const REPLAY_LIMIT = 400_000
/** The replay may grow this far past the limit before it is trimmed, so the copy trimming costs is not paid on every chunk. */
const REPLAY_SLACK = 100_000

/** Largest agent-signal request body accepted (bytes); real hook payloads are a few KB. */
const SIGNAL_BODY_LIMIT = 64 * 1024
/** Largest WebSocket message accepted from a browser (bytes): input, resize and control frames only. */
const WS_MAX_PAYLOAD = 1024 * 1024

/**
 * Timing and size knobs. Each can be overridden by an environment variable, read
 * when the plugin is applied (not at import) so tests can run them fast.
 */
const DEFAULTS = {
  /** Ping interval; a socket that has not answered by the next ping is dropped. */
  heartbeatMs: 15_000,
  /** Stop forwarding live output when this many bytes are queued for the browser... */
  highWater: 1024 * 1024,
  /** ...and send one resync frame once the queue is back under this. */
  lowWater: 256 * 1024,
  /** How often a congested socket is checked for draining. */
  drainMs: 100,
  /** Live output is gathered for this long and sent as one frame (a TUI repaint arrives as many small PTY chunks). */
  batchMs: 8,
  /** A shell nobody has attached to or heard output from for this long is killed (12 h: overnight builds survive, forgotten shells do not pile up). */
  orphanMs: 12 * 60 * 60 * 1000,
  /** A detached session whose process already exited is dropped after this (10 min: long enough to reload and read the exit message). */
  exitedMs: 10 * 60 * 1000,
  /** How often detached sessions are checked against the two limits above. */
  sweepMs: 30_000,
  /** A finished sub-agent stays listed this long. */
  subagentRetainMs: 5 * 60 * 1000,
  /** At most one `subagents` frame per terminal in this window (the status line fires many times a second). */
  subagentThrottleMs: 500,
  /** How often finished sub-agents are checked against the retention above. */
  subagentSweepMs: 5000,
  /** At most one `edits` frame per terminal in this window. */
  editThrottleMs: 300,
  /** A provider's `kind: 'auth'` signal waits this long for a later one before it is applied (agy shows it briefly at every start). */
  authHoldMs: 3000,
}

/** Read one positive number from the environment, else the default. */
function envNumber(key, fallback) {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Resolve the tunables from the environment. */
function readConfig() {
  return {
    heartbeatMs: envNumber('DSH_WT_HEARTBEAT_MS', DEFAULTS.heartbeatMs),
    highWater: envNumber('DSH_WT_HIGH_WATER', DEFAULTS.highWater),
    lowWater: envNumber('DSH_WT_LOW_WATER', DEFAULTS.lowWater),
    drainMs: envNumber('DSH_WT_DRAIN_MS', DEFAULTS.drainMs),
    batchMs: envNumber('DSH_WT_BATCH_MS', DEFAULTS.batchMs),
    orphanMs: envNumber('DSH_WT_ORPHAN_MS', DEFAULTS.orphanMs),
    exitedMs: envNumber('DSH_WT_EXITED_MS', DEFAULTS.exitedMs),
    sweepMs: envNumber('DSH_WT_SWEEP_MS', DEFAULTS.sweepMs),
    subagentRetainMs: envNumber('DSH_WT_SUBAGENT_RETAIN_MS', DEFAULTS.subagentRetainMs),
    subagentThrottleMs: envNumber('DSH_WT_SUBAGENT_THROTTLE_MS', DEFAULTS.subagentThrottleMs),
    subagentSweepMs: envNumber('DSH_WT_SUBAGENT_SWEEP_MS', DEFAULTS.subagentSweepMs),
    editThrottleMs: envNumber('DSH_WT_EDIT_THROTTLE_MS', DEFAULTS.editThrottleMs),
    authHoldMs: envNumber('DSH_WT_AUTH_HOLD_MS', DEFAULTS.authHoldMs),
    allowedOrigins: parseExtraOrigins(process.env.DSH_WT_ALLOWED_ORIGINS),
  }
}

/** Where this plugin keeps files it generates (a provider's launch files, saved usage). */
function dataDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'web-terminal')
}

/** A provider's current launch hint (it may change after an opt-in); null when asking it fails. */
function safeLaunch(prepared) {
  try {
    return prepared.launchHint()
  } catch {
    return null
  }
}

/** Whether a process id is alive (signal 0 probes without sending anything). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Registry PATH merge for new terminals and PATH lookups (Windows only; cached ~30 s). */
const windowsPath = createWindowsPath()

/**
 * Environment the shell starts from.
 *
 * `ctx.subprocess` deliberately scrubs credential-shaped names (`*KEY*`,
 * `*TOKEN*`, `*SECRET*`, `*PASSWORD*`) and `DSH_*` facts before spawning. That
 * scrub is right for an agent-spawned process and wrong for a human's shell: it
 * would strip ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN (so `claude` could not
 * authenticate), plus HTTP_PROXY, AWS keys, npm tokens, and anything else a real
 * terminal is expected to have. Explicit entries are layered back after the
 * scrub, so this restores the full parent environment verbatim.
 *
 * Security note: a terminal opened here therefore inherits the harness process
 * environment, including whatever keys launched the harness. That is the
 * ordinary meaning of "open a terminal", and it is why this panel is
 * human-driven and is not exposed as a model-callable tool.
 *
 * On Windows PATH is the process PATH plus whatever the registry's Machine/User PATH adds, so a CLI
 * installed after the app launched is found (one cached async read; falls back to the process PATH).
 * @param token - this terminal's agent-signal secret.
 * @returns the environment override for one terminal spawn.
 */
async function terminalEnv(token) {
  let env = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  env = await windowsPath.childEnv(env)
  // The per-terminal secret an agent's hooks send back with each signal.
  env[TOKEN_ENV] = token
  return env
}

/**
 * Locate one executable by name on PATH without spawning a shell.
 *
 * Uses the platform lister (`where` / `which`) with piped stdio purely as a
 * read-only probe, and answers "not found" for every failure mode rather than
 * throwing: a missing launcher degrades one button, never the panel.
 * @param command - bare executable name to look for.
 * @returns the first resolved absolute path, or undefined.
 */
async function resolveOnPath(command) {
  // The lister searches its own PATH, so on Windows it gets the registry-merged one.
  const env = process.platform === 'win32' ? await windowsPath.childEnv(process.env) : undefined
  return new Promise((resolve) => {
    let child
    try {
      const lister = process.platform === 'win32' ? 'where.exe' : 'which'
      child = spawn(lister, [command], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env, cwd: process.platform === 'win32' ? listerCwd() : undefined })
    } catch {
      resolve(undefined)
      return
    }
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.stdout?.on('data', (chunk) => { out += String(chunk) })
    child.on('error', () => finish(undefined))
    child.on('close', (code) => {
      if (code !== 0) return finish(undefined)
      const first = out.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
      finish(first)
    })
    // Only a hung lister should hit this: a lookup that merely runs slowly (a loaded machine) must not read as "not installed",
    // because the answer for `node` is kept for the life of the host.
    setTimeout(() => {
      try { child.kill() } catch {}
      finish(undefined)
    }, 15_000).unref?.()
  })
}

/** Git Bash lookup, cached for the process: override env, registry, PATH, then common install dirs. */
const gitBash = createGitBashResolver({ which: resolveOnPath })

/** The ssh client's path, looked up once it is found (a missing client is looked for again, in case it gets installed). */
let sshFound
async function findSsh() {
  sshFound ??= await resolveOnPath('ssh')
  return sshFound
}

/** Agent CLI lookups for the info route: a found path is kept, a miss is retried after 30 s (each lookup spawns a lister). */
const agentCommands = createCommandCache({ resolve: resolveOnPath })

/** The ssh part of a terminal request: the query parameters, unchecked (shellSpec validates). */
function sshRequest(params) {
  const get = (name) => params.get(name) ?? undefined
  return { host: get('sshHost'), target: get('sshTarget'), port: get('sshPort'), command: get('sshCommand') }
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** How often attached sessions are probed for a running child process. */
const ACTIVITY_MS = 3000

/** Console plumbing that is always a child of a shell and never "work". */
const IGNORED_CHILDREN = new Set(['conhost.exe', 'openconsole.exe', 'wslhost.exe'])

/** Whether any descendant of `root` (other than console plumbing) is alive. */
function hasRealDescendant(children, root) {
  const seen = new Set([root])
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.pop()
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      if (!IGNORED_CHILDREN.has(child.name)) return true
      queue.push(child.pid)
    }
  }
  return false
}

/** Resize a PTY when the subprocess provider supports it (older hosts have no resize call). */
function resizeHandle(handle, cols, rows) {
  if (typeof handle.resize === 'function') safeCall(() => handle.resize(cols, rows))
}

/** Signal names a browser may forward to the foreground process. */
const ALLOWED_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT'])

/** Clamp a browser-supplied terminal dimension to something a PTY accepts. */
function clampDim(value, fallback, min, max) {
  const n = Number.parseInt(String(value), 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/**
 * Mount the terminal routes.
 *
 * Sessions are keyed by a browser-chosen id and OUTLIVE their socket: a page
 * reload (or a dropped connection) detaches the browser but leaves the shell —
 * and whatever agent runs inside it — alive, with a bounded scrollback replayed
 * on reattach. Only an explicit `kill` frame, the process exiting on its own,
 * or the plugin unloading ends one.
 * @param ctx - host plugin context carrying webServer and subprocess.
 */
function apply(ctx) {
  /** Live sessions by id: {handle, ws, replay, exited, exitCode, shellId, cwd, token, agent}. */
  const sessions = new Map()
  /** Agent-signal secret -> session id. */
  const tokens = new Map()
  /** Spawns in flight by id: a concurrent connection awaits these and reattaches. */
  const pending = new Map()
  let disposed = false

  // Resolved once: the async setup below must not follow a later change of DSH_HOME.
  const dir = dataDir()
  // Each provider's usage numbers (Claude: limits, cost, all-time tokens). They survive restarts
  // through usage.json so the stats bar is not empty until a terminal reports again.
  const usageStore = createUsageStore({ providers: registry.list(), dir, saveMs: USAGE_SAVE_MS })
  const saveUsage = (force = false) => usageStore.save(force)
  const usageTimer = setInterval(() => saveUsage(), USAGE_SAVE_MS)
  usageTimer.unref?.()
  /** Why the status-line wrapper is not installed, or null when it is. */
  let statusLineReason = 'starting'

  const config = readConfig()
  const server = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, handleProtocols: selectProtocol })
  /**
   * Register a route that only a local, token-bearing request may reach (see shared/local-auth.js).
   * Every route here runs commands, reads files or reveals the machine, so none is left open.
   */
  const registerSecured = (route) =>
    ctx.webServer.register({
      ...route,
      handler: (req, res) => {
        const access = checkAccess(req, config.allowedOrigins)
        if (!access.ok) return refuse(res, access)
        return route.handler(req, res)
      },
    })
  /**
   * Run one optional feature's setup: if it throws (a host without some service, a duplicate route...)
   * log it and carry on, so the terminals themselves never depend on an extra.
   * @returns fn's result, or `fallback` when it threw.
   */
  const optional = (label, fn, fallback) => {
    try {
      return fn()
    } catch (error) {
      console.warn(`[web-terminal] ${label} unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return fallback
    }
  }
  const noop = () => {}
  // The token reaches the page through the harness's index-inject table; without it no route accepts the client.
  const disposeToken = optional('access token', () => exposeToken(ctx), noop)

  const send = (ws, frame) => {
    if (ws !== null && ws !== undefined && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }

  // Branch and dirty marker of each local terminal's folder for the window header (async git, throttled; see git-header.js).
  const gitHeader = optional('git header', () => createGitHeader({ which: resolveOnPath, send: (session, frame) => send(session.ws, frame), attached: (session) => session.ws !== null, minGapMs: envNumber('DSH_WT_GIT_GAP_MS', 2000), intervalMs: envNumber('DSH_WT_GIT_INTERVAL_MS', 30_000) }), null)

  // Backpressure. The provider's `handle.output` is a PassThrough fed by node-pty's onData with the
  // write() return value ignored, so pausing it only moves the buffering into that stream (unbounded)
  // and the PTY itself cannot be paused through the handle. So instead: while the browser socket is
  // congested, live frames are dropped (the replay buffer keeps filling, bounded), and once the
  // socket drains one `resync` frame carries the whole replay for the browser to repaint from.
  const stopDrainWatch = (session) => {
    if (session.drainTimer !== null) clearInterval(session.drainTimer)
    session.drainTimer = null
    session.congested = false
  }
  const watchDrain = (session) => {
    if (session.drainTimer !== null) return
    session.drainTimer = setInterval(() => {
      const ws = session.ws
      if (ws === null || ws.readyState !== ws.OPEN) return stopDrainWatch(session)
      if (ws.bufferedAmount > config.lowWater) return
      stopDrainWatch(session)
      send(ws, catchUpFrame(session))
    }, config.drainMs)
    session.drainTimer.unref?.()
  }
  /**
   * What a socket that fell behind missed. The frames it did get form an unbroken prefix of the stream, so the dropped
   * tail alone continues it; only when that tail outgrew the replay limit is the whole replay repainted.
   */
  const catchUpFrame = (session) => {
    const missed = session.missed
    session.missed = undefined
    return typeof missed === 'string' && missed !== '' ? { type: 'data', data: missed } : { type: 'resync', replay: replayOf(session) }
  }
  /** The scrollback to repaint from, trimmed to the limit (it may sit slightly over between trims). */
  const replayOf = (session) => {
    if (session.replay.length > REPLAY_LIMIT) session.replay = trimReplay(session.replay, REPLAY_LIMIT)
    return session.replay
  }
  /** Drop output gathered but not yet sent (a repaint from the replay covers it). */
  const dropPending = (session) => {
    clearTimeout(session.flushTimer)
    session.flushTimer = null
    session.pendingText = ''
  }
  /** Send the gathered live output as one frame, unless the browser is falling behind. */
  const flushData = (session) => {
    clearTimeout(session.flushTimer)
    session.flushTimer = null
    const text = session.pendingText
    session.pendingText = ''
    const ws = session.ws
    if (text === '' || ws === null || ws.readyState !== ws.OPEN || session.congested) return
    if (ws.bufferedAmount > config.highWater) {
      session.congested = true
      session.missed = text
      watchDrain(session)
      return
    }
    send(ws, { type: 'data', data: text })
  }
  /** Queue one chunk of live output for the attached browser; it goes out within `batchMs`. */
  const forwardData = (session, text) => {
    const ws = session.ws
    if (ws === null || ws.readyState !== ws.OPEN) return
    if (session.congested) {
      // null: too much was missed to resend, the whole replay is repainted instead.
      if (typeof session.missed === 'string') session.missed = session.missed.length + text.length > REPLAY_LIMIT ? null : session.missed + text
      return
    }
    session.pendingText += text
    if (session.flushTimer !== null) return
    session.flushTimer = setTimeout(() => flushData(session), config.batchMs)
    session.flushTimer.unref?.()
  }

  // Agent signals arrive on a small loopback-only HTTP server of our own rather than on the
  // harness web server: hooks run outside the browser, so they carry no app auth cookie, and a
  // dedicated listener keeps the per-terminal secret as the only credential.
  /**
   * Start reading a terminal's output for agent signals, when the client says it was started as a provider that
   * reports there (`Provider.observe`). Unknown ids, ssh windows and sessions already watched are ignored.
   */
  const watchOutput = (session, providerId) => {
    if (session.observer !== null || session.shellId === 'ssh' || typeof providerId !== 'string') return
    const observe = registry.get(providerId)?.observe
    if (typeof observe !== 'function') return
    try {
      session.observer = observe()
      session.observerProvider = providerId
    } catch {}
  }
  /** Drop a pending auth hold. */
  const cancelAuthHold = (session) => {
    clearTimeout(session.authTimer)
    session.authTimer = null
  }
  /** Make one observed signal the session's state and tell the attached browser. */
  const applyObserved = (session, signal) => {
    session.agent = { provider: session.observerProvider, ...signal, at: Date.now() }
    send(session.ws, { type: 'agent', ...session.agent })
    gitHeader?.signal(session, signal.state)
  }
  /** Feed one chunk to the session's observer; a failing observer is dropped, the terminal carries on. */
  const observeOutput = (session, text) => {
    try {
      for (const signal of session.observer.feed(text)) {
        // Once the provider reported over its trusted channel, printed sequences no longer set the state:
        // only an exit hint naming the conversation that channel reported is still believed.
        if (session.trusted === session.observerProvider && !(signal.state === 'ended' && signal.session !== undefined && signal.session === session.trustedSession)) continue
        if (signal.kind === 'auth') {
          // Held back: a later signal supersedes it, else it applies when the hold ends. A repeat does not extend it.
          if (session.authTimer === null) {
            session.authTimer = setTimeout(() => {
              session.authTimer = null
              if (!session.exited) applyObserved(session, signal)
            }, config.authHoldMs)
            session.authTimer.unref?.()
          }
          continue
        }
        cancelAuthHold(session)
        applyObserved(session, signal)
      }
    } catch {
      session.observer = null
    }
  }
  /** The stream is over: apply what the observer still held back (`end()`, optional on an observer). */
  const endObserved = (session) => {
    if (session.observer === null || typeof session.observer.end !== 'function') return
    try {
      for (const signal of session.observer.end()) {
        cancelAuthHold(session)
        applyObserved(session, signal)
      }
    } catch {}
    session.observer = null
  }
  /** The shell exited: an agent that reported in it is over too, whatever it said last (its conversation id is kept). */
  const markAgentEnded = (session) => {
    if (session.agent === undefined || session.agent.state === 'ended') return
    const { kind: _kind, ...last } = session.agent
    session.agent = { ...last, state: 'ended', detail: '', at: Date.now() }
    send(session.ws, { type: 'agent', ...session.agent })
  }
  /** Send the sub-agent list to the attached browser, at most once per throttle window. */
  const notifySubagents = (session) => {
    if (session.subTimer) return
    const wait = session.subSentAt + config.subagentThrottleMs - Date.now()
    const flush = () => {
      session.subTimer = null
      session.subSentAt = Date.now()
      send(session.ws, { type: 'subagents', tasks: session.subagents.list() })
    }
    if (wait <= 0) return flush()
    session.subTimer = setTimeout(flush, wait)
    session.subTimer.unref?.()
  }
  /** Send the changed-file list to the attached browser, at most once per throttle window. */
  const notifyEdits = (session) => {
    if (session.editTimer) return
    const wait = session.editSentAt + config.editThrottleMs - Date.now()
    const flush = () => {
      session.editTimer = null
      session.editSentAt = Date.now()
      send(session.ws, { type: 'edits', files: session.edits.list() })
    }
    if (wait <= 0) return flush()
    session.editTimer = setTimeout(flush, wait)
    session.editTimer.unref?.()
  }

  /** What a provider's routes and hooks may call back into. */
  const hostApi = {
    notifySubagents,
    notifyEdits,
    ingestUsage: (providerId, id, body) => usageStore.ingest(providerId, id, body),
    /** A signal from a provider's own token-authenticated channel: it becomes the state, and output sequences stop counting (see observeOutput). */
    applySignal: (session, signal) => {
      cancelAuthHold(session)
      session.trusted = signal.provider
      if (signal.session !== undefined) session.trustedSession = signal.session
      session.agent = { ...signal, at: Date.now() }
      send(session.ws, { type: 'agent', ...session.agent })
      gitHeader?.signal(session, signal.state)
    },
  }

  const signalServer = createServer((req, res) => {
    const reply = (status) => {
      if (res.headersSent || res.writableEnded) return
      res.writeHead(status, { 'cache-control': 'no-store' })
      res.end()
    }
    const match = /^\/signal\/([a-z][a-z0-9-]{0,30})$/.exec((req.url ?? '').split('?')[0])
    if (match === null) return reply(404)
    if (req.method !== 'POST') return reply(405)
    const header = req.headers[TOKEN_HEADER]
    const id = typeof header === 'string' ? tokens.get(header) : undefined
    const session = id === undefined ? undefined : sessions.get(id)
    if (session === undefined) return reply(401)
    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > SIGNAL_BODY_LIMIT) tooBig = true
      else chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooBig) return reply(413)
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return reply(400)
      }
      const call = { id, session, body }
      // Endpoints a provider owns that carry something other than an agent state (edits, usage, sub-agents).
      const route = registry.route(match[1])
      if (route !== undefined) {
        route.handler(call, hostApi)
        return reply(204)
      }
      if (registry.get(match[1])?.intercept?.(call, hostApi) === true) return reply(204)
      const signal = registry.normalize(match[1], body)
      if (signal !== undefined) {
        session.agent = { ...signal, at: Date.now() }
        send(session.ws, { type: 'agent', ...session.agent })
        gitHeader?.signal(session, signal.state)
      }
      reply(204)
    })
    req.on('error', () => reply(400))
  })
  signalServer.on('error', () => resolveReady?.())
  /** What each provider wrote at start, by provider id (see `Provider.prepare`). */
  const prepared = new Map()
  /** Variables the providers add to every terminal's shell. */
  const providerEnv = () => Object.assign({}, ...[...prepared.values()].map((p) => p.env))
  /** `node` as found on PATH for the status-line wrapper (undefined when missing). */
  let nodeBin
  let resolveReady
  const signalReady = new Promise((resolve) => {
    resolveReady = resolve
    signalServer.listen(0, '127.0.0.1', async () => {
      // Hooks that are commands run under `node`.
      const nodePath = await resolveOnPath('node')
      nodeBin = nodePath
      if (disposed) {
        try { signalServer.close() } catch {}
        return resolve()
      }
      const env = { dir, pid: process.pid, base: `http://127.0.0.1:${signalServer.address().port}/signal`, nodePath, pidAlive, which: (command) => agentCommands.find(command), version: VERSION }
      for (const provider of registry.list()) {
        try {
          const result = provider.prepare?.(env)
          if (result === undefined) continue
          prepared.set(provider.id, result)
          if (result.statusLineReason !== undefined) statusLineReason = result.statusLineReason
        } catch {
          // One provider that cannot write its files does not take the others down.
        }
      }
      resolve()
    })
  })

  /** ~/.ssh/config aliases for the SSH picker; re-read only when the file changes. */
  const sshHosts = createSshHosts()

  const disposeInfo = optional('info route', () => registerSecured({
    kind: 'exact',
    path: INFO_PATH,
    handler: async (_req, res) => {
      await signalReady
      const table = process.platform === 'win32' ? WINDOWS_SHELLS : POSIX_SHELLS
      const shells = (
        await Promise.all(
          Object.entries(table).map(async ([id, entry]) => {
            const absolute = entry.file.includes('\\') || entry.file.includes('/')
            if (id === 'gitbash' && process.platform === 'win32') {
              return (await gitBash.resolve()) === undefined ? undefined : { id, label: entry.label }
            }
            const found = absolute ? (existsSync(entry.file) ? entry.file : undefined) : await resolveOnPath(entry.file)
            return found === undefined ? undefined : { id, label: entry.label }
          }),
        )
      ).filter((entry) => entry !== undefined)
      const providers = Object.fromEntries(
        await Promise.all(
          registry.list().map(async (provider) => {
            let path
            for (const command of provider.commands) if ((path = await agentCommands.find(command)) !== undefined) break
            // No prepare step: nothing to inject, so the client can launch it as typed ({} = ready, null = files could not be written).
            const ready = prepared.get(provider.id)
            const launch = provider.prepare === undefined ? {} : ((ready?.launchHint !== undefined ? safeLaunch(ready) : ready?.launch) ?? null)
            return [provider.id, { available: path !== undefined, path: path ?? null, launch }]
          }),
        ),
      )
      const sshPath = await findSsh()
      writeJson(res, 200, {
        ok: true,
        version: VERSION,
        platform: process.platform,
        shell: defaultShellSpec().file,
        shells,
        cwd: homedir(),
        providers,
        node: { available: nodeBin !== undefined, path: nodeBin ?? null },
        ssh: { available: sshPath !== undefined, path: sshPath ?? null, hosts: sshHosts.get() },
        maxSessions: MAX_SESSIONS,
        sessions: [...sessions.entries()].map(([id, session]) => ({ id, exited: session.exited, cwd: session.cwd, shell: session.shellId })),
      })
    },
  }), noop)

  // Opt-in provider integrations (Antigravity's plugin and launch settings): GET lists their state,
  // POST {provider, action: 'install' | 'remove'} runs one. Nothing is installed without that POST.
  const disposeIntegration = optional('integration route', () => registerSecured({
    kind: 'exact',
    path: INTEGRATION_PATH,
    handler: async (req, res) => {
      // The body is read before waiting, so no chunk arrives before its listener.
      const body = req.method === 'POST' ? await readJsonBody(req, res) : null
      if (body === undefined) return
      await signalReady
      const all = () => Object.fromEntries([...prepared].filter(([, p]) => p.integration !== undefined).map(([id, p]) => [id, p.integration.status()]))
      if (body === null) return writeJson(res, 200, { ok: true, integrations: all() })
      const integration = typeof body.provider === 'string' ? prepared.get(body.provider)?.integration : undefined
      if (integration === undefined || (body.action !== 'install' && body.action !== 'remove')) return writeJson(res, 400, { ok: false, error: 'unknown provider or action' })
      const status = await (body.action === 'install' ? integration.install() : integration.remove())
      writeJson(res, 200, { ok: status.error === null, status, integrations: all() })
    },
  }), noop)

  const disposeStats = optional('stats route', () => registerSecured({
    kind: 'exact',
    path: STATS_PATH,
    handler: async (_req, res) => {
      await signalReady
      const statusLine = { enabled: statusLineReason === null, reason: statusLineReason }
      const providers = usageStore.stats()
      // The top-level fields are Claude's, as before per-provider stats existed.
      const claude = providers.claude ?? { limits: { fiveHour: null, sevenDay: null, sampledAt: null }, cost: null, tokens: null }
      writeJson(res, 200, { ok: true, limits: claude.limits, cost: claude.cost, tokens: claude.tokens, statusLine, providers })
    },
  }), noop)

  // Clickable paths. Tests swap the spawn through setSpawnForTests (lib/open.js) so no editor launches.
  const openPath = optional('opener', () => createOpener({ which: resolveOnPath }), async () => { throw new OpenError('Opening files is unavailable') })
  /** Read a small JSON POST body; replies and returns undefined on any problem. */
  const readJsonBody = (req, res) =>
    new Promise((resolve) => {
      const fail = (status, error) => {
        writeJson(res, status, { ok: false, error })
        resolve(undefined)
      }
      if (req.method !== 'POST') return fail(405, 'POST only')
      const chunks = []
      let size = 0
      let big = false
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > PATH_BODY_LIMIT) big = true
        else chunks.push(chunk)
      })
      req.on('error', () => resolve(undefined))
      req.on('end', () => {
        if (big) return fail(413, 'Body too large')
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Bad request')
          resolve(body)
        } catch {
          fail(400, 'Bad JSON')
        }
      })
    })
  /**
   * What relative paths in a terminal's output are relative to. Linux reads the live cwd of the
   * shell's foreground program from /proc; elsewhere the client's `cwd` is used: with shell integration
   * it is the folder the shell reported (OSC 633;P), otherwise the folder the shell started in, so after
   * a `cd` in a shell without integration relative paths resolve against the old folder.
   */
  const terminalCwd = (session, fallback) => {
    if (session !== undefined && process.platform === 'linux' && !session.exited) {
      const live = linuxCwd(session.handle.pid)
      if (live !== undefined) return live
    }
    if (typeof fallback === 'string' && fallback.length > 0) return fallback
    return session?.cwd
  }
  const disposePaths = optional('paths route', () => registerSecured({
    kind: 'exact',
    path: PATHS_PATH,
    handler: async (req, res) => {
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const { terminalId, candidates, cwd } = body
      if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES || !candidates.every((c) => typeof c === 'string')) {
        return writeJson(res, 400, { ok: false, error: `candidates must be at most ${MAX_CANDIDATES} strings` })
      }
      const session = typeof terminalId === 'string' ? sessions.get(terminalId) : undefined
      const results = await resolveCandidates(candidates, { cwd: terminalCwd(session, cwd), home: homedir() })
      writeJson(res, 200, { ok: true, results })
    },
  }), noop)
  const disposeOpen = optional('open route', () => registerSecured({
    kind: 'exact',
    path: OPEN_PATH,
    handler: async (req, res) => {
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      try {
        await openPath(body)
        writeJson(res, 200, { ok: true })
      } catch (error) {
        if (!(error instanceof OpenError)) return writeJson(res, 500, { ok: false, error: 'Could not open the file' })
        writeJson(res, 200, { ok: false, error: error.message })
      }
    },
  }), noop)

  // Update from source. These routes run commands.
  const selfUpdate = createSelfUpdate({ pluginDir: PLUGIN_DIR, node: () => nodeBin })
  const disposeUpdate = optional('update route', () => registerSecured({
    kind: 'exact',
    path: UPDATE_PATH,
    handler: async (req, res) => {
      if (req.method === 'POST') {
        await signalReady
        const started = selfUpdate.start()
        return writeJson(res, started ? 202 : 409, { ok: started, ...(await selfUpdate.status()) })
      }
      writeJson(res, 200, { ok: true, ...(await selfUpdate.status()) })
    },
  }), noop)
  const disposeRelaunch = optional('relaunch route', () => registerSecured({
    kind: 'exact',
    path: RELAUNCH_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
      await signalReady
      try {
        selfUpdate.relaunch()
        writeJson(res, 200, { ok: true })
      } catch (error) {
        writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), noop)

  // Overseer: read-only questions about the terminals. `llm` is optional and not in `inject`, so it is
  // looked up per request with ctx.get (a strict context throws on reading an un-injected property).
  const service = (key) => {
    try {
      return ctx.get(key) ?? undefined
    } catch {
      return undefined
    }
  }
  const overseer = optional('overseer', () => createOverseer({ sessions, service, dir }), undefined)
  const disposeOverseerAsk = overseer === undefined ? noop : optional('overseer route', () => registerSecured({ kind: 'exact', path: ASK_PATH, handler: overseer.askHandler }), noop)
  const disposeOverseerHidden = overseer === undefined ? noop : optional('overseer hidden route', () => registerSecured({ kind: 'exact', path: HIDDEN_PATH, handler: overseer.hiddenHandler }), noop)

  /** End one session for good. */
  const destroy = (id) => {
    const session = sessions.get(id)
    if (session === undefined) return
    sessions.delete(id)
    tokens.delete(session.token)
    usageStore.removeSession(id)
    clearTimeout(session.subTimer)
    clearTimeout(session.editTimer)
    gitHeader?.forget(session)
    cancelAuthHold(session)
    session.edits.clear()
    stopDrainWatch(session)
    dropPending(session)
    try { session.ws?.close(1000, 'killed') } catch {}
    safeCall(() => session.handle.terminate())
  }

  /** Make room under the cap by reaping an already-exited session. */
  const reapExited = () => {
    for (const [id, session] of sessions) {
      if (session.exited) {
        destroy(id)
        return true
      }
    }
    return false
  }

  // Tell attached browsers whether a child process (an agent, a build...) is running
  // under the shell, so the UI can tell "idle at a prompt" from "something is running".
  // The provider's own inspectActivity answers "unknown" on Windows, so the host walks
  // the OS process table itself: one query per poll covers every session.
  // On Windows that walk goes through one long-lived PowerShell helper, stopped when idle and on dispose.
  const processes = optional('process table', () => createProcessTable(), { snapshot: async () => undefined, stop() {} })
  let polling = false
  let activityTick = 0
  const activityTimer = setInterval(async () => {
    if (polling) return
    // A window in a hidden page is looked at on every few ticks only (its "agent stopped" alert still comes, later).
    activityTick++
    const watched = [...sessions.values()].filter((s) => !s.exited && s.ws !== null && typeof s.handle.pid === 'number' && activityDue(s.hidden === true, activityTick))
    if (watched.length === 0) return
    polling = true
    try {
      const children = await processes.snapshot()
      if (children === undefined) return
      for (const session of watched) {
        const busy = hasRealDescendant(children, session.handle.pid)
        if (busy === session.lastBusy) continue
        session.lastBusy = busy
        send(session.ws, { type: 'activity', busy })
      }
    } finally {
      polling = false
    }
  }, ACTIVITY_MS)
  activityTimer.unref?.()

  // Reap sessions nobody is attached to: a long-idle one is a forgotten shell, an exited one is
  // only kept briefly so a reload can still show how it ended. Attached sessions are never touched.
  const sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of [...sessions]) {
      if (session.ws !== null) continue
      if (now - session.lastActive > (session.exited ? config.exitedMs : config.orphanMs)) destroy(id)
    }
  }, config.sweepMs)
  sweepTimer.unref?.()
  const subagentTimer = setInterval(() => {
    for (const session of sessions.values()) if (session.subagents.prune()) notifySubagents(session)
  }, config.subagentSweepMs)
  subagentTimer.unref?.()

  /** Heartbeat timers of live connections, cleared on teardown. */
  const heartbeats = new Set()

  server.on('connection', async (ws, req) => {
    // Heartbeat: a half-open socket (sleep, dropped wifi) never fires close, which would leave the
    // session "attached" forever. Ping each interval; no pong by the next one means terminate, and
    // the normal close handler then detaches (the shell survives for a reattach).
    let alive = true
    ws.on('pong', () => { alive = true })
    const beat = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      try { ws.ping() } catch {}
    }, config.heartbeatMs)
    beat.unref?.()
    heartbeats.add(beat)
    const stopBeat = () => {
      clearInterval(beat)
      heartbeats.delete(beat)
    }
    ws.on('close', stopBeat)
    ws.on('error', stopBeat)

    let url
    try {
      url = new URL(req.url ?? WS_PATH, 'http://127.0.0.1')
    } catch {
      ws.close(1008, 'bad url')
      return
    }
    const id = (url.searchParams.get('id') ?? '').replace(/[^\w.-]/g, '').slice(0, 64)
    if (id.length === 0) {
      ws.close(1008, 'missing id')
      return
    }
    const cols = clampDim(url.searchParams.get('cols'), 0, 2, 500)
    const rows = clampDim(url.searchParams.get('rows'), 0, 1, 200)

    let session = sessions.get(id)
    if (session === undefined && pending.has(id)) {
      // Another connection is spawning this id: wait for it, then attach as a reattach.
      await pending.get(id).catch(() => {})
      session = sessions.get(id)
      if (session === undefined) {
        send(ws, { type: 'error', message: 'could not start terminal' })
        try { ws.close(1011, 'spawn failed') } catch {}
        return
      }
      if (ws.readyState !== ws.OPEN) return
    }
    if (session !== undefined) {
      // Reattach: take the session from any stale socket and repaint scrollback.
      if (session.ws !== null && session.ws !== ws) {
        try { session.ws.close(4000, 'superseded') } catch {}
      }
      session.ws = ws
      session.lastActive = Date.now()
      watchOutput(session, url.searchParams.get('provider'))
      stopDrainWatch(session)
      dropPending(session)
      send(ws, { type: 'attached', created: false, replay: replayOf(session), exited: session.exited, exitCode: session.exitCode, agent: session.agent ?? null, subagents: session.subagents.list(), edits: session.edits.list() })
      session.lastBusy = undefined
      session.hidden = false // the client says so again when its page is hidden
      gitHeader?.attach(session)
      if (cols > 0 && rows > 0 && !session.exited) resizeHandle(session.handle, cols, rows)
    } else {
      if (sessions.size + pending.size >= MAX_SESSIONS && !reapExited()) {
        ws.close(1013, 'too many terminals')
        return
      }
      const shellId = url.searchParams.get('shell') ?? 'default'
      let cwd = url.searchParams.get('cwd')
      if (cwd === null || cwd.length === 0 || !existsSync(cwd)) cwd = homedir()
      // The client turns integration off per launch (`integration=0`); DSH_WT_SHELL_INTEGRATION=0 turns it off for the host.
      const sshParams = shellId === 'ssh' ? sshRequest(url.searchParams) : undefined
      let shell
      try {
        shell = shellSpec(shellId, { integration: url.searchParams.get('integration') !== '0', ssh: sshParams })
      } catch (error) {
        // An invalid ssh request: say why instead of a blank terminal.
        send(ws, { type: 'error', message: `could not start ssh: ${error instanceof Error ? error.message : String(error)}` })
        try { ws.close(1008, 'bad ssh request') } catch {}
        return
      }
      const token = randomBytes(24).toString('hex')
      const spawning = (async () => {
        // The providers' variables exist only once they have prepared (see signalReady).
        await signalReady
        // Git Bash may live anywhere; fall back to the stock path so the spawn error stays meaningful.
        let file = shellId === 'gitbash' && process.platform === 'win32' ? ((await gitBash.resolve()) ?? shell.file) : shell.file
        if (shellId === 'ssh') file = (await findSsh()) ?? file
        const handle = await ctx.subprocess.spawnTerminal({
          argv: [file, ...shell.args],
          cwd,
          env: { ...(await terminalEnv(token)), ...providerEnv(), ...shell.env },
          rows: rows > 0 ? rows : DEFAULT_ROWS,
          cols: cols > 0 ? cols : DEFAULT_COLS,
          graceMs: GRACE_MS,
        })
        if (disposed) {
          // The plugin unloaded mid-spawn: nothing will sweep this one.
          safeCall(() => handle.terminate())
          throw new Error('plugin unloaded')
        }
        const created = { handle, ws: null, replay: '', exited: false, exitCode: null, shellId, cwd, lastBusy: undefined, token, agent: undefined, observer: null, observerProvider: null, subagents: createSubagents({ retainMs: config.subagentRetainMs }), subSentAt: 0, subTimer: null, edits: createEdits(), editSentAt: 0, editTimer: null, lastActive: Date.now(), congested: false, drainTimer: null, pendingText: '', flushTimer: null, authTimer: null }
        watchOutput(created, url.searchParams.get('provider'))
        sessions.set(id, created)
        tokens.set(token, id)
        return created
      })()
      pending.set(id, spawning)
      let live
      try {
        live = await spawning
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(ws, { type: 'error', message: `could not start terminal: ${message}` })
        try { ws.close(1011, 'spawn failed') } catch {}
        return
      } finally {
        pending.delete(id)
      }
      session = live
      const handle = live.handle
      // One decoder per session so a multi-byte UTF-8 character split across two
      // PTY chunks is never emitted as replacement characters.
      const decoder = new StringDecoder('utf8')
      handle.output.on('data', (chunk) => {
        const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        if (text.length === 0) return
        live.replay += text
        if (live.replay.length > REPLAY_LIMIT + REPLAY_SLACK) live.replay = trimReplay(live.replay, REPLAY_LIMIT)
        live.lastActive = Date.now()
        if (live.observer !== null) observeOutput(live, text)
        forwardData(live, text)
      })
      handle.done.then(
        (outcome) => {
          // Output the observer still holds (an exit hint with no newline after it), then the agent is over.
          endObserved(live)
          live.exited = true
          cancelAuthHold(live)
          live.lastActive = Date.now()
          live.exitCode = outcome?.exitCode ?? null
          if (live.subagents.endAll()) notifySubagents(live)
          // A congested socket missed output: repaint it from the replay now, so no later resync lands after the exit.
          if (!live.congested) flushData(live) // may find the socket backed up and mark it congested
          if (live.congested) {
            stopDrainWatch(live)
            dropPending(live)
            send(live.ws, catchUpFrame(live))
          }
          markAgentEnded(live)
          send(live.ws, { type: 'exit', exitCode: live.exitCode })
        },
        () => {},
      )
      // The socket may have closed during the spawn: store the session detached so the sweep applies.
      if (ws.readyState !== ws.OPEN) return
      live.ws = ws
      send(ws, { type: 'attached', created: true, replay: replayOf(live), exited: live.exited, exitCode: live.exitCode, agent: null, subagents: [], edits: [] })
      gitHeader?.attach(live)
    }

    const bound = session
    ws.on('message', (raw) => {
      if (bound.ws !== ws) return
      let message
      try {
        message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
      } catch {
        return
      }
      if (message === null || typeof message !== 'object') return
      if (message.type === 'input' && typeof message.data === 'string') {
        if (!bound.exited) safeCall(() => bound.handle.write(message.data))
      } else if (message.type === 'resize') {
        const c = clampDim(message.cols, 0, 2, 500)
        const r = clampDim(message.rows, 0, 1, 200)
        if (c > 0 && r > 0 && !bound.exited) resizeHandle(bound.handle, c, r)
      } else if (message.type === 'visibility') {
        bound.hidden = message.visible === false
      } else if (message.type === 'signal' && ALLOWED_SIGNALS.has(message.signal)) {
        safeCall(() => bound.handle.signalForeground(message.signal))
      } else if (message.type === 'git-refresh') {
        gitHeader?.request(bound, message.cwd)
      } else if (message.type === 'kill') {
        destroy(id)
      } else if (message.type === 'close') {
        ws.close()
      }
    })

    // Detach only: the shell keeps running for a later reattach.
    const detach = () => {
      if (bound.ws !== ws) return
      bound.ws = null
      bound.lastActive = Date.now()
      stopDrainWatch(bound)
    }
    ws.on('close', detach)
    ws.on('error', detach)
  })

  // Registered last, after the connection listener: an upgrade must never reach a server nobody listens on.
  const disposeUpgrade = ctx.webServer.registerUpgrade({
    path: WS_PATH,
    handler: (req, socket, head) => {
      // A shell is RCE: refuse non-local peers, foreign Hosts and Origins, and a missing token
      // before the handshake so no session is ever created for them.
      const access = checkAccess(req, config.allowedOrigins)
      if (!access.ok) return refuseUpgrade(socket, access)
      server.handleUpgrade(req, socket, head, (ws) => {
        server.emit('connection', ws, req)
      })
    },
  })

  ctx.effect(() => () => {
    disposed = true
    clearInterval(activityTimer)
    safeCall(() => processes.stop())
    clearInterval(sweepTimer)
    clearInterval(subagentTimer)
    gitHeader?.dispose()
    for (const beat of heartbeats) clearInterval(beat)
    heartbeats.clear()
    safeCall(disposeUpgrade)
    safeCall(disposeToken)
    safeCall(disposeInfo)
    safeCall(disposeStats)
    safeCall(disposeIntegration)
    safeCall(disposePaths)
    safeCall(disposeOpen)
    safeCall(disposeUpdate)
    safeCall(disposeRelaunch)
    safeCall(disposeOverseerAsk)
    safeCall(disposeOverseerHidden)
    safeCall(() => overseer?.dispose())
    safeCall(() => selfUpdate.dispose())
    clearInterval(usageTimer)
    saveUsage(true)
    try { signalServer.close() } catch {}
    for (const result of prepared.values()) safeCall(() => result.dispose?.())
    for (const id of [...sessions.keys()]) destroy(id)
    for (const client of server.clients) {
      try { client.terminate() } catch {}
    }
    try { server.close() } catch {}
  }, 'web-terminal: routes and sessions')
}

export { name, inject, apply }
export default { name, inject, apply }
