// dsh-web-terminal — terminal runtimes: the xterm instance and WebSocket behind each
// window, reconnecting, sizing, restart and log export.

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { emit, hostInfo, hostInfoReady, prefs, refreshHostInfo, runtimes, store, updateWin } from './state.ts'
import { cleanTitle, displayName } from './names.ts'
import { noteExit, noteHostBusy, noteHostRestart, noteUserInput, raiseAttention, restoreAgent, applyAgentSignal, tick } from './attention.ts'
import { withAgentHooks } from './launch.ts'
import { startupWait } from './prompt-ready.ts'
import { termTheme } from './theme.ts'
import { openSearch } from './search.ts'
import type { AgentSignal, Conn, Runtime, WinState } from './types.ts'

let ticker: ReturnType<typeof setInterval> | undefined

/**
 * Most output bytes a terminal may have queued in xterm before further output is dropped.
 * term.write is fire-and-forget and xterm parses it far slower than a socket can deliver, so a
 * runaway program (or a host that stops pacing itself) would otherwise grow the queue until the
 * page runs out of memory. Dropping is crude but bounded; the host's own backpressure and its
 * `resync` repaint are the real fix, this is the last line of defence.
 */
export const MAX_PENDING_BYTES = 5_000_000

/** Whether `incoming` more bytes fit in the queue without passing the limit. */
export function admitOutput(pending: number, incoming: number, limit = MAX_PENDING_BYTES): boolean {
  return pending + incoming <= limit
}

/**
 * A reconnect that finds a brand-new shell (`created`) for a terminal that was already attached in
 * this page lifetime means the host restarted or lost the session. The first attach after a page
 * reload also has `created: true`, but that is how a saved terminal comes back and resumes.
 */
export function isHostRestart(attachedBefore: boolean, created: boolean): boolean {
  return attachedBefore && created
}

/**
 * Whether `data` is one of the replies xterm generates itself for a program: cursor position (CSI r;c R),
 * device attributes / status / mode reports (CSI ... c, n, $y), window reports (CSI ... t), focus (CSI I/O),
 * mouse in SGR, urxvt or X10 form, and OSC/DCS answers. Real key presses are recognised separately (via
 * onKey) so a key that happens to look like a report, such as Shift+F3 (CSI 1;2 R), is still mirrored.
 */
export function isTerminalReport(data: string): boolean {
  return (
    /^\x1b\[(?:[IO]|[?>=]?[\d;]*[cn]|\??[\d;]*\$y|\d+(?:;\d+)*t|\??\d+;\d+(?:;\d+)?R|<\d+;\d+;\d+[Mm]|\d+;\d+;\d+M)$/.test(data) ||
    /^\x1b\[M[\s\S]{3}$/.test(data) ||
    /^\x1b[\]P][\s\S]*(?:\x07|\x1b\x5c)$/.test(data)
  )
}

function setConn(rt: Runtime, conn: Conn, detail = ''): void {
  rt.conn = conn
  rt.detail = detail
  tick()
  emit()
}

/**
 * WebSocket origin for the host. The desktop app serves the page from a custom
 * `dsh-app://app` scheme, so `location.host` is useless there: the app publishes the
 * real loopback origin as `__DSH_TRANSPORT__.streamBaseUrl` (its own stream client
 * does the same) and rewrites the upgrade's Origin/cookie for that address. In a
 * plain browser the page origin is the host.
 */
function socketBase(): string {
  const transport = (globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }).__DSH_TRANSPORT__
  const base = new URL(transport?.streamBaseUrl ?? window.location.href)
  return `${base.protocol === 'https:' ? 'wss' : 'ws'}://${base.host}`
}

/** Key combinations the app handles itself, so the terminal must not swallow them. */
function isAppShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
}

