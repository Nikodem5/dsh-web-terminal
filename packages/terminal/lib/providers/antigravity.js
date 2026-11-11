// dsh-web-terminal — the Antigravity CLI (`agy`) provider (host half).
//
// Without the opt-in integration (lib/agy-integration.js) agy is read from its own terminal output
// (docs/adr/0002): with AGY_CLI_OSC7501=on it prints `ESC ] 7501 ; state=<state>[:kind=..]:app=antigravity[:msg=<base64>] BEL`
// status sequences, and on a clean exit a plain-text hint with the conversation id. Only terminals the
// client says were started as `agy` are read (`Provider.observe`).
//
import { clean } from '../agent-signals.js'
import { createAgyIntegration } from '../agy-integration.js'
import { geminiDir, userAgyStatusLine } from '../agy-statusline.mjs'
import { agyHookSignal, agyStatusSignal } from './antigravity-signals.js'
import { createAntigravityUsage } from './antigravity-usage.js'

/** Unterminated sequences longer than this are dropped, so a stray prefix never buffers without bound. */
const MAX_SEQUENCE = 64 * 1024
/** Text kept between chunks while looking for the exit hint (it can be split anywhere). */
const HINT_TAIL = 160
const OSC_START = '\x1b]7501;'
/** `agy --conversation=<id>` as printed after "Resume with -c (or command below):". */
const HINT = /--conversation=([A-Za-z0-9][A-Za-z0-9-]{7,63})(?=[\r\n])/
/** The same hint as the very last thing the stream printed (no newline after it). */
const HINT_AT_END = /--conversation=([A-Za-z0-9][A-Za-z0-9-]{7,63})\s*$/
/** SGR colour sequences, which agy puts around the hint. */
const SGR = /\x1b\[[0-9;]*m/g
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

/** The exit hint in `text` as an `ended` signal, or undefined. `pattern` is HINT or HINT_AT_END. */
function hintIn(text, pattern) {
  const plain = text.includes('\x1b[') ? text.replace(SGR, '') : text
  const hint = pattern.exec(plain)
  return hint === null ? undefined : { state: 'ended', detail: '', session: hint[1] }
}

/**
 * A parser for one terminal's output. Stateful (a sequence or the hint may be split across chunks)
 * and never throws.
 * @returns `feed(text)`: the signals found in that chunk, in order (usually none); `end()`: the
 *   signals still held in the retained tail once the stream is over (an exit hint with no newline after it).
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
        /** An unterminated sequence at the end of the chunk, kept for the next one. */
        let open = ''
        let at = rest.indexOf(OSC_START)
        while (at !== -1) {
          const bodyAt = at + OSC_START.length
          const bel = rest.indexOf('\x07', bodyAt)
          const st = rest.indexOf('\x1b\\', bodyAt)
          const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
          if (end === -1) {
            // Unterminated: keep it for the next chunk unless it is too long to be real. The text in
            // front of it is still read for the exit hint below.
            open = rest.length - at > MAX_SEQUENCE ? '' : rest.slice(at)
            rest = rest.slice(0, at)
            break
          }
          const signal = signalOf(rest.slice(bodyAt, end))
          if (signal !== undefined) signals.push(signal)
          rest = rest.slice(end + (end === st ? 2 : 1))
          at = rest.indexOf(OSC_START)
        }
        if (rest.includes('onversation') || rest.includes('Resume')) {
          const ended = hintIn(rest, HINT)
          if (ended !== undefined) {
            signals.push(ended)
            tail = open
            return signals
          }
          // An open sequence follows the text, so a hint in it can no longer be continued by later output.
          tail = open !== '' ? open : rest.slice(-HINT_TAIL)
        } else if (open !== '') {
          tail = open
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
    end() {
      try {
        const ended = tail === '' ? undefined : hintIn(tail, HINT_AT_END)
        tail = ''
        return ended === undefined ? [] : [ended]
      } catch {
        tail = ''
        return []
      }
    },
  }
}

/**
 * Set up the opt-in integration (nothing is installed here: see lib/agy-integration.js) and the variables
 * every terminal gets: AGY_CLI_OSC7501 (agy reports nothing without it; harmless in shells whose output is
 * not read) and DSH_WT_AGY_SIGNAL, where the integration's hook and status line post.
 */
function prepare({ dir, pid, base, nodePath, pidAlive, which, version }) {
  const integration = createAgyIntegration({
    dir,
    geminiDir: geminiDir(),
    pid,
    nodePath,
    pidAlive,
    version,
    findAgy: () => findAgy(which),
    agyArgv: agyArgvOverride(),
    userStatusLine: () => userAgyStatusLine(),
  })
  return {
    launch: {},
    launchHint: () => integration.launch(),
    env: { AGY_CLI_OSC7501: 'on', DSH_WT_AGY_SIGNAL: base },
    integration,
    dispose: () => integration.dispose(),
  }
}

/** agy's path: on Windows a real agy.exe when there is one (a .cmd or extensionless shim cannot be spawned directly). */
async function findAgy(which) {
  if (which === undefined) return undefined
  if (process.platform === 'win32') {
    const exe = await which('agy.exe')
    if (exe !== undefined) return exe
  }
  return which('agy')
}

/** DSH_WT_AGY_COMMAND (a JSON argv) runs something else as agy: tests use it. */
function agyArgvOverride() {
  try {
    const argv = JSON.parse(process.env.DSH_WT_AGY_COMMAND ?? 'null')
    return Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string') ? argv : undefined
  } catch {
    return undefined
  }
}

/** The session's state when it is this provider's, for the status line to compare against. */
const currentOf = (session) => (session.agent?.provider === 'antigravity' ? session.agent : undefined)

/** @type {import('./index.js').Provider} */
export const antigravity = {
  id: 'antigravity',
  label: 'Antigravity CLI',
  commands: ['agy'],
  prepare,
  observe: createAntigravityObserver,
  usage: () => createAntigravityUsage(),
  routes: {
    // The installed plugin's hooks: state, conversation id and the files agy wrote.
    'antigravity-hook': ({ session, body }, host) => {
      const { signal, edit, session: conversation } = agyHookSignal(body)
      if (edit !== undefined && session.edits.record(edit.path, edit.tool)) host.notifyEdits(session)
      if (signal !== undefined) host.applySignal(session, { provider: 'antigravity', ...signal, ...(conversation === undefined ? {} : { session: conversation }) })
    },
    // The launch-time status line: usage numbers, plus the state when it changed.
    'antigravity-status': ({ id, session, body }, host) => {
      host.ingestUsage('antigravity', id, body)
      const { signal, session: conversation } = agyStatusSignal(body, currentOf(session))
      if (signal !== undefined) host.applySignal(session, { provider: 'antigravity', ...signal, ...(conversation === undefined ? {} : { session: conversation }) })
    },
  },
}
