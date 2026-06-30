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

await build({
  entryPoints: ["src/plugin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/plugin.js",
  banner,
  logLevel: "info",
});

console.log("Bundled loader plugin -> dist/plugin.js");
