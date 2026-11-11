// dsh-web-terminal — Overseer: a terminal's raw scrollback as plain text.
//
// The host keeps each terminal's output as it came from the PTY (`session.replay`): ANSI escapes,
// carriage-return progress bars and, for full-screen agents (Claude Code is an Ink TUI), the same
// frame redrawn over and over with cursor moves. This turns the recent end of it into lines a model
// can read: escapes stripped, `\r` overwrites and backspaces applied, cursor jumps read as line
// breaks, and repeated redraw lines reduced to their latest copy.
//
// Pure functions, no I/O.

/** At most this much of the raw replay is looked at (characters, from the end). */
export const RAW_WINDOW = 200_000

/** A recent line seen again within this many lines is a redraw: only its latest copy is kept. */
const REDRAW_WINDOW = 80

/** Characters that only draw boxes, rules and spinners. */
const DECOR = /^[\s─-╿▀-▟■-◿⠀-⣿·•*✳✶✻✽✢⏺⎿│─|+=_.~-]*$/u

/**
 * Split raw terminal output into logical lines, applying what a terminal would do with the
 * control characters that matter for text: `\r` returns to column 0 (so a progress bar keeps its
 * last state), `\b` steps back, and cursor-position / clear sequences start a new line.
 * Every other escape (colours, modes, titles, hyperlinks...) is dropped.
 * @param raw - output as the PTY produced it.
 * @returns the lines, without trailing whitespace.
 */
export function terminalLines(raw) {
  const lines = []
  /** The line being written, as an array of characters so `\r` can overwrite in place. */
  let cells = []
  let col = 0
  const endLine = () => {
    lines.push(cells.join('').replace(/\s+$/u, ''))
    cells = []
    col = 0
  }
  const put = (ch) => {
    if (col < cells.length) cells[col] = ch
    else {
      while (cells.length < col) cells.push(' ')
      cells.push(ch)
    }
    col++
  }
  const n = raw.length
  let i = 0
  while (i < n) {
    const ch = raw[i]
    const code = ch.charCodeAt(0)
    if (ch === '\x1b') {
      const next = raw[i + 1]
      if (next === '[') {
        // CSI: parameters, intermediates, one final byte.
        let j = i + 2
        while (j < n && /[0-9;:<=>?]/.test(raw[j])) j++
        while (j < n && /[ -/]/.test(raw[j])) j++
        const final = raw[j]
        const params = raw.slice(i + 2, j)
        i = j + 1
        // Cursor moved to another row, or the screen/line was cleared: whatever follows is a new line.
        if (final === 'H' || final === 'f' || final === 'A' || final === 'B' || final === 'E' || final === 'F' || final === 'd') {
          if (cells.length > 0) endLine()
          else col = 0
        } else if (final === 'J') {
          if (cells.length > 0) endLine()
        } else if (final === 'K' && (params === '2' || params === '1')) {
          // Erase the whole line (or up to the cursor): the next text replaces it.
          cells = []
          col = 0
        } else if (final === 'K') {
          // Erase from the cursor to the end of the line.
          if (col < cells.length) cells.length = col
        } else if (final === 'G' || final === '`') {
          col = Math.max(0, (Number.parseInt(params, 10) || 1) - 1)
        } else if (final === 'C') {
          col += Math.max(1, Number.parseInt(params, 10) || 1)
        }
        continue
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        // OSC / DCS / APC / PM / SOS: a string ended by BEL or ST.
        let j = i + 2
        while (j < n && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j++
        i = raw[j] === '\x07' ? j + 1 : j + 2
        continue
      }
      // Two- or three-character escapes (charset selection, keypad modes, save/restore cursor).
      i += next === '(' || next === ')' || next === '*' || next === '+' || next === '#' ? 3 : 2
      continue
    }
    if (ch === '\n') {
      endLine()
      i++
      continue
    }
    if (ch === '\r') {
      col = 0
      i++
      continue
    }
    if (ch === '\b') {
      col = Math.max(0, col - 1)
      i++
      continue
    }
    if (ch === '\t') {
      col = (Math.floor(col / 8) + 1) * 8
      i++
      continue
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) {
      i++
      continue
    }
    // Keep surrogate pairs together.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
      put(raw.slice(i, i + 2))
      i += 2
      continue
    }
    put(ch)
    i++
  }
  if (cells.length > 0) endLine()
  return lines
}

/**
 * Reduce redraw noise: drop decoration-only lines, collapse blank runs, and of a line repeated
 * within a short window keep only its latest copy (a TUI repaints the same frame many times).
 * @param lines - lines from `terminalLines`.
 * @returns the reduced lines, in order.
 */
export function reduceNoise(lines) {
  const kept = []
  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, '')
    if (line.length > 0 && DECOR.test(line)) continue
    if (line.length === 0) {
      if (kept.length === 0 || kept[kept.length - 1] === '') continue
      kept.push('')
      continue
    }
    // A repeat of a line in the recent window: move it to the end (the newest copy wins).
    const from = Math.max(0, kept.length - REDRAW_WINDOW)
    const seen = kept.lastIndexOf(line)
    if (seen >= from) kept.splice(seen, 1)
    kept.push(line)
  }
  // Blank runs may have formed where repeats were removed.
  const out = []
  for (const line of kept) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

/**
 * The recent end of a terminal's scrollback as plain text.
 * @param replay - the raw replay string.
 * @param maxChars - most characters to return; older lines are dropped first.
 * @returns {{text: string, truncated: boolean}} the text and whether older output was left out.
 */
export function scrollbackText(replay, maxChars) {
  if (typeof replay !== 'string' || replay.length === 0 || maxChars <= 0) return { text: '', truncated: false }
  let raw = replay
  let cut = false
  if (raw.length > RAW_WINDOW) {
    raw = raw.slice(raw.length - RAW_WINDOW)
    // Start at a line boundary so a half escape sequence is not read as text.
    const nl = raw.indexOf('\n')
    if (nl >= 0) raw = raw.slice(nl + 1)
    cut = true
  }
  const lines = reduceNoise(terminalLines(raw))
  const picked = []
  let size = 0
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k].length > 1000 ? `${lines[k].slice(0, 999)}…` : lines[k]
    if (size + line.length + 1 > maxChars) {
      cut = true
      break
    }
    picked.push(line)
    size += line.length + 1
  }
  picked.reverse()
  return { text: picked.join('\n'), truncated: cut }
}