/** Build (once) the xterm + socket for a window. */
export function ensureRuntime(win: WinState): Runtime {
  const existing = runtimes.get(win.id)
  if (existing !== undefined) return existing

  const holder = document.createElement('div')
  holder.className = 'wt-holder'
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: prefs.font.family,
    fontSize: prefs.font.size,
    lineHeight: prefs.font.lineHeight,
    scrollback: 5000,
    allowProposedApi: true,
    // Keep text readable whatever colours a program prints (e.g. white text from a dark-themed TUI on a light background).
    minimumContrastRatio: 4.5,
    theme: termTheme(),
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  // Not opened here: a runtime is created at plugin start, before any page exists. xterm parses
  // writes without a renderer; `openRuntime` gives it a DOM once its window first mounts.

  const rt: Runtime = {
    id: win.id,
    holder,
    opened: false,
    term,
    fit,
    search,
    searchIndex: 0,
    searchCount: 0,
    socket: null,
    conn: 'connecting',
    detail: '',
    title: '',
    killed: false,
    retry: 0,
    attachedOnce: false,
    hostLost: false,
    pendingBytes: 0,
    droppedOutput: false,
    timer: undefined,
    lastCols: 0,
    lastRows: 0,
    activity: 'offline',
    hostBusy: undefined,
    lastOutputAt: 0,
    lastInputAt: 0,
    agent: undefined,
    hungRaised: false,
    attentionLevel: null,
    attentionLabel: '',
    attention: false,
    attentionReason: '',
  }
  runtimes.set(win.id, rt)
  ticker ??= setInterval(tick, 1000)

  // Bytes of the key press xterm is about to report through onData (onKey fires first, synchronously).
  let keyData: string | undefined
  term.onData((data) => {
    rt.lastInputAt = Date.now()
    if (rt.socket !== null && rt.socket.readyState === WebSocket.OPEN) rt.socket.send(JSON.stringify({ type: 'input', data }))
    const fromKey = keyData === data
    keyData = undefined
    // Live mirror: only what the user typed or pasted. onData also carries xterm's automatic answers to
    // program queries (cursor position, device attributes, focus and mouse reports), which belong to this
    // terminal's program alone and would be typed into the other shells.
    if (!fromKey && isTerminalReport(data)) return
    if (store.broadcast.on && store.broadcast.live && store.broadcast.ids.has(rt.id)) {
      for (const id of store.broadcast.ids) {
        if (id === rt.id) continue
        const other = runtimes.get(id)
        if (other?.socket?.readyState === WebSocket.OPEN) {
          other.lastInputAt = Date.now()
          other.socket.send(JSON.stringify({ type: 'input', data }))
        }
      }
    }
  })
  // Only real key presses count as the user answering a prompt. `onData` also carries the mouse and
  // focus reports xterm sends once a TUI turns on mouse tracking, so hovering would otherwise "answer".
  term.onKey(({ key }) => {
    keyData = key
    noteUserInput(rt)
  })
  term.onTitleChange((title) => {
    rt.title = title
    const w = store.wins.find((x) => x.id === rt.id)
    if (w !== undefined) {
      const name = cleanTitle(title, w.cwd)
      if (name !== undefined && name !== w.autoName) updateWin(rt.id, { autoName: name })
    }
    tick()
    emit()
  })
  term.onBell(() => raiseAttention(rt, { level: 'quiet', label: 'bell', reason: 'Rang the terminal bell' }))
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    rt.searchCount = resultCount
    rt.searchIndex = resultCount === 0 || resultIndex < 0 ? 0 : resultIndex + 1
    emit()
  })
  // Ctrl+C copies when there is a selection (otherwise it is SIGINT); Ctrl+Shift+C/V always copy/paste;
  // Ctrl+F opens the find bar.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (isAppShortcut(event)) return false
    const mod = event.ctrlKey || event.metaKey
    if (mod && !event.shiftKey && !event.altKey && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault()
      openSearch(rt.id)
      return false
    }
    if (mod && (event.key === 'c' || event.key === 'C') && (event.shiftKey || term.hasSelection())) {
      navigator.clipboard?.writeText(term.getSelection()).catch(() => {})
      return false
    }
    if (mod && event.shiftKey && (event.key === 'v' || event.key === 'V')) {
      navigator.clipboard?.readText().then((text) => term.paste(text)).catch(() => {})
      return false
    }
    return true
  })

  const connect = () => {
    if (rt.killed) return
    const current = store.wins.find((w) => w.id === rt.id)
    if (current === undefined) return
    const dims = rt.fit.proposeDimensions()
    const params = new URLSearchParams({ id: `${rt.id}-${current.gen ?? 0}`, shell: current.shell })
    if (current.cwd.length > 0) params.set('cwd', current.cwd)
    if (dims !== undefined && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
      params.set('cols', String(dims.cols))
      params.set('rows', String(dims.rows))
    }
    const socket = new WebSocket(`${socketBase()}/terminal/ws?${params.toString()}`)
    rt.socket = socket
    setConn(rt, 'connecting')
    // Startup typing waits for the shell's first output and then a quiet spell (see startupWait).
    let attachedAt = 0
    let lastOutputAt: number | undefined
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    let wakeStartup: (() => void) | undefined
    const stopStartup = () => {
      clearTimeout(startupTimer)
      wakeStartup = undefined
    }

    socket.onmessage = (event) => {
      let frame: { type: string; data?: string; replay?: string; created?: boolean; exited?: boolean; exitCode?: number | null; message?: string; busy?: boolean; agent?: AgentSignal | null } & Partial<AgentSignal>
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame.type === 'attached') {
        rt.retry = 0
        if (isHostRestart(rt.attachedOnce, frame.created === true)) {
          // Keep the old screen as the record of what was lost, and do not replace a long-running
          // agent with a fresh shell unasked: kill the one the host just spawned and offer Restart.
          rt.hostLost = true
          try {
            socket.send(JSON.stringify({ type: 'kill' }))
          } catch {}
          setConn(rt, 'exited', 'host restarted')
          noteHostRestart(rt)
          // The new host writes its own per-process settings file; the path we know belongs to the dead one.
          refreshHostInfo()
          term.write('\r\n\x1b[2m[host restarted: this shell is gone, restart this window]\x1b[0m\r\n')
          return
        }
        rt.attachedOnce = true
        stopStartup()
        attachedAt = Date.now()
        lastOutputAt = undefined
        // A fresh shell has no agent yet; a reattached one reports what its agent was last doing.
        rt.agent = undefined
        restoreAgent(rt, frame.agent)
        term.reset()
        if ((frame.replay ?? '').length > 0) term.write(frame.replay as string)
        if (frame.exited === true) {
          setConn(rt, 'exited', `exit ${frame.exitCode ?? 'signal'}`)
        } else {
          setConn(rt, 'live')
          rt.lastCols = 0
          sizeToHost(rt)
          const startup = store.wins.find((w) => w.id === rt.id)?.startup
          if (frame.created === true && startup !== undefined && startup.trim().length > 0) {
            // Wait for the host probe first: it names the agent-hook settings file, and on a cold app
            // start it can answer after the shell is already up.
            void hostInfoReady().then(() => {
              // Type once the shell has printed and gone quiet (its prompt is up), not after a fixed delay:
              // a slow profile would eat the command, a fast one waits for nothing.
              const check = () => {
                clearTimeout(startupTimer)
                if (rt.killed || rt.socket !== socket || socket.readyState !== WebSocket.OPEN) return stopStartup()
                const wait = startupWait(Date.now(), attachedAt, lastOutputAt)
                if (wait > 0) {
                  startupTimer = setTimeout(check, wait)
                  return
                }
                stopStartup()
                // Read the session when typing, not at attach: a slow probe may have delayed us.
                const session = store.wins.find((w) => w.id === rt.id)?.agentSession
                const command = withAgentHooks(startup, hostInfo.agent?.claudeSettings, session)
                socket.send(JSON.stringify({ type: 'input', data: `${command}\r` }))
              }
              wakeStartup = check
              rt.stopStartup = stopStartup
              check()
            })
          }
        }
      } else if (frame.type === 'resync') {
        // The host dropped output on a congested socket; its replay is the screen as it really is.
        if (typeof frame.replay !== 'string') return
        term.reset()
        if (frame.replay.length > 0) term.write(frame.replay)
      } else if (frame.type === 'data') {
        if (rt.hostLost || typeof frame.data !== 'string') return
        lastOutputAt = Date.now()
        wakeStartup?.()
        rt.lastOutputAt = Date.now()
        if (!admitOutput(rt.pendingBytes, frame.data.length)) {
          rt.droppedOutput = true
          return
        }
        const size = frame.data.length
        rt.pendingBytes += size
        term.write(frame.data, () => {
          rt.pendingBytes = Math.max(0, rt.pendingBytes - size)
          if (rt.droppedOutput && rt.pendingBytes === 0) {
            rt.droppedOutput = false
            term.write('\r\n\x1b[2m[output was too fast and part of it was dropped]\x1b[0m\r\n')
          }
        })
      } else if (frame.type === 'activity') {
        noteHostBusy(rt, frame.busy === true)
      } else if (frame.type === 'agent') {
        if (typeof frame.state === 'string') applyAgentSignal(rt, { provider: frame.provider ?? 'unknown', state: frame.state, detail: frame.detail ?? '', at: frame.at, session: frame.session })
      } else if (frame.type === 'exit') {
        if (rt.hostLost) return
        setConn(rt, 'exited', `exit ${frame.exitCode ?? 'signal'}`)
        noteExit(rt, frame.exitCode)
        term.write('\r\n\x1b[2m[process exited — close or restart this window]\x1b[0m\r\n')
      } else if (frame.type === 'error') {
        setConn(rt, 'failed', frame.message ?? 'error')
        term.write(`\x1b[31m${frame.message ?? 'error'}\x1b[0m\r\n`)
      }
    }
    socket.onclose = (event) => {
      stopStartup()
      if (rt.socket !== socket || rt.killed) return
      if (rt.conn === 'exited' || rt.conn === 'failed') return
      if (event.code === 4000) return setConn(rt, 'lost', 'opened in another tab')
      if (event.code === 1013) return setConn(rt, 'failed', 'too many terminals')
      setConn(rt, 'lost', 'reconnecting…')
      const delay = Math.min(8000, 700 * 2 ** rt.retry++)
      rt.timer = setTimeout(connect, delay)
    }
  }
  // Let the holder attach and fit once before the first connect so the PTY starts at the right size.
  requestAnimationFrame(() => {
    try {
      fit.fit()
    } catch {}
    connect()
  })
  return rt
}

