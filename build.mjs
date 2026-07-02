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
await build({
  entryPoints: ["src/plugin.ts", "src/tui-extension.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist",
  banner,
  logLevel: "info",
});

console.log("Bundled loader plugin -> dist/plugin.js, dist/tui-extension.js");
