// Replay buffer trimming.
//
// The scrollback kept for reattach is cut to a fixed size from the front. A
// blind slice can land inside an escape sequence (CSI, OSC, DCS...), and
// replaying a tail like `31m` or the end of a hyperlink paints garbage and can
// leave the terminal in a wrong mode. This moves the cut to a safe point.

/** An unterminated string sequence (a stream still being written) is kept whole only while it stays this far past the limit. */
const MAX_OPEN = 65_536

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
    // The payload can be hundreds of KB (inline image, sixel): search with indexOf, not per character.
    let end = Infinity
    const st = text.indexOf('\x1b\\', at + 2)
    if (st !== -1) end = st + 2
    const c1 = text.indexOf('\x9c', at + 2)
    if (c1 !== -1 && c1 + 1 < end) end = c1 + 1
    if (kind === ']') {
      const bel = text.indexOf('\x07', at + 2)
      if (bel !== -1 && bel + 1 < end) end = bel + 1
    }
    return end === Infinity ? -1 : end
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
 * text is kept whole instead (result longer by at most {@link MAX_OPEN}; a
 * longer one is cut like plain text). A string sequence (OSC, DCS, APC) of any
 * length that the cut lands in is skipped to its terminator.
 *
 * Cost: one backward search for the previous ESC and one forward search for a
 * terminator, so run it when the buffer overflows its slack, not per chunk.
 * @param text - full buffer.
 * @param limit - maximum characters to keep.
 * @returns the trimmed buffer (the same string when it already fits).
 */
export function trimReplay(text, limit) {
  if (text.length <= limit) return text
  let start = text.length - limit
  // The nearest ESC before the cut. A string payload holds none, so inside a long image it is the introducer, far back.
  const esc = text.lastIndexOf('\x1b', start - 1)
  if (esc !== -1) {
    const end = sequenceEnd(text, esc)
    if (end === -1) {
      if (text.length - esc <= limit + MAX_OPEN) start = esc
    } else if (end > start) start = end
  }
  // Never begin on the low half of a surrogate pair.
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start++
  return text.slice(start)
}
