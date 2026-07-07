#!/usr/bin/env node
// @ts-nocheck
// Tiny stdout helper the cc wrapper invokes at launch: prints the ANTHROPIC_DEFAULT_*
// model env, derived from the loader's (healed) tier->model mapping, so Claude Code's
// /model picker shows the mapped provider models. JSON/mapping logic stays in
// TypeScript instead of being duplicated in the shell/cmd wrappers.
//   `node model-env.js sh`  -> `export KEY='value'` lines (single-quote-safe)
//   `node model-env.js cmd` -> raw `KEY=value` lines (the .cmd parses with for /f)

import { join } from "path";
import { homedir } from "os";
import { modelEnvPairs } from "./model-map.js";

const configDir = process.env.HUB_CONFIG_DIR || join(homedir(), ".claude");
const format = process.argv[2] === "cmd" ? "cmd" : "sh";

try {
  const out = modelEnvPairs(configDir).map(({ key, value }) =>
    format === "cmd"
      ? key + "=" + value
      : "export " + key + "='" + String(value).replace(/'/g, "'\\''") + "'",
  );
  if (out.length) process.stdout.write(out.join("\n") + "\n");
} catch { /* no mapping yet -> emit nothing; wrapper leaves /model at its default */ }
