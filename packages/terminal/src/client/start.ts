// dsh-web-terminal — plugin start: reattach every saved terminal before the page is ever opened.
//
// Agent counts, attention alerts and the chime all come from the sockets, so without this a
// Claude terminal waiting for permission goes unnoticed until the user opens the Terminals page.
// Runtimes are created unopened (no DOM); the page opens them when it first shows their windows.

import { hydrate, store } from './state.ts'
import { ensureRuntime } from './runtime.ts'

/** Restore the saved layout and connect a runtime for each saved window. Safe to call repeatedly. */
export function startTerminals(): void {
  hydrate()
  // ensureRuntime returns the existing runtime, so a later page mount never builds a second one.
  for (const win of store.wins) ensureRuntime(win)
}
