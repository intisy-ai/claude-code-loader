#!/usr/bin/env node
// @ts-nocheck
// Tiny stdout helper the cc wrapper invokes at launch to decide routing mode:
// PROVIDER routing (proxy + provider accounts, the current/default behavior)
// vs NATIVE Claude account (no proxy, plain `claude` with its own login).
// Mirrors model-env.ts's pattern (same config path, same "never break the
// default on error" contract) so the wrapper's launch-time decisions all come
// from small standalone stdout helpers instead of shell/cmd-embedded logic.
//   `node route-mode.js` -> prints `<route> <login>`:
//     route: `1` (provider routing) or `0` (native)
//     login: `ok` (claude has native credentials / own API key) or `none`
// route is always the first token so a caller reading only one token
// (`for /f %%R` / `$(...)` first word) still gets correct routing; login is additive.
//
// On ANY error (missing file, parse error, whatever) route falls back to `1`;
// the safe default is always the current/existing behavior; a missing/broken
// helper must never silently switch a user into native mode.

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { anthropicProfile } from "../claude-code-proxy/dist/index.js";

const configDir = process.env.HUB_CONFIG_DIR || join(homedir(), ".claude");
const profile = anthropicProfile();

// Native launches with no credential land on "Not logged in · run /login" only
// after the first prompt; the wrapper uses this token to open /login at startup
// instead. Own API key/token in the env counts as logged in.
function nativeLogin() {
  try {
    if (process.env.ANTHROPIC_API_KEY) return "ok";
    if (process.env.ANTHROPIC_AUTH_TOKEN && process.env.ANTHROPIC_AUTH_TOKEN !== "sk-ant-loader-proxy") return "ok";
    const state = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    return state && state.oauthAccount && state.oauthAccount.emailAddress ? "ok" : "none";
  } catch { return "none"; }
}

try {
  const p = join(configDir, "config", profile.configFile);
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const providerRouting = cfg[profile.routingKey] !== false;   // default true
  process.stdout.write((providerRouting ? "1" : "0") + " " + nativeLogin());
} catch {
  process.stdout.write("1 ok");   // safe default: current behavior (provider routing)
}
