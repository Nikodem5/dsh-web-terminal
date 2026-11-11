// dsh-web-terminal — Overseer (client): the conversation, the terminal picker, privacy switches.
//
// A plain module store read with `useSyncExternalStore`, like state.ts, but self-contained: its own
// localStorage key, its own listeners. The conversation lives for the page; the panel switch, the
// picker, the privacy notice and the hidden-terminal mirror persist.
//
// Every question sends the CURRENT terminal list (numbers, names, titles, activity) to the host, which
// adds what it knows (scrollback, agent state, transcripts) and streams the model's answer back as
// server-sent events, read here with fetch because the route needs the auth header.

import { withAuth } from '../../../shared/client/local-auth.ts'
import { displayName } from './names.ts'
import { focusWin, getRuntime, getWins } from './state.ts'
import type { WinState } from './types.ts'

export const K_OVERSEER = 'dsh.web-terminal.overseer.v1'
export const ASK_URL = '/api/dsh-web-terminal/overseer/ask'
export const HIDDEN_URL = '/api/dsh-web-terminal/overseer/hidden'

/** Earlier turns sent with a follow-up (the host bounds them again). */
const HISTORY_SENT = 6

/** Why a question could not be answered, as the panel shows it. */
export type OverseerErrorCode = 'no-llm' | 'no-model' | 'model-error' | 'network' | 'bad-request' | 'http'

export interface OverseerTurn {
  id: number
  question: string
  answer: string
  status: 'streaming' | 'done' | 'stopped' | 'error'
  error?: string
  code?: OverseerErrorCode
  /** `provider / model` that answered. */
  model?: string
  /** The context had to be cut to fit the budget. */
  truncated?: boolean
  /** Terminals whose data did not fit at all (numbers). */
  omitted?: number[]
  /** The answer stopped at the model's output limit. */
  cutShort?: boolean
  /** Terminal number -> window id, as numbered when the question was asked (citations resolve through it). */
  nums: Record<number, string>
}

export interface OverseerState {
  open: boolean
  /** The user acknowledged that terminal content goes to the model provider. */
  noticeAccepted: boolean
  /** Window ids hidden from the Overseer (mirror of the host's list). */
  hidden: string[]
  /** Window ids picked for a deep look; null = all terminals equally. */
  selected: string[] | null
  turns: OverseerTurn[]
  busy: boolean
  version: number
}

export const overseer: OverseerState = { open: false, noticeAccepted: false, hidden: [], selected: null, turns: [], busy: false, version: 0 }
const listeners = new Set<() => void>()
let controller: AbortController | null = null
let nextId = 1

function emit(): void {
  overseer.version++
  for (const listener of listeners) listener()
}

function persist(): void {
  try {
    localStorage.setItem(K_OVERSEER, JSON.stringify({ open: overseer.open, noticeAccepted: overseer.noticeAccepted, hidden: overseer.hidden, selected: overseer.selected }))
  } catch {}
}

export function subscribeOverseer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const getOverseerVersion = (): number => overseer.version

let hydrated = false
/** Restore the persisted switches once per page load. */
export function hydrateOverseer(): void {
  if (hydrated) return
  hydrated = true
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(K_OVERSEER) ?? 'null')
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
    const r = raw as Record<string, unknown>
    overseer.open = r.open === true
    overseer.noticeAccepted = r.noticeAccepted === true
    if (Array.isArray(r.hidden)) overseer.hidden = r.hidden.filter((v): v is string => typeof v === 'string').slice(0, 200)
    if (Array.isArray(r.selected)) overseer.selected = r.selected.filter((v): v is string => typeof v === 'string').slice(0, 64)
  } catch {}
}

/** Forget the hydration (tests). */
export function resetOverseer(): void {
  controller?.abort()
  controller = null
  hydrated = false
  Object.assign(overseer, { open: false, noticeAccepted: false, hidden: [], selected: null, turns: [], busy: false })
  emit()
}

export function setOverseerOpen(open: boolean): void {
  if (overseer.open === open) return
  overseer.open = open
  persist()
  emit()
}
export const toggleOverseer = (): void => setOverseerOpen(!overseer.open)

export function acceptOverseerNotice(): void {
  overseer.noticeAccepted = true
  persist()
  emit()
}