/**
 * Give the xterm instance its DOM, once, when its holder is first in the document. Everything that
 * needs a renderer (links, fitting, focus) waits for this; the output received so far is kept.
 */
export function openRuntime(rt: Runtime): void {
  if (rt.opened) return
  rt.opened = true
  rt.term.open(rt.holder)
  // Links open with Ctrl/Cmd+click (like VS Code) so plain clicks still select text.
  // The desktop app routes window.open of http(s) URLs to the system browser.
  rt.term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!(event.ctrlKey || event.metaKey)) return
      window.open(uri, '_blank', 'noopener,noreferrer')
    }),
  )
  // The grid was never sent to the host (or only xterm's default); report the real one.
  rt.lastCols = 0
}

/** Push the current xterm grid size to the PTY when it changed. */
export function sizeToHost(rt: Runtime): void {
  if (!rt.opened) return
  const { cols, rows } = rt.term
  if (cols === rt.lastCols && rows === rt.lastRows) return
  rt.lastCols = cols
  rt.lastRows = rows
  if (rt.socket !== null && rt.socket.readyState === WebSocket.OPEN) {
    rt.socket.send(JSON.stringify({ type: 'resize', cols, rows }))
  }
}

/**
 * Font size for a window: the user's size, shrunk only as far as needed to keep about
 * `fitCols` columns visible (monospace glyphs are roughly 0.6 em wide), never below 9 px.
 */
