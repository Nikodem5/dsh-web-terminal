// dsh-web-terminal — styles for the colour tag strip and the picker.

export const TAG_CSS = `
/* Colour tag: --wt-tag is set on the element that carries data-tag. */
.wt-head[data-tag]::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px; background: var(--wt-tag); }
.wt-li[data-tag]::before { content: ""; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px; border-radius: 2px; background: var(--wt-tag); }
.wt-tile-head[data-tag] { box-shadow: inset 0 3px 0 var(--wt-tag); }
.wt-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px 8px; }
.wt-swatch { width: 18px; height: 18px; padding: 0; border-radius: 50%; border: 2px solid transparent; background: var(--wt-tag); cursor: pointer; box-sizing: border-box; }
.wt-swatch:hover { transform: scale(1.12); }
.wt-swatch[aria-pressed="true"] { border-color: var(--wt-text); }
.wt-swatch[data-none="true"] { background: transparent; border: 1.5px dashed var(--wt-dim); }
.wt-swatch[data-none="true"][aria-pressed="true"] { border-style: solid; border-color: var(--wt-text); }
`
