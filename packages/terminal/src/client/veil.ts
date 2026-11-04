// dsh-web-terminal — veil: hides a starting agent terminal until the agent is up.
//
// A new shell for an agent window shows its raw banner, prompt and the echoed startup command for
// about a second before the agent draws anything (and Antigravity flashes a sign-in splash and
// repaints). The veil covers the terminal with a placeholder from spawn until the agent reports a
// state, so the user sees "Starting …" and then the agent. The decisions are pure so they can be
// tested without a browser; the stateful half applies them to a runtime's holder.

import type { AgentProvider } from './providers.ts'
import type { Runtime } from './types.ts'

/** Bounds, in ms. Mutable so tests can shrink them. */
export const veilTiming = {
  /**
   * Never keep the veil longer than this. Claude signals only if its hooks run, and an agent that fails to start
   * says nothing, so the screen must become visible (the failure with it) even without a signal.
   */
  timeoutMs: 5000,
  /**
   * How long after the first signal the veil stays up. Antigravity reports `idle` about 15 ms before ConPTY repaints
   * its screen (and has just left the alternate screen the sign-in splash used, showing the shell underneath), so
   * lifting on the signal, or on the next frame, shows an unpainted frame. This covers that repaint, the network hop
   * and the output batching; it is brief enough to read as part of the start.
   */
  liftDelayMs: 120,
}

/**
 * Whether a shell that just attached is veiled: a new shell (not a reattach, whose replay is the real
 * screen) that will be typed a provider's startup command. Plain commands and ssh windows are never veiled.
 */
export function shouldVeil(input: { created: boolean; ssh: boolean; startup: string | undefined; provider: AgentProvider | undefined }): boolean {
  return input.created && !input.ssh && input.provider !== undefined && (input.startup?.trim().length ?? 0) > 0
}

/** The placeholder's text. */
export function veilText(label: string): string {
  return `Starting ${label}…`
}

/** Cover the terminal until the agent is up (or the timeout). Safe to call twice. */
export function startVeil(rt: Runtime, label: string): void {
  liftVeil(rt)
  rt.veiled = true
  const el = document.createElement('div')
  el.className = 'wt-veil'
  el.setAttribute('role', 'status')
  el.textContent = veilText(label)
  rt.holder.append(el)
  rt.veilEl = el
  rt.veilTimeout = setTimeout(() => liftVeil(rt), veilTiming.timeoutMs)
}

/** Take the veil off now (`soon`: after the repaint that follows the first signal has been painted). */
export function liftVeil(rt: Runtime, soon = false): void {
  if (rt.veiled !== true) return
  if (soon) {
    if (rt.veilLift !== undefined) return
    rt.veilLift = setTimeout(() => {
      rt.veilLift = undefined
      // What arrived so far (output is batched into xterm within 50 ms) is parsed first, and the veil comes off after the frame that draws it.
      rt.term.write('', () => requestAnimationFrame(() => liftVeil(rt)))
    }, veilTiming.liftDelayMs)
    return
  }
  clearVeilTimers(rt)
  rt.veiled = false
  rt.veilEl?.remove()
  rt.veilEl = undefined
}

/** Stop the veil's timers (the runtime is being dropped). */
export function clearVeilTimers(rt: Runtime): void {
  clearTimeout(rt.veilTimeout)
  clearTimeout(rt.veilLift)
  rt.veilTimeout = undefined
  rt.veilLift = undefined
}
