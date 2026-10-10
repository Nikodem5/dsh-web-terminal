// dsh-web-terminal — the harness's Workspaces as folder choices for the New terminal dialog.
//
// The Terminals page is a `main` entry, which receives the shell's standard `useWorkspaces`
// hook; each item carries the workspace `path` and `title`. Only the fields we need are typed.

export interface WorkspaceItem {
  path?: unknown
  title?: unknown
}

export interface WorkspaceChoice {
  /** Label on the chip (the workspace title, else the folder name). */
  label: string
  path: string
}

const leaf = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

/**
 * Turn the harness's workspace items into dialog choices: skips entries without a usable path
 * and repeats of the same folder, keeps the sidebar order.
 * @param items - `useWorkspaces(s => s.items)`, or anything else (ignored unless an array).
 * @returns the choices.
 */
export function workspaceChoices(items: unknown): WorkspaceChoice[] {
  if (!Array.isArray(items)) return []
  const seen = new Set<string>()
  const out: WorkspaceChoice[] = []
  for (const item of items as WorkspaceItem[]) {
    if (typeof item !== 'object' || item === null || typeof item.path !== 'string') continue
    const path = item.path.trim()
    if (path.length === 0 || seen.has(path.toLowerCase())) continue
    seen.add(path.toLowerCase())
    out.push({ label: typeof item.title === 'string' && item.title.trim().length > 0 ? item.title.trim() : leaf(path), path })
  }
  return out
}
