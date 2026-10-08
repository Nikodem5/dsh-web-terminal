// dsh-web-terminal — client plugin entry.
//
// Two registrations. The "Terminals" view goes into the conversation's `conversation.view`
// list slot, next to Chat and Trajectory. The stats bar goes into the session header's
// `conversation.session.header.utilities` list seat (session scope; neighbours register with
// order -10 and -5, `id` is the only required option, `inject` is optional). `slots.inject`
// fires once the owner has declared that seat, so this half tolerates any load order.

import type { Context } from '@deepseek-ai/cordis'
import { StatsBar } from './stats-bar.tsx'
import { TerminalsView } from './terminals-view.tsx'

/** Stable cordis plugin name (must match the client bundle id). */
export const name = 'web-terminal'

/** Client services this half needs. */
export const inject = ['slots', 'sessions']

/**
 * Register the Terminals view tab and the header stats bar.
 * @param ctx - the client plugin context carrying the slot registry and sessions.
 */
export function apply(ctx: Context): void {
  const slots = ctx.slots as {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  const sessions = (ctx as unknown as { sessions?: { list: { getSnapshot(): { byId: Record<string, { cwd?: string } | undefined> } } } }).sessions
  slots.inject('conversation.view', () =>
    slots.register(
      {
        name: 'conversation.view',
        id: 'terminals',
        order: 20,
        label: () => 'Terminals',
        // Lets the "new terminal" dialog offer the folder of the session this tab belongs to.
        inject: (sessionId: string) => ({
          sessionCwd: () => sessions?.list.getSnapshot().byId[sessionId]?.cwd,
        }),
      },
      TerminalsView as never,
    ),
  )
  slots.inject('conversation.session.header.utilities', () =>
    slots.register({ name: 'conversation.session.header.utilities', id: 'terminal-stats', order: 10 }, StatsBar as never),
  )
}
