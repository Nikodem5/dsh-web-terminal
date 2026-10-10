// dsh-web-terminal — command blocks: the shell tells the terminal where each prompt, command and
// output starts and how the command ended (OSC 133 / 633, see lib/shell/*), and this module turns
// that into one block per command, anchored to xterm markers so it survives scrolling and reflow.
//
//   133;A prompt start   133;B prompt end (input starts)   133;C output starts   133;D;<exit> finished
//   633;E;<command>      the command line (escaped)        633;P;Cwd=<path>      real current folder
//   7;file://host/path   the folder, the other common way
//
// Phase 1 renders a coloured gutter bar per block; the model is what later features (hover actions,
// navigation, sticky header, failed-command alerts) read.

import type { IDecoration, IMarker, Terminal } from '@xterm/xterm'
import { emit, persistSoon, prefs, runtimes } from './state.ts'
import type { Runtime } from './types.ts'

/** Blocks kept per terminal; older ones are dropped (their text is still in the scrollback). */
export const MAX_BLOCKS = 500

// ── parsing ──

export type SemanticEvent =
  | { kind: 'prompt-start' }
  | { kind: 'prompt-end' }
  | { kind: 'output-start' }
  | { kind: 'finished'; exitCode: number | undefined }
  | { kind: 'command'; command: string }
  | { kind: 'cwd'; cwd: string }

/** Undo the shell's escaping (`\\` and `\xNN`; a `;` or control character never appears raw in a value). */
export function unescapeValue(value: string): string {
  return value.replace(/\\(\\|x[0-9a-fA-F]{2})/g, (_, g: string) => (g === '\\' ? '\\' : String.fromCharCode(parseInt(g.slice(1), 16))))
}

/** The escaping the shell scripts apply (kept here so the round trip is testable). */
export function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\x3b').replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** A `file://host/path` URI (OSC 7) as a local path: `C:/x` on Windows, `/x` elsewhere. */
export function cwdFromUri(uri: string): string | undefined {
  const m = /^file:\/\/[^/]*(\/.*)$/i.exec(uri)
  if (m === null) return undefined
  let path: string
  try {
    path = decodeURIComponent(m[1]!)
  } catch {
    return undefined
  }
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path
}

/**
 * Meaning of one OSC payload, or undefined when it is not ours or malformed. 633 repeats 133's A-D and adds E and P.
 * @param ident - the OSC number (7, 133 or 633).
 * @param data - the payload after the number.
 */
export function parseSemantic(ident: number, data: string): SemanticEvent | undefined {
  if (ident === 7) {
    const cwd = cwdFromUri(data)
    return cwd === undefined ? undefined : { kind: 'cwd', cwd }
  }
  if (ident !== 133 && ident !== 633) return undefined
  const [code = '', ...rest] = data.split(';')
  switch (code) {
    case 'A':
      return { kind: 'prompt-start' }
    case 'B':
      return { kind: 'prompt-end' }
    case 'C':
      return { kind: 'output-start' }
    case 'D': {
      const n = rest[0] !== undefined && /^-?\d+$/.test(rest[0]) ? Number(rest[0]) : undefined
      return { kind: 'finished', exitCode: n }
    }
    case 'E':
      return ident === 633 ? { kind: 'command', command: unescapeValue(rest[0] ?? '') } : undefined
    case 'P': {
      if (ident !== 633) return undefined
      const eq = (rest[0] ?? '').indexOf('=')
      if (eq < 0) return undefined
      const key = rest[0]!.slice(0, eq)
      const value = unescapeValue([rest[0]!.slice(eq + 1), ...rest.slice(1)].join(';'))
      return key === 'Cwd' && value.length > 0 ? { kind: 'cwd', cwd: value } : undefined
    }
    default:
      return undefined
  }
}

// ── the model ──

export type BlockState = 'prompt' | 'running' | 'done'

export interface Block {
  id: number
  /** First line of the block (the prompt). */
  prompt: IMarker | undefined
  /** Where the input starts (end of the prompt text) and its column. */
  input: IMarker | undefined
  inputX: number
  /** First line of the command's output. */
  outputStart: IMarker | undefined
  /** Last line of the block, set when the command finished. */
  end: IMarker | undefined
  command: string
  /** The command came from the shell (633;E); otherwise it was read from the screen at output start. */
  commandFromShell: boolean
  /** Undefined while running, or when the shell did not report one. */
  exitCode: number | undefined
  /** Epoch ms of the output start (the command started running). */
  startedAt: number
  endedAt: number | undefined
  /** Folder the command ran in, when the shell reports it. */
  cwd: string
  state: BlockState
  decoration: IDecoration | undefined
}

