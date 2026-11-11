// dsh-web-terminal — Overseer: the model's answer as a small, safe document tree.
//
// The answer is untrusted text (the model read terminal output, which anyone can write to). It is
// never put into the page as HTML: this parser turns light Markdown into plain nodes (paragraphs,
// bullets, code blocks, bold, inline code) and `[T3]` citations into terminal references, and the
// panel renders those nodes as React elements, so every character ends up as a text node.

/** One inline piece of a line. */
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'code'; text: string }
  | { type: 'cite'; num: number }

/** One block of the answer. */
export type Block =
  | { type: 'para'; inlines: Inline[] }
  | { type: 'heading'; inlines: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'code'; text: string }

/** `[T3]`, `[T3, T5]` and `[T3][T5]` citations. */
const CITE = /\[T(\d{1,3})(?:\s*,\s*T(\d{1,3}))*\]/g

/** Split text into plain text and citations. */
function cites(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(CITE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) })
    for (const n of m[0].matchAll(/T(\d{1,3})/g)) out.push({ type: 'cite', num: Number(n[1]) })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

/** Inline Markdown: `code`, **bold** (and __bold__), citations everywhere except inside code. */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = []
  const re = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g
  let last = 0
  for (const m of line.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push(...cites(line.slice(last, at)))
    if (m[1] !== undefined) out.push({ type: 'code', text: m[1] })
    else out.push({ type: 'bold', text: m[2] ?? m[3] ?? '' })
    last = at + m[0].length
  }
  if (last < line.length) out.push(...cites(line.slice(last)))
  // A bold run may itself hold a citation: split it out so it stays clickable.
  return out.flatMap((part) => {
    if (part.type !== 'bold' || !/\[T\d/.test(part.text)) return [part]
    return cites(part.text).map((p): Inline => (p.type === 'text' ? { type: 'bold', text: p.text } : p))
  })
}

/**
 * Parse an answer (possibly still streaming: an unclosed code fence runs to the end).
 * @param text - the model's answer.
 */
export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  let list: { ordered: boolean; items: Inline[][] } | null = null
  const flushPara = () => {
    if (para.length > 0) blocks.push({ type: 'para', inlines: parseInline(para.join(' ')) })
    para = []
  }
  const flushList = () => {
    if (list !== null) blocks.push({ type: 'list', ordered: list.ordered, items: list.items })
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flushPara()
      flushList()
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }
    const bullet = /^\s*(?:[-*•]|(\d{1,3})[.)])\s+(.*)$/.exec(line)
    if (bullet !== null) {
      flushPara()
      const ordered = bullet[1] !== undefined
      if (list !== null && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push(parseInline(bullet[2]))
      continue
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushPara()
      flushList()
      blocks.push({ type: 'heading', inlines: parseInline(heading[1]) })
      continue
    }
    if (line.trim().length === 0) {
      flushPara()
      flushList()
      continue
    }
    flushList()
    para.push(line.trim())
  }
  flushPara()
  flushList()
  return blocks
}
