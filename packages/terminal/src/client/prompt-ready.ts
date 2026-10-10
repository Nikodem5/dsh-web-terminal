// dsh-web-terminal — when a fresh shell is ready to be typed into.

/** Bounds, in ms. Mutable so tests can shrink them. */
export const startupTiming = {
  /** Never type sooner than this after attach. */
  minMs: 150,
  /** Output must have been quiet this long: the profile has finished and the prompt is drawn. */
  settleMs: 250,
  /** Type anyway after this long: a shell that prints nothing until input, or never goes quiet. */
  maxMs: 5000,
}

/**
 * How long to wait before typing the startup command, 0 meaning now. A shell is ready once it has printed
 * something and then gone quiet; each chunk of output restarts the quiet period, so a slow profile that
 * prints in pieces is waited out. With no output at all the max bound applies.
 * With shell integration the shell says exactly when its prompt is ready for input (`promptReady`), so there is no waiting.
 */
export function startupWait(now: number, attachedAt: number, lastOutputAt: number | undefined, t = startupTiming, promptReady = false): number {
  if (promptReady) return 0
  const deadline = attachedAt + t.maxMs
  const readyAt = lastOutputAt === undefined ? deadline : Math.max(attachedAt + t.minMs, lastOutputAt + t.settleMs)
  return Math.max(0, Math.min(readyAt, deadline) - now)
}
