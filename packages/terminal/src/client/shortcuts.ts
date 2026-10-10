// dsh-web-terminal — the keyboard shortcut registry: ONE list that both the key handlers
// (runtime.ts, terminals-view.tsx, mission-view.tsx) and the help panel read, so the panel
// cannot describe a key the app no longer handles (tests/shortcuts.test.mjs enforces it).
//
// Entries with a `chord` are matched by `matches()`; the handlers call `matchShortcut(id, event)`
// instead of testing keys themselves. Entries without one are keys that only mean something inside
// a widget (find bar, send menu, overview): they are documented here but handled by that widget.

export type ShortcutGroup = 'Windows' | 'Overview' | 'Unread' | 'Send selection' | 'Command blocks' | 'Find' | 'Copy & paste' | 'Help' | 'Others'

/** Display order of the groups in the help panel. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Windows', 'Overview', 'Unread', 'Send selection', 'Command blocks', 'Find', 'Copy & paste', 'Help', 'Others']

/** How a modifier must be: held, not held (the default), or either. */
type Mod = boolean | 'any'

export interface Chord {
  /** `event.key` values that match; single letters compare case-insensitively. */
  key?: readonly string[]
  /** `event.code` values that match (layout-independent keys such as Space). Either `key` or `code` may match. */
  code?: readonly string[]
  /**
   * 'mod' = Ctrl, or Cmd on macOS; 'ctrl' = Ctrl only (Cmd must not be held); undefined = neither held.
   */
  mod?: 'mod' | 'ctrl'
  shift?: Mod
  alt?: Mod
}

export interface Shortcut {
  id: string
  group: ShortcutGroup
  desc: string
  /** Matched by a real handler. */
  chord?: Chord
  /** Display text for keys that have no chord (they are handled inside a widget). */
  keys?: string
  /** The handler only acts while the terminal has a selection (so the key is a plain key otherwise). */
  needsSelection?: boolean
  /** The handler only acts while the terminal shows its normal screen and has command blocks to go to (otherwise the program gets the key). */
  needsBlocks?: boolean
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'cycle', group: 'Windows', desc: 'Switch to the previous / next terminal', chord: { key: ['ArrowLeft', 'ArrowRight'], mod: 'ctrl', alt: true, shift: 'any' } },
  { id: 'overview', group: 'Overview', desc: 'Show / hide the overview of every terminal', chord: { code: ['Space'], key: [' '], mod: 'ctrl', shift: true } },
  { id: 'overview-filter', group: 'Overview', desc: 'Filter terminals by name or folder (while the overview is open)', keys: 'Type' },
  { id: 'overview-move', group: 'Overview', desc: 'Move the selection between tiles', keys: '← ↑ ↓ →' },
  { id: 'overview-open', group: 'Overview', desc: 'Open the selected terminal', keys: 'Enter' },
  { id: 'overview-leave', group: 'Overview', desc: 'Leave the overview without changing anything', keys: 'Esc' },
  { id: 'unread', group: 'Unread', desc: 'Jump to the "new since you last looked" divider', chord: { key: ['u'], mod: 'mod', shift: true } },
  { id: 'send', group: 'Send selection', desc: 'Send the selected text to another terminal', chord: { key: ['s'], mod: 'mod', shift: true }, needsSelection: true },
  { id: 'send-pick', group: 'Send selection', desc: 'Pick a target in the send menu, confirm, cancel', keys: '↑ ↓ · Enter · Esc' },
  { id: 'block-nav', group: 'Command blocks', desc: 'Jump to the previous / next command (needs shell integration)', chord: { key: ['ArrowUp', 'ArrowDown'], mod: 'mod', shift: true }, needsBlocks: true },
  { id: 'block-failed', group: 'Command blocks', desc: 'Jump to the last failed command; again for the one before', chord: { key: ['e'], mod: 'mod', shift: true }, needsBlocks: true },
  { id: 'find', group: 'Find', desc: 'Find in the terminal output', chord: { key: ['f'], mod: 'mod' } },
  { id: 'find-step', group: 'Find', desc: 'Next / previous match (in the find bar)', keys: 'Enter · Shift+Enter' },
  { id: 'find-close', group: 'Find', desc: 'Close the find bar', keys: 'Esc' },
  { id: 'copy', group: 'Copy & paste', desc: 'Copy the selection (without one, Ctrl+C is the usual interrupt)', chord: { key: ['c'], mod: 'mod', shift: 'any', alt: 'any' }, needsSelection: true },
  { id: 'copy-always', group: 'Copy & paste', desc: 'Copy the selection, even when the program would get Ctrl+C', chord: { key: ['c'], mod: 'mod', shift: true, alt: 'any' } },
  { id: 'paste', group: 'Copy & paste', desc: 'Paste from the clipboard', chord: { key: ['v'], mod: 'mod', shift: true, alt: 'any' } },
  { id: 'help', group: 'Help', desc: 'Show / hide this help (F1 is not sent to the program)', chord: { key: ['F1'] } },
  { id: 'help-close', group: 'Help', desc: 'Close the help panel', keys: 'Esc' },
  { id: 'rename-commit', group: 'Others', desc: 'Save / cancel a rename (window title or terminal list)', keys: 'Enter · Esc' },
  { id: 'dialog', group: 'Others', desc: 'Open the terminal / cancel (New terminal dialog)', keys: 'Enter · Esc' },
  { id: 'broadcast-send', group: 'Others', desc: 'Send the line to the selected terminals (Broadcast bar)', keys: 'Enter' },
]

