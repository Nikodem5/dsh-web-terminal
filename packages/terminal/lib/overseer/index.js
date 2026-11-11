// dsh-web-terminal — Overseer (host half): answer questions about the terminals with a model.
//
// Two routes, both registered through the host's `registerSecured` (loopback, Host and per-boot token):
//
//   POST /api/dsh-web-terminal/overseer/ask     question -> a streamed answer (text/event-stream)
//   GET|POST /api/dsh-web-terminal/overseer/hidden   the terminals hidden from the Overseer
//
// Strictly read-only: it reads the host's session records (scrollback, agent state, sub-agents,
// changed files, the transcript path the agent's own hook reported) and never writes to a terminal.
// The model gets no tools. The `llm` and `agentDefaultModel` services are optional and looked up per
// request, so the plugin loads and terminals work without them; the panel then says why it cannot answer.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_ID } from '../agent-signals.js'
import { DEFAULT_BUDGET, buildContext } from './context.js'
import { boundHistory, buildMessages, newMarker, systemPrompt } from './prompt.js'
import { createTranscriptReader } from './transcript.js'

export const ASK_PATH = '/api/dsh-web-terminal/overseer/ask'
export const HIDDEN_PATH = '/api/dsh-web-terminal/overseer/hidden'

/** Largest request body (a question, earlier turns and the terminal list). */
const BODY_LIMIT = 512 * 1024
/** Longest question accepted. */
const QUESTION_MAX = 4000
/** Most terminals one request may list. */
const TERMINALS_MAX = 64
/** A window id as the client makes them (`t…`); the host session id is `<window id>-<generation>`. */
const WIN_ID = /^[\w.]{1,64}$/

/** Read one positive number from the environment, else the default. */
function envNumber(key, fallback) {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** The client window a host session id belongs to (`t1abc-2` -> `t1abc`). */
export function windowOf(sessionId) {
  return String(sessionId).replace(/-\d+$/, '')
}

/**
 * Remember where a Claude session writes its transcript. Only called with the body of the
 * terminal's own authenticated hook signal, so a terminal can only name its own transcript; the
 * path is checked again (inside a Claude config folder) every time it is read.
 * @param session - the host session record.
 * @param body - a Claude Code hook payload.
 */
export function noteTranscript(session, body) {
  if (session === null || typeof session !== 'object' || body === null || typeof body !== 'object') return
  const path = body.transcript_path
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || !path.toLowerCase().endsWith('.jsonl')) return
  const id = typeof body.session_id === 'string' && SESSION_ID.test(body.session_id) ? body.session_id : undefined
  session.transcript = { path, session: id }
}

/** Write one JSON response. */
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/** Read a JSON POST body; replies and resolves undefined on any problem. */
function readBody(req, res) {
  return new Promise((resolve) => {
    const fail = (status, error) => {
      writeJson(res, status, { ok: false, code: 'bad-request', error })
      resolve(undefined)
    }
    if (req.method !== 'POST') return fail(405, 'POST only')
    const chunks = []
    let size = 0
    let big = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) big = true
      else chunks.push(chunk)
    })
    req.on('error', () => resolve(undefined))
    req.on('end', () => {
      if (big) return fail(413, 'Body too large')
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Bad request')
        resolve(body)
      } catch {
        fail(400, 'Bad JSON')
      }
    })
  })
}

/** A string field from the client, trimmed to `max`, or undefined. */
const str = (v, max) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined)

/**
 * The Overseer.
 * @param options.sessions - the host's live sessions (id -> record).
 * @param options.service - name -> an optional service, or undefined (never throws).
 * @param options.dir - folder for the hidden-terminal list.
 * @param options.transcriptDirs - allowed Claude config folders (tests only).
 * @param options.readTranscript - replaces the transcript reader (tests only).
 */
