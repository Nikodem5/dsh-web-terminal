// Replay buffer trimming.
//
// The scrollback kept for reattach is cut to a fixed size from the front. A
// blind slice can land inside an escape sequence (CSI, OSC, DCS...), and
// replaying a tail like `31m` or the end of a hyperlink paints garbage and can
// leave the terminal in a wrong mode. This moves the cut to a safe point.

/** How far back from the cut an escape sequence start is searched for (characters). */
const LOOKBACK = 4096

/**
 * Find where the escape sequence starting at `at` (an ESC) ends.
 * @param text - the buffer.
 * @param at - index of the ESC.
 * @returns the index just past the sequence, or -1 when it is not terminated within the text.
 */
function sequenceEnd(text, at) {
  const kind = text[at + 1]
  if (kind === undefined) return -1
  if (kind === '[') {
    // CSI: parameter/intermediate bytes 0x20-0x3f, then one final byte 0x40-0x7e.
    let j = at + 2
    while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x3f) j++
    if (j >= text.length) return -1
    const code = text.charCodeAt(j)
    // A byte outside the grammar aborts the sequence; treat it as ended before that byte.
    return code >= 0x40 && code <= 0x7e ? j + 1 : j
  }
  if (kind === ']' || kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
    // OSC / DCS / APC / PM / SOS: a string ended by ST (ESC \), and for OSC also BEL.
    const limit = Math.min(text.length, at + 2 + LOOKBACK)
    for (let j = at + 2; j < limit; j++) {
      const c = text[j]
      if (c === '\x07' && kind === ']') return j + 1
      if (c === '\x9c') return j + 1
      if (c === '\x1b' && text[j + 1] === '\\') return j + 2
    }
    return -1
  }
  // Two-character escapes, with optional intermediates (0x20-0x2f) before the final byte.
  let j = at + 1
  while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++
  return j < text.length ? j + 1 : -1
}

/**
 * Keep the last `limit` characters of `text`, without starting inside an escape
 * sequence or between the halves of a surrogate pair.
 *
 * The cut is advanced past the sequence it landed in, so the result can be a
 * few characters SHORTER than `limit`. A sequence still open at the end of the
 * text is kept whole instead (result longer by at most {@link LOOKBACK}). A
 * sequence that began more than {@link LOOKBACK} characters before the cut is
 * not detected; nothing real is that long.
 * @param text - full buffer.
 * @param limit - maximum characters to keep.
 * @returns the trimmed buffer (the same string when it already fits).
 */
export function trimReplay(text, limit) {
  if (text.length <= limit) return text
  let start = text.length - limit
  const from = Math.max(0, start - LOOKBACK)
  // Search only the bounded window: this runs on every PTY chunk once the buffer is full.
  const local = text.slice(from, start).lastIndexOf('\x1b')
  const esc = local === -1 ? -1 : from + local
  if (esc !== -1) {
    const end = sequenceEnd(text, esc)
    if (end === -1) start = esc
    else if (end > start) start = end
  }
  // Never begin on the low half of a surrogate pair.
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start++
  return text.slice(start)
}
