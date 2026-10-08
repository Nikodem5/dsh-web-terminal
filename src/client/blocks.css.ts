// dsh-web-terminal — styles for command blocks (the gutter bar in the terminal's left padding).

/**
 * xterm positions a decoration over its cell and the render hook only adds the class, so the bar is moved
 * into the 8px padding of .wt-body (left of column 0) and the text area keeps its full width.
 */
export const BLOCKS_CSS = `
.xterm-screen .xterm-decoration-container .xterm-decoration.wt-gutter { left: -7px !important; width: 3px !important; border-radius: 2px; pointer-events: none; opacity: 0.85; background: var(--wt-dim); }
.xterm-decoration.wt-gutter[data-state="ok"] { background: var(--wt-idle); opacity: 0.55; }
.xterm-decoration.wt-gutter[data-state="fail"] { background: var(--wt-dead); opacity: 0.9; }
.xterm-decoration.wt-gutter[data-state="unk"] { background: var(--wt-dim); opacity: 0.35; }
.xterm-decoration.wt-gutter[data-state="run"] { background: var(--wt-accent); animation: wt-gutter-pulse 1.4s ease-in-out infinite; }
@keyframes wt-gutter-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .xterm-decoration.wt-gutter[data-state="run"] { animation: none; opacity: 0.8; } }
`
