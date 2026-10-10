// dsh-web-terminal — files each terminal's agent changed, and the read-only window API that
// lets other plugins (the code editor) mark them.
//
//   window.__dshTerminals = { version: 1, listEdits(), subscribe(cb) }
//
// Only terminals that are currently open are listed; closing one removes its entries and
// notifies. Changes also fire a `dsh-terminals:edits` event on `window`.

import { displayName } from './names.ts'
import { runtimes, store } from './state.ts'
import type { Runtime } from './types.ts'

/** One file the agent changed, as the host reports it (`at` is epoch ms). */
export interface EditInfo {
  path: string
  at: number
  tool: string
}

/** One open terminal's changed files, as other plugins see them. */
export interface TerminalEdits {
  terminalId: string
  name: string
  color?: string
  /** The terminal's shell is connected (a closed terminal is not listed at all). */
  live: boolean
  files: EditInfo[]
}

export interface DshTerminalsApi {
  version: 1
  listEdits(): TerminalEdits[]
  subscribe(callback: () => void): () => void
}

/** Event dispatched on `window` whenever the listed edits change. */
export const EDITS_EVENT = 'dsh-terminals:edits'

const MAX_FILES = 500
const MAX_TEXT = 1024

/** Validate the host's list (untrusted): entries need a string path and a finite time; capped, newest wins on duplicates. */
export function parseEdits(raw: unknown): EditInfo[] {
  if (!Array.isArray(raw)) return []
  const byPath = new Map<string, EditInfo>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const { path, at, tool } = item as Record<string, unknown>
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_TEXT) continue
    byPath.delete(path)
    byPath.set(path, { path, at: typeof at === 'number' && Number.isFinite(at) ? at : 0, tool: typeof tool === 'string' ? tool.slice(0, 40) : '' })
  }
  return [...byPath.values()].slice(-MAX_FILES)
}

const listeners = new Set<() => void>()

/** Tell subscribers (and the window event's listeners) that the listed edits changed. */
export function notifyEdits(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {}
  }
  try {
    window.dispatchEvent(new window.CustomEvent(EDITS_EVENT))
  } catch {}
}

/** Replace a terminal's list with the host's (full list each time); a missing list from an old host means none. */
export function applyEdits(rt: Runtime, raw: unknown): void {
  const next = parseEdits(raw)
  if (next.length === 0 && (rt.edits?.length ?? 0) === 0) return
  rt.edits = next
  notifyEdits()
}

/** Open terminals that have changed files, oldest window first. */
export function listEdits(): TerminalEdits[] {
  const out: TerminalEdits[] = []
  for (const win of store.wins) {
    const rt = runtimes.get(win.id)
    if (rt === undefined || rt.killed || (rt.edits?.length ?? 0) === 0) continue
    out.push({ terminalId: win.id, name: displayName(win), live: rt.conn === 'live', files: rt.edits.map((f) => ({ ...f })) })
  }
  return out
}

export function subscribeEdits(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

/** Publish `window.__dshTerminals` (idempotent). */
export function installTerminalsApi(): void {
  const api: DshTerminalsApi = { version: 1, listEdits, subscribe: subscribeEdits }
  try {
    Object.defineProperty(window, '__dshTerminals', { value: api, configurable: true, writable: true })
  } catch {}
}
