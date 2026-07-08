// Bundle the loader's plugin entry into ONE self-contained ESM file. OpenCode
// auto-loads each deployed plugin/<name>.js, and the updater imports it under
// Claude — both load that single file in isolation, so sibling modules
// (commands.ts) and core/dist must be INLINED. tsc's multi-file output left a
// `./commands.js` import that can't resolve from the deploy dir, so the loader
// failed to load and `oc`/`cc` were never installed. esbuild inlines it all.
// (The TUI is a separate process — core-loader/dist/tui.js — and stays external.)
import { build } from "esbuild";

const banner = {
  js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
};

// tui-extension.ts is loaded in isolation via HUB_TUI_EXTENSION from the repo's
// dist dir; it imports core-loader's shared account-menu, so it must be bundled
// self-contained too (tsc left an unresolvable ../core-loader/dist import).
// proxy.ts is the always-on daemon (run standalone via `node dist/proxy.js`); it now
// imports core-loader's shared readDeployedProviders + the shared model-map, so it
// must be bundled too to stay a single self-contained file with no runtime
// cross-submodule dependency. model-env.ts is a standalone stdout helper the cc
// wrapper runs (`node dist/model-env.js`) to inject the mapped models into /model.
// claude-caps.ts (the app-capability adapter tui-extension registers) is ALSO its
// own entry point so dist/claude-caps.js exists standalone for node:test to
// import directly, in addition to being inlined into dist/tui-extension.js.
await build({
  entryPoints: ["src/plugin.ts", "src/tui-extension.ts", "src/proxy.ts", "src/model-env.ts", "src/claude-caps.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist",
  banner,
  logLevel: "info",
});

console.log("Bundled loader plugin -> dist/plugin.js, dist/tui-extension.js, dist/proxy.js, dist/model-env.js, dist/claude-caps.js");
