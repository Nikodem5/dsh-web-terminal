// dsh-web-terminal — remembered folders, favourites and simple on/off preferences.

import { emit, persistSoon, prefs } from './state.ts'
import { sshKey } from './ssh.ts'
import type { SshTarget } from './types.ts'

/** Remember a folder as recent and as the next default. */
export function noteFolder(cwd: string, shell?: string): void {
  if (cwd.length === 0) return
  prefs.lastCwd = cwd
  if (shell !== undefined) prefs.lastShell = shell
  prefs.recents = [cwd, ...prefs.recents.filter((p) => p !== cwd)].slice(0, 12)
}

export function toggleFavourite(cwd: string): void {
  if (cwd.length === 0) return
  prefs.favourites = prefs.favourites.includes(cwd) ? prefs.favourites.filter((p) => p !== cwd) : [...prefs.favourites, cwd]
  emit()
  persistSoon()
}

export function forgetRecent(cwd: string): void {
  prefs.recents = prefs.recents.filter((p) => p !== cwd)
  emit()
  persistSoon()
}

/** Remember an SSH target as recent (newest first, ten at most). The target holds no secrets. */
export function noteSsh(ssh: SshTarget): void {
  const key = sshKey(ssh)
  prefs.sshRecents = [ssh, ...prefs.sshRecents.filter((s) => sshKey(s) !== key)].slice(0, 10)
}

export function toggleSshFavourite(ssh: SshTarget): void {
  const key = sshKey(ssh)
  prefs.sshFavourites = prefs.sshFavourites.some((s) => sshKey(s) === key) ? prefs.sshFavourites.filter((s) => sshKey(s) !== key) : [...prefs.sshFavourites, ssh]
  emit()
  persistSoon()
}

export function forgetSsh(ssh: SshTarget): void {
  const key = sshKey(ssh)
  prefs.sshRecents = prefs.sshRecents.filter((s) => sshKey(s) !== key)
  emit()
  persistSoon()
}

export function setSidebar(open: boolean): void {
  prefs.sidebar = open
  emit()
  persistSoon()
}

export function setAgentsPanel(open: boolean): void {
  prefs.agentsPanel = open
  emit()
  persistSoon()
}

export function setNotify(on: boolean): void {
  prefs.notify = on
  emit()
  persistSoon()
}

export function setSound(on: boolean): void {
  prefs.sound = on
  emit()
  persistSoon()
}

/** Minutes of silence before a working agent is flagged; 0 turns the alert off. */
export function setHungMinutes(minutes: number): void {
  prefs.hungMinutes = Math.min(240, Math.max(0, Math.round(minutes) || 0))
  emit()
  persistSoon()
}

/** Remember the folder of the chat session being viewed, so the dialog can offer "the last session's workspace". */
export function noteSessionCwd(cwd: string | undefined): void {
  if (cwd === undefined || cwd.length === 0 || cwd === prefs.sessionCwd) return
  prefs.sessionCwd = cwd
  persistSoon()
}
