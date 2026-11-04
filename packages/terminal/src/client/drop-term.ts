// dsh-web-terminal — OS files dropped on a terminal body: paste their quoted full paths (no Enter).
//
// The full path comes from the desktop app's preload bridge (window.__DSH_HOST_PATHS__.pathFor, i.e. Electron's
// webUtils.getPathForFile). A plain browser has no such bridge and never exposes full paths, so there the drop
// does nothing. SSH windows ignore the drop: a path on this machine means nothing on the remote one.

import { dropShellKind, planDrop } from './drop-paths.ts'
import { pasteInput } from './send-to.ts'
import { hostInfo, runtimes } from './state.ts'
import type { DragEvent as ReactDragEvent } from 'react'

interface HostPaths {
  pathFor(file: File): string
}

function bridge(): HostPaths | undefined {
  const b = (window as unknown as { __DSH_HOST_PATHS__?: Partial<HostPaths> }).__DSH_HOST_PATHS__
  return typeof b?.pathFor === 'function' ? (b as HostPaths) : undefined
}

/** Only drags that carry OS files; internal drags (sidebar, windows) carry other types and are left alone. */
function hasFiles(e: ReactDragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

export function onTerminalDragOver(e: ReactDragEvent, ssh: boolean): void {
  if (!hasFiles(e)) return
  e.preventDefault() // also stops the page navigating to the file
  e.dataTransfer.dropEffect = ssh || bridge() === undefined ? 'none' : 'copy'
}

export function onTerminalDrop(e: ReactDragEvent, id: string, shellId: string, ssh: boolean): void {
  if (!hasFiles(e)) return
  e.preventDefault()
  e.stopPropagation()
  const api = bridge()
  const rt = runtimes.get(id)
  if (ssh || api === undefined || rt === undefined || rt.socket?.readyState !== WebSocket.OPEN) return
  const paths = Array.from(e.dataTransfer.files).map((f) => {
    try {
      return api.pathFor(f) || undefined
    } catch {
      return undefined
    }
  })
  const plan = planDrop(paths, dropShellKind(shellId, hostInfo.platform === 'win32'))
  if (plan.skipped > 0) console.warn(`[terminal] ${plan.skipped} dropped item(s) not pasted (no full path or not safely quotable for this shell)`)
  if (plan.text.length === 0) return
  rt.lastInputAt = Date.now()
  rt.socket.send(JSON.stringify({ type: 'input', data: pasteInput(plan.text, rt.term.modes.bracketedPasteMode) }))
  rt.term.focus()
}
