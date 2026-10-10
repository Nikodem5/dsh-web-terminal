// dsh-web-terminal - the link to the sibling dsh-code-editor plugin (same app, separate plugin).
//
// The editor listens for a window event and marks its presence with `window.__dshCodeEditor = { version }`
// when it loads. Nothing here talks to the host: opening a file or the review view is one DOM event.

/** Event the editor plugin listens for (contract: packages/code-editor/API.md). */
export const EDITOR_OPEN_EVENT = 'dsh-code-editor:open'

export interface EditorOpenDetail {
  /** Absolute path of a file, or of a folder together with `review`. */
  path: string
  line?: number
  col?: number
  /** Show the folder's uncommitted changes instead of opening a file. */
  review?: boolean
}

/** True when the editor plugin has loaded in this app (it sets the presence marker). */
export function editorInstalled(): boolean {
  try {
    const marker = (window as unknown as { __dshCodeEditor?: unknown }).__dshCodeEditor
    return marker !== undefined && marker !== null && marker !== false
  } catch {
    return false
  }
}

/** Ask the editor to open something. Returns false (and dispatches nothing) when it is not installed. */
export function openInEditor(detail: EditorOpenDetail): boolean {
  if (!editorInstalled()) return false
  const clean: EditorOpenDetail = { path: detail.path }
  if (detail.line !== undefined) clean.line = detail.line
  if (detail.col !== undefined) clean.col = detail.col
  if (detail.review === true) clean.review = true
  window.dispatchEvent(new window.CustomEvent(EDITOR_OPEN_EVENT, { detail: clean }))
  return true
}

/** Whether a window's menu offers "Review changes in this folder": the editor is installed and the window is local. */
export function showReview(ssh: boolean): boolean {
  return !ssh && editorInstalled()
}

/** Show the changed files of a terminal's folder in the editor. False when the editor is missing or there is no folder. */
export function reviewFolder(cwd: string | undefined): boolean {
  if (cwd === undefined || cwd === '') return false
  return openInEditor({ path: cwd, review: true })
}
