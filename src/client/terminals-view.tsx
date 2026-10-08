// dsh-web-terminal — the "Terminals" page.
//
// A top-level page (sidebar entry + `main` panel, like Plugins): a canvas on which terminal windows are
// opened, dragged, resized, snapped to edges and halves/quarters (Windows-style),
// maximized, minimized and pinned (position + size locked); a right-hand list of
// every terminal with live status; broadcast input; saved layouts. Window state
// and the live shells live in terminal-store.ts so they survive flipping tabs or
// sessions.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { requestClose, requestCloseAll } from './actions.ts'
import { LayoutsMenu, SettingsMenu } from './menus.tsx'
import { NewTerminalDialog } from './new-dialog.tsx'
import { AgentsPanel } from './agents-panel.tsx'
import { MissionOverlay, missionPlan, useMissionControl } from './mission-view.tsx'
import type { MissionPlan } from './mission-view.tsx'
import { Sidebar } from './sidebar.tsx'
import { StatsBar } from './stats-bar.tsx'
import { ensureStyles } from './styles.ts'
import {
  arrange,
  baseName,
  broadcastLine,
  closeSearch,
  cycleFocus,
  displayName,
  duplicateWin,
  ensureRuntime,
  focusWin,
  getBroadcast,
  getFocusId,
  getPrefs,
  getRuntime,
  getSearchId,
  getVersion,
  getWins,
  hostInfo,
  hydrate,
  isDarkSurface,
  loadHostInfo,
  openSearch,
  refit,
  renameWin,
  restartWin,
  runningSubagents,
  setAgentsPanel,
  runSearch,
  saveLog,
  setBroadcast,
  setSidebar,
  setViewMounted,
  subscribe,
  toggleOverview,
  termBackground,
  toggleMaximize,
  updateWin,
  workspaceChoices,
} from './terminal-store.ts'
import type { Activity, FindOptions, Preset, Rect, WinState } from './terminal-store.ts'

const MIN_W = 240
const MIN_H = 130
const SNAP = 8
const EDGE = 14
const CORNER = 56

interface Size {
  w: number
  h: number
}

/** Fractions → pixels inside the stage. */
function toPx(r: Rect, s: Size): Rect {
  return { x: r.x * s.w, y: r.y * s.h, w: r.w * s.w, h: r.h * s.h }
}
function toFrac(r: Rect, s: Size): Rect {
  return { x: r.x / s.w, y: r.y / s.h, w: r.w / s.w, h: r.h / s.h }
}

/** Pull one moving edge to the nearest target within SNAP px. */
function snapEdge(value: number, targets: number[]): number {
  let best = value
  let dist = SNAP + 1
  for (const t of targets) {
    const d = Math.abs(t - value)
    if (d < dist) {
      dist = d
      best = t
    }
  }
  return dist <= SNAP ? best : value
}

/** Snap a moving span by whichever of its two edges is closer to a target. */
function snapSpan(start: number, length: number, targets: number[]): number {
  const dl = snapEdge(start, targets) - start
  const dr = snapEdge(start + length, targets) - (start + length)
  if (dl === 0 && dr === 0) return start
  if (dr === 0) return start + dl
  if (dl === 0) return start + dr
  return Math.abs(dl) <= Math.abs(dr) ? start + dl : start + dr
}

/** Edge-snap targets: the stage borders plus every other visible window's edges. */
function targetsFor(id: string, s: Size): { xs: number[]; ys: number[] } {
  const xs = [0, s.w]
  const ys = [0, s.h]
  for (const w of getWins()) {
    if (w.id === id || w.minimized) continue
    const p = toPx(w, s)
    xs.push(p.x, p.x + p.w)
    ys.push(p.y, p.y + p.h)
  }
  return { xs, ys }
}

