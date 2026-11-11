// dsh-web-terminal — which providers' numbers the stats bar shows. Pure, so the tests load it directly.
//
// The bar follows the terminals in use: every provider that has an open terminal is shown (so Claude and
// Antigravity side by side when both run), the focused terminal's provider first. With no agent terminal
// open (the chat header, an empty page) it falls back to every provider that has numbers, Claude first.

import type { ProviderStats } from './stats-format.ts'

/** Whether a provider's numbers have anything to show. */
export function hasNumbers(stats: ProviderStats | undefined): boolean {
  if (stats === undefined) return false
  const { limits, cost, tokens } = stats
  return limits.fiveHour !== null || limits.sevenDay !== null || (cost !== null && (cost.terminals > 0 || cost.totalUsd > 0)) || (tokens !== null && tokens.total > 0)
}

/**
 * @param inUse - provider ids of the open terminals, in any order, repeats allowed (undefined: a plain shell).
 * @param focused - the focused terminal's provider id, if any.
 * @param stats - what the host reported, per provider id.
 * @param order - every provider id in UI order (the fallback order).
 * @returns provider ids to show, in display order.
 */
export function statsProviders(inUse: readonly (string | undefined)[], focused: string | undefined, stats: Record<string, ProviderStats>, order: readonly string[]): string[] {
  const used = order.filter((id) => inUse.includes(id))
  let ids: string[]
  if (used.length === 0) ids = order.filter((id) => hasNumbers(stats[id]))
  else ids = focused !== undefined && used.includes(focused) ? [focused, ...used.filter((id) => id !== focused)] : used
  // Claude keeps its slot even before it reports: the "limits n/a" hint belongs to it.
  return ids.filter((id) => stats[id] !== undefined && (hasNumbers(stats[id]) || id === 'claude'))
}