export interface BlockModel {
  /** Live blocks, oldest first (scrolled-out ones are dropped). */
  list(): readonly Block[]
  /** The shell has reported at least one prompt: integration is active. */
  readonly integrated: boolean
  /** Prompts whose input start (133;B) was seen; the startup command is typed once this grows after attach. */
  readonly promptsReady: number
  /** Called when a prompt becomes ready for input. */
  onPromptReady: (() => void) | undefined
  /** Called when a block is created, starts running or finishes. */
  subscribe(listener: (block: Block) => void): () => void
  /** The terminal has a DOM now: draw what could not be drawn before. */
  opened(): void
  /** The screen was reset (reattach, resync): xterm keeps the old markers alive, so drop every block. */
  reset(): void
  dispose(): void
}

/** Wall-clock run time of a block in ms (so far, while it runs). */
export function blockDuration(block: Block, now = Date.now()): number | undefined {
  if (block.state === 'prompt') return undefined
  return Math.max(0, (block.endedAt ?? now) - block.startedAt)
}

/** `1.2s`, `3m 04s`: how long a command took. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Register the OSC handlers for one terminal and keep its block model. Works before the terminal is opened. */
export function createBlocks(rt: Runtime): BlockModel {
  const term: Terminal = rt.term
  const blocks: Block[] = []
  const listeners = new Set<(block: Block) => void>()
  let current: Block | undefined
  let nextId = 1
  let integrated = false
  let promptsReady = 0
  let flushQueued = false

  const notify = (block: Block): void => {
    for (const listener of listeners) listener(block)
  }
  /** Marker at the cursor row (plus offset); none in the alternate screen, whose rows are not scrollback. */
  const mark = (offset = 0): IMarker | undefined => (term.buffer.active.type === 'alternate' ? undefined : term.registerMarker(offset))
  const alive = (b: Block): boolean => b.prompt !== undefined && !b.prompt.isDisposed

  const prune = (): void => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!
      if (!alive(b)) {
        b.decoration?.dispose()
        blocks.splice(i, 1)
      }
    }
    while (blocks.length > MAX_BLOCKS) disposeBlock(blocks.shift()!)
    if (current !== undefined && !alive(current)) current = undefined
  }
  const disposeBlock = (b: Block): void => {
    b.decoration?.dispose()
    b.decoration = undefined
    b.prompt?.dispose()
    b.input?.dispose()
    b.outputStart?.dispose()
    b.end?.dispose()
  }

  // ── drawing: a gutter bar in the terminal's left padding ──

  const drawn = new WeakMap<Block, { height: number; look: string }>()
  /** Gutter colour: running (pulsing accent), ok, failed, or finished without a known exit code. */
  const lookOf = (b: Block): string => (b.state !== 'done' ? 'run' : b.exitCode === undefined ? 'unk' : b.exitCode === 0 ? 'ok' : 'fail')
  const lastRow = (b: Block): number => {
    if (b.end !== undefined && !b.end.isDisposed) return b.end.line
    const buf = term.buffer.active
    return buf.baseY + buf.cursorY
  }
  /** (Re)draw one block's gutter; it spans prompt to last output line and changes colour with its state. */
  const decorate = (b: Block): void => {
    if (!rt.opened || b.state === 'prompt' || !alive(b)) return
    const height = Math.max(1, lastRow(b) - b.prompt!.line + 1)
    const look = lookOf(b)
    const was = drawn.get(b)
    if (b.decoration !== undefined && !b.decoration.isDisposed && was?.height === height && was.look === look) return
    b.decoration?.dispose()
    drawn.set(b, { height, look })
    const deco = term.registerDecoration({ marker: b.prompt!, x: 0, width: 1, height, layer: 'bottom' })
    b.decoration = deco
    deco?.onRender((el) => {
      el.classList.add('wt-gutter')
      el.dataset.state = lookOf(b)
    })
  }
  const decorateAll = (): void => {
    for (const b of blocks) decorate(b)
  }
  /** The running block grows with its output: re-measure at most once per frame. */
  const scheduleFlush = (): void => {
    if (flushQueued || current === undefined || current.state !== 'running') return
    flushQueued = true
    const run = (): void => {
      flushQueued = false
      if (current !== undefined && current.state === 'running') decorate(current)
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else setTimeout(run, 16)
  }

  // ── events ──

  /** Text typed after the prompt, read from the screen: the fallback when the shell does not send the command. */
  const commandFromScreen = (b: Block): string => {
    if (b.input === undefined || b.input.isDisposed) return ''
    const buf = term.buffer.active
    const cursor = buf.baseY + buf.cursorY
    const last = buf.cursorX === 0 ? cursor - 1 : cursor
    let text = ''
    for (let y = b.input.line; y <= last; y++) {
      const line = buf.getLine(y)
      if (line === undefined) break
      const chunk = line.translateToString(true, y === b.input.line ? b.inputX : 0)
      text += y > b.input.line && !line.isWrapped ? `\n${chunk}` : chunk
    }
    return text.trim()
  }

  const startBlock = (): Block => {
    prune()
    const b: Block = {
      id: nextId++, prompt: mark(), input: undefined, inputX: 0, outputStart: undefined, end: undefined, command: '', commandFromShell: false,
      exitCode: undefined, startedAt: Date.now(), endedAt: undefined, cwd: rt.cwd ?? '', state: 'prompt', decoration: undefined,
    }
    blocks.push(b)
    current = b
    return b
  }

  const finish = (b: Block, exitCode: number | undefined): void => {
    const buf = term.buffer.active
    // Output that ended with a newline leaves the cursor on the next, empty row: the block ends one row up.
    b.end = mark(buf.cursorX === 0 && b.prompt !== undefined && buf.baseY + buf.cursorY > b.prompt.line ? -1 : 0)
    b.exitCode = exitCode
    b.endedAt = Date.now()
    b.state = 'done'
    decorate(b)
    notify(b)
  }

  const handle = (event: SemanticEvent): void => {
    switch (event.kind) {
      case 'prompt-start': {
        integrated = true
        if (current !== undefined && alive(current)) {
          // A new prompt while the old block never reported its end: close it (exit unknown); a prompt that never ran anything just goes away.
          if (current.state === 'running') finish(current, undefined)
          else if (current.state === 'prompt') {
            const at = blocks.indexOf(current)
            if (at >= 0) blocks.splice(at, 1)
            disposeBlock(current)
          }
        }
        notify(startBlock())
        break
      }
      case 'prompt-end': {
        const b = current !== undefined && alive(current) && current.state === 'prompt' ? current : undefined
        if (b !== undefined) {
          b.input?.dispose()
          b.input = mark()
          b.inputX = term.buffer.active.cursorX
        }
        promptsReady++
        model.onPromptReady?.()
        break
      }
      case 'output-start': {
        const b = current !== undefined && alive(current) && current.state === 'prompt' ? current : startBlock()
        b.outputStart = mark()
        b.startedAt = Date.now()
        b.state = 'running'
        if (!b.commandFromShell) b.command = commandFromScreen(b)
        decorate(b)
        notify(b)
        break
      }
      case 'command': {
        if (current === undefined || !alive(current)) break
        current.command = event.command
        current.commandFromShell = true
        break
      }
      case 'finished': {
        if (current === undefined || !alive(current) || current.state !== 'running') break
        finish(current, event.exitCode)
        break
      }
      case 'cwd': {
        rt.cwd = event.cwd
        if (current !== undefined && current.state === 'prompt') current.cwd = event.cwd
        break
      }
    }
  }

  // Every handler returns true: the sequence is consumed and never reaches the screen or another handler.
  const oscHandler = (ident: number) => (data: string): boolean => {
    const event = parseSemantic(ident, data)
    if (event !== undefined) handle(event)
    return true
  }
  const disposables = [
    term.parser.registerOscHandler(133, oscHandler(133)),
    term.parser.registerOscHandler(633, oscHandler(633)),
    term.parser.registerOscHandler(7, oscHandler(7)),
    term.onWriteParsed(scheduleFlush),
  ]

  const model: BlockModel = {
    list() {
      prune()
      return blocks
    },
    get integrated() {
      return integrated
    },
    get promptsReady() {
      return promptsReady
    },
    onPromptReady: undefined,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    opened() {
      prune()
      decorateAll()
    },
    reset() {
      for (const b of blocks) disposeBlock(b)
      blocks.length = 0
      current = undefined
    },
    dispose() {
      for (const d of disposables) d.dispose()
      for (const b of blocks) disposeBlock(b)
      blocks.length = 0
      listeners.clear()
    },
  }
  return model
}

/** Whether the shell of terminal `id` has sent any integration marker (OSC 133 prompt); undefined for an unknown terminal. */
export function integrationSeen(id: string): boolean | undefined {
  const rt = runtimes.get(id)
  return rt === undefined ? undefined : rt.blocks?.integrated === true
}

// ── preference ──

/** Applies to shells started after the change: the integration is injected when the shell spawns. */
export function setShellIntegration(on: boolean): void {
  prefs.shellIntegration = on
  emit()
  persistSoon()
}
