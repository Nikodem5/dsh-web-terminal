// dsh-code-editor - stylesheet for the Code page, injected once. Colours are local --ce-* tokens that follow
// the MEASURED app scheme (data-scheme), so a theme whose tokens disagree with color-scheme cannot give white-on-white.

export const VIEW_CSS = `
.ce-view { --ce-accent: #4d6bfe; --ce-warn: #f0b429; --ce-danger: #ff6b6b; --ce-ok: #3fd68f;
  --ce-line: #333844; --ce-surface: #1b1d23; --ce-deep: #14161b; --ce-text: #e8eaed; --ce-dim: #9aa0a6; --ce-hover: #ffffff14; --ce-sel: #4d6bfe33; --ce-field: #101216; color-scheme: dark;
  position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; box-sizing: border-box; width: 100%; height: 100%; overflow: hidden;
  background: var(--ce-surface); color: var(--ce-text); font-family: var(--ds-font-family-sans, system-ui, sans-serif); font-size: 13px; line-height: 1.35; }
.ce-view[data-scheme="light"] { --ce-line: #d0d7de; --ce-surface: #f6f7f9; --ce-deep: #ffffff; --ce-text: #1f2328; --ce-dim: #5b636c; --ce-hover: #2631480f; --ce-sel: #4d6bfe22; --ce-field: #ffffff; --ce-warn: #9a6700; --ce-danger: #cf222e; --ce-ok: #1a7f37; color-scheme: light; }
.ce-view *, .ce-view *::before, .ce-view *::after { box-sizing: border-box; }
.ce-view button, .ce-view input, .ce-view select { font: inherit; color: inherit; }
.ce-cols { flex: 1; min-height: 0; display: flex; }
[data-platform="darwin"] .ce-view > .ce-cols { padding-top: var(--dsh-frame-top-clearance, 0px); }

/* sidebar */
.ce-side { flex: none; width: 280px; min-width: 0; display: flex; flex-direction: column; background: var(--ce-surface); min-height: 0; overflow: hidden; }
.ce-secs { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ce-split { flex: none; position: relative; z-index: 3; background: transparent; outline: none; }
.ce-split-v { width: 5px; margin: 0 -2px 0 -3px; cursor: col-resize; border-right: 0.5px solid var(--ce-line); }
.ce-split-h { height: 5px; margin: -2px 0 -3px 0; cursor: row-resize; }
.ce-split:hover, .ce-split[data-drag="true"], .ce-split:focus-visible { background: var(--ce-accent); }
.ce-split-v:hover, .ce-split-v[data-drag="true"], .ce-split-v:focus-visible { border-right-color: transparent; }
.ce-roots { flex: none; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; border-bottom: 0.5px solid var(--ce-line); }
.ce-roots-row { display: flex; gap: 6px; }
.ce-select, .ce-input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border: 0.5px solid var(--ce-line); border-radius: 6px; background: var(--ce-field); outline: none; }
.ce-select:focus, .ce-input:focus { border-color: var(--ce-accent); }
.ce-btn { height: 26px; padding: 0 10px; border: 0.5px solid var(--ce-line); border-radius: 6px; background: transparent; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.ce-btn:hover:not(:disabled) { background: var(--ce-hover); }
.ce-btn:disabled { opacity: 0.45; cursor: default; }
.ce-btn[data-primary="true"] { background: var(--ce-accent); border-color: transparent; color: #fff; }
.ce-btn[data-primary="true"]:hover:not(:disabled) { filter: brightness(1.1); background: var(--ce-accent); }
.ce-btn[data-danger="true"] { color: var(--ce-danger); }
.ce-sec { display: flex; flex-direction: column; min-height: 0; border-top: 0.5px solid var(--ce-line); overflow: hidden; }
.ce-sec-h { flex: none; display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; cursor: pointer; user-select: none; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: var(--ce-dim); }
.ce-sec-h:hover { background: var(--ce-hover); }
.ce-sec-h .ce-grow { flex: 1; }
.ce-chev { width: 14px; height: 14px; flex: none; display: inline-flex; align-items: center; justify-content: center; transition: transform 0.1s; }
.ce-chev[data-open="true"] { transform: rotate(90deg); }
.ce-count { background: var(--ce-accent); color: #fff; border-radius: 8px; padding: 0 6px; font-size: 10.5px; line-height: 15px; }
.ce-body { flex: 1; min-height: 0; overflow: auto; padding-bottom: 4px; }
.ce-ibtn { width: 20px; height: 20px; padding: 0; border: none; background: transparent; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; color: var(--ce-dim); font-size: 13px; line-height: 1; }
.ce-ibtn:hover { background: var(--ce-hover); color: var(--ce-text); }
.ce-ibtn[data-danger="true"]:hover { color: var(--ce-danger); }

/* tree + changes rows */
.ce-row { display: flex; align-items: center; gap: 6px; height: 24px; padding-right: 6px; cursor: pointer; white-space: nowrap; user-select: none; }
.ce-row:hover { background: var(--ce-hover); }
.ce-row[data-active="true"] { background: var(--ce-sel); }
.ce-row .ce-name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ce-row .ce-dim { color: var(--ce-dim); overflow: hidden; text-overflow: ellipsis; margin-left: 4px; font-size: 12px; min-width: 0; }
.ce-row .ce-acts { display: none; margin-left: auto; flex: none; }
.ce-row:hover .ce-acts { display: inline-flex; }
.ce-row .ce-badge { margin-left: auto; width: 14px; text-align: center; font-size: 11px; font-weight: 700; flex: none; }
.ce-row:hover .ce-badge { display: none; }
.ce-badge[data-k="M"], .ce-badge[data-k="R"] { color: var(--ce-warn); }
.ce-badge[data-k="A"], .ce-badge[data-k="U"] { color: var(--ce-ok); }
.ce-badge[data-k="D"], .ce-badge[data-k="!"] { color: var(--ce-danger); }
.ce-ficon { width: 16px; height: 16px; flex: none; color: var(--ce-dim); }
.ce-folder { color: #c09553; }
.ce-note { padding: 4px 12px; color: var(--ce-dim); font-size: 12px; }
.ce-note[data-error="true"] { color: var(--ce-danger); }
.ce-grp { display: flex; align-items: center; gap: 2px; height: 24px; padding: 0 6px 0 10px; color: var(--ce-dim); font-size: 11px; font-weight: 600; }
.ce-grp .ce-grow { flex: 1; }

/* search entry + repositories */
.ce-search { display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 8px; border: 0.5px solid var(--ce-line); border-radius: 6px; background: var(--ce-field); color: var(--ce-dim); cursor: pointer; text-align: left; }
.ce-search:hover { border-color: var(--ce-accent); color: var(--ce-text); }
.ce-search span { flex: 1; }
.ce-search kbd { font-family: inherit; font-size: 11px; border: 0.5px solid var(--ce-line); border-radius: 4px; padding: 0 5px; }
.ce-repo-h { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px 0 6px; cursor: pointer; user-select: none; font-weight: 600; }
.ce-repo-h:hover { background: var(--ce-hover); }
.ce-repo-h .ce-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ce-repo-h .ce-dim { color: var(--ce-dim); font-weight: 400; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ce-repo-h .ce-grow { flex: 1; }
.ce-repo-h .ce-branch { color: var(--ce-dim); font-weight: 400; font-size: 11.5px; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ce-repo-body { padding-left: 8px; border-left: 0.5px solid var(--ce-line); margin-left: 12px; }

/* main */
.ce-main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--ce-deep); }
.ce-tabs { flex: none; display: flex; overflow-x: auto; overflow-y: hidden; background: var(--ce-surface); border-bottom: 0.5px solid var(--ce-line); min-height: 35px; scrollbar-width: thin; }
.ce-tab { flex: none; display: flex; align-items: center; gap: 6px; max-width: 240px; height: 35px; padding: 0 8px 0 12px; border-right: 0.5px solid var(--ce-line); cursor: pointer; user-select: none; color: var(--ce-dim); }
.ce-tab:hover { background: var(--ce-hover); }
.ce-tab[data-active="true"] { background: var(--ce-deep); color: var(--ce-text); box-shadow: inset 0 -2px 0 var(--ce-accent); }
.ce-tab .ce-ttl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ce-tab[data-kind="diff"] .ce-ttl, .ce-tab[data-kind="compare"] .ce-ttl { font-style: italic; }
.ce-tab .ce-x { width: 18px; height: 18px; flex: none; border: none; background: transparent; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; color: inherit; padding: 0; }
.ce-tab .ce-x:hover { background: var(--ce-hover); }
.ce-agent { flex: none; font-size: 10.5px; line-height: 1; color: var(--ce-warn); cursor: default; }
.ce-agent-dir { flex: none; width: 5px; height: 5px; margin-left: 2px; border-radius: 50%; background: var(--ce-warn); opacity: 0.45; }
.ce-tab .ce-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ce-text); opacity: 0.8; }
.ce-tab[data-conflict="true"] .ce-dot { background: var(--ce-warn); }
.ce-crumb { flex: none; display: flex; align-items: center; gap: 6px; min-height: 26px; padding: 2px 10px; color: var(--ce-dim); border-bottom: 0.5px solid var(--ce-line); overflow: hidden; }
.ce-crumb .ce-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.ce-crumb .ce-path > span { direction: ltr; unicode-bidi: plaintext; }
.ce-crumb .ce-path b { color: var(--ce-text); font-weight: 600; }
.ce-seg { display: inline-flex; }
.ce-seg .ce-btn { border-radius: 0; margin-left: -0.5px; height: 22px; }
.ce-seg .ce-btn:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
.ce-seg .ce-btn:last-child { border-radius: 0 6px 6px 0; }
.ce-seg .ce-btn[data-on="true"] { background: var(--ce-sel); border-color: var(--ce-accent); }
.ce-crumb .ce-btn { height: 22px; }
.ce-conflict { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: color-mix(in srgb, var(--ce-warn) 16%, var(--ce-deep)); border-bottom: 0.5px solid var(--ce-warn); }
.ce-conflict b { color: var(--ce-warn); }
.ce-conflict .ce-grow { flex: 1; }
.ce-editor { position: relative; flex: 1; min-height: 0; }
.ce-monaco { position: absolute; inset: 0; }
.ce-monaco .ce-ed { position: absolute; inset: 0; }
.ce-overlay { position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; background: var(--ce-deep); color: var(--ce-dim); text-align: center; padding: 24px; }
.ce-overlay h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--ce-text); }
.ce-overlay kbd { border: 0.5px solid var(--ce-line); border-radius: 4px; padding: 0 5px; font-family: inherit; background: var(--ce-surface); }

/* status bar */
.ce-status { flex: none; display: flex; align-items: center; gap: 14px; height: 22px; padding: 0 10px; border-top: 0.5px solid var(--ce-line); background: var(--ce-surface); color: var(--ce-dim); font-size: 12px; overflow: hidden; white-space: nowrap; }
.ce-status .ce-grow { flex: 1; }
.ce-status .ce-live { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: var(--ce-dim); margin-right: 5px; }
.ce-status .ce-live[data-s="live"] { background: var(--ce-ok); }
.ce-status .ce-live[data-s="connecting"] { background: var(--ce-warn); }
.ce-status .ce-live[data-s="down"] { background: var(--ce-danger); }

/* quick open */
.ce-qo-back { position: absolute; inset: 0; z-index: 40; display: flex; justify-content: center; align-items: flex-start; padding-top: 56px; background: #00000040; }
.ce-qo { width: min(560px, calc(100% - 32px)); max-height: 70%; display: flex; flex-direction: column; background: var(--ce-surface); border: 0.5px solid var(--ce-line); border-radius: 8px; box-shadow: 0 12px 40px #0006; overflow: hidden; }
.ce-qo input { flex: none; margin: 8px; height: 30px; padding: 0 10px; border: 0.5px solid var(--ce-line); border-radius: 6px; background: var(--ce-field); outline: none; }
.ce-qo input:focus { border-color: var(--ce-accent); }
.ce-qo-list { overflow: auto; padding-bottom: 6px; }
.ce-qo-item { display: flex; align-items: center; gap: 8px; padding: 3px 12px; min-height: 26px; cursor: pointer; white-space: nowrap; overflow: hidden; }
.ce-qo-item[data-sel="true"] { background: var(--ce-sel); }
.ce-qo-item .ce-dim { color: var(--ce-dim); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; }
.ce-qo-item mark { background: transparent; color: var(--ce-accent); font-weight: 700; }
.ce-qo-note { padding: 6px 14px; color: var(--ce-dim); }

/* notice */
.ce-notice { position: absolute; right: 12px; bottom: 30px; z-index: 50; max-width: 420px; display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 8px; border: 0.5px solid var(--ce-line); background: var(--ce-surface); box-shadow: 0 6px 24px #0005; }
.ce-notice[data-level="error"] { border-color: var(--ce-danger); }
.ce-notice span { white-space: pre-wrap; word-break: break-word; }
/* git tools block: sync bar, commit box, branch picker, history */
.ce-tools { padding: 4px 8px 6px 10px; border-bottom: 0.5px solid var(--ce-line); display: flex; flex-direction: column; gap: 6px; }
.ce-sync-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ce-sync-row .ce-grow { flex: 1; }
.ce-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; min-width: 0; height: 20px; padding: 0 6px; border: 0.5px solid var(--ce-line); border-radius: 10px; background: transparent; color: var(--ce-text); cursor: pointer; font-size: 11.5px; }
.ce-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ce-chip:hover { border-color: var(--ce-accent); }
.ce-repo-h .ce-chip.ce-branch { color: var(--ce-dim); }
.ce-chip-bar { height: 18px; border-color: transparent; padding: 0 4px; color: inherit; font-size: 12px; }
.ce-chip-bar:hover { border-color: var(--ce-line); }
.ce-ab { color: var(--ce-dim); font-size: 11.5px; white-space: nowrap; }
.ce-tbtn { width: auto; padding: 0 6px; font-size: 11.5px; border: 0.5px solid var(--ce-line); }
.ce-tbtn:disabled { opacity: 0.45; cursor: default; }
.ce-sync-msg { font-size: 11.5px; white-space: pre-wrap; word-break: break-word; color: var(--ce-dim); display: flex; align-items: center; gap: 6px; }
.ce-sync-msg[data-error="true"] { color: var(--ce-danger); }
.ce-sync-msg[data-warn="true"] { color: var(--ce-warn); }
.ce-sync-msg[data-info="true"] { color: var(--ce-ok); }
.ce-spin { width: 11px; height: 11px; flex: none; border: 1.5px solid var(--ce-line); border-top-color: var(--ce-accent); border-radius: 50%; display: inline-block; animation: ce-spin 0.8s linear infinite; }
@keyframes ce-spin { to { transform: rotate(360deg); } }
.ce-commit { display: flex; flex-direction: column; gap: 5px; }
.ce-msg { width: 100%; resize: vertical; min-height: 54px; max-height: 200px; padding: 5px 8px; border: 0.5px solid var(--ce-line); border-radius: 6px; background: var(--ce-field); outline: none; font: inherit; }
.ce-msg:focus { border-color: var(--ce-accent); }
.ce-commit-row { display: flex; align-items: center; gap: 6px; }
.ce-commit-row .ce-grow { flex: 1; }
.ce-check { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ce-dim); cursor: pointer; user-select: none; }
.ce-hint { font-size: 11px; color: var(--ce-dim); }
.ce-hint[data-long="true"] { color: var(--ce-warn); }
.ce-commit > .ce-btn { justify-content: center; }
.ce-bp { max-height: 75%; }
.ce-bp-h { padding: 8px 12px 0; font-weight: 600; }
.ce-bp-h .ce-dim { color: var(--ce-dim); font-weight: 400; margin-left: 6px; }
.ce-bp .ce-sync-msg { padding: 2px 12px; }
.ce-bp .ce-qo-note { font-size: 11.5px; }
.ce-bp .ce-plus { width: 12px; text-align: center; color: var(--ce-ok); font-weight: 700; }
.ce-bp .ce-qo-item[data-current="true"] { color: var(--ce-dim); cursor: default; }
.ce-hbar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; }
.ce-hbar .ce-select { height: 24px; }
.ce-hc { border-bottom: 0.5px solid var(--ce-line); }
.ce-hrow { padding: 3px 8px 3px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 1px; }
.ce-hrow:hover { background: var(--ce-hover); }
.ce-hc[data-open="true"] > .ce-hrow { background: var(--ce-sel); }
.ce-hsub { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ce-hs { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 0 1 auto; }
.ce-ref { flex: none; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; padding: 0 5px; border-radius: 8px; background: color-mix(in srgb, var(--ce-accent) 22%, transparent); color: var(--ce-text); }
.ce-ref[data-tag="true"] { background: color-mix(in srgb, var(--ce-warn) 25%, transparent); }
.ce-hmeta { display: flex; gap: 8px; font-size: 11px; color: var(--ce-dim); white-space: nowrap; overflow: hidden; }
.ce-hmeta code { font-family: var(--ds-font-family-mono, ui-monospace, monospace); }
.ce-hmeta span { overflow: hidden; text-overflow: ellipsis; }
.ce-hdetail { padding: 2px 0 4px 10px; background: var(--ce-deep); }
.ce-hmsg { margin: 2px 8px 4px 0; white-space: pre-wrap; word-break: break-word; font: inherit; font-size: 12px; color: var(--ce-dim); max-height: 140px; overflow: auto; }
.ce-hbadge { margin-left: auto; width: 14px; text-align: center; font-size: 11px; font-weight: 700; flex: none; }
.ce-hbadge[data-k="M"], .ce-hbadge[data-k="R"], .ce-hbadge[data-k="C"], .ce-hbadge[data-k="T"] { color: var(--ce-warn); }
.ce-hbadge[data-k="A"] { color: var(--ce-ok); }
.ce-hbadge[data-k="D"] { color: var(--ce-danger); }
.ce-more { padding: 6px 10px; display: flex; justify-content: center; }
.ce-note[data-busy="true"] { display: flex; align-items: center; gap: 6px; }
`

let injected = false
/** Add the stylesheet once. */
export function injectStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const el = document.createElement('style')
  el.dataset.dshCodeEditor = 'view'
  el.textContent = VIEW_CSS
  document.head.appendChild(el)
}
