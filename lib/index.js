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

import { execFile, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { WebSocketServer } from 'ws'

/** Stable cordis plugin name. */
const name = 'web-terminal'

/** Services required before the terminal surfaces can mount. */
const inject = ['webServer', 'subprocess']

/** The single upgrade path this plugin owns. */
const WS_PATH = '/terminal/ws'
/** The info route the browser half reads before opening a socket. */
const INFO_PATH = '/api/dsh-web-terminal/info'

/** Default terminal geometry; the browser re-fits its view without a resize call. */
const DEFAULT_ROWS = 50
const DEFAULT_COLS = 200

/** TERM-to-KILL grace for one terminal session. */
const GRACE_MS = 4000

/** Number of concurrent terminals allowed; each is a real OS process tree. */
const MAX_SESSIONS = 24

/** Scrollback kept per detached session so a reload can repaint it (characters). */
const REPLAY_LIMIT = 400_000

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
 * @returns the environment override for one terminal spawn.
 */
function terminalEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return env
}

/** Shell choices the picker can offer, keyed by the id the browser sends. */
const WINDOWS_SHELLS = {
  powershell: { label: 'PowerShell', file: 'powershell.exe', args: ['-NoLogo'] },
  pwsh: { label: 'PowerShell 7', file: 'pwsh.exe', args: ['-NoLogo'] },
  cmd: { label: 'Command Prompt', file: 'cmd.exe', args: [] },
  gitbash: { label: 'Git Bash', file: 'C:/Program Files/Git/bin/bash.exe', args: ['-i', '-l'] },
  wsl: { label: 'WSL', file: 'wsl.exe', args: [] },
}
const POSIX_SHELLS = {
  bash: { label: 'bash', file: '/bin/bash', args: ['-i'] },
  zsh: { label: 'zsh', file: '/bin/zsh', args: ['-i'] },
  sh: { label: 'sh', file: '/bin/sh', args: ['-i'] },
}

/** The platform default shell, and its arguments. */
function defaultShellSpec() {
  if (process.platform === 'win32') {
    const shell = process.env.COMSPEC ?? 'powershell.exe'
    return { file: shell, args: shell.toLowerCase().endsWith('powershell.exe') || shell.toLowerCase().endsWith('pwsh.exe') ? ['-NoLogo'] : [] }
  }
  return { file: process.env.SHELL ?? '/bin/bash', args: ['-i'] }
}

/**
 * Resolve a browser-supplied shell id to a program. Unknown ids fall back to
 * the default so a stale saved layout can never fail to open.
 * @param id - shell key from the query string.
 */
