// dsh-code-editor - the live-update socket with reconnect backoff.

import type { WsFrame } from './types.ts'

export type LiveState = 'connecting' | 'live' | 'down'

export interface SocketLike {
  onopen: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev?: unknown) => void) | null
  onerror: ((ev?: unknown) => void) | null
  close(): void
}
export type SocketCtor = new (url: string) => SocketLike

export interface LiveOptions {
  url: string
  onFrame(f: WsFrame): void
  /** `again` is true when the socket had been live before (events may have been missed: refresh everything). */
  onState(s: LiveState, again: boolean): void
  Socket?: SocketCtor
  /** Delay before attempt n (0-based), ms. */
  delay?(n: number): number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(h: unknown): void
}

export const backoff = (n: number): number => Math.min(15000, 500 * 2 ** n)

/** Parse a socket message into a frame; null when it is not one of ours. */
export function parseFrame(data: unknown): WsFrame | null {
  try {
    const v = JSON.parse(String(data)) as { type?: unknown; paths?: unknown; overflow?: unknown }
    if (v.type === 'hello' || v.type === 'git') return v as WsFrame
    if (v.type === 'changed') {
      return { type: 'changed', paths: Array.isArray(v.paths) ? v.paths.filter((p): p is string => typeof p === 'string') : [], overflow: v.overflow === true }
    }
  } catch { /* ignore */ }
  return null
}

/** Connects, and keeps reconnecting (500 ms doubling to 15 s) until `close()`. */
export function openLive(o: LiveOptions): { close(): void } {
  const Sock = o.Socket ?? (globalThis.WebSocket as unknown as SocketCtor)
  const setT = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const delay = o.delay ?? backoff
  let closed = false
  let attempt = 0
  let timer: unknown = null
  let sock: SocketLike | null = null
  let everLive = false

  const schedule = (): void => {
    if (closed || timer !== null) return
    timer = setT(() => { timer = null; connect() }, delay(attempt++))
  }
  const connect = (): void => {
    if (closed) return
    o.onState('connecting', everLive)
    let s: SocketLike
    try { s = new Sock(o.url) } catch { schedule(); return }
    sock = s
    s.onopen = () => {
      if (closed || sock !== s) return
      const again = everLive
      everLive = true
      attempt = 0
      o.onState('live', again)
    }
    s.onmessage = (ev) => {
      if (closed || sock !== s) return
      const f = parseFrame(ev.data)
      if (f) o.onFrame(f)
    }
    const lost = (): void => {
      if (closed || sock !== s) return
      sock = null
      o.onState('down', everLive)
      schedule()
    }
    s.onclose = lost
    s.onerror = () => { try { s.close() } catch { /* ignore */ } lost() }
  }
  connect()
  return {
    close() {
      closed = true
      if (timer !== null) clearT(timer)
      const s = sock
      sock = null
      if (s) { s.onopen = s.onmessage = s.onclose = s.onerror = null; try { s.close() } catch { /* ignore */ } }
    },
  }
}
