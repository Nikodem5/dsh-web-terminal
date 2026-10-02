// Shim module: routes the bundled client code's `react` import to the React
// instance the DSH module loader hands to `factory(require)`.
//
// CommonJS shape on purpose: `module.exports = <the React namespace>` gives the
// bundler a module with an unknown export list at build time (so named imports
// like `useState` resolve dynamically) while keeping exactly one React instance
// at runtime. `.cts` makes it unambiguously CommonJS to esbuild,
// tooling that inspects it.
module.exports = globalThis.__wt_require__('react')
