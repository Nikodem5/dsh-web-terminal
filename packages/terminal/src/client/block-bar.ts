// dsh-web-terminal — command blocks, phase 2: the floating header shown while the pointer is on a
// command (its text, exit, duration and the actions) and the slim sticky bar that names the command
// whose output fills the top of the window. Plain DOM inside the terminal's holder, not React: the
// holder is created before any page exists and is moved between windows, so it carries its own overlay.
//
// xterm cannot hide buffer rows, so there is no folding; this only reads the blocks and the viewport.

import { blockDuration, formatDuration } from './blocks.ts'
import type { Block } from './blocks.ts'
import { blockAt, stickyFor } from './block-text.ts'
import { blockOutput, blockSpans, copyBlockCommand, copyBlockOutput, jumpToBlock, rerunBlock, rerunBlocked, selectBlockOutput, sendBlockOutput } from './block-actions.ts'
import { timeLabel } from './unread.ts'
import type { Runtime } from './types.ts'

/** Same colour rule as the gutter bar (blocks.ts), so the header and the bar always agree. */
export function blockLook(b: Block): 'run' | 'ok' | 'fail' | 'unk' {
  return b.state !== 'done' ? 'run' : b.exitCode === undefined ? 'unk' : b.exitCode === 0 ? 'ok' : 'fail'
}

/** `✓`, `✗ 1`, `running`, or `—` when the shell reported no exit code. */
export function exitText(b: Block): string {
  const look = blockLook(b)
  return look === 'run' ? '● running' : look === 'ok' ? '✓' : look === 'fail' ? `✗ ${b.exitCode}` : '—'
}

/** First line of the command, for a one-line label. */
const firstLine = (command: string): string => command.split('\n', 1)[0]!.trim()

const ACTIONS = [
  { id: 'copy-output', glyph: '⧉', title: 'Copy output' },
  { id: 'copy-command', glyph: '⌘', title: 'Copy command' },
  { id: 'rerun', glyph: '↻', title: 'Run this command again' },
  { id: 'send', glyph: '➤', title: 'Send output to another terminal…' },
  { id: 'select', glyph: '▭', title: 'Select output' },
] as const
type ActionId = (typeof ACTIONS)[number]['id']

export interface BlockBar {
  /** Re-read the model and the viewport now (normally scheduled by the events below). */
  refresh(): void
  dispose(): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  return e
}

