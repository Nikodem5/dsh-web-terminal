// dsh-code-editor - client plugin entry.
//
// Same shape as the terminal: the Code page is a top-level entry, an icon in the root-scoped
// `sidebar.panellist` list seat plus the page in the root-scoped `main` keyed seat under the same id.
// Only `slots` is injected (reading any other ctx property would throw on a real cordis ctx);
// the layout service is looked up defensively when another plugin asks to open a file.

import type { Context } from '@deepseek-ai/cordis'
import { CodeIcon } from './panel-icon.tsx'
import { getStore, setSelectPanel } from './instance.ts'
import { CodeEditorView } from './view.tsx'

/** Stable cordis plugin name (must match the client bundle id). */
export const name = 'code-editor'

/** Client services this half needs. */
export const inject = ['slots']

/** Shared by the sidebar entry and the `main` panel. */
export const PANEL_ID = 'dsh-code-editor'

/**
 * `ctx.layout.selectPanel(id)` is how the harness' own plugins switch pages. `layout` is not in our inject
 * list, so it is only probed (inside try/catch) at the moment a file is opened from another plugin.
 */
function findSelectPanel(ctx: Context): (() => void) | undefined {
  const probes: Array<() => unknown> = [
    () => (ctx as unknown as { layout?: unknown }).layout,
    () => (ctx as unknown as { get?(n: string): unknown }).get?.('layout'),
  ]
  for (const probe of probes) {
    try {
      const layout = probe() as { selectPanel?: (id: string | null) => void } | undefined
      if (layout && typeof layout.selectPanel === 'function') {
        const l = layout
        return () => { try { l.selectPanel?.(PANEL_ID) } catch { /* panel not registered yet */ } }
      }
    } catch { /* not available on this ctx */ }
  }
  return undefined
}

/**
 * Register the Code page (sidebar entry + main panel) and the cross-plugin open listener.
 * @param ctx - the client plugin context carrying the slot registry.
 */
export function apply(ctx: Context): void {
  const slots = ctx.slots as {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, CodeEditorView as never))
  // order 6: right after Terminals (5).
  slots.inject('sidebar.panellist', () =>
    slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => 'Code' }, CodeIcon as never),
  )
  if (typeof window !== 'undefined') {
    const onOpen = (ev: Event): void => {
      setSelectPanel(findSelectPanel(ctx))
      void getStore().handleOpenRequest((ev as CustomEvent).detail)
    }
    window.addEventListener('dsh-code-editor:open', onOpen)
    try { ctx.on('dispose', () => window.removeEventListener('dsh-code-editor:open', onOpen)) } catch { /* no dispose hook */ }
  }
}
