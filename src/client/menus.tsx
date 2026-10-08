// dsh-web-terminal — toolbar popovers: saved layouts and terminal settings
// (font, notifications).

import { useState } from 'react'
import type { ReactElement } from 'react'
import { requestCloseAll } from './actions.ts'
import { setPathTarget, setPathTemplate } from './path-links.ts'
import type { PathTarget } from './types.ts'
import { DEFAULT_FONT, deleteLayout, getPrefs, getWins, loadLayout, saveLayout, setAutoFont, setFitCols, setFont, setHungMinutes, setNotify, setSound, setTermTheme } from './terminal-store.ts'

const FONT_CHOICES = [
  { label: 'Recommended (Cascadia Mono, Consolas…)', value: DEFAULT_FONT.family },
  { label: 'Cascadia Code', value: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace" },
  { label: 'Consolas', value: "Consolas, 'Courier New', monospace" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono', Consolas, monospace" },
  { label: 'Fira Code', value: "'Fira Code', Consolas, monospace" },
  { label: 'Courier New', value: "'Courier New', monospace" },
]

const BOLD_LABELS: Record<number, string> = { 400: 'Regular (400)', 500: 'Medium (500)', 600: 'Semi-bold (600)', 700: 'Bold (700)', 800: 'Extra bold (800)' }
const CONTRAST_LABELS: Record<number, string> = { 1: 'Off (1:1)', 4.5: 'Normal (4.5:1)', 7: 'High (7:1)' }

/** Saved layouts: save the current windows, open (replace) or add a layout, delete. */
export function LayoutsMenu(): ReactElement {
  const prefs = getPrefs()
  const [name, setName] = useState('')
  const wins = getWins()
  const save = () => {
    saveLayout(name)
    setName('')
  }
  return (
    <div className="wt-pop" onPointerDown={(e) => e.stopPropagation()}>
      <div className="wt-pop-title">Saved layouts</div>
      {prefs.layouts.length === 0 ? (
        <div className="wt-item" style={{ color: 'var(--wt-dim)' }}>None yet.</div>
      ) : null}
      {prefs.layouts.map((l) => (
        <div key={l.name} className="wt-item" title={`${l.wins.length} terminal${l.wins.length === 1 ? '' : 's'}`}>
          <span className="wt-grow">
            {l.name} <span className="wt-state">{l.wins.length}</span>
          </span>
          <button
            type="button"
            className="wt-link"
            title="Close the open terminals and open this layout"
            onClick={() => {
              if (wins.length === 0 || requestCloseAll()) loadLayout(l.name)
            }}
          >
            Open
          </button>
          <button type="button" className="wt-link" title="Add this layout alongside the open terminals" onClick={() => loadLayout(l.name)}>Add</button>
          <button type="button" className="wt-link" data-danger="true" title="Delete" onClick={() => deleteLayout(l.name)}>✕</button>
        </div>
      ))}
      <div className="wt-pop-title">Save current</div>
      <div className="wt-row">
        <input
          className="wt-input wt-grow"
          value={name}
          placeholder="Layout name"
          disabled={wins.length === 0}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
        />
        <button type="button" className="wt-btn" disabled={wins.length === 0 || name.trim().length === 0} onClick={save}>Save</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--wt-dim)' }}>
        Saves each window's name, folder, shell, startup command, position and pin. The same name overwrites.
      </div>
    </div>
  )
}

/** Font family / size / line height for every terminal, plus the notification toggle. */
export function SettingsMenu(): ReactElement {
  const prefs = getPrefs()
  const font = prefs.font
  const preset = FONT_CHOICES.find((c) => c.value === font.family)
  return (
    <div className="wt-pop" data-right="true" style={{ width: 300 }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="wt-pop-title">Terminal colours</div>
      <label className="wt-field">
        Theme (agents like Claude Code assume a dark background)
        <select className="wt-input" value={prefs.termTheme} onChange={(e) => setTermTheme(e.target.value as 'dark' | 'light' | 'auto')}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="auto">Follow the app</option>
        </select>
      </label>
      <div className="wt-pop-title">Terminal font</div>
      <label className="wt-field">
        Preset
        <select
          className="wt-input"
          value={preset?.value ?? ''}
          onChange={(e) => {
            if (e.target.value !== '') setFont({ family: e.target.value })
          }}
        >
          <option value="">Custom…</option>
          {FONT_CHOICES.map((c) => (
            <option key={c.label} value={c.value}>{c.label}</option>
          ))}
        </select>
      </label>
      <label className="wt-field">
        Font family (any installed font, CSS list)
        <input
          className="wt-input"
          defaultValue={font.family}
          key={font.family}
          onBlur={(e) => setFont({ family: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
      </label>
      <div className="wt-row">
        <label className="wt-field wt-grow">
          Size
          <input className="wt-input" type="number" min={8} max={32} step={1} value={font.size} onChange={(e) => setFont({ size: Number(e.target.value) })} />
        </label>
        <label className="wt-field wt-grow">
          Line height
          <input className="wt-input" type="number" min={1} max={2} step={0.05} value={font.lineHeight} onChange={(e) => setFont({ lineHeight: Number(e.target.value) })} />
        </label>
      </div>
      {/* ── readability: spacing, bold weight, contrast ── */}
      <div className="wt-row">
        <label className="wt-field wt-grow">
          Letter spacing (px)
          <input className="wt-input" type="number" min={0} max={2} step={1} value={font.letterSpacing} onChange={(e) => setFont({ letterSpacing: Number(e.target.value) })} />
        </label>
        <label className="wt-field wt-grow">
          Bold weight
          <select className="wt-input" value={font.boldWeight} onChange={(e) => setFont({ boldWeight: Number(e.target.value) })}>
            {[400, 500, 600, 700, 800].map((w) => (
              <option key={w} value={w}>{BOLD_LABELS[w]}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="wt-field" title="Text whose colour is too close to the background is lifted to at least this contrast ratio. Dim (faint) text gets half of it.">
        Contrast
        <select className="wt-input" value={font.minContrast} onChange={(e) => setFont({ minContrast: Number(e.target.value) })}>
          {[1, 4.5, 7].map((c) => (
            <option key={c} value={c}>{CONTRAST_LABELS[c]}</option>
          ))}
          {CONTRAST_LABELS[font.minContrast] === undefined ? <option value={font.minContrast}>{`Custom (${font.minContrast}:1)`}</option> : null}
        </select>
      </label>
      {/* ── end readability ── */}
      <label className="wt-item" style={{ cursor: 'pointer' }} title="In narrow windows the font shrinks just enough to keep this many columns visible; it never grows past the size above.">
        <input type="checkbox" checked={prefs.autoFont} onChange={(e) => setAutoFont(e.target.checked)} />
        <span className="wt-grow">Shrink font to fit window</span>
      </label>
      <label className="wt-field">
        Columns to keep visible
        <input className="wt-input" type="number" min={40} max={240} step={5} disabled={!prefs.autoFont} value={prefs.fitCols} onChange={(e) => setFitCols(Number(e.target.value))} />
      </label>
      <button type="button" className="wt-btn" onClick={() => setFont({ ...DEFAULT_FONT })}>Reset font</button>
      <div className="wt-pop-title">Notifications</div>
      <label className="wt-item" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={prefs.notify} onChange={(e) => setNotify(e.target.checked)} />
        <span className="wt-grow">Desktop notification when an agent needs me or finishes while I am elsewhere</span>
      </label>
      <label className="wt-item" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={prefs.sound} onChange={(e) => setSound(e.target.checked)} />
        <span className="wt-grow">Play a chime when an agent needs me</span>
      </label>
      <label className="wt-field">
        Flag a working agent as stuck after (minutes, 0 = never)
        <input className="wt-input" type="number" min={0} max={240} step={1} value={prefs.hungMinutes} onChange={(e) => setHungMinutes(Number(e.target.value))} />
      </label>
      <PathLinksSettings />
    </div>
  )
}

// ── clickable file paths (setting block) ──

const PATH_TARGETS: Array<{ value: PathTarget; label: string }> = [
  { value: 'vscode', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'default', label: 'OS default app' },
  { value: 'custom', label: 'Custom command' },
]

/** Where a Ctrl+clicked file path in the terminal opens. */
function PathLinksSettings(): ReactElement {
  const prefs = getPrefs()
  return (
    <>
      <div className="wt-pop-title">Clickable file paths</div>
      <label className="wt-field" title="Ctrl+click (Cmd+click on macOS) a file path in the output to open it">
        Open with
        <select className="wt-input" value={prefs.pathTarget} onChange={(e) => setPathTarget(e.target.value as PathTarget)}>
          {PATH_TARGETS.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </label>
      {prefs.pathTarget === 'custom' ? (
        <label className="wt-field" title="Placeholders: {file} {line} {col} {dir}. A missing {line}/{col} after a colon is dropped with the colon, elsewhere it becomes 1.">
          Command ({'{file} {line} {col} {dir}'})
          <input
            className="wt-input"
            defaultValue={prefs.pathTemplate}
            placeholder="myeditor {file}:{line}:{col}"
            onBlur={(e) => setPathTemplate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </label>
      ) : null}
    </>
  )
}
