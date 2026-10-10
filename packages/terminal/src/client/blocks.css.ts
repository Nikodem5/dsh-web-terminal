// dsh-web-terminal — styles for command blocks (the gutter bar in the terminal's left padding).

/**
 * xterm positions a decoration over its cell and the render hook only adds the class, so the bar is moved
 * into the 8px padding of .wt-body (left of column 0) and the text area keeps its full width.
 */
export const BLOCKS_CSS = `
.xterm-screen .xterm-decoration-container .xterm-decoration.wt-gutter { left: -7px !important; width: 3px !important; border-radius: 2px; pointer-events: none; opacity: 0.85; background: var(--wt-dim); }
.xterm-decoration.wt-gutter[data-state="ok"], .wt-gutter-swatch[data-state="ok"] { background: var(--wt-idle); opacity: 0.55; }
.xterm-decoration.wt-gutter[data-state="fail"], .wt-gutter-swatch[data-state="fail"] { background: var(--wt-dead); opacity: 0.9; }
.xterm-decoration.wt-gutter[data-state="unk"], .wt-gutter-swatch[data-state="unk"] { background: var(--wt-dim); opacity: 0.35; }
.xterm-decoration.wt-gutter[data-state="run"], .wt-gutter-swatch[data-state="run"] { background: var(--wt-accent); animation: wt-gutter-pulse 1.4s ease-in-out infinite; }
/* The help legend draws the same bar with the same colour rules (above), so the two cannot drift. */
.wt-gutter-swatch { display: inline-block; width: 3px; height: 16px; border-radius: 2px; flex: none; }
@keyframes wt-gutter-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .xterm-decoration.wt-gutter[data-state="run"], .wt-gutter-swatch[data-state="run"] { animation: none; opacity: 0.8; } }

/* Phase 2 overlays live inside the holder (block-bar.ts): the hover header, the sticky bar and the strip that makes the gutter hoverable. */
.wt-holder { position: relative; }
.wt-bzone { position: absolute; left: -8px; top: 0; bottom: 0; width: 8px; }
.wt-bh[hidden], .wt-bsticky[hidden] { display: none; }
.wt-bh { position: absolute; right: 16px; z-index: 6; display: flex; align-items: center; gap: 7px; max-width: min(78%, 640px); height: 22px; padding: 0 3px 0 10px; box-sizing: border-box; border: 0.5px solid var(--wt-line); border-radius: 11px; background: color-mix(in srgb, var(--wt-text) 8%, var(--wt-surface)); color: var(--wt-text); font: 11.5px/1 var(--ds-font-family-sans, system-ui, sans-serif); box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
.wt-bh-cmd { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--ds-font-family-mono, ui-monospace, monospace); }
.wt-bh-exit, .wt-bh-dur, .wt-bh-time { flex: none; color: var(--wt-dim); white-space: nowrap; }
.wt-bh[data-state="ok"] .wt-bh-exit { color: var(--wt-idle); }
.wt-bh[data-state="fail"] .wt-bh-exit { color: var(--wt-dead); font-weight: 600; }
.wt-bh[data-state="run"] .wt-bh-exit { color: var(--wt-accent); }
.wt-bh-btn { flex: none; width: 20px; height: 18px; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--wt-text); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.wt-bh-btn:hover:not(:disabled) { background: var(--wt-hover); }
.wt-bh-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.wt-bsticky { position: absolute; left: 0; right: 14px; top: 0; z-index: 5; display: flex; align-items: center; gap: 8px; height: 22px; padding: 0 8px; box-sizing: border-box; border-bottom: 0.5px solid var(--wt-line); background: color-mix(in srgb, var(--wt-text) 9%, var(--wt-surface)); color: var(--wt-text); font: 11.5px/1 var(--ds-font-family-sans, system-ui, sans-serif); cursor: pointer; }
.wt-bsticky:hover { background: color-mix(in srgb, var(--wt-text) 14%, var(--wt-surface)); }
.wt-bsticky-cmd { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--ds-font-family-mono, ui-monospace, monospace); }
.wt-bsticky-exit, .wt-bsticky-dur { flex: none; color: var(--wt-dim); }
.wt-bsticky[data-state="ok"] .wt-bsticky-exit { color: var(--wt-idle); }
.wt-bsticky[data-state="fail"] .wt-bsticky-exit { color: var(--wt-dead); font-weight: 600; }
.wt-bsticky[data-state="run"] .wt-bsticky-exit { color: var(--wt-accent); }
/* The row a jump landed on fades out (the decoration is removed after a second). */
.xterm-decoration.wt-flash { background: color-mix(in srgb, var(--wt-accent) 38%, transparent); animation: wt-flash-fade 1s ease-out forwards; pointer-events: none; }
@keyframes wt-flash-fade { from { opacity: 1; } to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .xterm-decoration.wt-flash { animation: none; } }
`