/** Windows-style snap zone for a pointer position, as a fraction rect. */
function zoneFor(px: number, py: number, s: Size): Rect | null {
  const top = py <= EDGE
  const bottom = py >= s.h - EDGE
  const left = px <= EDGE
  const right = px >= s.w - EDGE
  if (top && px <= CORNER) return { x: 0, y: 0, w: 0.5, h: 0.5 }
  if (top && px >= s.w - CORNER) return { x: 0.5, y: 0, w: 0.5, h: 0.5 }
  if (bottom && px <= CORNER) return { x: 0, y: 0.5, w: 0.5, h: 0.5 }
  if (bottom && px >= s.w - CORNER) return { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
  if (top) return { x: 0, y: 0, w: 1, h: 1 }
  if (left) return { x: 0, y: 0, w: 0.5, h: 1 }
  if (right) return { x: 0.5, y: 0, w: 0.5, h: 1 }
  if (bottom) return { x: 0, y: 0.5, w: 1, h: 0.5 }
  return null
}

type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const DIRS: Dir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

const ACTIVITY_TITLE: Record<Activity, string> = {
  working: 'Working — the agent is on a turn',
  'needs-you': 'Needs you — the agent is blocked on a permission, a question or an error',
  finished: 'Finished — the agent is waiting for your next prompt',
  running: 'Running — a program is running in the shell',
  idle: 'Idle — nothing is running',
  exited: 'The process exited',
  offline: 'Not connected',
}

/** Find-in-terminal bar (Ctrl+F): Enter/Shift+Enter step through matches, Esc closes. */
function FindBar({ id }: { id: string }): ReactElement {
  const rt = getRuntime(id)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState(() => {
    const selected = rt?.term.getSelection() ?? ''
    return selected.length > 0 && !selected.includes('\n') ? selected : ''
  })
  const [opts, setOpts] = useState<FindOptions>({ caseSensitive: false, regex: false, wholeWord: false })

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  // Re-run incrementally whenever the query or options change.
  useEffect(() => {
    runSearch(id, query, opts, 'next', true)
  }, [id, query, opts])

  const toggle = (key: keyof FindOptions) => setOpts((o) => ({ ...o, [key]: !o[key] }))
  const count = rt?.searchCount ?? 0
  const label = query.length === 0 ? '' : count === 0 ? 'No results' : `${rt?.searchIndex ?? 0} / ${count}`

  return (
    <div className="wt-find" onPointerDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="wt-input"
        value={query}
        placeholder="Find"
        data-bad={query.length > 0 && count === 0}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') runSearch(id, query, opts, e.shiftKey ? 'prev' : 'next')
          else if (e.key === 'Escape') closeSearch()
        }}
      />
      <span className="wt-find-count">{label}</span>
      <button type="button" className="wt-hbtn" data-on={opts.caseSensitive} title="Match case" onClick={() => toggle('caseSensitive')}>Aa</button>
      <button type="button" className="wt-hbtn" data-on={opts.wholeWord} title="Whole word" onClick={() => toggle('wholeWord')}>ab</button>
      <button type="button" className="wt-hbtn" data-on={opts.regex} title="Regular expression" onClick={() => toggle('regex')}>.*</button>
      <button type="button" className="wt-hbtn" title="Previous match (Shift+Enter)" onClick={() => runSearch(id, query, opts, 'prev')}>↑</button>
      <button type="button" className="wt-hbtn" title="Next match (Enter)" onClick={() => runSearch(id, query, opts, 'next')}>↓</button>
      <button type="button" className="wt-hbtn" title="Close (Esc)" onClick={() => closeSearch()}>✕</button>
    </div>
  )
}

interface WindowProps {
  win: WinState
  stage: Size
  focused: boolean
  onGhost: (ghost: Rect | null) => void
  /** Mission control: show the live window scaled into its tile (or hidden when filtered out). */
  mission?: MissionPlan | null
}

