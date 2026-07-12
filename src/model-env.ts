#!/usr/bin/env node
// @ts-nocheck
// Tiny stdout helper the cc wrapper invokes at launch: prints the ANTHROPIC_DEFAULT_*
// model env, derived from the loader's (healed) tier->model mapping, so Claude Code's
// /model picker shows the mapped provider models. JSON/mapping logic stays in
// TypeScript instead of being duplicated in the shell/cmd wrappers.
//   `node model-env.js sh`       -> `export KEY='value'` lines (single-quote-safe)
//   `node model-env.js cmd`      -> raw `KEY=value` lines (the .cmd parses with for /f)
//   `node model-env.js sh-unset` -> `unset KEY` lines (native-routing cleanup)
//   `node model-env.js keys`     -> bare KEY names (the .cmd clears via set "KEY=")

import { join } from "path";
import { homedir } from "os";
import { modelEnvPairs, anthropicProfile } from "../core-proxy/dist/index.js";

const configDir = process.env.HUB_CONFIG_DIR || join(homedir(), ".claude");
const format = process.argv[2] || "sh";

try {
  const pairs = modelEnvPairs(configDir, anthropicProfile());
  const out = pairs.map(({ key, value }) => {
    if (format === "cmd") return key + "=" + value;
    if (format === "sh-unset") return "unset " + key;
    if (format === "keys") return key;
    return "export " + key + "='" + String(value).replace(/'/g, "'\\''") + "'";
  });
  if (out.length) process.stdout.write(out.join("\n") + "\n");
} catch { /* no mapping yet -> emit nothing; wrapper leaves /model at its default */ }
