// dsh-web-terminal — command blocks, phase 2: what the header buttons and the navigation keys do to a
// terminal (copy, rerun, select, send, jump). The decisions are in block-text.ts; this file reads the
// xterm buffer and the model and performs them.

import type { Block } from './blocks.ts'
import { extractOutput, failedTarget, outputRows, rerunGate, stepTarget } from './block-text.ts'
import type { OutputText, Span } from './block-text.ts'
import { matchShortcut } from './shortcuts.ts'
import { openSendText } from './send-to.ts'
import type { Runtime } from './types.ts'

/** Spans of the blocks that ran (or run) a command, oldest first, and the block behind each. */
export function blockSpans(rt: Runtime): { spans: Span[]; byId: Map<number, Block> } {
  const spans: Span[] = []
  const byId = new Map<number, Block>()
  const buf = rt.term.buffer.active
  const cursor = buf.baseY + buf.cursorY
  for (const b of rt.blocks?.list() ?? []) {
    if (b.state === 'prompt' || b.prompt === undefined || b.prompt.isDisposed) continue
    const end = b.end !== undefined && !b.end.isDisposed ? b.end.line : b.state === 'running' ? cursor : Math.max(b.prompt.line, b.outputStart?.isDisposed === false ? b.outputStart.line : 0)
    spans.push({ id: b.id, prompt: b.prompt.line, last: Math.max(b.prompt.line, end), failed: b.state === 'done' && b.exitCode !== undefined && b.exitCode !== 0 })
    byId.set(b.id, b)
  }
  return { spans, byId }
}

/** The block's output as text, or why it cannot be had. */
export function blockOutput(rt: Runtime, block: Block): { ok: OutputText } | { disabled: string } {
  const buf = rt.term.buffer.active
  const rows = outputRows(block, buf.baseY + buf.cursorY, buf.cursorX)
  if ('disabled' in rows) return rows
  const out = extractOutput(
    (y) => {
      const line = buf.getLine(y)
      return line === undefined ? undefined : { wrapped: line.isWrapped, text: (trim) => line.translateToString(trim) }
    },
    rows.first,
    rows.last,
  )
  return out === undefined ? { disabled: 'This command printed no output' } : { ok: out }
}

/** Why Rerun is unavailable, or undefined when it may run. */
export function rerunBlocked(rt: Runtime, block: Block): string | undefined {
  const all = rt.blocks?.list() ?? []
  const gate = rerunGate({
    block,
    newest: all.at(-1),
    live: rt.conn === 'live' && rt.socket?.readyState === WebSocket.OPEN,
    hostBusy: rt.hostBusy,
    alternate: rt.term.buffer.active.type === 'alternate',
  })
  return gate.ok ? undefined : gate.reason
}

const copy = (text: string): Promise<boolean> =>
  navigator.clipboard === undefined ? Promise.resolve(false) : navigator.clipboard.writeText(text).then(() => true, () => false)

export function copyBlockOutput(rt: Runtime, block: Block): Promise<boolean> {
  const out = blockOutput(rt, block)
  return 'ok' in out ? copy(out.ok.text) : Promise.resolve(false)
}

export const copyBlockCommand = (block: Block): Promise<boolean> => (block.command.length > 0 ? copy(block.command) : Promise.resolve(false))

/** Type the command again and press Enter, only when the shell is at a prompt. */
export function rerunBlock(rt: Runtime, block: Block): boolean {
  if (rerunBlocked(rt, block) !== undefined || rt.socket === null) return false
  rt.lastInputAt = Date.now()
  rt.socket.send(JSON.stringify({ type: 'input', data: `${block.command}\r` }))
  rt.term.scrollToBottom()
  return true
}

/** Select the output rows so the ordinary copy and send-selection keys work on them. */
export function selectBlockOutput(rt: Runtime, block: Block): boolean {
  const out = blockOutput(rt, block)
  if (!('ok' in out)) return false
  const { first, last, lastLen } = out.ok
  rt.term.select(0, first, (last - first) * rt.term.cols + lastLen)
  return true
}

/** Open the "Send to…" picker with the output. */
export function sendBlockOutput(rt: Runtime, block: Block, at?: { x: number; y: number }): boolean {
  const out = blockOutput(rt, block)
  return 'ok' in out && openSendText(rt, out.ok.text, at)
}

// ── jumping ──

/** Flash a block's prompt row so the eye finds it after a jump. */
function flash(rt: Runtime, block: Block | undefined): void {
  if (!rt.opened || block?.prompt === undefined || block.prompt.isDisposed) return
  const deco = rt.term.registerDecoration({ marker: block.prompt, x: 0, width: rt.term.cols, height: 1, layer: 'top' })
  if (deco === undefined) return
  deco.onRender((el) => el.classList.add('wt-flash'))
  setTimeout(() => deco.dispose(), 1000)
}

/** Scroll so the block's prompt is the top row, and flash it. */
export function jumpToBlock(rt: Runtime, block: Block): void {
  if (block.prompt === undefined || block.prompt.isDisposed) return
  rt.term.scrollToLine(block.prompt.line)
  flash(rt, block)
}

/** Where the last "failed command" jump left the view, so a repeat press moves on to the next older failure. */
const failedJump = new WeakMap<Runtime, { prompt: number; top: number }>()

/**
 * Act on a block-navigation key. False = not ours or nothing to do (the key goes to the program): the
 * terminal shows a full-screen program, or has no finished/running block, or (failed jump) no failed one.
 */
export function handleBlockKey(rt: Runtime, event: KeyboardEvent): boolean {
  const step = matchShortcut('block-nav', event)
  const failed = matchShortcut('block-failed', event)
  if (!step && !failed) return false
  const buf = rt.term.buffer.active
  if (buf.type !== 'normal') return false
  const { spans, byId } = blockSpans(rt)
  if (spans.length === 0) return false
  const top = buf.viewportY
  let line: number | undefined
  if (failed) {
    line = failedTarget(spans, top, failedJump.get(rt))
    if (line === undefined) return false
  } else {
    const dir = event.key === 'ArrowUp' ? -1 : 1
    line = stepTarget(spans, top, dir)
    if (line === undefined && dir > 0) rt.term.scrollToBottom()
  }
  event.preventDefault()
  if (line === undefined) return true
  const target = spans.find((s) => s.prompt === line)
  const block = target === undefined ? undefined : byId.get(target.id)
  if (block !== undefined) jumpToBlock(rt, block)
  if (failed) failedJump.set(rt, { prompt: line, top: rt.term.buffer.active.viewportY })
  return true
}
