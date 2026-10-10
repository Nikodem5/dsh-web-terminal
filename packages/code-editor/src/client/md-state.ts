// dsh-code-editor - the markdown preview's logic: the mode per tab (Off / Side by side / Preview only), the text being
// previewed (updated as you type, debounced) and scroll-sync fan-out. No DOM, no Monaco.

export type MdMode = 'off' | 'side' | 'only'
export const MD_DEBOUNCE_MS = 200

export interface MdState {
  modes: Record<string, MdMode>
  /** The text shown by the preview of the active tab (`id` null = nothing). */
  source: { id: string | null; text: string }
}

export interface MdDeps {
  /** The live text of a file tab (the editor's model), or null when unavailable. */
  getText(id: string): string | null
  active(): string | null
  debounceMs?: number
}

export class MarkdownController {
  private s: MdState = { modes: {}, source: { id: null, text: '' } }
  private listeners = new Set<() => void>()
  private scrollListeners = new Set<(ratio: number) => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly deps: MdDeps

  constructor(deps: MdDeps) { this.deps = deps }

  getState = (): MdState => this.s
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
  private set(patch: Partial<MdState>): void {
    this.s = { ...this.s, ...patch }
    for (const l of [...this.listeners]) l()
  }

  mode(id: string | null): MdMode { return id === null ? 'off' : (this.s.modes[id] ?? 'off') }

  setMode(id: string, mode: MdMode): void {
    const modes = { ...this.s.modes }
    if (mode === 'off') delete modes[id]
    else modes[id] = mode
    this.set({ modes })
    if (id === this.deps.active()) this.refresh()
  }

  /** The active tab changed (or finished loading): show its text now. */
  activeChanged(id: string | null): void {
    this.cancel()
    if (id === null || this.mode(id) === 'off') {
      if (this.s.source.id !== null) this.set({ source: { id: null, text: '' } })
      return
    }
    this.refresh()
  }

  /** The editor text of `id` changed: refresh the preview after the debounce when that tab is previewed. */
  notifyEdit(id: string): void {
    if (id !== this.deps.active() || this.mode(id) === 'off') return
    this.cancel()
    this.timer = setTimeout(() => { this.timer = null; this.refresh() }, this.deps.debounceMs ?? MD_DEBOUNCE_MS)
  }

  /** Re-read the text of the active previewed tab right away. */
  refresh(): void {
    this.cancel()
    const id = this.deps.active()
    if (id === null || this.mode(id) === 'off') {
      if (this.s.source.id !== null) this.set({ source: { id: null, text: '' } })
      return
    }
    const text = this.deps.getText(id)
    if (text === null) return
    if (this.s.source.id !== id || this.s.source.text !== text) this.set({ source: { id, text } })
  }

  /** A tab closed. */
  forget(id: string): void {
    if (!(id in this.s.modes) && this.s.source.id !== id) return
    const modes = { ...this.s.modes }
    delete modes[id]
    this.cancel()
    this.set({ modes, source: this.s.source.id === id ? { id: null, text: '' } : this.s.source })
  }

  /** The folder changed: every tab is gone. */
  reset(): void {
    this.cancel()
    this.set({ modes: {}, source: { id: null, text: '' } })
  }

  private cancel(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  // ---- scroll sync (editor -> preview, by line ratio) -----------------------------------------------------------

  /** The editor of `id` scrolled to `ratio` (0..1 of its scrollable height). */
  scrolled(id: string, ratio: number): void {
    if (id !== this.deps.active() || this.mode(id) !== 'side') return
    const r = Math.min(1, Math.max(0, ratio))
    for (const l of [...this.scrollListeners]) l(r)
  }
  onScroll(cb: (ratio: number) => void): () => void {
    this.scrollListeners.add(cb)
    return () => { this.scrollListeners.delete(cb) }
  }

  dispose(): void { this.cancel(); this.listeners.clear(); this.scrollListeners.clear() }
}
