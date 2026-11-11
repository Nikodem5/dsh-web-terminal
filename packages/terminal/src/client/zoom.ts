// dsh-web-terminal — per-terminal font zoom: Ctrl+wheel over a terminal, Ctrl+0 to go back.
//
// The zoom is whole pixels added to the global font size and is saved with the window. A zoomed terminal
// uses that size as it is (no shrink-to-fit); the PTY is told the new grid once the zooming has settled.

import { isOverview } from './mission.ts'
import { prefs, runtimes, store, updateWin } from './state.ts'
import { ZOOM_MAX_SIZE, ZOOM_MIN_SIZE, wheelSteps } from './term-prefs.ts'
import type { Runtime } from './types.ts'

/** Quiet time after the last zoom step before the terminal is refitted and the PTY resized. */
export const ZOOM_REFIT_MS = 150

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Refit once the zooming has stopped; every step restarts the wait. */
function refitSoon(rt: Runtime, refit: () => void): void {
  clearTimeout(timers.get(rt.id))
  timers.set(
    rt.id,
    setTimeout(() => {
      timers.delete(rt.id)
      if (!rt.killed && runtimes.get(rt.id) === rt) refit()
    }, ZOOM_REFIT_MS),
  )
}

/** Zoom a terminal by `steps` pixels from the size it shows now; the glyphs change at once, the grid after the debounce. */
export function zoomBy(id: string, steps: number, refit: () => void): void {
  const rt = runtimes.get(id)
  const win = store.wins.find((w) => w.id === id)
  if (rt === undefined || win === undefined || steps === 0) return
  const shown = typeof rt.term.options.fontSize === 'number' ? rt.term.options.fontSize : prefs.font.size
  const target = Math.min(ZOOM_MAX_SIZE, Math.max(ZOOM_MIN_SIZE, shown + steps))
  const zoom = target - prefs.font.size
  if (win.zoom === zoom) return
  updateWin(id, { zoom })
  rt.term.options.fontSize = target
  refitSoon(rt, refit)
}

/** Back to the global size (and its shrink-to-fit). */
export function resetZoom(id: string, refit: () => void): void {
  const rt = runtimes.get(id)
  const win = store.wins.find((w) => w.id === id)
  if (rt === undefined || win === undefined || win.zoom === undefined) return
  updateWin(id, { zoom: undefined })
  rt.term.options.fontSize = prefs.font.size // the refit applies shrink-to-fit on top
  refitSoon(rt, refit)
}

/** Listen for Ctrl+wheel on the terminal's holder. Capture phase, so xterm never scrolls for it. */
export function installZoom(rt: Runtime, refit: () => void): void {
  let acc = 0
  let last = 0
  rt.holder.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault() // the page must not zoom either
      event.stopPropagation()
      if (isOverview()) return
      const now = Date.now()
      const next = wheelSteps(acc, event.deltaY, event.deltaMode, now - last)
      acc = next.acc
      last = now
      if (next.steps !== 0) zoomBy(rt.id, next.steps, refit)
    },
    { passive: false, capture: true },
  )
}
