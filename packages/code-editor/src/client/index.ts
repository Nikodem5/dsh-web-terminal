// dsh-code-editor - client plugin entry.
//
// Same shape as the terminal: the Code page is a top-level entry, an icon in the root-scoped
// `sidebar.panellist` list seat plus the page in the root-scoped `main` keyed seat under the same id.
// Only `slots` is injected (reading any other ctx property would throw on a real cordis ctx);
// the layout service is tracked through the optional `ctx.inject(['layout'], ...)` form (layout-link.ts).

import type { Context } from '@deepseek-ai/cordis'
import { CodeIcon } from './panel-icon.tsx'
import { trackLayout } from './layout-link.ts'
import { getStore, setSelectPanel } from './instance.ts'
import { CodeEditorView } from './view.tsx'

/** Stable cordis plugin name (must match the client bundle id). */
export const name = 'code-editor'

/** Client services this half needs. */
export const inject = ['slots']

/** Shared by the sidebar entry and the `main` panel. */
export const PANEL_ID = 'dsh-code-editor'

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
  const layout = trackLayout(ctx, PANEL_ID)
  setSelectPanel(() => layout.select())
  if (typeof window !== 'undefined') {
    // Presence marker: other plugins (the terminal) check it before offering "open in Code".
    const marked = window as unknown as { __dshCodeEditor?: unknown }
    marked.__dshCodeEditor = { version: 1 }
    const onOpen = (ev: Event): void => {
      void getStore().handleOpenRequest((ev as CustomEvent).detail)
    }
    window.addEventListener('dsh-code-editor:open', onOpen)
    try {
      ctx.on('dispose', () => {
        window.removeEventListener('dsh-code-editor:open', onOpen)
        delete marked.__dshCodeEditor
      })
    } catch { /* no dispose hook */ }
  }
}
