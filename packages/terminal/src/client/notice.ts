// dsh-web-terminal — brief notices ("Copy failed", "Not connected"): a tiny store of short-lived
// messages that the Terminals page shows at the bottom of the canvas (notice-view.tsx). It is its
// own store, not the window store, so a notice never re-renders the whole page's state or gets persisted.

export interface Notice {
  id: number
  text: string
}

/** How long a notice stays up. */
export const NOTICE_MS = 3500

let notices: readonly Notice[] = []
let seq = 0
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function change(next: readonly Notice[]): void {
  notices = next
  for (const listener of listeners) listener()
}

/** Show `text` for a moment. The same text that is already showing only has its timer restarted. */
export function showNotice(text: string, ms = NOTICE_MS): void {
  const existing = notices.find((n) => n.text === text)
  const id = existing?.id ?? ++seq
  const old = timers.get(id)
  if (old !== undefined) clearTimeout(old)
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      change(notices.filter((n) => n.id !== id))
    }, ms),
  )
  if (existing === undefined) change([...notices, { id, text }].slice(-3))
}

/** Drop every notice (tests use it between cases). */
export function clearNotices(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  change([])
}

export const getNotices = (): readonly Notice[] => notices

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
