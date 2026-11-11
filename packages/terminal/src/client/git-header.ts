// dsh-web-terminal — git branch and dirty marker in a window's header.
//
// The host does the work (lib/git-header.js: async git, cached, throttled) and sends a `git` frame
// whenever the answer changes. This side only asks at the right moments — the terminal attached, or
// a command finished and a new prompt appeared (the folder or the repository may have changed) —
// and shows what comes back. ssh windows never ask: their folder is on another machine.

import { emit } from './state.ts'
import type { GitInfo, Runtime } from './types.ts'

/** Longest branch text drawn in the header; the full name is in the tooltip. */
export const BRANCH_SHOWN = 28

/** Ask the host to look at this terminal's folder (the shell's current one when it reports it). */
export function requestGit(rt: Runtime): void {
  if (rt.ssh || rt.socket === null || rt.socket.readyState !== WebSocket.OPEN) return
  try {
    rt.socket.send(JSON.stringify({ type: 'git-refresh', cwd: rt.cwd }))
  } catch {}
}

/** Take the host's answer: `null` (or anything malformed) means "not a repository". */
export function applyGit(rt: Runtime, raw: unknown): void {
  let next: GitInfo | undefined
  if (!rt.ssh && typeof raw === 'object' && raw !== null) {
    const { branch, dirty, detached } = raw as Record<string, unknown>
    if (typeof branch === 'string' && branch.length > 0 && branch.length <= 300) {
      next = { branch, dirty: dirty === true, ...(detached === true ? { detached: true } : {}) }
    }
  }
  const prev = rt.git
  if (prev === next || (prev !== undefined && next !== undefined && prev.branch === next.branch && prev.dirty === next.dirty && prev.detached === next.detached)) return
  rt.git = next
  emit()
}

/** The header chip's text and tooltip, or undefined when there is nothing to show. */
export function gitLabel(git: GitInfo | undefined): { text: string; title: string } | undefined {
  if (git === undefined) return undefined
  const name = git.branch.length > BRANCH_SHOWN ? `${git.branch.slice(0, BRANCH_SHOWN - 1)}…` : git.branch
  const where = git.detached === true ? `Detached HEAD at ${git.branch}` : `Branch ${git.branch}`
  return { text: `⎇ ${name}${git.dirty ? ' ●' : ''}`, title: `${where} — ${git.dirty ? 'uncommitted changes' : 'clean'}` }
}

/**
 * Ask again after each command: a new prompt that follows a finished command, or one in a different folder.
 * The subscription lives and dies with the block model, so there is nothing to clean up.
 */
export function watchGit(rt: Runtime): void {
  const blocks = rt.blocks
  if (blocks === undefined || rt.ssh) return
  let ran = false
  let askedIn = ''
  blocks.subscribe((b) => {
    if (b.state === 'done') ran = true
    else if (b.state === 'prompt' && (ran || (rt.cwd ?? '') !== askedIn)) {
      ran = false
      askedIn = rt.cwd ?? ''
      requestGit(rt)
    }
  })
}
