// dsh-code-editor - the editor behind a small interface, so the page logic is testable without Monaco.

/** Shortcuts the editor itself catches (Monaco swallows keys before the page's window listener sees them). */
export type EditorKey = 'save' | 'quickOpen' | 'closeTab' | 'searchFiles' | 'searchNext' | 'searchPrev'

export interface Position { line: number; col: number }

export interface EditorHost {
  /** Show a text file; creates its model on first use. Returns the model text (line endings normalised): the new "saved" baseline. */
  showFile(id: string, text: string, language: string, readOnly: boolean): string
  /** Show a diff; updates the existing models' text in place when the id is already known. */
  showDiff(id: string, original: string, modified: string, language: string, inline: boolean): void
  /** Show nothing (no tab). */
  showNone(): void
  getValue(id: string): string | null
  /** Replace a model's text keeping cursor and scroll. False when the model does not exist. */
  setValue(id: string, text: string): boolean
  hasModel(id: string): boolean
  getEol(id: string): 'lf' | 'crlf'
  disposeModel(id: string): void
  reveal(line: number, col: number): void
  setTheme(dark: boolean): void
  setInline(inline: boolean): void
  layout(): void
  focus(): void
  /** The DOM element to put in the page. */
  readonly element: HTMLElement
  onChange(cb: (id: string) => void): void
  onCursor(cb: (p: Position) => void): void
  onKey(cb: (action: EditorKey) => void): void
  // --- search + markdown preview (all optional: hosts without them just skip the feature) ---
  /** Highlight a search match in the shown file `id` (replaces the previous one; cleared by `clearHighlight` or by showing another file). */
  highlight?(id: string, line: number, col: number, length: number): void
  clearHighlight?(): void
  /** Syntax-colour code to HTML (`<span class="mtkN">` runs); null when the language is unknown. The caller sanitizes. */
  colorize?(text: string, language: string): Promise<string | null>
  /** The shown file scrolled; ratio = scrollTop / scrollable height (0..1). */
  onScroll?(cb: (id: string, ratio: number) => void): void
  dispose(): void
}

export interface AdapterFactory {
  create(opts: { dark: boolean }): Promise<EditorHost>
}
