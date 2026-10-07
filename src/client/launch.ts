// dsh-web-terminal — launch commands: what actually gets typed into a fresh shell.

/** `claude` as the first word of a command (not `claude-code-router` or a path to another tool). */
const CLAUDE_COMMAND = /^(\s*)claude(?=\s|$)/

/**
 * What a conversation id looks like (Claude's are UUIDs). The id is typed into a shell, so
 * anything outside this shape is refused rather than quoted. Mirrors lib/agent-signals.js.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

/** Whether a value is a conversation id that is safe to put in a command line. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

/** `--resume` or `--continue` with no conversation named: the interactive picker, or "the latest one". */
const BARE_RESUME = /(?<=\s)(?:--resume|-r|--continue|-c)(?=\s|$)(?!\s+[^\s-])/
/** Any flag that already chooses a conversation. */
const HAS_RESUME = /(?:^|\s)(?:--resume|-r|--continue|-c)(?:\s|=|$)/

/**
 * Make a Claude launch report to this plugin, and pick up where it left off.
 *
 * A startup command that starts `claude` gets `--settings <file>` inserted after it, so
 * Claude's own hooks tell the plugin when it works, needs you or finishes, without touching
 * the user's Claude configuration (`--settings` adds to it).
 *
 * When the terminal remembers a conversation, the fresh shell resumes it: a bare `--resume`
 * or `--continue` becomes `--resume <id>`, and a plain `claude` gets `--resume <id>` added.
 * A command that already names a conversation (`--resume <id>`) is left alone.
 *
 * Any other command, a command that already passes `--settings`, or a missing settings file
 * leaves that part unchanged. The path uses forward slashes and double quotes, which
 * PowerShell, cmd and bash all accept.
 * @param startup - the command saved with the terminal (e.g. `claude --resume`).
 * @param settingsPath - the host's generated settings file, when it has one.
 * @param session - the conversation id this terminal's agent last reported, if any.
 */
export function withAgentHooks(startup: string, settingsPath: string | null | undefined, session?: string | null): string {
  if (!CLAUDE_COMMAND.test(startup)) return startup
  let command = startup
  if (isSessionId(session)) {
    if (BARE_RESUME.test(command)) command = command.replace(BARE_RESUME, `--resume ${session}`)
    else if (!HAS_RESUME.test(command)) command = `${command.trimEnd()} --resume ${session}`
  }
  if (settingsPath !== null && settingsPath !== undefined && settingsPath.length > 0 && !/(^|\s)--settings(\s|=)/.test(command)) {
    const file = settingsPath.replace(/\\/g, '/')
    command = command.replace(CLAUDE_COMMAND, (_all, lead: string) => `${lead}claude --settings "${file}"`)
  }
  return command
}
