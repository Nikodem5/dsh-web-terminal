// dsh-web-terminal — saved layouts: snapshot the open windows and reopen them later.

import { emit, persistSoon, prefs, store } from './state.ts'
import { displayName } from './names.ts'
import { openTerminal } from './windows.ts'
import type { LayoutWin, SavedLayout } from './types.ts'

function snapshotWins(): LayoutWin[] {
  return store.wins.map((w) => {
    const g = w.maximized && w.restore !== undefined ? w.restore : w
    return {
      title: displayName(w),
      nameManual: true,
      shell: w.shell,
      cwd: w.cwd,
      startup: w.startup,
      x: g.x,
      y: g.y,
      w: g.w,
      h: g.h,
      pinned: w.pinned,
      minimized: w.minimized,
    }
  })
}

/** Save (or overwrite) the open windows as a named layout. */
export function saveLayout(name: string): void {
  const trimmed = name.trim()
  if (trimmed.length === 0 || store.wins.length === 0) return
  const entry: SavedLayout = { name: trimmed, savedAt: Date.now(), wins: snapshotWins() }
  prefs.layouts = [...prefs.layouts.filter((l) => l.name !== trimmed), entry]
  emit()
  persistSoon()
}

export function deleteLayout(name: string): void {
  prefs.layouts = prefs.layouts.filter((l) => l.name !== name)
  emit()
  persistSoon()
}

/** Open every window of a saved layout (spawning fresh shells and running startup commands). */
export function loadLayout(name: string): void {
  const layout = prefs.layouts.find((l) => l.name === name)
  if (layout === undefined) return
  for (const w of layout.wins) {
    openTerminal({
      title: w.title,
      nameManual: w.nameManual ?? true,
      shell: w.shell,
      cwd: w.cwd,
      startup: w.startup,
      rect: { x: w.x, y: w.y, w: w.w, h: w.h },
      pinned: w.pinned,
      minimized: w.minimized,
    })
  }
}
