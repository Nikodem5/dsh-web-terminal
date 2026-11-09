// dsh-web-terminal — Claude Code's usage numbers (host half), behind the provider `usage` contract.
//
// Two sources: the status-line payloads (account limits and session cost, lib/usage.js) and the
// all-time token total read from Claude's own files (lib/token-totals.js).

import { createUsage } from '../usage.js'
import { createTokenTotals } from '../token-totals.js'

/**
 * @param options.now - clock (ms), injectable for tests.
 * @param options.tokenTotals - options for createTokenTotals (tests point `dir` elsewhere).
 * @returns {import('./index.js').UsageSource}
 */
export function createClaudeUsage({ now = Date.now, tokenTotals: tokenOptions = {} } = {}) {
  const usage = createUsage({ now })
  const tokens = createTokenTotals({ now, ...tokenOptions })
  return {
    ingest: (terminalId, body) => usage.ingest(terminalId, body),
    removeSession: (terminalId) => usage.removeSession(terminalId),
    stats: () => ({ limits: usage.limits(), cost: usage.cost(), tokens: tokens.get() }),
    serialize: () => ({ usage: usage.serialize(), tokens: tokens.serialize() }),
    restore(saved) {
      if (saved === null || typeof saved !== 'object') return
      usage.restore(saved.usage)
      tokens.restore(saved.tokens)
    },
    onChange: (fn) => tokens.onScanned(fn),
  }
}
