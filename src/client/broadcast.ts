// dsh-web-terminal — broadcast: send one command line to several terminals at once.

import { emit, runtimes, store } from './state.ts'

export function setBroadcast(patch: Partial<{ on: boolean; live: boolean }>): void {
  store.broadcast = { ...store.broadcast, ...patch, ids: store.broadcast.ids }
  if (patch.on === true && store.broadcast.ids.size === 0) for (const w of store.wins) store.broadcast.ids.add(w.id)
  emit()
}

export function toggleBroadcastTarget(id: string): void {
  if (store.broadcast.ids.has(id)) store.broadcast.ids.delete(id)
  else store.broadcast.ids.add(id)
  emit()
}

export function setBroadcastTargets(ids: string[]): void {
  store.broadcast.ids = new Set(ids)
  emit()
}

/** Type one command line into every selected terminal. Returns how many received it. */
export function broadcastLine(text: string): number {
  let sent = 0
  for (const id of store.broadcast.ids) {
    const rt = runtimes.get(id)
    if (rt?.socket?.readyState === WebSocket.OPEN) {
      rt.lastInputAt = Date.now()
      rt.socket.send(JSON.stringify({ type: 'input', data: `${text}\r` }))
      sent++
    }
  }
  return sent
}
