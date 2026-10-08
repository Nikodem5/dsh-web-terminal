// dsh-web-terminal — client plugin entry.
//
// Three registrations. The Terminals page is a top-level entry like Plugins and the Task manager:
// an icon in the root-scoped `sidebar.panellist` list seat, and the page in the root-scoped
// `main` keyed seat under the same id (selecting a panel whose `main` key is missing throws, so
// both are always registered together; a click on the sidebar row selects the panel by itself).
// The stats bar goes into the session header's `conversation.session.header.utilities` list seat
// (session scope; neighbours register with order -10 and -5, `id` is the only required option,
// `inject` is optional). `slots.inject` fires once the owner has declared that seat, so every
// part tolerates any load order.

import type { Context } from '@deepseek-ai/cordis'
import { StatsBar } from './stats-bar.tsx'
import { TerminalsIcon } from './panel-icon.tsx'
import { TerminalsView } from './terminals-view.tsx'

/** Stable cordis plugin name (must match the client bundle id). */
export const name = 'web-terminal'

/** Client services this half needs. */
export const inject = ['slots', 'sessions']

/** Shared by the sidebar entry and the `main` panel (the sidebar selects the panel by this id). */
const PANEL_ID = 'dsh-web-terminal'

/**
 * Register the Terminals page (sidebar entry + main panel) and the header stats bar.
 * @param ctx - the client plugin context carrying the slot registry and sessions.
 */
export function apply(ctx: Context): void {
  const slots = ctx.slots as {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  const sessions = (ctx as unknown as { sessions?: { list: { getSnapshot(): { byId: Record<string, { cwd?: string } | undefined> } } } }).sessions
  slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, TerminalsView as never))
  // order 5: right after Plugins (0) and before the Task manager (10).
  slots.inject('sidebar.panellist', () =>
    slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => 'Terminals' }, TerminalsIcon as never),
  )
  slots.inject('conversation.session.header.utilities', () =>
    slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'terminal-stats',
        order: 10,
        // Lets the bar record the folder of the session being viewed (the New terminal dialog's fallback).
        inject: (sessionId: string) => ({
          sessionCwd: () => sessions?.list.getSnapshot().byId[sessionId]?.cwd,
        }),
      },
      StatsBar as never,
    ),
  )
}