const byId = new Map(SHORTCUTS.map((s) => [s.id, s]))

export const isMac = (): boolean => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')

const modOk = (want: Mod | undefined, held: boolean): boolean => (want === 'any' ? true : held === (want === true))

/** Whether a keyboard event is this chord. Pure: takes only the event's modifier and key fields. */
export function matches(chord: Chord, e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  const keyHit = chord.key?.some((k) => (k.length === 1 ? e.key.toLowerCase() === k.toLowerCase() : e.key === k)) === true
  const codeHit = chord.code?.includes(e.code ?? '') === true
  if (!keyHit && !codeHit) return false
  if (chord.mod === 'mod') {
    if (!(e.ctrlKey || e.metaKey)) return false
  } else if (chord.mod === 'ctrl') {
    if (!e.ctrlKey || e.metaKey) return false
  } else if (e.ctrlKey || e.metaKey) return false
  return modOk(chord.shift, e.shiftKey) && modOk(chord.alt, e.altKey)
}

/** Whether the event is the shortcut `id` (false for an unknown id or a documentation-only entry). */
export function matchShortcut(id: string, e: Parameters<typeof matches>[1]): boolean {
  const chord = byId.get(id)?.chord
  return chord !== undefined && matches(chord, e)
}

const KEY_LABEL: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', ' ': 'Space', Space: 'Space' }

/** Display text for a shortcut's keys, e.g. `Ctrl+Shift+U` (`Cmd+Shift+U` on macOS) or `Ctrl+Alt+←/→`. */
export function formatShortcut(s: Shortcut, mac = isMac()): string {
  const chord = s.chord
  if (chord === undefined) return s.keys ?? ''
  const parts: string[] = []
  if (chord.mod === 'mod') parts.push(mac ? 'Cmd' : 'Ctrl')
  else if (chord.mod === 'ctrl') parts.push('Ctrl')
  if (chord.alt === true) parts.push(mac ? 'Option' : 'Alt')
  if (chord.shift === true) parts.push('Shift')
  // `code` and `key` of a chord name the same physical key (Space); show the key list once.
  const names = [...new Set((chord.key ?? chord.code ?? []).map((k) => KEY_LABEL[k] ?? (k.length === 1 ? k.toUpperCase() : k)))]
  parts.push(names.join('/'))
  return parts.join('+')
}

/** Shortcuts whose description or keys contain every word of `query` (case-insensitive); all of them for an empty query. */
export function filterShortcuts(list: readonly Shortcut[], query: string, mac = isMac()): Shortcut[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (terms.length === 0) return [...list]
  return list.filter((s) => {
    const hay = `${s.group} ${s.desc} ${formatShortcut(s, mac)}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}
