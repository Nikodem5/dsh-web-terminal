// dsh-web-terminal — Overseer panel styles (injected once, like styles.ts).

const OVERSEER_CSS = `
.wt-view { --wt-overseer: #38bdf8; --wt-overseer-solid: #0284c7; }
.wt-view[data-scheme="light"] { --wt-overseer: #0369a1; --wt-overseer-solid: #0369a1; }
.wt-view .wt-btn.wt-btn-overseer { position: relative; border-color: color-mix(in srgb, var(--wt-overseer) 60%, transparent); background-color: color-mix(in srgb, var(--wt-overseer) 12%, transparent); color: var(--wt-overseer); }
.wt-view .wt-btn.wt-btn-overseer:hover:not(:disabled) { background-color: color-mix(in srgb, var(--wt-overseer) 24%, transparent); }
.wt-view .wt-btn.wt-btn-overseer[data-on="true"] { background-color: var(--wt-overseer-solid); border-color: var(--wt-overseer-solid); color: #fff; font-weight: 600; }
.wt-view .wt-btn.wt-btn-overseer .wt-btn-count { background: var(--wt-overseer-solid); }
.wt-overseer { flex: none; width: 360px; max-width: 45vw; display: flex; flex-direction: column; border-left: 0.5px solid var(--wt-line); background: var(--wt-surface); min-height: 0; box-sizing: border-box; color: var(--wt-text); }
.wt-overseer .wt-side-head .wt-link { font-size: 12px; }
.wt-ov-picker { flex: none; display: flex; flex-wrap: wrap; gap: 4px; padding: 0 10px 8px; max-height: 120px; overflow-y: auto; scrollbar-width: thin; border-bottom: 0.5px solid var(--wt-line); }
.wt-ov-pick { display: inline-flex; align-items: center; border: 0.5px solid var(--wt-line); border-radius: 10px; overflow: hidden; max-width: 100%; }
.wt-ov-pick[data-hidden="true"] { opacity: 0.55; }
.wt-ov-pick .wt-ov-chip { border: 0; border-radius: 0; }
.wt-ov-chip { font: inherit; font-size: 11px; padding: 2px 8px; border: 0.5px solid var(--wt-line); border-radius: 10px; background: transparent; color: var(--wt-text); cursor: pointer; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-ov-chip:hover:not(:disabled) { background: var(--wt-hover); }
.wt-ov-chip[data-on="true"] { background: color-mix(in srgb, var(--wt-overseer) 22%, transparent); color: var(--wt-text); font-weight: 600; }
.wt-ov-chip:disabled { cursor: default; text-decoration: line-through; }
.wt-ov-eye { font: inherit; font-size: 11px; padding: 2px 6px; border: 0; border-left: 0.5px solid var(--wt-line); background: transparent; color: var(--wt-dim); cursor: pointer; }
.wt-ov-eye:hover { background: var(--wt-hover); color: var(--wt-text); }
.wt-ov-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 12px; scrollbar-width: thin; font-size: 13px; line-height: 1.45; }
.wt-ov-notice { font-size: 12px; padding: 10px; border-radius: 8px; border: 0.5px solid color-mix(in srgb, var(--wt-warn) 60%, transparent); background: color-mix(in srgb, var(--wt-warn) 10%, transparent); display: flex; flex-direction: column; gap: 8px; }
.wt-ov-turn { display: flex; flex-direction: column; gap: 6px; }
.wt-ov-q { align-self: flex-end; max-width: 90%; padding: 6px 10px; border-radius: 10px; background: color-mix(in srgb, var(--wt-overseer) 16%, transparent); white-space: pre-wrap; overflow-wrap: anywhere; }
.wt-ov-answer { overflow-wrap: anywhere; }
.wt-ov-answer p { margin: 0 0 6px; }
.wt-ov-answer ul, .wt-ov-answer ol { margin: 0 0 6px; padding-left: 18px; }
.wt-ov-answer code { font-family: var(--wt-mono, ui-monospace, Consolas, monospace); font-size: 12px; padding: 0 3px; border-radius: 4px; background: var(--wt-hover); }
.wt-ov-pre { margin: 0 0 6px; padding: 6px 8px; border-radius: 6px; background: var(--wt-deep); font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.wt-ov-h { font-weight: 600; margin: 4px 0; }
.wt-ov-cite { font: inherit; font-size: 11px; font-weight: 600; padding: 0 5px; margin: 0 1px; border-radius: 6px; border: 0.5px solid var(--wt-overseer); background: color-mix(in srgb, var(--wt-overseer) 14%, transparent); color: var(--wt-overseer); cursor: pointer; vertical-align: baseline; }
.wt-ov-cite:hover { background: color-mix(in srgb, var(--wt-overseer) 28%, transparent); }
.wt-ov-note { font-size: 11px; color: var(--wt-dim); }
.wt-ov-meta { font-size: 10px; color: var(--wt-dim); }
.wt-ov-error { font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 0.5px solid color-mix(in srgb, var(--wt-danger) 60%, transparent); background: color-mix(in srgb, var(--wt-danger) 10%, transparent); }
.wt-ov-input { flex: none; display: flex; gap: 6px; align-items: flex-end; padding: 8px 10px 10px; border-top: 0.5px solid var(--wt-line); }
.wt-ov-input textarea { flex: 1; resize: vertical; min-height: 38px; max-height: 160px; font: inherit; font-size: 13px; }
`

let injected = false

/** Add the Overseer styles to the page once. */
export function ensureOverseerStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const attr = 'data-dsh-web-terminal-overseer'
  const existing = document.querySelector(`style[${attr}]`)
  if (existing !== null) {
    existing.textContent = OVERSEER_CSS
    return
  }
  const tag = document.createElement('style')
  tag.setAttribute(attr, '')
  tag.textContent = OVERSEER_CSS
  document.head.appendChild(tag)
}
