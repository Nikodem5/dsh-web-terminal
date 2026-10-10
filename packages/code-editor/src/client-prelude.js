window.__ModuleLoader__.load({
  id: 'dsh-code-editor',
  factory: (require) => {
    // The loader's contract is a CommonJS-ish factory: `module` and `exports`
    // must exist before the bundled body runs, because esbuild's IIFE assigns
    // its entry exports to the globalName and this wrapper hands them back
    // through `module.exports`. Declaring them here is what makes the postlude
    // work — the factory body is NOT a CommonJS module scope by itself.
    var module = { exports: {} };
    var exports = module.exports;
    // The bundled body resolves `react` / `react/jsx-runtime` through the shim
    // modules, which read this hook — so React stays the loader's shared
    // instance while everything else (xterm) is bundled in below.
    globalThis.__ce_require__ = require;
