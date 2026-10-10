// dsh-web-terminal — user-level actions that wrap store operations with safety prompts.

import { busyAmong, closeAll, closeWin, displayName, getWins } from './terminal-store.ts'

/**
 * Close terminals, asking first when any of them is still running something
 * (an agent, a build...). Returns whether they were closed.
 * @param ids - window ids to close.
 */
export function requestClose(ids: string[]): boolean {
  const busy = busyAmong(ids)
  if (busy.length > 0) {
    const names = busy.map((w) => `“${displayName(w)}”`).join(', ')
    const message =
      busy.length === 1
        ? `${names} is still running something. Close it and end its shell?`
        : `${names} are still running something. Close them and end their shells?`
    if (!window.confirm(message)) return false
  }
  for (const id of ids) closeWin(id)
  return true
}

/** Close every terminal, with the same running-process confirmation. */
export function requestCloseAll(): boolean {
  const ids = getWins().map((w) => w.id)
  if (ids.length === 0) return true
  const busy = busyAmong(ids)
  const message =
    busy.length > 0
      ? `Close all ${ids.length} terminals? ${busy.length} still running something and will be ended.`
      : `Close all ${ids.length} terminals and end their shells?`
  if (!window.confirm(message)) return false
  closeAll()
  return true
}

/** Native folder chooser exposed by the desktop app, when present. */
export function canBrowse(): boolean {
  return typeof (globalThis as { __DSH_DIRECTORY_PICKER__?: unknown }).__DSH_DIRECTORY_PICKER__ === 'object'
}

/** Ask the OS for a folder; resolves to its path or null when cancelled/unavailable. */
export async function browseFolder(): Promise<string | null> {
  const picker = (globalThis as { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } }).__DSH_DIRECTORY_PICKER__
  if (picker === undefined) return null
  try {
    return await picker.pick()
  } catch {
    return null
  }
}
