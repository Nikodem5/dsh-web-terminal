// dsh-web-terminal — the Antigravity CLI (`agy`) provider (host half).
//
// agy has no per-process config, so it is read from its own terminal output instead of hooks
// (docs/adr/0002): with AGY_CLI_OSC7501=on it prints `ESC ] 7501 ; state=<state>[:kind=..]:app=antigravity[:msg=<base64>] BEL`
// status sequences, and on a clean exit a plain-text hint with the conversation id. Only terminals the
// client says were started as `agy` are read (`Provider.observe`).
//
import { clean } from '../agent-signals.js'

/** Unterminated sequences longer than this are dropped, so a stray prefix never buffers without bound. */
const MAX_SEQUENCE = 64 * 1024
/** Text kept between chunks while looking for the exit hint (it can be split anywhere). */
const HINT_TAIL = 160
const OSC_START = '\x1b]7501;'
/** `agy --conversation=<id>` as printed after "Resume with -c (or command below):". */
const HINT = /--conversation=([A-Za-z0-9][A-Za-z0-9-]{7,63})(?=[\r\n])/
/** How agy's states map to neutral ones; anything else is ignored. */
const STATES = { working: 'working', blocked: 'needs-you', done: 'finished', failed: 'failed', idle: 'idle' }

/** `base64` text as UTF-8, or '' when it is not valid base64. */
function decode(text) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return ''
  try {
    return Buffer.from(text, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/** One sequence body (`state=...:app=...`) as a signal, or undefined. */
function signalOf(body) {
  const fields = new Map()
  for (const part of body.split(':')) {
    const at = part.indexOf('=')
    if (at > 0) fields.set(part.slice(0, at), part.slice(at + 1))
  }
  const state = STATES[fields.get('state')]
  if (state === undefined) return undefined
  const detail = clean(decode(fields.get('msg') ?? ''))
  const signal = { state, detail: state === 'needs-you' || state === 'finished' ? detail : '' }
  // agy shows kind=auth for a moment at every start; the host holds it back and drops it if another signal follows soon.
  if (state === 'needs-you' && fields.get('kind') === 'auth') signal.kind = 'auth'
  return signal
}

/**
 * A parser for one terminal's output. Stateful (a sequence or the hint may be split across chunks)
 * and never throws.
 * @returns `feed(text)`: the signals found in that chunk, in order (usually none).
 */
export function createAntigravityObserver() {
  let tail = ''
  return {
    feed(text) {
      try {
        const data = tail === '' ? text : tail + text
        tail = ''
        const signals = []
        let rest = data
        let at = rest.indexOf(OSC_START)
        while (at !== -1) {
          const bodyAt = at + OSC_START.length
          const bel = rest.indexOf('\x07', bodyAt)
          const st = rest.indexOf('\x1b\\', bodyAt)
          const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
          if (end === -1) {
            // Unterminated: keep it for the next chunk unless it is too long to be real.
            tail = rest.length - at > MAX_SEQUENCE ? '' : rest.slice(at)
            return signals
          }
          const signal = signalOf(rest.slice(bodyAt, end))
          if (signal !== undefined) signals.push(signal)
          rest = rest.slice(end + (end === st ? 2 : 1))
          at = rest.indexOf(OSC_START)
        }
        if (rest.includes('onversation') || rest.includes('Resume')) {
          const plain = rest.includes('\x1b[') ? rest.replace(/\x1b\[[0-9;]*m/g, '') : rest
          const hint = HINT.exec(plain)
          if (hint !== null) {
            signals.push({ state: 'ended', detail: '', session: hint[1] })
            return signals
          }
          tail = rest.slice(-HINT_TAIL)
        } else if (/\x1b(?:\](?:7(?:5(?:0(?:1)?)?)?)?)?$/.test(rest)) {
          // The start of a sequence cut in the middle of its prefix.
          tail = rest.slice(-OSC_START.length)
        } else if (/(?:R|Re|Res|Resu|Resum|Resume|--c|--co|--con|--conv)$/.test(rest)) {
          tail = rest.slice(-HINT_TAIL)
        }
        return signals
      } catch {
        tail = ''
        return []
      }
    },
  }
}

/** @type {import('./index.js').Provider} */
export const antigravity = {
  id: 'antigravity',
  label: 'Antigravity CLI',
  commands: ['agy'],
  // agy reports nothing without this variable; harmless in shells whose output is not read.
  prepare: () => ({ launch: {}, env: { AGY_CLI_OSC7501: 'on' } }),
  observe: createAntigravityObserver,
}
