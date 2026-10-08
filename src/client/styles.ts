// dsh-web-terminal — stylesheet for the Terminals view, injected once.
//
// Colours come from the harness's own `--dsw-*` tokens with literal fallbacks so
// the view follows the active theme. Plugin accents are local `--wt-*` variables.

import { XTERM_CSS } from './xterm.css.ts'

const VIEW_CSS = `
.wt-view { --wt-accent: #4d6bfe; --wt-work: #5b8cff; --wt-wait: #f0b429; --wt-idle: #22c55e; --wt-dead: #ef4444; --wt-urgent: #ff6b3d;
  --wt-line: #333844; --wt-surface: #1b1d23; --wt-deep: #14161b;
  --wt-text: #e8eaed; --wt-dim: #9aa0a6; --wt-hover: #ffffff14; --wt-field: #101216; color-scheme: dark;
  --wt-claude: #d97757; --wt-claude-fg: #1f1410; --wt-agents: #b79cff; --wt-agents-solid: #7c5cf0; --wt-tool: #2dd4bf; --wt-tool-solid: #14b8a6; --wt-tool-fg: #06201d; --wt-warn: #f0b429; --wt-danger: #ff6b6b;
  position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; box-sizing: border-box; width: 100%; height: 100%; overflow: hidden; background: var(--wt-surface); color: var(--wt-text); font-family: var(--ds-font-family-sans, system-ui, sans-serif); }
/* Text colours follow the MEASURED background (data-scheme is set from it), so a theme whose tokens disagree with color-scheme can never give white-on-white. */
.wt-view[data-scheme="light"] { --wt-text: #1f2328; --wt-dim: #5b636c; --wt-hover: #2631480f; --wt-field: #ffffff; --wt-surface: #f6f7f9; --wt-deep: #ffffff; --wt-line: #d0d7de; --wt-agents: #5b32b8; --wt-agents-solid: #6d3fd1; --wt-tool: #0f766e; --wt-tool-solid: #0f766e; --wt-tool-fg: #fff; --wt-warn: #9a6700; --wt-danger: #cf222e; color-scheme: light; }
.wt-view[data-scheme="dark"] { --wt-text: #e8eaed; --wt-dim: #9aa0a6; --wt-hover: #ffffff14; --wt-field: #101216; --wt-surface: #1b1d23; --wt-deep: #14161b; --wt-line: #333844; --wt-agents: #b79cff; --wt-agents-solid: #7c5cf0; --wt-tool: #2dd4bf; --wt-tool-solid: #14b8a6; --wt-tool-fg: #06201d; --wt-warn: #f0b429; --wt-danger: #ff6b6b; color-scheme: dark; }
.wt-view input, .wt-view select, .wt-view button { font-family: inherit; }
.wt-cols { flex: 1; min-height: 0; display: flex; flex-direction: row; }
.wt-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }

/* The page is a main-panel entry: it fills the main area. On macOS the window chrome overlaps the top strip, and entry pages pad their top by the frame's clearance (Windows reserves its caption outside the page). */
[data-platform="darwin"] .wt-page > .wt-bar:first-child { padding-top: var(--dsh-frame-top-clearance, 0px); height: calc(44px + var(--dsh-frame-top-clearance, 0px)); }

/* toolbar */
.wt-bar { flex: none; display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 12px; box-sizing: border-box; border-bottom: 0.5px solid var(--wt-line); position: relative; z-index: 30; background: var(--wt-surface); }
/* Row 1: left and right never change width or wrap; only the middle (chips) flexes and clips. Row 2 (.wt-statsrow) holds the stats bar. */
.wt-bar-left, .wt-bar-right { flex: none; display: flex; align-items: center; gap: 6px; }
.wt-bar-mid { flex: 1 1 0; min-width: 0; overflow: hidden; display: flex; align-items: center; gap: 10px; }
.wt-bar-mid > * { flex: none; }
.wt-statsrow { flex: none; display: flex; align-items: center; height: 26px; padding: 0 12px; box-sizing: border-box; overflow: hidden; border-bottom: 0.5px solid var(--wt-line); background: color-mix(in srgb, var(--wt-text) 4%, var(--wt-surface)); container-type: inline-size; container-name: wtbar; }
.wt-statsrow > .wt-stats { flex: 0 1 auto; min-width: 0; height: 100%; }
.wt-seg { display: inline-flex; align-items: center; }
.wt-seg .wt-btn { border-radius: 0; margin-left: -0.5px; }
.wt-seg .wt-btn:first-child { border-radius: 14px 0 0 14px; margin-left: 0; }
.wt-seg .wt-btn:last-child { border-radius: 0 14px 14px 0; }
.wt-bar2 { flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 12px; border-bottom: 0.5px solid var(--wt-line); position: relative; z-index: 30; background: color-mix(in srgb, var(--wt-accent) 7%, var(--wt-surface)); }
.wt-sep { width: 1px; height: 18px; background: var(--wt-line); margin: 0 4px; }
.wt-grow { flex: 1; }
.wt-btn { height: 28px; padding: 0 11px; border: 0.5px solid var(--wt-line); border-radius: 14px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; transition: background 0.12s, border-color 0.12s; }
.wt-btn:hover:not(:disabled) { background: var(--wt-hover); }
.wt-btn:disabled { opacity: 0.45; cursor: default; }
.wt-btn[data-on="true"] { border-color: var(--wt-accent); color: var(--wt-accent); }
.wt-btn[data-variant="primary"] { background: var(--wt-accent); border-color: transparent; color: #fff; }
.wt-btn[data-variant="primary"]:hover:not(:disabled) { filter: brightness(1.1); background: var(--wt-accent); }
.wt-btn { position: relative; }
.wt-btn-icon { width: 28px; padding: 0; justify-content: center; }
.wt-view .wt-btn.wt-btn-preset { background-color: var(--wt-hover); }
.wt-view .wt-btn.wt-btn-preset:hover:not(:disabled) { background-color: color-mix(in srgb, var(--wt-text) 16%, transparent); }
.wt-view .wt-btn.wt-btn-claude { background-color: var(--wt-claude); border-color: transparent; color: var(--wt-claude-fg); font-weight: 600; }
.wt-view .wt-btn.wt-btn-claude:hover:not(:disabled) { background-color: var(--wt-claude); filter: brightness(1.08); }
.wt-view .wt-btn.wt-btn-tool { border-color: color-mix(in srgb, var(--wt-tool) 55%, transparent); background-color: color-mix(in srgb, var(--wt-tool) 11%, transparent); color: var(--wt-tool); }
.wt-view .wt-btn.wt-btn-tool:hover:not(:disabled) { background-color: color-mix(in srgb, var(--wt-tool) 22%, transparent); }
.wt-view .wt-btn.wt-btn-tool[data-on="true"] { background-color: var(--wt-tool-solid); border-color: var(--wt-tool-solid); color: var(--wt-tool-fg); font-weight: 600; }
.wt-view .wt-btn.wt-btn-agents { border-color: color-mix(in srgb, var(--wt-agents) 60%, transparent); background-color: color-mix(in srgb, var(--wt-agents) 12%, transparent); color: var(--wt-agents); }
.wt-view .wt-btn.wt-btn-agents:hover:not(:disabled) { background-color: color-mix(in srgb, var(--wt-agents) 24%, transparent); }
.wt-view .wt-btn.wt-btn-agents[data-on="true"] { background-color: var(--wt-agents-solid); border-color: var(--wt-agents-solid); color: #fff; font-weight: 600; }
.wt-view .wt-btn.wt-btn-agents[data-on="true"] .wt-btn-count { background: #fff; color: var(--wt-agents-solid); }
.wt-view .wt-btn.wt-btn-danger:hover:not(:disabled) { background-color: color-mix(in srgb, var(--wt-danger) 16%, transparent); border-color: var(--wt-danger); color: var(--wt-danger); }
.wt-view .wt-btn.wt-btn-icon[data-on="true"] { background-color: color-mix(in srgb, var(--wt-text) 14%, transparent); border-color: var(--wt-text); color: var(--wt-text); }
.wt-menu-wrap { position: relative; }
.wt-pop { position: absolute; top: 34px; left: 0; min-width: 240px; padding: 8px; border: 0.5px solid var(--wt-line); border-radius: 12px; background: var(--wt-surface); box-shadow: 0 16px 40px rgba(0,0,0,0.45); z-index: 60; display: flex; flex-direction: column; gap: 6px; }
.wt-pop[data-right="true"] { left: auto; right: 0; }
.wt-pop-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--wt-dim); padding: 2px 4px; }
.wt-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 7px; font-size: 12px; }
.wt-item:hover { background: var(--wt-hover); }
.wt-item .wt-grow { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-link { border: 0; background: transparent; color: var(--wt-accent); font: inherit; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
.wt-link:hover { background: var(--wt-hover); }
.wt-link[data-danger="true"] { color: var(--wt-dead); }
.wt-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--wt-dim); }
.wt-input { height: 28px; padding: 0 9px; box-sizing: border-box; border: 0.5px solid var(--wt-line); border-radius: 8px; background: var(--wt-field); color: var(--wt-text); font: inherit; font-size: 12px; min-width: 0; }
.wt-view .wt-input, .wt-view select.wt-input, .wt-view input.wt-input, .wt-view .wt-name-input { background: var(--wt-field) !important; color: var(--wt-text) !important; -webkit-text-fill-color: var(--wt-text) !important; caret-color: var(--wt-text); }
.wt-view .wt-input:-webkit-autofill { -webkit-text-fill-color: var(--wt-text) !important; box-shadow: 0 0 0 100px var(--wt-field) inset !important; }
.wt-view .wt-input option { background: var(--wt-field) !important; color: var(--wt-text) !important; }
.wt-view .wt-btn { background-color: transparent; }
.wt-view .wt-btn:hover:not(:disabled) { background-color: var(--wt-hover); }
.wt-view .wt-btn[data-variant="primary"], .wt-view .wt-btn[data-variant="primary"]:hover:not(:disabled) { background-color: var(--wt-accent); color: #fff; }
.wt-view .wt-btn[data-on="true"] { color: var(--wt-accent); }
.wt-view .wt-chip, .wt-view .wt-btn, .wt-view .wt-link, .wt-view .wt-folder, .wt-view .wt-item { color: var(--wt-text); }
.wt-view .wt-btn[data-variant="primary"] { color: #fff; }
.wt-view .wt-link { color: var(--wt-accent); }
.wt-view .wt-link[data-danger="true"] { color: var(--wt-dead); }
.wt-view .wt-dialog, .wt-view .wt-pop, .wt-view .wt-find { color: var(--wt-text); }
.wt-input::placeholder { color: var(--wt-dim); opacity: 0.8; }
.wt-input option { background: var(--wt-field); color: var(--wt-text); }
.wt-input:focus { outline: none; border-color: var(--wt-accent); }
.wt-row { display: flex; gap: 6px; align-items: center; }
.wt-dim { font-size: 12px; color: var(--wt-dim); }
.wt-note { font-size: 12px; color: var(--dsw-alias-state-warn-label, #f0b429); }
.wt-chip { height: 24px; padding: 0 10px; border: 0.5px solid var(--wt-line); border-radius: 12px; background: var(--wt-field); color: var(--wt-text); font: inherit; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }

/* canvas + windows */
.wt-canvas { position: relative; z-index: 0; isolation: isolate; flex: 1; min-height: 0; overflow: hidden; background: radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--wt-dim) 18%, transparent) 1px, transparent 0) 0 0 / 22px 22px, var(--wt-surface); }
.wt-stage { position: absolute; inset: 0; bottom: 0; z-index: 0; isolation: isolate; }
.wt-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--wt-dim); font-size: 13px; text-align: center; padding: 0 24px; }
.wt-ghost { position: absolute; border-radius: 12px; background: color-mix(in srgb, var(--wt-accent) 16%, transparent); border: 1.5px solid var(--wt-accent); pointer-events: none; z-index: 2000; transition: all 80ms ease-out; }

.wt-view .wt-btn.wt-btn-overview[data-on="true"] { background-color: color-mix(in srgb, var(--wt-text) 14%, transparent); border-color: var(--wt-text); color: var(--wt-text); }
/* mission control: live windows are CSS-scaled into tiles (never resized); the overlay draws only the frames */
.wt-mission { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
.wt-tile { position: absolute; box-sizing: border-box; border: 1px solid var(--wt-line); border-radius: 10px; cursor: pointer; pointer-events: auto; transition: border-color 0.12s, box-shadow 0.12s; }
.wt-tile:hover { border-color: var(--wt-text); }
.wt-tile[data-sel="true"] { border-color: var(--wt-accent); box-shadow: 0 0 0 2px var(--wt-accent); }
.wt-tile[data-attn="urgent"] { border-color: var(--wt-urgent); }
.wt-tile[data-attn="quiet"] { border-color: var(--wt-wait); }
.wt-tile-head { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; box-sizing: border-box; border-radius: 9px 9px 0 0; background: color-mix(in srgb, var(--wt-surface) 92%, transparent); font-size: 12px; color: var(--wt-text); overflow: hidden; }
.wt-tile-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.wt-tile-cwd { margin-left: auto; color: var(--wt-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 40%; text-align: right; }
.wt-mission-filter, .wt-mission-hint { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); padding: 4px 12px; border-radius: 14px; font-size: 12px; background: var(--wt-field); border: 0.5px solid var(--wt-line); color: var(--wt-text); }
.wt-mission-hint { color: var(--wt-dim); }
@media (prefers-reduced-motion: reduce) { .wt-win, .wt-tile { transition: none !important; } }
.wt-win { position: absolute; display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; border: 1px solid var(--wt-line); border-radius: 12px; background: var(--wt-term-bg, var(--wt-deep)); box-shadow: 0 6px 22px rgba(0,0,0,0.28); transition: box-shadow 0.15s, border-color 0.15s, transform 0.15s ease; }
.wt-win[data-focused="true"] { border-color: var(--wt-accent); box-shadow: 0 0 0 1px var(--wt-accent), 0 14px 40px rgba(0,0,0,0.5); }
.wt-win[data-attn="urgent"] { border-color: var(--wt-urgent); box-shadow: 0 0 0 1px var(--wt-urgent), 0 0 22px color-mix(in srgb, var(--wt-urgent) 45%, transparent); }
.wt-win[data-attn="quiet"] { border-color: var(--wt-wait); box-shadow: 0 0 0 1px var(--wt-wait), 0 0 16px color-mix(in srgb, var(--wt-wait) 28%, transparent); }
.wt-win[data-dragging="true"] { opacity: 0.93; }
.wt-win[data-max="true"] { border-radius: 0; border-width: 0; }
.wt-head { flex: none; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 6px 0 12px; background: color-mix(in srgb, var(--wt-surface) 88%, #000); border-bottom: 0.5px solid var(--wt-line); cursor: grab; user-select: none; touch-action: none; position: relative; }
.wt-win[data-pinned="true"] .wt-head { cursor: default; }
.wt-win[data-dragging="true"] .wt-head { cursor: grabbing; }
.wt-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--wt-dim); }
.wt-dot[data-a="idle"] { background: var(--wt-idle); }
.wt-dot[data-a="working"] { background: var(--wt-work); animation: wt-pulse 1.1s ease-in-out infinite; }
.wt-dot[data-a="needs-you"] { background: var(--wt-urgent); animation: wt-pulse 0.9s ease-in-out infinite; }
.wt-dot[data-a="finished"] { background: var(--wt-wait); }
.wt-dot[data-a="running"] { background: var(--wt-work); }
.wt-dot[data-a="exited"] { background: var(--wt-dead); }
.wt-dot[data-a="offline"] { background: var(--wt-dim); opacity: 0.6; }
@keyframes wt-pulse { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--wt-work) 60%, transparent); } 50% { box-shadow: 0 0 0 5px transparent; } }
.wt-name { font-size: 12.5px; font-weight: 600; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; cursor: text; }
.wt-sub { flex: 1; min-width: 0; font-size: 11px; color: var(--wt-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-badge[data-level="urgent"] { background: var(--wt-urgent); color: #fff; }
.wt-badge { font-size: 10px; font-weight: 600; padding: 1px 7px; border-radius: 9px; background: var(--wt-wait); color: #1b1d23; white-space: nowrap; }
.wt-name-input { width: 150px; height: 22px; font: inherit; font-size: 12px; color: var(--wt-text); background: var(--wt-field); border: 1px solid var(--wt-accent); border-radius: 5px; padding: 0 6px; box-sizing: border-box; }
.wt-hbtn { width: 26px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: transparent; color: var(--wt-dim); font-size: 13px; line-height: 1; cursor: pointer; flex: none; }
.wt-hbtn:hover { background: var(--wt-hover); color: var(--wt-text); }
.wt-hbtn[data-on="true"] { color: var(--wt-accent); }
.wt-hbtn[data-danger="true"]:hover { background: #ef444433; color: #ef4444; }
.wt-body { flex: 1; min-height: 0; padding: 8px; background: var(--wt-term-bg, var(--wt-deep)); }
.wt-holder { width: 100%; height: 100%; }
.wt-holder .xterm { height: 100%; }
.wt-holder .xterm-viewport { background-color: transparent !important; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--wt-dim) 45%, transparent) transparent; }
.wt-holder .xterm-viewport::-webkit-scrollbar { width: 9px; }
.wt-holder .xterm-viewport::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--wt-dim) 40%, transparent); border-radius: 5px; border: 2px solid transparent; background-clip: content-box; }
.wt-grip { position: absolute; z-index: 5; touch-action: none; }
.wt-grip[data-d="n"] { top: -3px; left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
.wt-grip[data-d="s"] { bottom: -3px; left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
.wt-grip[data-d="e"] { right: -3px; top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
.wt-grip[data-d="w"] { left: -3px; top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
.wt-grip[data-d="ne"] { top: -3px; right: -3px; width: 14px; height: 14px; cursor: nesw-resize; }
.wt-grip[data-d="nw"] { top: -3px; left: -3px; width: 14px; height: 14px; cursor: nwse-resize; }
.wt-grip[data-d="se"] { bottom: -3px; right: -3px; width: 14px; height: 14px; cursor: nwse-resize; }
.wt-grip[data-d="sw"] { bottom: -3px; left: -3px; width: 14px; height: 14px; cursor: nesw-resize; }

/* sidebar */
.wt-side { flex: none; width: 262px; display: flex; flex-direction: column; border-left: 0.5px solid var(--wt-line); background: var(--wt-surface); min-height: 0; box-sizing: border-box; }
.wt-side-head { flex: none; display: flex; align-items: center; gap: 6px; padding: 10px 12px 8px; font-size: 12px; font-weight: 600; }
.wt-side-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 8px 8px; display: flex; flex-direction: column; gap: 3px; scrollbar-width: thin; }
.wt-li { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 9px; border: 0.5px solid transparent; cursor: pointer; position: relative; }
.wt-li:hover { background: var(--wt-hover); }
.wt-li[data-focused="true"] { background: color-mix(in srgb, var(--wt-accent) 13%, transparent); border-color: color-mix(in srgb, var(--wt-accent) 45%, transparent); }
.wt-li[data-attn="true"] .wt-li-name { color: var(--wt-wait); }
.wt-li[data-over="true"] { box-shadow: 0 -2px 0 var(--wt-accent); }
.wt-li-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.wt-li-name { font-size: 12.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-li-sub { font-size: 11px; color: var(--wt-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-send-item { width: 100%; text-align: left; border: 0; background: transparent; font: inherit; cursor: pointer; }
.wt-send-item[data-active="true"] { background: var(--wt-hover); }
.wt-unread { flex: none; font-size: 10px; line-height: 1; padding: 2px 5px; border-radius: 8px; color: var(--wt-accent); background: color-mix(in srgb, var(--wt-accent) 14%, transparent); font-variant-numeric: tabular-nums; }
.wt-unread::before { content: ''; display: inline-block; width: 5px; height: 5px; margin-right: 4px; border-radius: 50%; background: currentColor; vertical-align: middle; }
.wt-unread-line { box-sizing: border-box; display: flex; align-items: center; justify-content: center; font-size: 10.5px; line-height: 1; letter-spacing: 0.02em; color: var(--wt-dim); background: color-mix(in srgb, var(--wt-accent) 10%, var(--wt-term-bg, var(--wt-deep))); border-top: 1px solid color-mix(in srgb, var(--wt-accent) 40%, transparent); pointer-events: none; overflow: hidden; white-space: nowrap; }
.wt-unread-pill { position: absolute; right: 18px; bottom: 14px; z-index: 5; height: 24px; padding: 0 10px; border: 0.5px solid color-mix(in srgb, var(--wt-accent) 55%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--wt-accent) 18%, var(--wt-surface)); color: var(--wt-text); font: inherit; font-size: 11.5px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
.wt-unread-pill:hover { background: color-mix(in srgb, var(--wt-accent) 32%, var(--wt-surface)); }
.wt-li-acts { display: none; gap: 2px; }
.wt-li:hover .wt-li-acts { display: inline-flex; }
.wt-side-empty { padding: 14px 12px; font-size: 12px; color: var(--wt-dim); }
.wt-agents { flex: none; width: 280px; display: flex; flex-direction: column; border-left: 0.5px solid var(--wt-line); background: var(--wt-surface); min-height: 0; box-sizing: border-box; }
.wt-agents-group { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
.wt-agents-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 8px; border: 0; border-radius: 7px; background: transparent; color: var(--wt-text); font: inherit; cursor: pointer; text-align: left; min-width: 0; }
.wt-agents-head:hover { background: var(--wt-hover); }
.wt-agents-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 9px; }
.wt-agents-row[data-running="false"] { opacity: 0.55; }
.wt-agents-type { flex: none; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; padding: 1px 7px; border-radius: 9px; border: 0.5px solid var(--wt-line); color: var(--wt-dim); }
.wt-btn-count { position: absolute; top: -6px; right: -4px; min-width: 16px; height: 16px; box-sizing: border-box; padding: 0 4px; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; line-height: 1; border-radius: 8px; background: var(--wt-agents-solid); color: #fff; font-variant-numeric: tabular-nums; }
.wt-state { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--wt-dim); }

/* find bar */
.wt-find { position: absolute; top: 40px; right: 14px; z-index: 40; display: flex; align-items: center; gap: 4px; padding: 5px 6px; border: 0.5px solid var(--wt-line); border-radius: 10px; background: var(--wt-surface); color: var(--wt-text); box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
.wt-find .wt-input { width: 190px; height: 24px; }
.wt-find .wt-input[data-bad="true"] { border-color: var(--wt-dead); }
.wt-find-count { font-size: 11px; color: var(--wt-dim); min-width: 58px; text-align: center; white-space: nowrap; }
.wt-find .wt-hbtn { width: 24px; height: 22px; }

/* dialog */
.wt-scrim { position: absolute; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.45); }
.wt-dialog { width: min(520px, calc(100% - 32px)); max-height: calc(100% - 32px); overflow: auto; padding: 16px; border: 0.5px solid var(--wt-line); border-radius: 14px; background: var(--wt-surface); box-shadow: 0 24px 60px rgba(0,0,0,0.5); display: flex; flex-direction: column; gap: 12px; }
.wt-dialog h3 { margin: 0; font-size: 14px; font-weight: 600; }
.wt-folders { display: flex; flex-direction: column; gap: 1px; max-height: 150px; overflow-y: auto; border: 0.5px solid var(--wt-line); border-radius: 8px; padding: 3px; background: var(--wt-field); color: var(--wt-text); }
.wt-folder { display: flex; align-items: center; gap: 6px; padding: 4px 7px; border-radius: 6px; font-size: 12px; cursor: pointer; }
.wt-folder:hover { background: var(--wt-hover); }
.wt-folder span.wt-grow { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.wt-star { border: 0; background: transparent; cursor: pointer; font-size: 13px; color: var(--wt-dim); padding: 0 3px; }
.wt-star[data-on="true"] { color: var(--wt-wait); }

/* header stats bar: lives in the harness chat header, outside .wt-view, so it carries its own variables. */
.wt-stats { --wt-warn: #f0b429; --wt-danger: #ff6b6b; --wt-work: #5b8cff; --wt-wait: #f0b429; --wt-idle: #22c55e; --wt-dead: #ef4444; --wt-urgent: #ff6b3d; --wt-dim: var(--dsw-alias-label-tertiary, #9aa0a6);
  display: inline-flex; align-items: center; gap: 12px; height: 28px; flex: none; white-space: nowrap; overflow: hidden; font-size: 12px; line-height: 1; font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--dsw-alias-label-secondary, var(--wt-dim)); }
.wt-stats-group { display: inline-flex; align-items: center; gap: 10px; }
.wt-stats-group[data-stale="true"] { opacity: 0.55; }
.wt-stats-item { display: inline-flex; align-items: center; gap: 5px; }
.wt-stats .wt-dot { width: 7px; height: 7px; display: inline-block; }
/* In the page toolbar the bar sits on the plugin's measured surface, not the harness tokens. */
.wt-view .wt-stats { color: color-mix(in srgb, var(--wt-text) 75%, transparent); }
.wt-stats-warn { color: var(--wt-warn); }
/* Tabular digits (monospace) keep a changing percentage from jittering; the field is only as wide as its text. */
.wt-pct { display: inline-block; }
.wt-pct-warn { color: var(--wt-warn); font-weight: 600; }
.wt-pct-danger { color: var(--wt-danger); font-weight: 600; }
.wt-stats-group, .wt-stats-item { flex: none; }
/* The header bar sits outside .wt-view: pick the pair from the inherited color-scheme when the browser can. */
@supports (color: light-dark(#000, #fff)) {
  .wt-stats { --wt-warn: light-dark(#9a6700, #f0b429); --wt-danger: light-dark(#cf222e, #ff6b6b); }
}
.wt-view .wt-stats { --wt-warn: inherit; --wt-danger: inherit; }
/* Narrow toolbar: drop the lowest-priority parts instead of pushing buttons (tokens, then cost, then 7d). */
@container wtbar (max-width: 560px) { .wt-stats-item[data-p="tokens"] { display: none; } }
@container wtbar (max-width: 460px) { .wt-stats-item[data-p="cost"] { display: none; } }
@container wtbar (max-width: 360px) { .wt-stats-item[data-p="seven"] { display: none; } }
`

let injected = false

/** Inject the view and xterm stylesheets exactly once per page load. */
export function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  for (const [attr, css] of [
    ['data-dsh-web-terminal-view', VIEW_CSS],
    ['data-dsh-web-terminal-xterm', XTERM_CSS],
  ] as const) {
    const existing = document.querySelector(`style[${attr}]`)
    if (existing !== null) {
      existing.textContent = css
      continue
    }
    const tag = document.createElement('style')
    tag.setAttribute(attr, '')
    tag.textContent = css
    document.head.appendChild(tag)
  }
}
