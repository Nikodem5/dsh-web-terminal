// dsh-web-terminal — agent signals (host half).
//
// An agent signal is a provider-neutral statement about one terminal's agent:
//
//   { provider, state, detail }
//
// where `state` is one of AGENT_STATES. It is the only trusted source of an agent's
// state; nothing is inferred from terminal output. A provider adapter (see providers/)
// turns the provider's own event payload into a signal. This module is the neutral half:
// the states, the names of the shared secret and the normalising of one request body.
//

// Pure functions only: no I/O, so the mapping is unit-tested without a host.

/**
 * What an agent is doing, from the user's point of view.
 *  - idle:      session is open and waiting for a first prompt
 *  - working:   a turn is in progress
 *  - needs-you: blocked on the user (permission, question)
 *  - finished:  the turn ended; waiting for the next prompt
 *  - failed:    the turn ended with an error
 *  - ended:     the agent program exited
 */
export const AGENT_STATES = ['idle', 'working', 'needs-you', 'finished', 'failed', 'ended']

/** Longest detail text carried to the browser (it is shown in a tooltip and a notification). */
const DETAIL_MAX = 160

/**
 * What a conversation id may look like. Claude's are UUIDs. The id is later typed into a
 * shell (`claude --resume <id>`), so anything outside this shape is dropped, never quoted.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

/** The conversation id a payload carries, if it is a safe one. */
function sessionOf(body) {
  const raw = body.session ?? body.session_id
  return typeof raw === 'string' && SESSION_ID.test(raw) ? raw : undefined
}

/** Collapse whitespace and cap length so a signal never carries a transcript. */
export function clean(text) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat
}

/**
 * Turn a request body into a signal.
 *
 * A body that already carries a valid `state` is a provider-neutral signal (how a
 * provider, or a hand-rolled script, reports without an adapter); otherwise the
 * provider's adapter interprets it.
 * @param provider - provider id from the request path.
 * @param body - parsed JSON body.
 * @param adapter - the provider's adapter (body -> {state, detail} or undefined), when it has one.
 * @returns the signal (with the conversation id when the payload had a safe one), or undefined when the event carries no state.
 */
export function normalizeSignal(provider, body, adapter) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const session = sessionOf(body)
  const withSession = (signal) => (session === undefined ? signal : { ...signal, session })
  if (typeof body.state === 'string' && AGENT_STATES.includes(body.state)) {
    return withSession({ provider, state: body.state, detail: clean(body.detail) })
  }
  if (typeof adapter !== 'function') return undefined
  const signal = adapter(body)
  return signal === undefined ? undefined : withSession({ provider, ...signal })
}

/** Name of the env var that carries a terminal's secret into its shell. */
export const TOKEN_ENV = 'DSH_WT_TOKEN'
/** Header the hook sends the secret in. */
export const TOKEN_HEADER = 'x-dsh-wt-token'
