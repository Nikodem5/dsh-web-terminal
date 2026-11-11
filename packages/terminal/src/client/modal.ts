// dsh-web-terminal — which modal surfaces (New terminal dialog, help panel) are open.
//
// A plain module flag, not React state: the page's window-level key handler is installed once, so
// anything it reads from a render would be stale. Window shortcuts (close, maximize, switch...)
// stand down while a modal is open instead of acting on the terminal behind it.

const open = new Set<string>()

/** Record that the modal `name` opened or closed. */
export function setModalOpen(name: string, on: boolean): void {
  if (on) open.add(name)
  else open.delete(name)
}

/** Whether any modal surface is open. */
export const isModalOpen = (): boolean => open.size > 0
