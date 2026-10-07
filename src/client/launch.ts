// dsh-web-terminal — launch commands: what actually gets typed into a fresh shell.

/** `claude` as the first word of a command (not `claude-code-router` or a path to another tool). */
const CLAUDE_COMMAND = /^(\s*)claude(?=\s|$)/

/**
 * Make a Claude launch report to this plugin.
 *
 * A startup command that starts `claude` gets `--settings <file>` inserted after it, so
 * Claude's own hooks tell the plugin when it works, needs you or finishes, without touching
 * the user's Claude configuration (`--settings` adds to it). Any other command, a command
 * that already passes `--settings`, or a missing settings file is returned unchanged.
 *
 * The path uses forward slashes and double quotes, which PowerShell, cmd and bash all accept.
 * @param startup - the command saved with the terminal (e.g. `claude --resume`).
 * @param settingsPath - the host's generated settings file, when it has one.
 */
export function withAgentHooks(startup: string, settingsPath: string | null | undefined): string {
  if (settingsPath === null || settingsPath === undefined || settingsPath.length === 0) return startup
  if (!CLAUDE_COMMAND.test(startup) || /(^|\s)--settings(\s|=)/.test(startup)) return startup
  const file = settingsPath.replace(/\\/g, '/')
  return startup.replace(CLAUDE_COMMAND, (_all, lead: string) => `${lead}claude --settings "${file}"`)
}
