// dsh-web-terminal — short visible notices on the Terminals page (something the user asked for did not
// happen as expected). A tiny store: `showNotice` adds one, it disappears after a while or when dismissed.
// The page renders them with <Notices /> (notices-view.tsx).

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
const emit = (): void => listeners.forEach((l) => l())

export const getNotices = (): readonly Notice[] => notices

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function dismissNotice(id: number): void {
  if (!notices.some((n) => n.id === id)) return
  notices = notices.filter((n) => n.id !== id)
  emit()
}

/**
 * Show a notice.
 * @param ms - how long it stays (0: until dismissed).
 * @returns its id.
 */
export function showNotice(text: string, options: { title?: string; ms?: number } = {}): number {
  const id = next++
  notices = [...notices, { id, text, title: options.title }].slice(-MAX_NOTICES)
  emit()
  const ms = options.ms ?? NOTICE_MS
  if (ms > 0) setTimeout(() => dismissNotice(id), ms)
  return id
}