/** The picker: null = all terminals; otherwise the window ids looked at in depth. */
export function setOverseerSelection(ids: string[] | null): void {
  overseer.selected = ids === null || ids.length === 0 ? null : [...new Set(ids)]
  persist()
  emit()
}
export function togglePicked(id: string): void {
  const current = overseer.selected ?? []
  setOverseerSelection(current.includes(id) ? current.filter((x) => x !== id) : [...current, id])
}

export const isHiddenFromOverseer = (id: string): boolean => overseer.hidden.includes(id)

/** Hide or show one terminal: applied here at once and saved on the host, which enforces it for every request. */
export async function setHiddenFromOverseer(id: string, hidden: boolean): Promise<void> {
  overseer.hidden = hidden ? [...new Set([...overseer.hidden, id])] : overseer.hidden.filter((x) => x !== id)
  if (hidden && overseer.selected !== null) overseer.selected = overseer.selected.filter((x) => x !== id)
  persist()
  emit()
  try {
    const res = await fetch(HIDDEN_URL, { method: 'POST', headers: withAuth({ 'content-type': 'application/json', accept: 'application/json' }), body: JSON.stringify({ id, hidden }) })
    const body = (await res.json()) as { ok?: boolean; hidden?: unknown }
    if (body.ok === true && Array.isArray(body.hidden)) adoptHostHidden(body.hidden)
  } catch {}
}

/** Take the host's hidden list, keeping anything hidden here that the host has not heard of yet (it is sent with each question too). */
function adoptHostHidden(list: unknown[]): void {
  const host = list.filter((v): v is string => typeof v === 'string')
  const merged = [...new Set([...host, ...overseer.hidden])]
  if (merged.length === overseer.hidden.length && merged.every((id) => overseer.hidden.includes(id))) return
  overseer.hidden = merged
  persist()
  emit()
}

/** Read the host's hidden list (on opening the panel). */
export async function syncOverseerHidden(): Promise<void> {
  try {
    const res = await fetch(HIDDEN_URL, { headers: withAuth({ accept: 'application/json' }) })
    const body = (await res.json()) as { ok?: boolean; hidden?: unknown }
    if (body.ok === true && Array.isArray(body.hidden)) adoptHostHidden(body.hidden)
  } catch {}
}

/** The host session id of a window (the socket's `id`): `<window id>-<generation>`. */
export const sessionIdOf = (win: WinState): string => `${win.id}-${win.gen ?? 0}`

/** What the host is told about each terminal the Overseer may see, numbered as in the terminal list. */
export function terminalPayload(wins: readonly WinState[] = getWins()): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  wins.forEach((win, index) => {
    if (isHiddenFromOverseer(win.id)) return
    const rt = getRuntime(win.id)
    out.push({
      id: sessionIdOf(win),
      num: index + 1,
      name: displayName(win),
      title: rt?.title || undefined,
      cwd: rt?.cwd ?? (win.cwd || undefined),
      provider: win.provider,
      activity: rt?.activity,
      attention: rt?.attention === true ? rt.attentionReason || rt.attentionLabel || 'needs attention' : undefined,
    })
  })
  return out
}

/** One parsed server-sent event. */
export interface SseEvent {
  event: string
  data: unknown
}

/**
 * Split a server-sent-event buffer into complete events and the unfinished rest.
 * @param buffer - text received so far.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []
  const text = buffer.replace(/\r\n?/g, '\n')
  const parts = text.split('\n\n')
  const rest = parts.pop() ?? ''
  for (const part of parts) {
    let event = 'message'
    const data: string[] = []
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length === 0) continue
    try {
      events.push({ event, data: JSON.parse(data.join('\n')) })
    } catch {}
  }
  return { events, rest }
}

function patchTurn(turn: OverseerTurn, patch: Partial<OverseerTurn>): void {
  Object.assign(turn, patch)
  overseer.turns = overseer.turns.map((t) => (t.id === turn.id ? { ...turn } : t))
  emit()
}

/** Apply one streamed event to the turn. */
function applyEvent(turn: OverseerTurn, { event, data }: SseEvent): void {
  const d = (data ?? {}) as Record<string, unknown>
  if (event === 'meta') {
    const model = d.model as { provider?: unknown; model?: unknown } | undefined
    const sections = Array.isArray(d.sections) ? (d.sections as Array<{ num?: unknown; depth?: unknown }>) : []
    patchTurn(turn, {
      model: typeof model?.model === 'string' ? `${String(model.provider ?? '')} / ${model.model}` : undefined,
      truncated: d.truncated === true,
      omitted: sections.filter((s) => s.depth === 'omitted' && typeof s.num === 'number').map((s) => s.num as number),
    })
  } else if (event === 'delta' && typeof d.text === 'string') {
    patchTurn(turn, { answer: turn.answer + d.text })
  } else if (event === 'error') {
    patchTurn(turn, { status: 'error', code: 'model-error', error: typeof d.error === 'string' ? d.error : 'The model call failed.' })
  } else if (event === 'done') {
    const reason = d.reason
    if (turn.status === 'streaming') patchTurn(turn, { status: reason === 'aborted' ? 'stopped' : 'done', cutShort: reason === 'max-tokens' })
  }
}

