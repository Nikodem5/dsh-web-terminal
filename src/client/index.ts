// dsh-web-terminal — client plugin entry.
//
// One registration: the "Terminals" view into the conversation's `conversation.view`
// list slot, next to Chat and Trajectory. `slots.inject` fires once the conversation
// shell has declared that seat, so this half tolerates any load order.

import type { Context } from '@deepseek-ai/cordis'
import { TerminalsView } from './terminals-view.tsx'

/** Stable cordis plugin name (must match the client bundle id). */
export const name = 'web-terminal'

/** Client services this half needs. */
export const inject = ['slots', 'sessions']

/**
 * Register the Terminals view tab.
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
}
