// dsh-web-terminal — terminal runtimes: the xterm instance and WebSocket behind each
// window, reconnecting, sizing, restart and log export.

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { emit, prefs, runtimes, store, updateWin } from './state.ts'
import { cleanTitle, displayName } from './names.ts'
import { raiseAttention, tick } from './attention.ts'
import { termTheme } from './theme.ts'
import { openSearch } from './search.ts'
import type { Conn, Runtime, WinState } from './types.ts'

let ticker: ReturnType<typeof setInterval> | undefined

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
  // Links open with Ctrl/Cmd+click (like VS Code) so plain clicks still select text.
  // The desktop app routes window.open of http(s) URLs to the system browser.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!(event.ctrlKey || event.metaKey)) return
      window.open(uri, '_blank', 'noopener,noreferrer')
    }),
  )
  term.open(holder)

  const rt: Runtime = {
    id: win.id,
    holder,
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
    timer: undefined,
    lastCols: 0,
    lastRows: 0,
    activity: 'offline',
    hostBusy: undefined,
    lastOutputAt: 0,
    lastInputAt: 0,
    workStart: 0,
    attention: false,
    attentionReason: '',
  }
  runtimes.set(win.id, rt)
  ticker ??= setInterval(tick, 1000)

  term.onData((data) => {
    rt.lastInputAt = Date.now()
    if (rt.socket !== null && rt.socket.readyState === WebSocket.OPEN) rt.socket.send(JSON.stringify({ type: 'input', data }))
    // Live mirror: keystrokes typed here also go to the other selected terminals.
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
  term.onBell(() => raiseAttention(rt, 'Rang the terminal bell'))
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

    socket.onmessage = (event) => {
      let frame: { type: string; data?: string; replay?: string; created?: boolean; exited?: boolean; exitCode?: number | null; message?: string; busy?: boolean }
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame.type === 'attached') {
        rt.retry = 0
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
            setTimeout(() => {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: `${startup}\r` }))
            }, 500)
          }
        }
      } else if (frame.type === 'data') {
        rt.lastOutputAt = Date.now()
        term.write(frame.data ?? '')
      } else if (frame.type === 'activity') {
        rt.hostBusy = frame.busy === true
        tick()
        emit()
      } else if (frame.type === 'exit') {
        setConn(rt, 'exited', `exit ${frame.exitCode ?? 'signal'}`)
        term.write('\r\n\x1b[2m[process exited — close or restart this window]\x1b[0m\r\n')
      } else if (frame.type === 'error') {
        setConn(rt, 'failed', frame.message ?? 'error')
        term.write(`\x1b[31m${frame.message ?? 'error'}\x1b[0m\r\n`)
      }
    }
    socket.onclose = (event) => {
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

/** Push the current xterm grid size to the PTY when it changed. */
export function sizeToHost(rt: Runtime): void {
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
  if (!rt.holder.isConnected || rt.holder.clientWidth < 20 || rt.holder.clientHeight < 20) return
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
  try {
    if (kill && rt.socket?.readyState === WebSocket.OPEN) rt.socket.send(JSON.stringify({ type: 'kill' }))
    rt.socket?.close()
  } catch {}
  try {
    rt.term.dispose()
  } catch {}
  rt.holder.remove()
  runtimes.delete(id)
}
