// Shim module: routes the bundled client code's automatic JSX runtime import to
// the JSX runtime the DSH module loader hands to `factory(require)`.
//
// CommonJS shape for the same reason as the React shim: the bundler must not
// assume it knows this module's export list, because the real shape is supplied
// by the loader at runtime.
module.exports = globalThis.__ce_require__('react/jsx-runtime')
