// dsh-web-terminal — opt-in provider integrations (client half): the Antigravity plugin and launch settings.
// The host does nothing until the user presses Install (POST /api/dsh-web-terminal/integration); this module
// reads their state and runs that one action. After a change the host probe is refreshed, so the next agy
// launch picks up (or drops) the `--settings` file.

import { withAuth } from '../../../shared/client/local-auth.ts'
import { emit, refreshHostInfo } from './state.ts'

const ENDPOINT = '/api/dsh-web-terminal/integration'

export interface IntegrationStatus {
  enabled: boolean
  pluginInstalled: boolean
  busy: boolean
  /** Why it is not fully working while enabled (or cannot be), else null. */
  reason: string | null
  /** The last action's failure, else null. */
  error: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** One provider's status from the host, or undefined when the body is not one. */
export function parseIntegration(raw: unknown): IntegrationStatus | undefined {
  if (!isObj(raw) || typeof raw.enabled !== 'boolean') return undefined
  return {
    enabled: raw.enabled,
    pluginInstalled: raw.pluginInstalled === true,
    busy: raw.busy === true,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    error: typeof raw.error === 'string' ? raw.error : null,
  }
}

let state: Record<string, IntegrationStatus> = {}
/** True while an install / remove this page started is running. */
let running: string | null = null

export const getIntegrations = (): Record<string, IntegrationStatus> => state
export const integrationRunning = (): string | null => running

function take(body: unknown): void {
  if (!isObj(body) || !isObj(body.integrations)) return
  const next: Record<string, IntegrationStatus> = {}
  for (const [id, raw] of Object.entries(body.integrations)) {
    const parsed = parseIntegration(raw)
    if (parsed !== undefined) next[id] = parsed
  }
  state = next
}

/** Ask the host for the current state (the help panel calls this when it opens). */
export async function loadIntegrations(): Promise<void> {
  try {
    const res = await fetch(ENDPOINT, { headers: withAuth({ accept: 'application/json' }) })
    if (!res.ok) return
    take(await res.json())
    emit()
  } catch {}
}

/**
 * Install or remove one provider's integration (the one explicit action). Resolves with the new status,
 * or an error text when the host could not be reached.
 */
export async function runIntegration(provider: string, action: 'install' | 'remove'): Promise<IntegrationStatus | string> {
  if (running !== null) return 'another change is running'
  running = provider
  emit()
  try {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: withAuth({ accept: 'application/json', 'content-type': 'application/json' }), body: JSON.stringify({ provider, action }) })
    const body: unknown = await res.json().catch(() => undefined)
    take(body)
    const status = isObj(body) ? parseIntegration(body.status) : undefined
    if (status === undefined) return `the host answered ${res.status}`
    refreshHostInfo()
    return status
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    running = null
    emit()
  }
}

/** One line for the diagnostics. */
export function describeIntegration(status: IntegrationStatus | undefined): { value: string; bad: boolean } {
  if (status === undefined) return { value: 'unknown (host has not answered)', bad: false }
  if (status.error !== null) return { value: `${status.enabled ? 'installed' : 'not installed'}; last change failed: ${status.error}`, bad: true }
  if (!status.enabled) return { value: 'not installed (status from terminal output only)', bad: false }
  if (status.reason !== null) return { value: `installed, but ${status.reason}`, bad: true }
  return { value: 'installed (hooks plugin and status line)', bad: false }
}
