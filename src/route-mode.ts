#!/usr/bin/env node
// @ts-nocheck
// Tiny stdout helper the cc wrapper invokes at launch to decide routing mode:
// PROVIDER routing (proxy + provider accounts, the current/default behavior)
// vs NATIVE Claude account (no proxy, plain `claude` with its own login).
// Mirrors model-env.ts's pattern (same config path, same "never break the
// default on error" contract) so the wrapper's launch-time decisions all come
// from small standalone stdout helpers instead of shell/cmd-embedded logic.
//   `node route-mode.js` -> prints `1` (provider routing) or `0` (native)
//
// On ANY error (missing file, parse error, whatever) this prints `1` — the
// safe default is always the current/existing behavior; a missing/broken
// helper must never silently switch a user into native mode.

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

const configDir = process.env.HUB_CONFIG_DIR || join(homedir(), ".claude");

try {
  const p = join(configDir, "config", "claude-code-loader.json");
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const providerRouting = cfg.providerRouting !== false;   // default true
  process.stdout.write(providerRouting ? "1" : "0");
} catch {
  process.stdout.write("1");   // safe default: current behavior (provider routing)
}
