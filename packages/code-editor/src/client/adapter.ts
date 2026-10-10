// dsh-code-editor - the editor behind a small interface, so the page logic is testable without Monaco.

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
  onKey(cb: (action: 'save' | 'quickOpen' | 'closeTab') => void): void
  dispose(): void
}

export interface AdapterFactory {
  create(opts: { dark: boolean }): Promise<EditorHost>
}
