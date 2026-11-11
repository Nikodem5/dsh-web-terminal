// dsh-web-terminal — styles for the copy-on-select confirmation.

export const COPY_CSS = `
.wt-holder { position: relative; }
.wt-toast { position: absolute; top: 4px; right: 12px; z-index: 25; padding: 3px 10px; border-radius: 9px; font: 600 11px/1.4 var(--ds-font-family-sans, system-ui, sans-serif); background: color-mix(in srgb, var(--wt-idle, #22c55e) 88%, #000); color: #04140a; pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
.wt-toast[data-kind="fail"] { background: var(--wt-danger, #ff6b6b); color: #1b0606; }
`