/** Add the hover header, the sticky bar and the gutter hot zone to an opened terminal. */
export function installBlockBar(rt: Runtime): BlockBar {
  const { term, holder } = rt
  const cleanup: (() => void)[] = []

  // The gutter bar lives in the padding left of the holder; this transparent strip makes it hoverable.
  const zone = el('div', 'wt-bzone')
  const header = el('div', 'wt-bh')
  header.hidden = true
  const cmdEl = el('span', 'wt-bh-cmd')
  const exitEl = el('span', 'wt-bh-exit')
  const durEl = el('span', 'wt-bh-dur')
  const timeEl = el('span', 'wt-bh-time')
  const buttons = new Map<ActionId, HTMLButtonElement>()
  header.append(cmdEl, exitEl, durEl, timeEl)
  for (const a of ACTIONS) {
    const b = el('button', 'wt-bh-btn')
    b.type = 'button'
    b.dataset.action = a.id
    b.textContent = a.glyph
    buttons.set(a.id, b)
    header.append(b)
  }
  const sticky = el('div', 'wt-bsticky')
  sticky.hidden = true
  sticky.setAttribute('role', 'button')
  holder.append(zone, header, sticky)

  let hoverLine: number | undefined
  let lastY: number | undefined
  let inside = false
  let overHeader = false
  let headerId: number | undefined
  let stickyId: number | undefined
  let drawnHeader = ''
  let drawnSticky = ''
  let tickTimer: ReturnType<typeof setInterval> | undefined
  let queued = false
  let disposed = false

  const screen = (): HTMLElement | null => term.element?.querySelector<HTMLElement>('.xterm-screen') ?? null

  /** Buffer row under a viewport y coordinate, or undefined outside the text area. */
  const lineAt = (y: number): number | undefined => {
    const s = screen()
    if (s === null) return undefined
    const rect = s.getBoundingClientRect()
    if (!(rect.height > 0)) return undefined
    const row = Math.floor((y - rect.top) / (rect.height / term.rows))
    return row < 0 || row >= term.rows ? undefined : term.buffer.active.viewportY + row
  }

  const byId = (id: number | undefined): Block | undefined => (id === undefined ? undefined : rt.blocks?.list().find((b) => b.id === id))

  const setButton = (id: ActionId, reason: string | undefined): void => {
    const b = buttons.get(id)!
    const a = ACTIONS.find((x) => x.id === id)!
    b.disabled = reason !== undefined
    b.title = reason === undefined ? a.title : `${a.title} (unavailable: ${reason})`
    b.setAttribute('aria-label', b.title)
  }

  const drawHeader = (b: Block, top: number): void => {
    const output = blockOutput(rt, b)
    const outputReason = 'ok' in output ? undefined : output.disabled
    const rerunReason = rerunBlocked(rt, b)
    const dur = blockDuration(b)
    const key = `${b.id}|${b.state}|${b.exitCode}|${b.command}|${dur === undefined ? '' : formatDuration(dur)}|${outputReason}|${rerunReason}`
    header.style.top = `${top}px`
    header.dataset.state = blockLook(b)
    if (key === drawnHeader) return
    drawnHeader = key
    cmdEl.textContent = firstLine(b.command) || '(command text unknown)'
    cmdEl.title = b.command + (b.cwd.length > 0 ? `\n${b.cwd}` : '')
    exitEl.textContent = exitText(b)
    exitEl.title = blockLook(b) === 'unk' ? 'The shell did not report an exit code' : b.exitCode === undefined ? 'Still running' : `Exit code ${b.exitCode}`
    durEl.textContent = dur === undefined ? '' : formatDuration(dur)
    timeEl.textContent = timeLabel(b.startedAt)
    timeEl.title = `Started ${new Date(b.startedAt).toLocaleString()}`
    setButton('copy-output', outputReason)
    setButton('select', outputReason)
    setButton('send', outputReason)
    setButton('copy-command', b.command.length === 0 ? 'no command text' : undefined)
    setButton('rerun', rerunReason)
  }

  const drawSticky = (b: Block | undefined): void => {
    stickyId = b?.id
    if (b === undefined) {
      sticky.hidden = true
      drawnSticky = ''
      return
    }
    const dur = blockDuration(b)
    const text = `▸ ${firstLine(b.command) || '(command)'}`
    const key = `${b.id}|${b.state}|${b.exitCode}|${text}|${dur === undefined ? '' : formatDuration(dur)}`
    sticky.hidden = false
    sticky.dataset.state = blockLook(b)
    if (key === drawnSticky) return
    drawnSticky = key
    sticky.replaceChildren()
    const t = el('span', 'wt-bsticky-cmd')
    t.textContent = text
    const x = el('span', 'wt-bsticky-exit')
    x.textContent = exitText(b)
    const d = el('span', 'wt-bsticky-dur')
    d.textContent = dur === undefined ? '' : formatDuration(dur)
    sticky.append(t, x, d)
    sticky.title = `${b.command}\nClick to jump to its prompt`
  }

  /** The header sits at the right edge; when the prompt text on its row reaches it, use the row below if that one is clear. */
  const avoidPrompt = (row: number, hasBelow: boolean): void => {
    const s = screen()
    if (s === null || term.cols === 0 || s.offsetWidth === 0) return
    const buf = term.buffer.active
    const cellW = s.offsetWidth / term.cols
    const room = holder.clientWidth - header.offsetWidth - 20
    const used = (r: number): number => (buf.getLine(buf.viewportY + r)?.translateToString(true).length ?? 0) * cellW
    if (used(row) > room && hasBelow && row + 1 < term.rows && used(row + 1) <= room) header.style.top = `${s.offsetTop + (row + 1) * (s.offsetHeight / term.rows)}px`
  }

  const refresh = (): void => {
    queued = false
    if (disposed) return
    const buf = term.buffer.active
    // A full-screen program owns the screen (and the mouse); its rows are not blocks.
    const usable = buf.type === 'normal' && term.modes.mouseTrackingMode === 'none' && rt.blocks !== undefined
    const { spans } = usable ? blockSpans(rt) : { spans: [] }
    if (inside && !overHeader && lastY !== undefined) hoverLine = lineAt(lastY)
    const st = usable ? stickyFor(spans, buf.viewportY) : undefined
    drawSticky(byId(st?.id))
    const hover = !usable || !inside ? undefined : overHeader && headerId !== undefined ? spans.find((s) => s.id === headerId) : hoverLine === undefined ? undefined : blockAt(spans, hoverLine)
    const hb = byId(hover?.id)
    if (hover === undefined || hb === undefined) {
      header.hidden = true
      headerId = undefined
      drawnHeader = ''
    } else {
      // Pinned to the block's first row; a block that starts above the window keeps the header at the top edge (below the sticky bar).
      const row = Math.max(hover.prompt - buf.viewportY, sticky.hidden ? 0 : 1)
      const s = screen()
      const cell = s === null || term.rows === 0 ? 0 : s.offsetHeight / term.rows
      if (row >= term.rows) {
        header.hidden = true
        headerId = undefined
      } else {
        headerId = hb.id
        header.hidden = false
        drawHeader(hb, (s?.offsetTop ?? 0) + row * cell)
        avoidPrompt(row, hover.last - hover.prompt > 0)
      }
    }
    // Live durations tick while a running block is shown.
    const ticking = (!header.hidden && byId(headerId)?.state === 'running') || (!sticky.hidden && byId(stickyId)?.state === 'running')
    if (ticking && tickTimer === undefined) tickTimer = setInterval(refresh, 1000)
    else if (!ticking && tickTimer !== undefined) {
      clearInterval(tickTimer)
      tickTimer = undefined
    }
  }

  const queue = (): void => {
    if (queued || disposed) return
    queued = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refresh)
    else setTimeout(refresh, 16)
  }

  // ── events ──

  const listen = <E extends Event>(target: EventTarget, type: string, fn: (e: E) => void): void => {
    target.addEventListener(type, fn as EventListener)
    cleanup.push(() => target.removeEventListener(type, fn as EventListener))
  }
  listen<MouseEvent>(holder, 'mousemove', (e) => {
    inside = true
    overHeader = header.contains(e.target as Node)
    if (overHeader || e.buttons !== 0) return // on the header, or dragging a selection
    lastY = e.clientY
    const line = lineAt(e.clientY)
    if (line !== hoverLine) {
      hoverLine = line
      refresh()
    }
  })
  listen<MouseEvent>(holder, 'mouseleave', () => {
    inside = false
    overHeader = false
    hoverLine = undefined
    refresh()
  })
  listen<MouseEvent>(header, 'pointerdown', (e) => {
    // A press on a button must not move focus or clear the selection that "Select output" just made.
    e.preventDefault()
    e.stopPropagation()
  })
  listen<MouseEvent>(header, 'click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')
    const block = byId(headerId)
    if (target === null || target.disabled || block === undefined) return
    void run(target, target.dataset.action as ActionId, block, e)
  })
  listen<MouseEvent>(sticky, 'click', () => {
    const block = byId(stickyId)
    if (block !== undefined) jumpToBlock(rt, block)
    term.focus()
  })

  /** Show a ✓ / ✗ on the button for a moment instead of a toast. */
  const flashButton = (button: HTMLButtonElement, ok: boolean): void => {
    const glyph = ACTIONS.find((a) => a.id === button.dataset.action)!.glyph
    button.textContent = ok ? '✓' : '✗'
    setTimeout(() => {
      button.textContent = glyph
    }, 900)
  }
  const run = async (button: HTMLButtonElement, action: ActionId, block: Block, e: MouseEvent): Promise<void> => {
    let ok = false
    switch (action) {
      case 'copy-output':
        ok = await copyBlockOutput(rt, block)
        break
      case 'copy-command':
        ok = await copyBlockCommand(block)
        break
      case 'rerun':
        ok = rerunBlock(rt, block)
        break
      case 'select':
        ok = selectBlockOutput(rt, block)
        break
      case 'send':
        // The picker takes the keyboard itself.
        sendBlockOutput(rt, block, { x: e.clientX, y: e.clientY })
        return
    }
    flashButton(button, ok)
    term.focus()
  }

  for (const d of [term.onScroll(queue), term.onResize(queue), term.buffer.onBufferChange(queue)]) cleanup.push(() => d.dispose())
  // Output only moves what is shown while something is shown (a running block grows; the model events cover the rest).
  const written = term.onWriteParsed(() => {
    if (!header.hidden || !sticky.hidden) queue()
  })
  cleanup.push(() => written.dispose())
  const unsubscribe = rt.blocks?.subscribe(queue)

  const bar: BlockBar = {
    refresh,
    dispose() {
      disposed = true
      if (tickTimer !== undefined) clearInterval(tickTimer)
      unsubscribe?.()
      for (const fn of cleanup) fn()
      zone.remove()
      header.remove()
      sticky.remove()
    },
  }
  rt.blockBar = bar
  return bar
}