export function createOverseer({ sessions, service, dir, transcriptDirs, readTranscript }) {
  const budget = envNumber('DSH_WT_OVERSEER_BUDGET', DEFAULT_BUDGET)
  const maxTokens = envNumber('DSH_WT_OVERSEER_MAX_TOKENS', 4096)
  const transcripts = readTranscript === undefined ? createTranscriptReader({ dirs: transcriptDirs }) : { read: readTranscript }
  const file = join(dir, 'overseer.json')

  /** Window ids hidden from the Overseer: persisted, and enforced here for every request. */
  const hidden = new Set()
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(saved?.hidden)) for (const id of saved.hidden) if (typeof id === 'string' && WIN_ID.test(id)) hidden.add(id)
  } catch {}
  const saveHidden = () => {
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, hidden: [...hidden] }))
      renameSync(tmp, file)
    } catch {}
  }

  /** In-flight answers, aborted when the plugin unloads. */
  const inflight = new Set()

  /** GET: the hidden list. POST {id, hidden}: hide or show one window. */
  const hiddenHandler = async (req, res) => {
    if (req.method === 'GET') return writeJson(res, 200, { ok: true, hidden: [...hidden] })
    const body = await readBody(req, res)
    if (body === undefined) return
    if (typeof body.id !== 'string' || !WIN_ID.test(body.id) || typeof body.hidden !== 'boolean') return writeJson(res, 400, { ok: false, code: 'bad-request', error: 'id and hidden are required' })
    const before = hidden.has(body.id)
    if (body.hidden) hidden.add(body.id)
    else hidden.delete(body.id)
    if (before !== body.hidden) saveHidden()
    writeJson(res, 200, { ok: true, hidden: [...hidden] })
  }

  /** The model route the app is set to use, or a reason it cannot be used. */
  const route = () => {
    const llm = service('llm')
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') return { code: 'no-llm', error: 'No model service is available in this app, so the Overseer cannot answer.' }
    let selection
    try {
      selection = service('agentDefaultModel')?.currentSelection?.()
    } catch {}
    if (selection === null || typeof selection !== 'object' || typeof selection.provider !== 'string' || selection.provider.length === 0 || typeof selection.model !== 'string' || selection.model.length === 0) {
      return { code: 'no-model', error: 'No default model is selected. Pick one in the app\'s model settings, then ask again.' }
    }
    return { llm, selection }
  }

  /**
   * The terminals the request may see: listed by the client, alive on this host, and not hidden
   * (by the host's list or the request's own).
   */
  const visibleTerminals = (body) => {
    const extraHidden = new Set(Array.isArray(body.hidden) ? body.hidden.filter((id) => typeof id === 'string') : [])
    const out = []
    const seen = new Set()
    for (const t of Array.isArray(body.terminals) ? body.terminals.slice(0, TERMINALS_MAX) : []) {
      if (t === null || typeof t !== 'object' || typeof t.id !== 'string' || seen.has(t.id)) continue
      const session = sessions.get(t.id)
      if (session === undefined) continue
      const win = windowOf(t.id)
      if (hidden.has(win) || extraHidden.has(win) || extraHidden.has(t.id)) continue
      const num = Number.isInteger(t.num) && t.num > 0 && t.num < 1000 ? t.num : out.length + 1
      seen.add(t.id)
      out.push({
        id: t.id,
        num,
        name: str(t.name, 200) ?? `Terminal ${num}`,
        title: str(t.title, 200),
        cwd: str(t.cwd, 1000) ?? session.cwd,
        provider: session.agent?.provider ?? session.observerProvider ?? str(t.provider, 40),
        ssh: session.shellId === 'ssh',
        agent: session.agent === undefined ? undefined : { state: session.agent.state, detail: session.agent.detail, at: session.agent.at },
        activity: str(t.activity, 30),
        attention: str(t.attention, 300),
        exited: session.exited === true,
        subagents: typeof session.subagents?.list === 'function' ? session.subagents.list() : [],
        edits: typeof session.edits?.list === 'function' ? session.edits.list() : [],
        replay: typeof session.replay === 'string' ? session.replay : '',
        transcriptPath: session.transcript?.path,
      })
    }
    return out
  }

  const askHandler = async (req, res) => {
    const body = await readBody(req, res)
    if (body === undefined) return
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (question.length === 0 || question.length > QUESTION_MAX) return writeJson(res, 400, { ok: false, code: 'bad-request', error: `Ask a question of 1–${QUESTION_MAX} characters.` })
    const target = route()
    if (target.code !== undefined) return writeJson(res, 200, { ok: false, code: target.code, error: target.error })
    const { llm, selection } = target

    // The client may stop (Stop button, closed panel, reload) at any point, including while the context is
    // built: listen from the start, and never call the model for a request nobody waits for any more.
    const controller = new AbortController()
    let finished = false
    res.on('close', () => {
      if (!finished) controller.abort()
    })
    inflight.add(controller)
    try {
      await answer(res, controller, { body, question, llm, selection })
    } finally {
      finished = true
      inflight.delete(controller)
    }
  }

  /** Build the context and stream the model's answer for one request; returns when it is over (or abandoned). */
  const answer = async (res, controller, { body, question, llm, selection }) => {
    const terminals = visibleTerminals(body)
    const selected = Array.isArray(body.selected) ? body.selected.filter((n) => Number.isInteger(n)) : null
    const marker = newMarker()
    const context = await buildContext({ question, terminals, selected, budget, marker, readTranscript: transcripts.read })
    if (controller.signal.aborted || res.destroyed) {
      // Nobody is waiting (the client left, or the plugin unloaded): no model call.
      if (!res.writableEnded && !res.destroyed) res.end()
      return
    }
    const history = boundHistory(body.history)
    const options = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      system: systemPrompt(marker),
      messages: buildMessages({ history, context: context.text, question, route: selection }),
      maxTokens,
    }

    // The answer streams as server-sent events. The client reads them with fetch (it needs the auth header).
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'referrer-policy': 'no-referrer' })
    const event = (name, data) => {
      if (res.writableEnded || res.destroyed) return
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    event('meta', {
      model: { provider: selection.provider, model: selection.model },
      terminals: terminals.map((t) => ({ num: t.num, id: t.id })),
      focus: context.focus,
      sections: context.sections,
      truncated: context.truncated,
      budget,
      used: context.text.length,
    })
    let reason = 'stop'
    try {
      for await (const chunk of llm.stream({ ...options, signal: controller.signal })) {
        if (controller.signal.aborted) {
          reason = 'aborted'
          break
        }
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) event('delta', { text: chunk.text })
        else if (chunk?.type === 'finish') {
          const kind = chunk.reason?.kind
          if (kind === 'error') {
            reason = 'error'
            event('error', { code: 'model-error', error: String(chunk.reason.failure?.message ?? 'The model call failed.').slice(0, 500) })
          } else if (kind === 'aborted') reason = 'aborted'
          else if (kind === 'max-tokens') reason = 'max-tokens'
        }
      }
    } catch (error) {
      if (controller.signal.aborted) reason = 'aborted'
      else {
        reason = 'error'
        event('error', { code: 'model-error', error: (error instanceof Error ? error.message : String(error)).slice(0, 500) })
      }
    }
    event('done', { reason })
    if (!res.writableEnded) res.end()
  }

  return {
    askHandler,
    hiddenHandler,
    /** Whether a window is hidden (tests). */
    isHidden: (id) => hidden.has(id),
    dispose() {
      for (const controller of inflight) controller.abort()
      inflight.clear()
    },
  }
}