/**
 * Ask a question. Earlier answered turns go along as history; the host builds fresh context.
 * @returns the turn (already in the conversation), resolved when the answer has finished.
 */
export async function askOverseer(question: string): Promise<OverseerTurn | undefined> {
  const q = question.trim()
  if (q.length === 0 || overseer.busy || !overseer.noticeAccepted) return undefined
  const wins = getWins()
  const nums: Record<number, string> = {}
  wins.forEach((w, i) => {
    nums[i + 1] = w.id
  })
  const history = overseer.turns
    .filter((t) => (t.status === 'done' || t.status === 'stopped') && t.answer.length > 0)
    .slice(-HISTORY_SENT)
    .map((t) => ({ question: t.question, answer: t.answer }))
  const selected = overseer.selected === null ? null : wins.flatMap((w, i) => (overseer.selected?.includes(w.id) === true && !isHiddenFromOverseer(w.id) ? [i + 1] : []))
  const turn: OverseerTurn = { id: nextId++, question: q, answer: '', status: 'streaming', nums }
  overseer.turns = [...overseer.turns, turn]
  overseer.busy = true
  const own = new AbortController()
  controller = own
  emit()
  try {
    const res = await fetch(ASK_URL, {
      method: 'POST',
      headers: withAuth({ 'content-type': 'application/json', accept: 'text/event-stream' }),
      body: JSON.stringify({ question: q, history, terminals: terminalPayload(wins), selected: selected !== null && selected.length > 0 ? selected : null, hidden: overseer.hidden }),
      signal: own.signal,
    })
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('text/event-stream')) {
      let body: { code?: unknown; error?: unknown } | undefined
      try {
        body = (await res.json()) as { code?: unknown; error?: unknown }
      } catch {}
      const code = body?.code === 'no-llm' || body?.code === 'no-model' || body?.code === 'bad-request' ? body.code : 'http'
      patchTurn(turn, { status: 'error', code, error: typeof body?.error === 'string' ? body.error : `The host answered ${res.status}.` })
      return turn
    }
    const reader = res.body?.getReader()
    if (reader === undefined) {
      patchTurn(turn, { status: 'error', code: 'network', error: 'The answer could not be read.' })
      return turn
    }
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSse(buffer)
      buffer = parsed.rest
      for (const ev of parsed.events) applyEvent(turn, ev)
    }
    buffer += decoder.decode()
    for (const ev of parseSse(`${buffer}\n\n`).events) applyEvent(turn, ev)
    if (turn.status === 'streaming') patchTurn(turn, { status: 'done' })
  } catch {
    if (own.signal.aborted) {
      if (turn.status === 'streaming') patchTurn(turn, { status: 'stopped' })
    } else patchTurn(turn, { status: 'error', code: 'network', error: 'Lost the connection to the host.' })
  } finally {
    if (controller === own) controller = null
    overseer.busy = false
    emit()
  }
  return turn
}

/** Stop the answer being streamed (the host aborts the model call when the request closes). */
export function stopOverseer(): void {
  controller?.abort()
}

/** Forget the conversation (stopping an answer in progress). */
export function clearOverseer(): void {
  controller?.abort()
  overseer.turns = []
  emit()
}

/** Focus the terminal a citation names, as numbered when the question was asked. @returns whether it still exists. */
export function focusCited(turn: OverseerTurn, num: number): boolean {
  const id = turn.nums[num]
  if (id === undefined || !getWins().some((w) => w.id === id)) return false
  focusWin(id)
  getRuntime(id)?.term.focus()
  return true
}
