// dsh-web-terminal — host half.
//
// Gives the harness web GUI a real PTY: one WebSocket route (/terminal/ws)
// bridges a browser xterm.js instance to a native terminal process owned by
// this host process, plus a tiny /api/dsh-web-terminal/info probe the panel
// uses to label itself and decide whether a `claude` executable is on PATH.
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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { TOKEN_ENV, TOKEN_HEADER, buildClaudeSettings, normalizeSignal } from './agent-signals.js'
import { originAllowed, parseExtraOrigins } from './origin.js'
import { createGitBashResolver } from './git-bash.js'
import { POSIX_SHELLS, WINDOWS_SHELLS, defaultShellSpec, shellSpec } from './shells.js'
import { createProcessTable } from './process-table.js'
import { trimReplay } from './replay.js'
import { createSubagents } from './subagents.js'
import { userStatusLine } from './statusline.js'
import { OpenError, createOpener } from './open.js'
import { MAX_CANDIDATES, linuxCwd, resolveCandidates } from './paths.js'
import { createTokenTotals } from './token-totals.js'
import { createUsage } from './usage.js'

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

/** The stats route the stats bar polls. */
const STATS_PATH = '/api/dsh-web-terminal/stats'
/** Absolute path of the status-line wrapper Claude runs. */
const STATUSLINE_SCRIPT = fileURLToPath(new URL('./statusline.js', import.meta.url))
const HOOK_POST_SCRIPT = fileURLToPath(new URL('./hook-post.js', import.meta.url))
/** Refresh interval (s) for the wrapper when the user's own status line sets none. */
const DEFAULT_REFRESH_S = 10
/** Usage state is saved at most this often (ms), and once more on unload. */
const USAGE_SAVE_MS = 30_000

/** Default terminal geometry; the browser re-fits its view without a resize call. */
const DEFAULT_ROWS = 50
const DEFAULT_COLS = 200

/** TERM-to-KILL grace for one terminal session. */
const GRACE_MS = 4000

/** Number of concurrent terminals allowed; each is a real OS process tree. */
const MAX_SESSIONS = 24

/** Scrollback kept per detached session so a reload can repaint it (characters). */
const REPLAY_LIMIT = 400_000

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
  highWater: 4 * 1024 * 1024,
  /** ...and send one resync frame once the queue is back under this. */
  lowWater: 512 * 1024,
  /** How often a congested socket is checked for draining. */
  drainMs: 100,
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
    orphanMs: envNumber('DSH_WT_ORPHAN_MS', DEFAULTS.orphanMs),
    exitedMs: envNumber('DSH_WT_EXITED_MS', DEFAULTS.exitedMs),
    sweepMs: envNumber('DSH_WT_SWEEP_MS', DEFAULTS.sweepMs),
    subagentRetainMs: envNumber('DSH_WT_SUBAGENT_RETAIN_MS', DEFAULTS.subagentRetainMs),
    subagentThrottleMs: envNumber('DSH_WT_SUBAGENT_THROTTLE_MS', DEFAULTS.subagentThrottleMs),
    subagentSweepMs: envNumber('DSH_WT_SUBAGENT_SWEEP_MS', DEFAULTS.subagentSweepMs),
    allowedOrigins: parseExtraOrigins(process.env.DSH_WT_ALLOWED_ORIGINS),
  }
}

/** Where this plugin keeps files it generates (the Claude `--settings` file, saved usage). */
function dataDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'web-terminal')
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
 * @param token - this terminal's agent-signal secret.
 * @returns the environment override for one terminal spawn.
 */
