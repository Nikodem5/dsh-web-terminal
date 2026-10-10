// dsh-code-editor - styles of the SEARCH view and the markdown preview (appended to the page stylesheet by styles.ts).
// Colours are the page's --ce-* tokens, so both follow the measured light / dark scheme.

export const SEARCH_MD_CSS = `
/* sidebar view switch + search */
.ce-secs[hidden] { display: none; }
.ce-sidetabs { flex: none; display: flex; gap: 2px; padding: 4px 8px 0; border-bottom: 0.5px solid var(--ce-line); }
.ce-sidetab { height: 26px; padding: 0 10px; border: none; border-bottom: 2px solid transparent; background: transparent; color: var(--ce-dim); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; }
.ce-sidetab:hover { color: var(--ce-text); }
.ce-sidetab[data-on="true"] { color: var(--ce-text); border-bottom-color: var(--ce-accent); }
.ce-searchp { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ce-sq { flex: none; padding: 8px 8px 4px; display: flex; flex-direction: column; gap: 6px; }
.ce-sq-row { display: flex; align-items: center; gap: 3px; }
.ce-sq-in { height: 28px; }
.ce-sq-filters { display: flex; flex-direction: column; gap: 6px; }
.ce-tgl { flex: none; min-width: 24px; height: 24px; padding: 0 4px; border: 0.5px solid transparent; border-radius: 5px; background: transparent; color: var(--ce-dim); cursor: pointer; font-size: 11.5px; font-weight: 700; font-family: ui-monospace, Consolas, monospace; }
.ce-tgl:hover { background: var(--ce-hover); color: var(--ce-text); }
.ce-tgl[data-on="true"] { background: var(--ce-sel); border-color: var(--ce-accent); color: var(--ce-text); }
.ce-sq-sum { flex: none; padding: 2px 10px 6px; color: var(--ce-dim); font-size: 12px; min-height: 18px; }
.ce-sres { flex: 1; min-height: 0; overflow: auto; padding-bottom: 6px; }
.ce-count-dim { background: var(--ce-hover); color: var(--ce-dim); margin-left: auto; }
.ce-sfile-h { font-weight: 600; padding-left: 6px; }
.ce-smatch { display: flex; align-items: baseline; gap: 8px; min-height: 22px; padding: 1px 8px 1px 26px; cursor: pointer; white-space: nowrap; overflow: hidden; }
.ce-smatch:hover { background: var(--ce-hover); }
.ce-smatch[data-sel="true"] { background: var(--ce-sel); }
.ce-smatch .ce-ln { flex: none; min-width: 28px; text-align: right; color: var(--ce-dim); font-size: 11px; font-variant-numeric: tabular-nums; }
.ce-smatch .ce-prev { overflow: hidden; text-overflow: ellipsis; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.ce-smatch mark { background: color-mix(in srgb, var(--ce-warn) 38%, transparent); color: inherit; border-radius: 2px; }
.ce-search-hit-inline { background: color-mix(in srgb, #f0b429 45%, transparent); border-radius: 2px; outline: 1px solid #f0b429; }

/* markdown preview */
.ce-work { flex: 1; min-height: 0; display: flex; }
.ce-work > .ce-editor { flex: 1 1 0; min-width: 0; }
.ce-work[data-md="only"] > .ce-editor { display: none; }
.ce-work[data-md="side"] > .ce-md { border-left: 0.5px solid var(--ce-line); }
.ce-md { position: relative; flex: 1 1 0; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--ce-deep); }
.ce-md-body { flex: 1; min-height: 0; overflow: auto; padding: 16px 24px 40px; color: var(--ce-text); font-size: 14px; line-height: 1.6; word-wrap: break-word; }
.ce-md-body > :first-child { margin-top: 0; }
.ce-md-body h1, .ce-md-body h2, .ce-md-body h3, .ce-md-body h4, .ce-md-body h5, .ce-md-body h6 { margin: 1.4em 0 0.6em; font-weight: 600; line-height: 1.25; }
.ce-md-body h1 { font-size: 1.9em; padding-bottom: 0.3em; border-bottom: 0.5px solid var(--ce-line); }
.ce-md-body h2 { font-size: 1.45em; padding-bottom: 0.3em; border-bottom: 0.5px solid var(--ce-line); }
.ce-md-body h3 { font-size: 1.2em; }
.ce-md-body h4, .ce-md-body h5, .ce-md-body h6 { font-size: 1em; }
.ce-md-body h6 { color: var(--ce-dim); }
.ce-md-body p, .ce-md-body ul, .ce-md-body ol, .ce-md-body blockquote, .ce-md-body pre, .ce-md-body table, .ce-md-body details { margin: 0 0 1em; }
.ce-md-body ul, .ce-md-body ol { padding-left: 2em; }
.ce-md-body li + li { margin-top: 0.25em; }
.ce-md-body li > p { margin: 0.4em 0; }
.ce-md-body input[type="checkbox"] { margin: 0 0.5em 0 -1.4em; vertical-align: middle; }
.ce-md-body blockquote { padding: 0 1em; color: var(--ce-dim); border-left: 3px solid var(--ce-line); }
.ce-md-body a[data-ce-md], .ce-md-body a[data-ce-ext], .ce-md-body a[data-ce-anchor] { color: var(--ce-accent); text-decoration: none; cursor: pointer; }
.ce-md-body a[data-ce-md]:hover, .ce-md-body a[data-ce-ext]:hover, .ce-md-body a[data-ce-anchor]:hover { text-decoration: underline; }
.ce-md-body a:focus-visible { outline: 1px solid var(--ce-accent); outline-offset: 2px; }
.ce-md-body code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.88em; padding: 0.15em 0.4em; border-radius: 4px; background: var(--ce-hover); }
.ce-md-body pre { padding: 12px 14px; overflow: auto; border-radius: 6px; background: var(--ce-field); border: 0.5px solid var(--ce-line); line-height: 1.45; }
.ce-md-body pre code { padding: 0; background: transparent; font-size: 12.5px; white-space: pre; }
.ce-md-body table { border-collapse: collapse; display: block; max-width: 100%; overflow: auto; }
.ce-md-body th, .ce-md-body td { padding: 6px 12px; border: 0.5px solid var(--ce-line); }
.ce-md-body th { background: var(--ce-surface); font-weight: 600; }
.ce-md-body tr:nth-child(2n) td { background: color-mix(in srgb, var(--ce-surface) 55%, transparent); }
.ce-md-body hr { height: 1px; border: 0; margin: 1.6em 0; background: var(--ce-line); }
.ce-md-body img { max-width: 100%; height: auto; }
.ce-md-body del { color: var(--ce-dim); }
.ce-md-body kbd { font-family: inherit; font-size: 0.85em; padding: 0 5px; border: 0.5px solid var(--ce-line); border-radius: 4px; background: var(--ce-surface); }
.ce-md-body summary { cursor: pointer; }
.ce-md-body [data-ce-noimg] { display: inline-block; padding: 1px 6px; border: 0.5px dashed var(--ce-line); border-radius: 4px; color: var(--ce-dim); font-size: 0.9em; }
.ce-md-note { padding: 6px 24px; color: var(--ce-dim); font-size: 12px; }
`
