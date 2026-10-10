// dsh-code-editor - which keyboard shortcut an event is, and whether it may fire where the user is typing.

export type ShortcutAction = 'quickOpen' | 'save' | 'closeTab'

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }
export interface TargetInfo {
  /** The event target is an input, textarea, select or contenteditable. */
  editable: boolean
  /** ...and it is the text area of Monaco itself (a code editor, where Ctrl+S/W are ours). */
  inMonaco: boolean
  /** ...and it is the quick-open input (Ctrl+P toggles it closed). */
  inQuickOpen: boolean
}

/** Ctrl (Cmd on macOS) + P / S / W, with no Shift or Alt. */
export function matchShortcut(e: KeyLike): ShortcutAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return null
  const k = e.key.toLowerCase()
  return k === 'p' ? 'quickOpen' : k === 's' ? 'save' : k === 'w' ? 'closeTab' : null
}

/**
 * The action to run for this key at this target, or null to let the key through. Plain inputs (root path,
 * filters) keep Ctrl+S / Ctrl+W for themselves; only Monaco and non-editable surfaces trigger save/close.
 */
export function actionFor(e: KeyLike, t: TargetInfo): ShortcutAction | null {
  const a = matchShortcut(e)
  if (a === null) return null
  if (!t.editable || t.inMonaco) return a
  if (a === 'quickOpen' && t.inQuickOpen) return a
  return null
}

/** Describe an event target for `actionFor` (DOM only). */
export function describeTarget(target: EventTarget | null): TargetInfo {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return { editable: false, inMonaco: false, inQuickOpen: false }
  const tag = el.tagName
  const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
  return { editable, inMonaco: editable && el.closest('.monaco-editor') !== null, inQuickOpen: el.closest('[data-ce-quick]') !== null }
}
