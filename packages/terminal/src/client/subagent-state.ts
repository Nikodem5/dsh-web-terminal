// dsh-web-terminal — keeps each runtime's sub-agent list and counts them across terminals.

import { emit, runtimes } from './state.ts'
import { countRunning, parseSubagents } from './subagents.ts'
import type { Runtime } from './types.ts'

/** Replace a terminal's list with the host's (full list each time); a missing list from an old host means none. */
export function applySubagents(rt: Runtime, raw: unknown): void {
  rt.subagents = parseSubagents(raw)
  emit()
}

/** Running sub-agents across every terminal. */
export const runningSubagents = (): number => countRunning([...runtimes.values()].map((rt) => rt.subagents))
