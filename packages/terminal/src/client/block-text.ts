// dsh-web-terminal — command blocks: what a block's output is, as text and as buffer rows, and the
// pure decisions around it (which rows it spans, whether Rerun is allowed, which block the keys and
// the sticky bar mean). No DOM and no xterm import, so the tests can feed it plain data.

/** One buffer row as the extraction needs it. */
export interface RowLike {
  /** The row continues the one above (the program's line was wider than the terminal). */
  wrapped: boolean
  /** The row's text; with `trimRight` the trailing blanks are dropped. */
  text: (trimRight: boolean) => string
}

export interface OutputText {
  text: string
  /** First and last buffer row that hold output, trailing blank rows excluded. */
  first: number
  last: number
  /** Characters on the last row (trimmed): with the rows above it, the length of a selection over the output. */
  lastLen: number
}

/**
 * Text of the buffer rows `first..last`: wrapped rows are joined back into the line they came from (no
 * newline, and no trimming of a row that goes on), the end of every line is trimmed, and trailing blank
 * lines are dropped. Undefined when nothing but blank lines is left.
 */
export function extractOutput(row: (y: number) => RowLike | undefined, first: number, last: number): OutputText | undefined {
  const lines: { text: string; lastRow: number; lastLen: number }[] = []
  for (let y = first; y <= last; y++) {
    const r = row(y)
    if (r === undefined) break
    const continues = y < last && row(y + 1)?.wrapped === true
    const text = r.text(!continues)
    const tail = lines.at(-1)
    if (r.wrapped && tail !== undefined) {
      tail.text += text
      tail.lastRow = y
      tail.lastLen = r.text(true).length
    } else lines.push({ text, lastRow: y, lastLen: text.length })
  }
  while (lines.length > 0 && lines.at(-1)!.text.trim().length === 0) lines.pop()
  const tail = lines.at(-1)
  if (tail === undefined) return undefined
  return { text: lines.map((l) => l.text).join('\n'), first, last: tail.lastRow, lastLen: tail.lastLen }
}

/** The marker fields the output range needs (xterm's IMarker has them). */
interface MarkerLike {
  line: number
  isDisposed: boolean
}
interface BlockLike {
  state: 'prompt' | 'running' | 'done'
  outputStart: MarkerLike | undefined
  end: MarkerLike | undefined
}

export type OutputRows = { first: number; last: number } | { disabled: string }

/**
 * Rows a block's output covers. Disabled when the command has not started, when its first output row
 * has already left the scrollback (only part of the output would be copied) or when it printed nothing.
 * A running block ends at the cursor row, so it can be copied as a snapshot.
 * @param cursorRow - absolute row of the cursor, and `cursorX` its column (a cursor at column 0 sits below the last output line).
 */
export function outputRows(block: BlockLike, cursorRow: number, cursorX: number): OutputRows {
  const start = block.outputStart
  if (block.state === 'prompt' || start === undefined) return { disabled: 'This prompt has no command output yet' }
  if (start.isDisposed) return { disabled: 'Part of this output has scrolled out of the history, so it cannot be copied whole' }
  const end = block.end !== undefined && !block.end.isDisposed ? block.end.line : block.state === 'running' ? (cursorX === 0 ? cursorRow - 1 : cursorRow) : undefined
  if (end === undefined) return { disabled: 'The end of this output has scrolled out of the history' }
  if (end < start.line) return { disabled: 'This command printed no output' }
  return { first: start.line, last: end }
}

// ── rerun ──

export interface RerunInput {
  /** The block asked about, and the newest block of the terminal. */
  block: { command: string; id: number }
  newest: { state: 'prompt' | 'running' | 'done'; id: number } | undefined
  live: boolean
  /** The host says a program runs under the shell. */
  hostBusy: boolean | undefined
  alternate: boolean
}

/** Whether a block's command may be typed again: only while the shell sits at a prompt, and only a one-line command. */
export function rerunGate(i: RerunInput): { ok: true } | { ok: false; reason: string } {
  if (i.block.command.trim().length === 0) return { ok: false, reason: 'No command text to run again' }
  if (/[\r\n]/.test(i.block.command)) return { ok: false, reason: 'A multi-line command cannot be typed again safely' }
  if (!i.live) return { ok: false, reason: 'The terminal is not connected' }
  if (i.alternate || i.hostBusy === true || i.newest === undefined || i.newest.state === 'running') return { ok: false, reason: 'A program is running: wait for the prompt' }
  return { ok: true }
}

// ── which block the position means ──

export interface Span {
  id: number
  prompt: number
  /** Last row of the block. */
  last: number
  failed: boolean
}

/** The block whose rows include `line`. */
export function blockAt(spans: readonly Span[], line: number): Span | undefined {
  return spans.find((s) => s.prompt <= line && line <= s.last)
}

/** The block the sticky bar names: the viewport starts below its prompt, inside its rows. */
export function stickyFor(spans: readonly Span[], viewportTop: number): Span | undefined {
  return spans.find((s) => s.prompt < viewportTop && viewportTop <= s.last)
}

/** Prompt row to scroll to for "previous" / "next" command, relative to the top row of the viewport; undefined = no such block. */
export function stepTarget(spans: readonly Span[], viewportTop: number, dir: -1 | 1): number | undefined {
  if (dir < 0) return spans.filter((s) => s.prompt < viewportTop).at(-1)?.prompt
  return spans.find((s) => s.prompt > viewportTop)?.prompt
}

/**
 * Prompt row of the failed command to show. The first press picks the newest failure; pressing again
 * (while the view still sits where that jump left it) moves to the next older one, then wraps to the newest.
 * `shown.top` is the viewport top after the jump (the view cannot scroll past the end, so it is not always the prompt row).
 */
export function failedTarget(spans: readonly Span[], viewportTop: number, shown: { prompt: number; top: number } | undefined): number | undefined {
  const failed = spans.filter((s) => s.failed)
  if (failed.length === 0) return undefined
  if (shown !== undefined && viewportTop === shown.top) {
    const older = failed.filter((s) => s.prompt < shown.prompt).at(-1)
    if (older !== undefined) return older.prompt
  }
  return failed.at(-1)!.prompt
}