/** One terminal window: chrome plus the re-parented xterm holder. */
function TerminalWindow({ win, stage, focused, onGhost, mission }: WindowProps): ReactElement {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [renaming, setRenaming] = useState(false)
  // Escape blurs the input to close it, and blur commits; this tells the blur handler to discard instead.
  const cancelRename = useRef(false)
  const [more, setMore] = useState(false)
  const rt = ensureRuntime(win)
  const name = displayName(win)
  const searching = getSearchId() === win.id

  // Re-parent the persistent xterm holder into this window and keep it fitted.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    body.appendChild(rt.holder)
    refit(rt)
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => refit(rt))
    })
    observer.observe(body)
    return () => {
      observer.disconnect()
      if (rt.holder.parentElement === body) body.removeChild(rt.holder)
    }
  }, [rt])

  useEffect(() => {
    if (focused) rt.term.focus()
  }, [focused, rt])

  useEffect(() => {
    if (!more) return
    const close = () => setMore(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [more])

  const px = toPx(win, stage)
  const tile = mission?.tiles.get(win.id)

  /** Drag the window by its header, with edge snapping and Windows-style zones. */
  const onHeaderDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, input') !== null) return
    focusWin(win.id)
    if (win.pinned || event.button !== 0) return
    const header = event.currentTarget
    header.setPointerCapture(event.pointerId)
    const stageEl = header.closest('.wt-stage') as HTMLElement
    const bounds = stageEl.getBoundingClientRect()
    const start = { px: event.clientX, py: event.clientY, rect: toPx(win, stage) }
    const wasMax = win.maximized
    // Where "restore" should go back to, fixed now: a maximized window's own rect is the full canvas, and
    // `restore` is cleared while dragging.
    const restoreTo: Rect = wasMax ? (win.restore ?? { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }) : { x: win.x, y: win.y, w: win.w, h: win.h }
    const targets = targetsFor(win.id, stage)
    let moved = false
    let zone: Rect | null = null
    setDragging(true)

    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.px
      const dy = e.clientY - start.py
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
      moved = true
      let r = { ...start.rect }
      if (wasMax) {
        // Grab a maximized window: restore its previous size under the cursor.
        const back = restoreTo
        const bw = back.w * stage.w
        r = { x: e.clientX - bounds.left - bw * ((start.px - bounds.left) / stage.w), y: 0, w: bw, h: back.h * stage.h }
      } else {
        r.x += dx
        r.y += dy
      }
      r.x = snapSpan(r.x, r.w, targets.xs)
      r.y = snapSpan(r.y, r.h, targets.ys)
      r.x = Math.min(Math.max(r.x, -r.w + 80), stage.w - 80)
      r.y = Math.min(Math.max(r.y, 0), stage.h - 30)
      zone = zoneFor(e.clientX - bounds.left, e.clientY - bounds.top, stage)
      onGhost(zone)
      updateWin(win.id, { ...toFrac(r, stage), maximized: false, restore: wasMax ? undefined : win.restore })
    }
    const up = () => {
      header.removeEventListener('pointermove', move)
      header.removeEventListener('pointerup', up)
      header.removeEventListener('pointercancel', up)
      setDragging(false)
      onGhost(null)
      if (zone !== null) {
        const full = zone.w === 1 && zone.h === 1
        updateWin(win.id, {
          ...zone,
          maximized: full,
          restore: full ? restoreTo : undefined,
        })
      }
    }
    header.addEventListener('pointermove', move)
    header.addEventListener('pointerup', up)
    header.addEventListener('pointercancel', up)
  }

  /** Resize from any edge or corner, with the same edge snapping. */
  const onGripDown = (dir: Dir) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (win.pinned || win.maximized || event.button !== 0) return
    event.stopPropagation()
    focusWin(win.id)
    const grip = event.currentTarget
    grip.setPointerCapture(event.pointerId)
    const start = { px: event.clientX, py: event.clientY, rect: toPx(win, stage) }
    const targets = targetsFor(win.id, stage)
    setDragging(true)

    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.px
      const dy = e.clientY - start.py
      let { x, y } = start.rect
      let right = x + start.rect.w
      let bottom = y + start.rect.h
      if (dir.includes('e')) right = snapEdge(Math.max(x + MIN_W, right + dx), targets.xs)
      if (dir.includes('w')) x = snapEdge(Math.min(right - MIN_W, x + dx), targets.xs)
      if (dir.includes('s')) bottom = snapEdge(Math.max(y + MIN_H, bottom + dy), targets.ys)
      if (dir.includes('n')) y = snapEdge(Math.min(bottom - MIN_H, y + dy), targets.ys)
      updateWin(win.id, toFrac({ x, y, w: Math.max(MIN_W, right - x), h: Math.max(MIN_H, bottom - y) }, stage))
    }
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      setDragging(false)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  }

  const sub = rt.conn === 'live' ? win.cwd : rt.detail.length > 0 ? `${rt.conn} · ${rt.detail}` : rt.conn

  return (
    <div
      className="wt-win"
      data-focused={focused}
      data-attn={rt.attention && !focused ? rt.attentionLevel ?? 'quiet' : false}
      data-dragging={dragging}
      data-pinned={win.pinned}
      data-max={win.maximized}
      style={mission != null
        ? { left: px.x, top: px.y, width: px.w, height: px.h, zIndex: 1, display: 'flex', transformOrigin: '0 0', pointerEvents: 'none', visibility: tile === undefined ? 'hidden' : 'visible', transform: tile === undefined ? undefined : `translate(${tile.tx}px, ${tile.ty}px) scale(${tile.scale})` }
        : { left: px.x, top: px.y, width: px.w, height: px.h, zIndex: win.z, display: win.minimized ? 'none' : 'flex' }}
      onPointerDownCapture={() => focusWin(win.id)}
    >
      <div
        className="wt-head"
        onPointerDown={onHeaderDown}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest('button, input')) toggleMaximize(win.id)
        }}
      >
        <span className="wt-dot" data-a={rt.activity} title={ACTIVITY_TITLE[rt.activity]} />
        {renaming ? (
          <input
            className="wt-name-input"
            autoFocus
            defaultValue={name}
            onBlur={(e) => {
              if (!cancelRename.current) renameWin(win.id, e.target.value)
              cancelRename.current = false
              setRenaming(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancelRename.current = true
              if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
            }}
          />
        ) : (
          <span className="wt-name" title="Click to rename (empty = automatic name). Double-click the title bar to maximize." onClick={() => setRenaming(true)}>
            {name}
          </span>
        )}
        {rt.attention ? <span className="wt-badge" data-level={rt.attentionLevel ?? 'quiet'} title={rt.attentionReason}>{rt.attentionLabel || 'needs you'}</span> : null}
        <span className="wt-sub" title={win.cwd}>{sub}</span>
        {rt.conn === 'exited' || rt.conn === 'failed' ? (
          <button type="button" className="wt-hbtn" title="Restart shell" onClick={() => restartWin(win.id)}>↻</button>
        ) : null}
        <button type="button" className="wt-hbtn" data-on={win.pinned} title={win.pinned ? 'Unpin (allow move/resize)' : 'Pin in place (lock position and size)'} onClick={() => updateWin(win.id, { pinned: !win.pinned })}>
          {win.pinned ? '◆' : '◇'}
        </button>
        <button type="button" className="wt-hbtn" title="More" onPointerDown={(e) => e.stopPropagation()} onClick={() => setMore((v) => !v)}>⋯</button>
        <button type="button" className="wt-hbtn" title="Minimize" onClick={() => updateWin(win.id, { minimized: true })}>–</button>
        <button type="button" className="wt-hbtn" title={win.maximized ? 'Restore' : 'Maximize'} onClick={() => toggleMaximize(win.id)}>{win.maximized ? '❐' : '□'}</button>
        <button type="button" className="wt-hbtn" data-danger="true" title="Close and end the shell" onClick={() => requestClose([win.id])}>✕</button>
      </div>
      {more ? (
        <div className="wt-pop" data-right="true" style={{ top: 36, right: 6, minWidth: 190, zIndex: 80 }} onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" className="wt-item wt-link" style={{ color: 'inherit', textAlign: 'left' }} onClick={() => { openSearch(win.id); setMore(false) }}>⌕ Find…  <span className="wt-state">Ctrl+F</span></button>
          <button type="button" className="wt-item wt-link" style={{ color: 'inherit', textAlign: 'left' }} onClick={() => { duplicateWin(win.id); setMore(false) }}>⧉ Duplicate</button>
          <button type="button" className="wt-item wt-link" style={{ color: 'inherit', textAlign: 'left' }} onClick={() => { saveLog(win.id); setMore(false) }}>⤓ Save log…</button>
          <button type="button" className="wt-item wt-link" style={{ color: 'inherit', textAlign: 'left' }} onClick={() => { if (rt.activity === 'idle' || rt.activity === 'finished' || rt.activity === 'exited' || window.confirm('This terminal is still running something. Restart it?')) restartWin(win.id); setMore(false) }}>↻ Restart shell</button>
          <div style={{ fontSize: 11, color: 'var(--wt-dim)', padding: '2px 8px' }}>{baseName(win.cwd) || win.cwd}{win.startup !== undefined ? ` · runs “${win.startup}”` : ''}</div>
        </div>
      ) : null}
      {searching ? <FindBar id={win.id} /> : null}
      <div className="wt-body" ref={bodyRef} onClick={() => rt.term.focus()} />
      {win.pinned || win.maximized ? null : DIRS.map((d) => <div key={d} className="wt-grip" data-d={d} onPointerDown={onGripDown(d)} />)}
    </div>
  )
}

