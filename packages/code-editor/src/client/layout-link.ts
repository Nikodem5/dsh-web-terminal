// dsh-code-editor - switching to the Code page without making `layout` a hard dependency.
//
// The harness' `layout` service (`ctx.layout.selectPanel(id)`) is provided by the app frame plugin, and the
// sidebar plugin that shows our icon requires it too. The cordis in the harness has no optional-inject form
// (an object `inject` is a service-name -> intercept-config map), so listing `layout` in `inject` would make
// it a REQUIRED service: our plugin would stay inactive wherever it is missing. `ctx.inject(['layout'], cb)`
// is the documented optional route: the plugin loads regardless and `cb` runs only while the service exists.
// Reading `ctx.layout` directly would throw (it is not in `inject`), so it is never done.

/** The slice of the layout service we use. */
interface LayoutLike { selectPanel?: (id: string | null) => void }

/** The slice of a cordis context we use (all optional: fakes and older hosts may lack them). */
interface CtxLike {
  inject?: (names: string[], callback: (child: { layout?: unknown; on?: (event: string, fn: () => void) => unknown }) => void) => unknown
}

/**
 * Track the layout service. Never throws and never reads an uninjected property of `ctx`.
 * @returns `select()`: best-effort switch to the panel `id` (a no-op while the service is absent or the panel unregistered).
 */
export function trackLayout(ctx: unknown, id: string): { select(): void; available(): boolean } {
  let layout: LayoutLike | undefined
  try {
    const c = ctx as CtxLike
    if (typeof c.inject === 'function') {
      c.inject(['layout'], (child) => {
        let mine: LayoutLike | undefined
        try { mine = child.layout as LayoutLike | undefined } catch { return }
        if (!mine || typeof mine.selectPanel !== 'function') return
        layout = mine
        try { child.on?.('dispose', () => { if (layout === mine) layout = undefined }) } catch { /* no dispose hook */ }
      })
    }
  } catch { /* inject unavailable: switching stays a no-op */ }
  return {
    select(): void {
      try { layout?.selectPanel?.(id) } catch { /* panel not registered yet */ }
    },
    available: () => layout !== undefined,
  }
}
