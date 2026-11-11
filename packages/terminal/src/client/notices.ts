// dsh-web-terminal — short visible notices on the Terminals page (something the user asked for did not
// happen as expected: "Copy failed", "Not connected"). A tiny store of its own, not the window store, so a
// notice never re-renders the page's state or gets persisted: `showNotice` adds one, it disappears after a
// while or when dismissed. The page renders them with <Notices /> (notices-view.tsx).

export interface Notice {
  id: number
  text: string
  /** Shown on hover. */
  title?: string
}

/** How long a notice stays unless it is dismissed (ms). */
export const NOTICE_MS = 20_000
/** At most this many at once; the oldest goes first. */
const MAX_NOTICES = 3

let notices: readonly Notice[] = []
let next = 1
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()
const emit = (): void => listeners.forEach((l) => l())

export const getNotices = (): readonly Notice[] => notices

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function forget(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(id)
}

export function dismissNotice(id: number): void {
  forget(id)
  if (!notices.some((n) => n.id === id)) return
  notices = notices.filter((n) => n.id !== id)
  emit()
}

/** Drop every notice (tests use it between cases). */
export function clearNotices(): void {
  for (const id of [...timers.keys()]) forget(id)
  notices = []
  emit()
}

/**
 * Show a notice. The same text that is already showing is not stacked: it only gets its timer restarted.
 * @param ms - how long it stays (0: until dismissed).
 * @returns its id.
 */
export function showNotice(text: string, options: { title?: string; ms?: number } = {}): number {
  const existing = notices.find((n) => n.text === text)
  const id = existing?.id ?? next++
  forget(id)
  if (existing === undefined) {
    notices = [...notices, { id, text, title: options.title }].slice(-MAX_NOTICES)
    emit()
  }
  const ms = options.ms ?? NOTICE_MS
  if (ms > 0) timers.set(id, setTimeout(() => dismissNotice(id), ms))
  return id
}