const PRESETS: { id: Preset; label: string; title: string }[] = [
  { id: 'grid', label: '▦ Grid', title: 'Tile all windows in a grid' },
  { id: 'columns', label: '▥ Columns', title: 'Side by side' },
  { id: 'rows', label: '▤ Rows', title: 'Stacked' },
  { id: 'main-side', label: '◧ Main + side', title: 'First window large, the rest stacked on the right' },
  { id: 'cascade', label: '❏ Cascade', title: 'Overlapping cascade' },
]

interface ViewProps {
  /** The shell's standard workspaces hook (every `main` entry receives it); absent in older shells. */
  useWorkspaces?: <T>(select: (snapshot: { items?: unknown }) => T) => T
}

/**
 * The Terminals page component registered into the `main` slot.
 * @returns the toolbar, the window canvas and the terminal list.
 */
export function TerminalsView({ useWorkspaces }: ViewProps): ReactElement {
  ensureStyles()
  hydrate()
  useSyncExternalStore(subscribe, getVersion, getVersion)
  // Selecting `items` keeps the reference stable between workspace changes; the choices are derived below.
  const workspaceItems = useWorkspaces?.((snapshot) => snapshot.items)

  const wins = getWins()
  const focusId = getFocusId()
  const prefs = getPrefs()
  const broadcast = getBroadcast()
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [stage, setStage] = useState<Size>({ w: 800, h: 500 })
  const [ghost, setGhost] = useState<Rect | null>(null)
  const [menu, setMenu] = useState<'layouts' | 'settings' | null>(null)
  const [dialog, setDialog] = useState<{ startup?: string } | null>(null)
  const [bcText, setBcText] = useState('')
  const viewRef = useRef<HTMLDivElement | null>(null)
  const [scheme, setScheme] = useState<'dark' | 'light'>('dark')
  const plan = missionPlan(wins, stage)
  useMissionControl(wins, focusId, plan)

  // Pick text colours from the MEASURED background so inputs and labels always contrast.
  useLayoutEffect(() => {
    const el = viewRef.current
    if (el === null) return
    const measure = () => setScheme(isDarkSurface(el) ? 'dark' : 'light')
    measure()
    const observer = new MutationObserver(measure)
    observer.observe(document.documentElement, { attributes: true })
    observer.observe(document.body, { attributes: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    loadHostInfo()
    setViewMounted(true)
    return () => setViewMounted(false)
  }, [])

  // Ctrl+Alt+←/→ cycles terminals. Capture phase so it wins over the page and the focused xterm.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.altKey) || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
      e.preventDefault()
      e.stopPropagation()
      cycleFocus(e.key === 'ArrowRight' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useLayoutEffect(() => {
    const el = stageRef.current
    if (el === null) return
    const measure = () => setStage({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (menu === null) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  const minimized = wins.filter((w) => w.minimized)
  const visibleCount = wins.length - minimized.length
  const sendBroadcast = () => {
    const text = bcText.trim()
    if (text.length === 0) return
    broadcastLine(text)
    setBcText('')
  }
  const runningAgents = runningSubagents()
  const needsYou = wins.filter((w) => w.id !== focusId && getRuntimeAttention(w.id)).length

  return (
    <div className="wt-view wt-page" ref={viewRef} data-scheme={scheme} style={{ ['--wt-term-bg' as string]: termBackground() }} data-dsh-plugin="web-terminal">
      <div className="wt-bar" data-toolbar="true">
        <div className="wt-bar-left">
          <button type="button" className="wt-btn" data-variant="primary" onClick={() => setDialog({})}>＋ New terminal</button>
          <button type="button" className="wt-btn wt-btn-claude" title="New terminal that runs `claude`" onClick={() => setDialog({ startup: 'claude' })}>✦ Claude</button>
          <span className="wt-sep" />
          <div className="wt-seg">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" className="wt-btn wt-btn-preset" title={p.title} disabled={visibleCount === 0} onClick={() => arrange(p.id)}>{p.label}</button>
            ))}
          </div>
          <span className="wt-sep" />
          <div className="wt-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" className="wt-btn wt-btn-tool" data-on={menu === 'layouts'} onClick={() => setMenu(menu === 'layouts' ? null : 'layouts')}>▾ Layouts</button>
            {menu === 'layouts' ? <LayoutsMenu /> : null}
          </div>
          <button type="button" className="wt-btn wt-btn-tool wt-btn-broadcast" data-on={broadcast.on} title="Send the same input to several terminals" disabled={wins.length === 0} onClick={() => setBroadcast({ on: !broadcast.on })}>⇉ Broadcast</button>
        </div>
        <div className="wt-bar-mid">
          {needsYou > 0 ? <span className="wt-badge" title="Terminals waiting for you">{needsYou} need you</span> : null}
          {minimized.map((w) => (
            <button key={w.id} type="button" className="wt-chip" title="Restore" onClick={() => focusWin(w.id)}>
              <span className="wt-dot" data-a={getRuntimeActivity(w.id)} />
              {displayName(w)}
            </button>
          ))}
        </div>
        <div className="wt-bar-right">
          {wins.length > 0 ? (
            <button type="button" className="wt-btn wt-btn-danger" title="Close every terminal and end their shells" onClick={() => requestCloseAll()}>Close all</button>
          ) : null}
          {hostInfo.claude !== undefined && hostInfo.claude.available !== true ? <span className="wt-note">`claude` not found on PATH</span> : null}
          <div className="wt-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" className="wt-btn wt-btn-icon" data-on={menu === 'settings'} title="Font and notification settings" onClick={() => setMenu(menu === 'settings' ? null : 'settings')}>Aa</button>
            {menu === 'settings' ? <SettingsMenu /> : null}
          </div>
          <button type="button" className="wt-btn wt-btn-overview" data-on={plan !== null} title="Overview of every terminal (Ctrl+Shift+Space)" disabled={wins.length === 0} onClick={() => toggleOverview(focusId)}>▦ Overview</button>
          <button type="button" className="wt-btn wt-btn-agents" data-on={prefs.agentsPanel} title={prefs.agentsPanel ? 'Hide the sub-agents panel' : 'Show the sub-agents panel'} onClick={() => setAgentsPanel(!prefs.agentsPanel)}>
            Agents{runningAgents > 0 ? <span className="wt-btn-count">{runningAgents}</span> : null}
          </button>
          <button type="button" className="wt-btn wt-btn-icon" data-on={prefs.sidebar} title={prefs.sidebar ? 'Hide the terminal list' : 'Show the terminal list'} onClick={() => setSidebar(!prefs.sidebar)}>☰</button>
        </div>
      </div>
      <div className="wt-statsrow" data-toolbar="stats">
        <StatsBar />
      </div>
      <div className="wt-cols">
      <div className="wt-main">
        {broadcast.on ? (
          <div className="wt-bar2">
            <span style={{ fontSize: 12 }}>Send to <b>{broadcast.ids.size}</b> selected</span>
            <input className="wt-input wt-grow" value={bcText} placeholder="Type a command and press Enter — it goes to every selected terminal" onChange={(e) => setBcText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendBroadcast() }} />
            <button type="button" className="wt-btn" data-variant="primary" disabled={bcText.trim().length === 0 || broadcast.ids.size === 0} onClick={sendBroadcast}>Send</button>
            <label className="wt-row" style={{ fontSize: 12, cursor: 'pointer' }} title="Whatever you type in one selected terminal is also typed into the others">
              <input type="checkbox" checked={broadcast.live} onChange={(e) => setBroadcast({ live: e.target.checked })} />
              Live mirror typing
            </label>
            <button type="button" className="wt-link" onClick={() => setBroadcast({ on: false, live: false })}>Done</button>
          </div>
        ) : null}
        <div className="wt-canvas">
          <div className="wt-stage" ref={stageRef}>
            {wins.length === 0 ? (
              <div className="wt-empty">
                <div>No terminals yet.</div>
                <button type="button" className="wt-btn" data-variant="primary" onClick={() => setDialog({})}>＋ New terminal</button>
                <div>Drag windows by the title bar, snap them to edges or corners, and pin them in place.<br />Ctrl+Alt+←/→ switches between terminals.</div>
              </div>
            ) : null}
            {wins.map((w) => (
              <TerminalWindow key={w.id} win={w} stage={stage} focused={focusId === w.id} onGhost={setGhost} mission={plan} />
            ))}
            {plan !== null ? <MissionOverlay wins={wins} plan={plan} /> : null}
            {ghost !== null ? <div className="wt-ghost" style={{ left: ghost.x * stage.w, top: ghost.y * stage.h, width: ghost.w * stage.w, height: ghost.h * stage.h }} /> : null}
          </div>
        </div>
      </div>
      {prefs.agentsPanel ? <AgentsPanel wins={wins} /> : null}
      {prefs.sidebar ? <Sidebar wins={wins} focusId={focusId} /> : null}
      </div>
      {dialog !== null ? <NewTerminalDialog startup={dialog.startup} workspaces={workspaceChoices(workspaceItems)} onClose={() => setDialog(null)} /> : null}
    </div>
  )
}


function getRuntimeAttention(id: string): boolean {
  return getRuntime(id)?.attention === true
}
function getRuntimeActivity(id: string): Activity {
  return getRuntime(id)?.activity ?? 'offline'
}
