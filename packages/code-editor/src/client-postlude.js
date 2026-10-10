    // esbuild's IIFE assigns the bundled entry's exports to this name just
    // above. The loader's contract is that the factory RETURNS the exports
    // object (see any shipped bundle: `return module.exports`), so omitting
    // this return makes the plugin materialize as `undefined` — the host half
    // mounts and the UI silently never appears. Keep the name in sync with
    // BUNDLED_EXPORTS in build.mjs (each build asserts it actually occurred).
    module.exports = __dsh_ce_exports__;
    return module.exports;
  },
});