function terminalEnv(token) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
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
function resolveOnPath(command) {
  return new Promise((resolve) => {
    let child
    try {
      const lister = process.platform === 'win32' ? 'where.exe' : 'which'
      child = spawn(lister, [command], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
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
    setTimeout(() => {
      try { child.kill() } catch {}
      finish(undefined)
    }, 3000).unref?.()
  })
}

/** Git Bash lookup, cached for the process: override env, registry, PATH, then common install dirs. */
const gitBash = createGitBashResolver({ which: resolveOnPath })

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

/** Run a provider call, swallowing both synchronous throws and async rejections. */
function safeCall(fn) {
  try {
    Promise.resolve(fn()).catch(() => {})
  } catch {}
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

  // Usage the Claude status line reports, and the lifetime token total. Both survive restarts
  // through usage.json so the stats bar is not empty until a terminal reports again.
  const usage = createUsage()
  const tokenTotals = createTokenTotals()
  // Resolved once: the async setup below must not follow a later change of DSH_HOME.
  const dir = dataDir()
  const usageFile = join(dir, 'usage.json')
  try {
    const saved = JSON.parse(readFileSync(usageFile, 'utf8'))
    usage.restore(saved?.usage)
    tokenTotals.restore(saved?.tokens)
  } catch {}
  let usageDirty = false
  let lastUsageSave = 0
  /** Write usage.json if something changed; atomic so a crash never leaves half a file. */
  const saveUsage = (force = false) => {
    if (!usageDirty || (!force && Date.now() - lastUsageSave < USAGE_SAVE_MS)) return
    usageDirty = false
    lastUsageSave = Date.now()
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = `${usageFile}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, usage: usage.serialize(), tokens: tokenTotals.serialize() }))
      renameSync(tmp, usageFile)
    } catch {}
  }
  tokenTotals.onScanned(() => { usageDirty = true })
  const usageTimer = setInterval(() => saveUsage(), USAGE_SAVE_MS)
  usageTimer.unref?.()
  /** Why the status-line wrapper is not installed, or null when it is. */
  let statusLineReason = 'starting'

  const config = readConfig()
  const server = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD })
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

  const send = (ws, frame) => {
    if (ws !== null && ws !== undefined && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }

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
      send(ws, { type: 'resync', replay: session.replay })
    }, config.drainMs)
    session.drainTimer.unref?.()
  }
  /** Forward one chunk of live output to the attached browser, unless it is falling behind. */
  const forwardData = (session, text) => {
    const ws = session.ws
    if (ws === null || ws.readyState !== ws.OPEN || session.congested) return
    if (ws.bufferedAmount > config.highWater) {
      session.congested = true
      watchDrain(session)
      return
    }
    send(ws, { type: 'data', data: text })
  }

  // Agent signals arrive on a small loopback-only HTTP server of our own rather than on the
  // harness web server: hooks run outside the browser, so they carry no app auth cookie, and a
  // dedicated listener keeps the per-terminal secret as the only credential.
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
  /** Sub-agent hooks and the end of the Claude session. @returns true when the event was a sub-agent one (no agent state to derive). */
  const trackSubagents = (session, body) => {
    switch (body?.hook_event_name) {
      case 'SubagentStart':
        if (session.subagents.start(body)) notifySubagents(session)
        return true
      case 'SubagentStop':
        if (session.subagents.stop(body)) notifySubagents(session)
        return true
      case 'SessionEnd':
        if (session.subagents.endAll()) notifySubagents(session)
        return false
      default:
        return false
    }
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
      if (match[1] === 'subagents') {
        // The sub-agent status line's payload: the live task list.
        if (session.subagents.ingestTasks(body)) notifySubagents(session)
        return reply(204)
      }
      if (match[1] === 'claude' && trackSubagents(session, body)) return reply(204)
      if (match[1] === 'usage') {
        // The status line's payload: limits and cost, not an agent state.
        if (usage.ingest(id, body)) usageDirty = true
        return reply(204)
      }
      const signal = normalizeSignal(match[1], body)
      if (signal !== undefined) {
        session.agent = { ...signal, at: Date.now() }
        send(session.ws, { type: 'agent', ...session.agent })
      }
      reply(204)
    })
    req.on('error', () => reply(400))
  })
  signalServer.on('error', () => resolveReady?.())
  /** Path of the Claude `--settings` file for this host process; null if it could not be written. */
  let claudeSettingsPath = null
  let resolveReady
  const signalReady = new Promise((resolve) => {
    resolveReady = resolve
    signalServer.listen(0, '127.0.0.1', async () => {
      // The wrapper runs under `node`; without it on PATH keep the user's own status line.
      const nodePath = await resolveOnPath('node')
      if (disposed) {
        try { signalServer.close() } catch {}
        return resolve()
      }
      try {
        mkdirSync(dir, { recursive: true })
        // Settings files of host processes that no longer exist are litter.
        for (const name of readdirSync(dir)) {
          const stale = /^claude-settings-(\d+)\.json$/.exec(name)
          if (stale !== null && Number(stale[1]) !== process.pid && !pidAlive(Number(stale[1]))) rmSync(join(dir, name), { force: true })
        }
        const file = join(dir, `claude-settings-${process.pid}.json`)
        const base = `http://127.0.0.1:${signalServer.address().port}/signal`
        const statusLine =
          nodePath === undefined
            ? undefined
            : { script: STATUSLINE_SCRIPT, url: `${base}/usage`, refreshInterval: userStatusLine()?.refreshInterval ?? DEFAULT_REFRESH_S }
        statusLineReason = statusLine === undefined ? 'node not on PATH' : null
        // SessionStart only runs command hooks, and the sub-agent status line is a command too: both need node.
        const hookScript = nodePath === undefined ? undefined : HOOK_POST_SCRIPT
        const subagentLine = nodePath === undefined ? undefined : { script: STATUSLINE_SCRIPT, url: `${base}/subagents` }
        writeFileSync(file, `${JSON.stringify(buildClaudeSettings(`${base}/claude`, { statusLine, hookScript, subagentLine }), null, 2)}\n`)
        claudeSettingsPath = file
      } catch {
        statusLineReason = 'settings file could not be written'
      }
      resolve()
    })
  })

  const disposeInfo = optional('info route', () => ctx.webServer.register({
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
      const claudePath = await resolveOnPath('claude')
      writeJson(res, 200, {
        ok: true,
        platform: process.platform,
        shell: defaultShellSpec().file,
        shells,
        cwd: homedir(),
        claude: { available: claudePath !== undefined, path: claudePath ?? null },
        maxSessions: MAX_SESSIONS,
        agent: { claudeSettings: claudeSettingsPath },
        sessions: [...sessions.entries()].map(([id, session]) => ({ id, exited: session.exited, cwd: session.cwd, shell: session.shellId })),
      })
    },
  }), noop)

  const disposeStats = optional('stats route', () => ctx.webServer.register({
    kind: 'exact',
    path: STATS_PATH,
    handler: async (_req, res) => {
      await signalReady
      writeJson(res, 200, {
        ok: true,
        limits: usage.limits(),
        cost: usage.cost(),
        tokens: tokenTotals.get(),
        statusLine: { enabled: statusLineReason === null, reason: statusLineReason },
      })
    },
  }), noop)

  // Clickable paths. `ctx.wtSpawn` is a test seam so no editor launches under test.
  // Read through optional(): a real cordis context THROWS on a property that was not injected.
  const wtSpawn = optional('spawn override', () => ctx.wtSpawn, undefined)
  const openPath = optional('opener', () => createOpener({ spawn: wtSpawn, which: resolveOnPath }), async () => { throw new OpenError('Opening files is unavailable') })
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
  const disposePaths = optional('paths route', () => ctx.webServer.register({
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
  const disposeOpen = optional('open route', () => ctx.webServer.register({
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

  /** End one session for good. */
  const destroy = (id) => {
    const session = sessions.get(id)
    if (session === undefined) return
    sessions.delete(id)
    tokens.delete(session.token)
    usage.removeSession(id)
    clearTimeout(session.subTimer)
    stopDrainWatch(session)
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
  const activityTimer = setInterval(async () => {
    if (polling) return
    const watched = [...sessions.values()].filter((s) => !s.exited && s.ws !== null && typeof s.handle.pid === 'number')
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
      stopDrainWatch(session)
      send(ws, { type: 'attached', created: false, replay: session.replay, exited: session.exited, exitCode: session.exitCode, agent: session.agent ?? null, subagents: session.subagents.list() })
      session.lastBusy = undefined
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
      const shell = shellSpec(shellId, { integration: url.searchParams.get('integration') !== '0' })
      const token = randomBytes(24).toString('hex')
      const spawning = (async () => {
        // Git Bash may live anywhere; fall back to the stock path so the spawn error stays meaningful.
        const file = shellId === 'gitbash' && process.platform === 'win32' ? ((await gitBash.resolve()) ?? shell.file) : shell.file
        const handle = await ctx.subprocess.spawnTerminal({
          argv: [file, ...shell.args],
          cwd,
          env: { ...terminalEnv(token), ...shell.env },
          rows: rows > 0 ? rows : DEFAULT_ROWS,
          cols: cols > 0 ? cols : DEFAULT_COLS,
          graceMs: GRACE_MS,
        })
        if (disposed) {
          // The plugin unloaded mid-spawn: nothing will sweep this one.
          safeCall(() => handle.terminate())
          throw new Error('plugin unloaded')
        }
        const created = { handle, ws: null, replay: '', exited: false, exitCode: null, shellId, cwd, lastBusy: undefined, token, agent: undefined, subagents: createSubagents({ retainMs: config.subagentRetainMs }), subSentAt: 0, subTimer: null, lastActive: Date.now(), congested: false, drainTimer: null }
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
        live.replay = trimReplay(live.replay + text, REPLAY_LIMIT)
        live.lastActive = Date.now()
        forwardData(live, text)
      })
      handle.done.then(
        (outcome) => {
          live.exited = true
          live.lastActive = Date.now()
          live.exitCode = outcome?.exitCode ?? null
          if (live.subagents.endAll()) notifySubagents(live)
          send(live.ws, { type: 'exit', exitCode: live.exitCode })
        },
        () => {},
      )
      // The socket may have closed during the spawn: store the session detached so the sweep applies.
      if (ws.readyState !== ws.OPEN) return
      live.ws = ws
      send(ws, { type: 'attached', created: true, replay: live.replay, exited: live.exited, exitCode: live.exitCode, agent: null, subagents: [] })
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
      } else if (message.type === 'signal' && ALLOWED_SIGNALS.has(message.signal)) {
        safeCall(() => bound.handle.signalForeground(message.signal))
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
      // A shell is RCE and any web page can open a socket to loopback: refuse foreign Origins
      // before the handshake so no session is ever created for them.
      if (!originAllowed(req.headers.origin, req.headers.host, config.allowedOrigins)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy())
        socket.on('error', () => {})
        return
      }
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
    for (const beat of heartbeats) clearInterval(beat)
    heartbeats.clear()
    safeCall(disposeUpgrade)
    safeCall(disposeInfo)
    safeCall(disposeStats)
    safeCall(disposePaths)
    safeCall(disposeOpen)
    clearInterval(usageTimer)
    saveUsage(true)
    try { signalServer.close() } catch {}
    if (claudeSettingsPath !== null) rmSync(claudeSettingsPath, { force: true })
    for (const id of [...sessions.keys()]) destroy(id)
    for (const client of server.clients) {
      try { client.terminate() } catch {}
    }
    try { server.close() } catch {}
  }, 'web-terminal: routes and sessions')
}

export { name, inject, apply }
export default { name, inject, apply }