function shellSpec(id) {
  const table = process.platform === 'win32' ? WINDOWS_SHELLS : POSIX_SHELLS
  const entry = typeof id === 'string' ? table[id] : undefined
  return entry === undefined ? defaultShellSpec() : { file: entry.file, args: entry.args }
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

/**
 * Snapshot the OS process table as parent pid -> [{pid, name}].
 * @returns the map, or undefined when the platform query failed.
 */
function processChildren() {
  return new Promise((resolve) => {
    const [file, args] =
      process.platform === 'win32'
        ? [
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { ($_.ProcessId, $_.ParentProcessId, $_.Name) -join " " }'],
          ]
        : ['ps', ['-A', '-o', 'pid=,ppid=,comm=']]
    execFile(file, args, { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) return resolve(undefined)
      const children = new Map()
      for (const line of String(stdout).split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
        if (match === null) continue
        const ppid = Number(match[2])
        const list = children.get(ppid) ?? []
        list.push({ pid: Number(match[1]), name: match[3].toLowerCase() })
        children.set(ppid, list)
      }
      resolve(children)
    })
  })
}

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
  if (typeof handle.resize === 'function') Promise.resolve(handle.resize(cols, rows)).catch(() => {})
}

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
  /** Live sessions by id: {handle, ws, replay, exited, exitCode, shellId, cwd}. */
  const sessions = new Map()

  const server = new WebSocketServer({ noServer: true })

  const disposeUpgrade = ctx.webServer.registerUpgrade({
    path: WS_PATH,
    handler: (req, socket, head) => {
      server.handleUpgrade(req, socket, head, (ws) => {
        server.emit('connection', ws, req)
      })
    },
  })

  const send = (ws, frame) => {
    if (ws !== null && ws !== undefined && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }

  const disposeInfo = ctx.webServer.register({
    kind: 'exact',
    path: INFO_PATH,
    handler: async (_req, res) => {
      const table = process.platform === 'win32' ? WINDOWS_SHELLS : POSIX_SHELLS
      const shells = (
        await Promise.all(
          Object.entries(table).map(async ([id, entry]) => {
            const absolute = entry.file.includes('\\') || entry.file.includes('/')
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
        sessions: [...sessions.entries()].map(([id, session]) => ({ id, exited: session.exited, cwd: session.cwd, shell: session.shellId })),
      })
    },
  })

  /** End one session for good. */
  const destroy = (id) => {
    const session = sessions.get(id)
    if (session === undefined) return
    sessions.delete(id)
    try { session.ws?.close(1000, 'killed') } catch {}
    Promise.resolve(session.handle.terminate()).catch(() => {})
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
  let polling = false
  const activityTimer = setInterval(async () => {
    if (polling) return
    const watched = [...sessions.values()].filter((s) => !s.exited && s.ws !== null && typeof s.handle.pid === 'number')
    if (watched.length === 0) return
    polling = true
    try {
      const children = await processChildren()
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

  server.on('connection', async (ws, req) => {
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
    if (session !== undefined) {
      // Reattach: take the session from any stale socket and repaint scrollback.
      if (session.ws !== null && session.ws !== ws) {
        try { session.ws.close(4000, 'superseded') } catch {}
      }
      session.ws = ws
      send(ws, { type: 'attached', created: false, replay: session.replay, exited: session.exited, exitCode: session.exitCode })
      session.lastBusy = undefined
      if (cols > 0 && rows > 0 && !session.exited) resizeHandle(session.handle, cols, rows)
    } else {
      if (sessions.size >= MAX_SESSIONS && !reapExited()) {
        ws.close(1013, 'too many terminals')
        return
      }
      const shellId = url.searchParams.get('shell') ?? 'default'
      let cwd = url.searchParams.get('cwd')
      if (cwd === null || cwd.length === 0 || !existsSync(cwd)) cwd = homedir()
      const shell = shellSpec(shellId)
      let handle
      try {
        handle = await ctx.subprocess.spawnTerminal({
          argv: [shell.file, ...shell.args],
          cwd,
          env: terminalEnv(),
          rows: rows > 0 ? rows : DEFAULT_ROWS,
          cols: cols > 0 ? cols : DEFAULT_COLS,
          graceMs: GRACE_MS,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(ws, { type: 'error', message: `could not start terminal: ${message}` })
        try { ws.close(1011, 'spawn failed') } catch {}
        return
      }

      const live = { handle, ws, replay: '', exited: false, exitCode: null, shellId, cwd, lastBusy: undefined }
      session = live
      sessions.set(id, live)
      // One decoder per session so a multi-byte UTF-8 character split across two
      // PTY chunks is never emitted as replacement characters.
      const decoder = new StringDecoder('utf8')
      handle.output.on('data', (chunk) => {
        const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        if (text.length === 0) return
        live.replay += text
        if (live.replay.length > REPLAY_LIMIT) live.replay = live.replay.slice(live.replay.length - REPLAY_LIMIT)
        send(live.ws, { type: 'data', data: text })
      })
      handle.done.then(
        (outcome) => {
          live.exited = true
          live.exitCode = outcome?.exitCode ?? null
          send(live.ws, { type: 'exit', exitCode: live.exitCode })
        },
        () => {},
      )
      send(ws, { type: 'attached', created: true, replay: '', exited: false, exitCode: null })
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
        if (!bound.exited) Promise.resolve(bound.handle.write(message.data)).catch(() => {})
      } else if (message.type === 'resize') {
        const c = clampDim(message.cols, 0, 2, 500)
        const r = clampDim(message.rows, 0, 1, 200)
        if (c > 0 && r > 0 && !bound.exited) resizeHandle(bound.handle, c, r)
      } else if (message.type === 'signal' && typeof message.signal === 'string') {
        Promise.resolve(bound.handle.signalForeground(message.signal)).catch(() => {})
      } else if (message.type === 'kill') {
        destroy(id)
      } else if (message.type === 'close') {
        ws.close()
      }
    })

    // Detach only: the shell keeps running for a later reattach.
    const detach = () => {
      if (bound.ws === ws) bound.ws = null
    }
    ws.on('close', detach)
    ws.on('error', detach)
  })

  ctx.effect(() => () => {
    clearInterval(activityTimer)
    disposeUpgrade()
    disposeInfo()
    for (const id of [...sessions.keys()]) destroy(id)
    for (const client of server.clients) {
      try { client.terminate() } catch {}
    }
    try { server.close() } catch {}
  }, 'web-terminal: routes and sessions')
}

export { name, inject, apply }
export default { name, inject, apply }
