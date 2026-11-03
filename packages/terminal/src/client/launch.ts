// dsh-web-terminal — launch commands: what a conversation id may look like. How a command is
// rewritten to start (and resume) an agent belongs to its provider (providers.ts).

/**
 * What a conversation id looks like (Claude's are UUIDs). The id is typed into a shell, so
 * anything outside this shape is refused rather than quoted. Mirrors lib/agent-signals.js.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

/** Whether a value is a conversation id that is safe to put in a command line. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}
