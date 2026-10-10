// dsh-code-editor - React side of the "changed by agent" marks: one shared source, a hook and the two badges.

import { useEffect, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { createAgentMarkSource, dirMarked, markFor, markTitle, type AgentMarks, type AgentMarkSource } from './agent-marks.ts'

let source: AgentMarkSource | null = null
const shared = (): AgentMarkSource => (source ??= createAgentMarkSource())

/** Marks for the page's current root; call `useAgentMarkRoot` once in the page to keep the root in step. */
export function useAgentMarks(): AgentMarks {
  const src = shared()
  return useSyncExternalStore(src.subscribe, src.get, src.get)
}

export function useAgentMarkRoot(root: string | null): void {
  useEffect(() => { shared().setRoot(root) }, [root])
}

/** The badge on a changed file (nothing when no open terminal changed it). `path` is relative to the open root. */
export function AgentBadge({ path }: { path: string }): ReactElement | null {
  const entries = markFor(useAgentMarks(), path)
  if (entries === undefined) return null
  const color = entries.find((e) => e.color)?.color
  return <span className="ce-agent" data-agent-mark="file" title={markTitle(entries)} style={color ? { color } : undefined}>&#x26A1;</span>
}

/** A faint dot on a collapsed folder with a changed file somewhere below it. */
export function AgentFolderDot({ path }: { path: string }): ReactElement | null {
  if (!dirMarked(useAgentMarks(), path)) return null
  return <span className="ce-agent-dir" data-agent-mark="dir" title="Contains files changed by an agent" />
}
