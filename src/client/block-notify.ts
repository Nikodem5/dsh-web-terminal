// dsh-web-terminal — command blocks, phase 2: tell the user when a long command ends while they are
// looking elsewhere. The decision is pure (commandAlert); watchBlockAlerts feeds it from the block model.
//
// Never for agents: `claude` and the terminals that report an agent state already have their own signals,
// and a full-screen program (editor, pager, TUI) is something the user is in, not waiting for.

import { blockDuration, formatDuration } from './blocks.ts'
import type { Block } from './blocks.ts'
import { raiseAttention, unattended } from './attention.ts'
import type { Alert } from './attention.ts'
import { emit, persistSoon, prefs } from './state.ts'
import type { Runtime } from './types.ts'

/** Choices of the setting, in seconds; 0 = off. */
export const COMMAND_NOTIFY_CHOICES: readonly number[] = [0, 5, 10, 30, 60]

export function setCommandNotifySeconds(seconds: number): void {
  prefs.commandNotifySec = COMMAND_NOTIFY_CHOICES.includes(seconds) ? seconds : 10
  emit()
  persistSoon()
}

/** `claude`, `claude --resume`, `C:\bin\claude.exe ...`: the agent itself. */
export function isAgentCommand(command: string): boolean {
  return /^\s*(?:\S*[\\/])?claude(?:\.(?:exe|cmd|ps1))?(?=\s|$)/i.test(command)
}

export interface CommandAlertInput {
  command: string
  /** Undefined when the shell did not report one. */
  exitCode: number | undefined
  durationMs: number
  /** The setting; 0 = off. */
  thresholdSec: number
  /** The terminal has an agent state (an agent that has not ended). */
  agent: boolean
  /** The command used the alternate screen (a full-screen program). */
  fullScreen: boolean
  unattended: boolean
}

/** One-line label for a command in a notification. */
function label(command: string): string {
  const line = command.split('\n', 1)[0]!.trim()
  if (line.length === 0) return 'Command'
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

/**
 * The alert for a command that just ended, or undefined. Success is a quiet `done` badge (a desktop
 * notification only while the app is in the background, like `finished`); failure is a quiet `failed`
 * badge that also interrupts like an urgent alert would, without the chime. An unknown exit code says
 * nothing: it cannot be called either.
 */
export function commandAlert(i: CommandAlertInput): Alert | undefined {
  if (i.thresholdSec <= 0 || !i.unattended || i.agent || i.fullScreen || isAgentCommand(i.command)) return undefined
  if (i.durationMs < i.thresholdSec * 1000 || i.exitCode === undefined) return undefined
  const took = formatDuration(i.durationMs)
  if (i.exitCode === 0) return { level: 'quiet', label: 'done', reason: `${label(i.command)} finished after ${took}` }
  return { level: 'quiet', label: 'failed', reason: `${label(i.command)} failed (exit ${i.exitCode}) after ${took}`, interrupt: true }
}

/** Watch one terminal's blocks and raise the alert when a long command ends. */
export function watchBlockAlerts(rt: Runtime): void {
  const blocks = rt.blocks
  if (blocks === undefined) return
  const fullScreen = new Set<number>()
  const handled = new Set<number>()
  // A block counts as full-screen once the alternate buffer was on while it ran.
  rt.term.buffer.onBufferChange((buf) => {
    if (buf.type !== 'alternate') return
    const list = blocks.list()
    const running = list[list.length - 1]
    if (running?.state === 'running') fullScreen.add(running.id)
  })
  blocks.subscribe((b: Block) => {
    if (b.state !== 'done' || handled.has(b.id)) return
    handled.add(b.id)
    if (handled.size > 1000) handled.delete(handled.values().next().value as number)
    const alert = commandAlert({
      command: b.command,
      exitCode: b.exitCode,
      durationMs: blockDuration(b) ?? 0,
      thresholdSec: prefs.commandNotifySec,
      agent: rt.agent !== undefined && rt.agent.state !== 'ended',
      fullScreen: fullScreen.has(b.id) || rt.term.buffer.active.type === 'alternate',
      unattended: unattended(rt.id),
    })
    if (alert !== undefined) raiseAttention(rt, alert)
  })
}
