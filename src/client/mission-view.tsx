// dsh-web-terminal — the mission-control overlay and its keyboard handling (logic in mission.ts).
//
// The overlay only draws tile frames (name, status, folder); the live terminals are the ordinary windows,
// CSS-scaled by TerminalsView using the plan returned here, so they are never resized or duplicated.

import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { baseName, displayName, getRuntime, refit, runtimes, unreadCount } from './terminal-store.ts'
import {
  exitOverview,
  filterTiles,
  isMissionShortcut,
  mission,
  moveSel,
  planOverview,
  resolveSel,
  setMissionQuery,
  setMissionSel,
  takePendingFocus,
  toggleOverview,
} from './mission.ts'
import type { Size, TilePlan } from './mission.ts'
import type { Rect, WinState } from './types.ts'

export interface MissionPlan {
  /** Scale/translate per visible window; windows absent from the map are filtered out (hidden). */
  tiles: Map<string, TilePlan>
  sel: string | null
  cols: number
}

function px(win: WinState, stage: Size): Rect {
  return { x: win.x * stage.w, y: win.y * stage.h, w: win.w * stage.w, h: win.h * stage.h }
}

/** Plan for the current state, or null while overview is off. */
export function missionPlan(wins: WinState[], stage: Size): MissionPlan | null {
  if (!mission.active) return null
  const named = wins.map((w) => ({ win: w, name: displayName(w), cwd: w.cwd }))
  const shown = filterTiles(named, mission.query).map((n) => n.win)
  const plan = planOverview(shown.map((w) => ({ id: w.id, ...px(w, stage) })), stage)
  return { tiles: new Map(plan.tiles.map((t) => [t.id, t])), sel: resolveSel(shown.map((w) => w.id), mission.sel), cols: plan.cols }
}

/** Shortcut, keys and the leave-overview bookkeeping. Call once from the page. */
export function useMissionControl(wins: WinState[], focusId: string | null, plan: MissionPlan | null): void {
  const live = useRef({ wins, focusId, plan })
  live.current = { wins, focusId, plan }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { focusId: focus, plan: p } = live.current
      if (isMissionShortcut(e)) {
        e.preventDefault()
        e.stopPropagation()
        toggleOverview(focus)
        return
      }
      if (!mission.active || p === null) return
      // Everything else belongs to overview: the terminals underneath must not see these keys.
      const ids = [...p.tiles.keys()]
      const at = p.sel === null ? -1 : ids.indexOf(p.sel)
      if (e.key === 'Escape') exitOverview()
      else if (e.key === 'Enter') {
        if (p.sel !== null) exitOverview(p.sel)
      } else if (e.key.startsWith('Arrow') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const next = moveSel(ids.length, p.cols, Math.max(0, at), e.key)
        if (next >= 0) setMissionSel(ids[next] ?? null)
      } else if (e.key === 'Backspace') setMissionQuery(mission.query.slice(0, -1))
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) setMissionQuery(mission.query + e.key)
      else if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Tab' || e.key.length > 1) {
        // Let browser/app chords (Ctrl+Alt+arrows, F-keys, Tab) through untouched.
        return
      }
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Leaving (or unmounting) overview: the stage may have resized meanwhile with fitting paused, so refit now.
  const was = useRef(false)
  useEffect(() => {
    if (was.current && !mission.active) {
      for (const rt of runtimes.values()) refit(rt)
      takePendingFocus()
    }
    was.current = mission.active
  })
  useEffect(() => () => {
    if (mission.active) exitOverview()
  }, [])
}

/** Tile frames over the scaled terminals: transparent in the middle so the live terminal shows through. */
export function MissionOverlay({ wins, plan }: { wins: WinState[]; plan: MissionPlan }): ReactElement {
  const byId = new Map(wins.map((w) => [w.id, w]))
  return (
    <div className="wt-mission" data-toolbar="mission">
      {[...plan.tiles.values()].map((t) => {
        const win = byId.get(t.id)
        if (win === undefined) return null
        const rt = getRuntime(t.id)
        const activity = rt?.activity ?? 'offline'
        return (
          <div
            key={t.id}
            className="wt-tile"
            data-sel={plan.sel === t.id}
            data-attn={rt?.attention === true ? rt.attentionLevel ?? 'quiet' : false}
            style={{ left: t.tile.x, top: t.tile.y, width: t.tile.w, height: t.tile.h }}
            title={win.cwd}
            onClick={() => exitOverview(t.id)}
          >
            <div className="wt-tile-head">
              <span className="wt-dot" data-a={activity} />
              <span className="wt-tile-name">{displayName(win)}</span>
              {rt?.attention === true ? <span className="wt-badge" data-level={rt.attentionLevel ?? 'quiet'}>{rt.attentionLabel || 'needs you'}</span> : null}
              {unreadCount(t.id) > 0 ? <span className="wt-unread" title="New output since you last looked">{unreadCount(t.id) > 99 ? '99+' : unreadCount(t.id)} new</span> : null}
              <span className="wt-tile-cwd">{baseName(win.cwd) || win.cwd}</span>
            </div>
          </div>
        )
      })}
      {mission.query.length > 0 ? <div className="wt-mission-filter">Filter: <b>{mission.query}</b>{plan.tiles.size === 0 ? ' — no match' : ''}</div> : null}
      {wins.length > 0 && mission.query.length === 0 ? <div className="wt-mission-hint">Type to filter · arrows move · Enter opens · Esc leaves</div> : null}
    </div>
  )
}
