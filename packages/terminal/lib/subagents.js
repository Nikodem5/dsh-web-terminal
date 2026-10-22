// dsh-web-terminal — sub-agents of one terminal's Claude session (host half).
//
// Three untrusted sources describe the same sub-agents and are merged here by agent id:
//  - the `subagentStatusLine` payload (`tasks`): live status, model and token count;
//  - the SubagentStart hook: the agent appears, running;
//  - the SubagentStop hook: the agent is completed.
// Finished sub-agents are kept for a while (so the panel can show them) and then dropped.
//
// Pure state, no I/O and no timers: the host feeds it payloads and passes the clock in.

/**
 * @typedef {object} SubagentInfo
 * @property {string} id
 * @property {string} agentType
 * @property {string} label
 * @property {string} description
 * @property {string} status - 'running' | 'completed' | whatever Claude reports
 * @property {string | null} model
 * @property {number | null} startTime - ms since the epoch
 * @property {number | null} endedAt - ms since the epoch
 * @property {number | null} tokenCount
 * @property {number | null} contextWindowSize
 */

/** How long a finished sub-agent stays listed. */
export const RETAIN_MS = 5 * 60 * 1000
/** Most sub-agents kept per terminal. */
export const MAX_SUBAGENTS = 50
/** Longest text field carried to the browser. */
const TEXT_MAX = 200
/** What an agent id may look like (Claude's are short hex strings). */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/
/** Statuses that mean the agent is over. */
const FINISHED = /^(completed|complete|done|failed|error|killed|cancelled|canceled|stopped)$/i

/** Trim, collapse whitespace and cap length; '' for anything but a string. */
function text(value) {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat
}

/** A finite non-negative number, else null. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

const idOf = (raw) => (typeof raw === 'string' && ID.test(raw) ? raw : undefined)

/**
 * @param options.now - clock (ms), injectable for tests.
 * @param options.retainMs - how long finished sub-agents are kept.
 * @param options.max - cap on sub-agents kept.
 */
export function createSubagents({ now = Date.now, retainMs = RETAIN_MS, max = MAX_SUBAGENTS } = {}) {
  /** @type {Map<string, SubagentInfo>} insertion order = first seen */
  const agents = new Map()

  const fresh = (id) => ({ id, agentType: '', label: '', description: '', status: 'running', model: null, startTime: null, endedAt: null, tokenCount: null, contextWindowSize: null })

  /** Apply `patch` to the entry for `id` (created if missing); true when anything changed. */
  const put = (id, patch) => {
    let entry = agents.get(id)
    let changed = false
    if (entry === undefined) {
      entry = fresh(id)
      agents.set(id, entry)
      changed = true
    }
    for (const [key, value] of Object.entries(patch)) {
      if (entry[key] !== value) {
        entry[key] = value
        changed = true
      }
    }
    return changed
  }

  /** Make room: finished entries go first, then the oldest. */
  const enforceCap = () => {
    let changed = false
    while (agents.size > max) {
      const victim = [...agents.values()].find((a) => a.endedAt !== null) ?? agents.values().next().value
      agents.delete(victim.id)
      changed = true
    }
    return changed
  }

  /** Drop finished entries past retention; true when any went. */
  const prune = () => {
    const t = now()
    let changed = false
    for (const [id, a] of agents) {
      if (a.endedAt !== null && t - a.endedAt >= retainMs) {
        agents.delete(id)
        changed = true
      }
    }
    return changed
  }

  return {
    /** The `subagentStatusLine` payload. @returns whether the list changed. */
    ingestTasks(body) {
      const tasks = body !== null && typeof body === 'object' && Array.isArray(body.tasks) ? body.tasks : []
      let changed = false
      for (const task of tasks.slice(0, max * 2)) {
        if (task === null || typeof task !== 'object') continue
        const id = idOf(task.id)
        if (id === undefined) continue
        const existing = agents.get(id)
        // A finished agent stays finished whatever a late status-line tick says.
        if (existing?.endedAt != null) continue
        const patch = {}
        const status = text(task.status) || 'running'
        patch.status = status
        if (FINISHED.test(status)) patch.endedAt = now()
        const agentType = text(task.agentType)
        if (agentType !== '') patch.agentType = agentType
        const description = text(task.description)
        if (description !== '') patch.description = description
        const label = text(task.label)
        if (label !== '') patch.label = label
        const model = text(task.model)
        if (model !== '') patch.model = model
        const startTime = num(task.startTime)
        if (startTime !== null) patch.startTime = startTime
        else if (existing === undefined) patch.startTime = now()
        const tokenCount = num(task.tokenCount)
        if (tokenCount !== null) patch.tokenCount = tokenCount
        const windowSize = num(task.contextWindowSize)
        if (windowSize !== null) patch.contextWindowSize = windowSize
        if (put(id, patch)) changed = true
      }
      if (enforceCap()) changed = true
      return changed
    },

    /** A SubagentStart hook payload. */
    start(body) {
      const id = idOf(body?.agent_id)
      if (id === undefined) return false
      const existing = agents.get(id)
      const patch = {}
      const agentType = text(body.agent_type)
      if (agentType !== '') patch.agentType = agentType
      if (existing === undefined) patch.startTime = now()
      let changed = put(id, patch)
      if (enforceCap()) changed = true
      return changed
    },

    /** A SubagentStop hook payload. */
    stop(body) {
      const id = idOf(body?.agent_id)
      if (id === undefined) return false
      const existing = agents.get(id)
      // Never seen running: it would only be a nameless, 0s row, so there is nothing worth listing.
      if (existing === undefined) return false
      const patch = {}
      const agentType = text(body.agent_type)
      if (agentType !== '') patch.agentType = agentType
      if (existing.endedAt == null) {
        patch.status = 'completed'
        patch.endedAt = now()
      }
      let changed = put(id, patch)
      if (enforceCap()) changed = true
      return changed
    },

    /** The Claude session ended or the shell exited: everything still running is over. */
    endAll() {
      let changed = false
      for (const a of agents.values()) {
        if (a.endedAt === null) {
          a.status = 'completed'
          a.endedAt = now()
          changed = true
        }
      }
      return changed
    },

    /** Drop expired finished entries; true when any went. */
    prune,

    /** Current sub-agents, oldest first (expired ones dropped). @returns {SubagentInfo[]} */
    list() {
      prune()
      return [...agents.values()].map((a) => ({ ...a }))
    },
  }
}
