// dsh-code-editor - which keyboard shortcut an event is, and whether it may fire where the user is typing.
//
// Bindings (Ctrl, or Cmd on macOS; no Shift / Alt):
//   Ctrl+E   search files (quick open) - VS Code's alias of Ctrl+P; the desktop app does not own it
//   Ctrl+P   search files too, where the app lets the page have it (the desktop app binds Mod+P to its own file page)
//   Ctrl+S   save
//   Ctrl+F4  close the tab (Ctrl+W is the desktop app's window accelerator and never reaches the page)
//   Ctrl+Shift+F, Ctrl+Shift+H  search in files (VS Code's key, and an alias: the app's web build binds Ctrl+Shift+F to
//            "fork session", its desktop build uses Ctrl+Alt+F; Ctrl+Shift+H is free in both)
//   F4 / Shift+F4  next / previous search result (the app binds no bare F4; Ctrl+F4 above stays close-tab)

export type ShortcutAction = 'quickOpen' | 'save' | 'closeTab' | 'searchFiles' | 'searchNext' | 'searchPrev'

export interface KeyLike { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }
export interface TargetInfo {
  /** The event target is an input, textarea, select or contenteditable. */
  editable: boolean
  /** ...and it is the text area of Monaco itself (a code editor, where Ctrl+S / Ctrl+F4 are ours). */
  inMonaco: boolean
  /** ...and it is the quick-open input (the quick-open key toggles it closed). */
  inQuickOpen: boolean
}

/** The shortcut an event is, with no regard to where it happened. The physical key is the fallback for non-Latin layouts. */
export function matchShortcut(e: KeyLike): ShortcutAction | null {
  // --- search in files (ce-search-md) ---
  const searchKey = matchSearchShortcut(e)
  if (searchKey !== null) return searchKey
  // --- end search ---
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return null
  const k = e.key.toLowerCase()
  if (k === 'f4') return 'closeTab'
  const latin = k.length === 1 && k >= 'a' && k <= 'z'
  const c = latin ? k : e.code === 'KeyP' ? 'p' : e.code === 'KeyE' ? 'e' : e.code === 'KeyS' ? 's' : ''
  return c === 'p' || c === 'e' ? 'quickOpen' : c === 's' ? 'save' : null
}

/** The search shortcuts: Ctrl/Cmd+Shift+F|H, and bare F4 / Shift+F4. */
export function matchSearchShortcut(e: KeyLike): ShortcutAction | null {
  const k = e.key.toLowerCase()
  if (k === 'f4' && !e.ctrlKey && !e.metaKey && !e.altKey) return e.shiftKey ? 'searchPrev' : 'searchNext'
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return null
  const c = k.length === 1 && k >= 'a' && k <= 'z' ? k : e.code === 'KeyF' ? 'f' : e.code === 'KeyH' ? 'h' : ''
  return c === 'f' || c === 'h' ? 'searchFiles' : null
}

/**
 * The action to run for this key at this target, or null to let the key through. Search files works from anywhere
 * (it would otherwise reach the browser, e.g. print). Plain inputs (root path, filters) keep Ctrl+S for themselves;
 * only Monaco and non-editable surfaces trigger save / close.
 */
export function actionFor(e: KeyLike, t: TargetInfo): ShortcutAction | null {
  const a = matchShortcut(e)
  if (a === null) return null
  if (a === 'quickOpen' || a === 'searchFiles' || a === 'searchNext' || a === 'searchPrev') return a
  return !t.editable || t.inMonaco ? a : null
}

/** Describe an event target for `actionFor` (DOM only). */
export function describeTarget(target: EventTarget | null): TargetInfo {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return { editable: false, inMonaco: false, inQuickOpen: false }
  const tag = el.tagName
  const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
  return { editable, inMonaco: editable && el.closest('.monaco-editor') !== null, inQuickOpen: el.closest('[data-ce-quick]') !== null }
}

interface KeyEventLike extends KeyLike { target: EventTarget | null; defaultPrevented?: boolean }

/**
 * The action for a keydown seen anywhere on the page (window capture phase). A key typed into an editable thing
 * OUTSIDE the Code view (another plugin's input) is not ours; everything else on the page is.
 * @param view - the Code page's root element (`contains` is all that is used).
 */
export function pageAction(e: KeyEventLike, view: { contains(n: unknown): boolean } | null): ShortcutAction | null {
  if (e.defaultPrevented) return null
  const info = describeTarget(e.target)
  if (info.editable && (view === null || !view.contains(e.target))) return null
  return actionFor(e, info)
}