function effectiveFontSize(widthPx: number): number {
  const base = prefs.font.size
  if (!prefs.autoFont) return base
  const fitting = Math.floor(widthPx / (prefs.fitCols * 0.6))
  return Math.max(Math.min(9, base), Math.min(base, fitting))
}

/** Refit a runtime to its container (adapting the font size to its width) and tell the host. */
export function refit(rt: Runtime): void {
  if (!rt.holder.isConnected) return
  openRuntime(rt)
  if (rt.holder.clientWidth < 20 || rt.holder.clientHeight < 20) return
  const size = effectiveFontSize(rt.holder.clientWidth)
  if (rt.term.options.fontSize !== size) rt.term.options.fontSize = size
  try {
    rt.fit.fit()
  } catch {
    return
  }
  sizeToHost(rt)
}

/** Kill the shell and start a fresh one (same folder, startup command re-runs). */
export function restartWin(id: string): void {
  const win = store.wins.find((w) => w.id === id)
  if (win === undefined) return
  disposeRuntime(id, true)
  updateWin(id, { gen: (win.gen ?? 0) + 1 })
}

/** Plain-text copy of a terminal's buffer (scrollback included). */
export function bufferText(id: string): string {
  const rt = runtimes.get(id)
  if (rt === undefined) return ''
  const buffer = rt.term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  return lines.join('\n').replace(/\s+$/, '')
}

/** Download a terminal's text as a log file. */
export function saveLog(id: string): void {
  const win = store.wins.find((w) => w.id === id)
  if (win === undefined) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safe = displayName(win).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'terminal'
  const url = URL.createObjectURL(new Blob([bufferText(id)], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${safe}-${stamp}.log`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function disposeRuntime(id: string, kill: boolean): void {
  const rt = runtimes.get(id)
  if (rt === undefined) return
  rt.killed = true
  if (rt.timer !== undefined) clearTimeout(rt.timer)
  rt.stopStartup?.()
  try {
    if (kill && rt.socket?.readyState === WebSocket.OPEN) rt.socket.send(JSON.stringify({ type: 'kill' }))
    rt.socket?.close()
  } catch {}
  try {
    rt.term.dispose()
  } catch {}
  rt.holder.remove()
  runtimes.delete(id)
  // Nothing left to watch: stop the once-a-second tick until the next terminal opens.
  if (runtimes.size === 0 && ticker !== undefined) {
    clearInterval(ticker)
    ticker = undefined
  }
}
