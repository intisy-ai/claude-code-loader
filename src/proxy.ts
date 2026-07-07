#!/usr/bin/env node
// @ts-nocheck
// Always-on proxy the `cc` wrapper points ANTHROPIC_BASE_URL at; routes each
// request to the {provider, model} assigned to its Claude tier (opus/sonnet/haiku)
// in the loader config, discovered from repos/ via claudeHub.authProviders.

import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { pathToFileURL } from "url";
import { createServer } from "http";
import { Readable } from "stream";
import { readDeployedProviders } from "../core-loader/dist/loader-runtime.js";
import { resolveModelMap } from "./model-map.js";

const PORT = parseInt(process.env.HUB_PROXY_PORT || "34567", 10);
const CONFIG_DIR = process.env.HUB_CONFIG_DIR
  || (existsSync(join(homedir(), ".claude")) ? join(homedir(), ".claude") : join(homedir(), ".config", "opencode"));
const CONFIG_FOLDER = join(CONFIG_DIR, "config");
const REPOS_DIR = join(CONFIG_DIR, "repos");
const LOADER_CONFIG = join(CONFIG_FOLDER, "claude-code-loader.json");
const START_TIME = new Date().toISOString().replace(/:/g, "-").split(".")[0];

function log(message) {
  try {
    const dateStr = new Date().toISOString().split("T")[0];
    const logsDir = join(CONFIG_DIR, "logs", dateStr);
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, "loader-proxy-" + START_TIME + ".log"), "[" + new Date().toISOString() + "] " + message + "\n");
  } catch {}
}

function loaderConfig() {
  try { if (existsSync(LOADER_CONFIG)) return JSON.parse(readFileSync(LOADER_CONFIG, "utf8")); } catch {}
  return {};
}

function claudeSlot(model) {
  const m = (model || "").toLowerCase();
  if (m.indexOf("opus") >= 0) return "opus";
  if (m.indexOf("sonnet") >= 0) return "sonnet";
  if (m.indexOf("haiku") >= 0) return "haiku";
  return "default";
}

// the ORDERED CHAIN [{provider, model}, ...] the cc Providers tab assigned to the
// request's Claude tier (primary + fallbacks). Healed: stale/unset tiers auto-derive
// to the current catalog, so routing tracks a model refresh even if never re-assigned.
async function resolveAssignment(request) {
  let requested = "";
  try { requested = ((await request.clone().json()) || {}).model || ""; } catch {}
  const map = resolveModelMap(CONFIG_DIR);   // { slot: [ {provider, model, ...}, ... ] }
  // Exact-id match first: the cc wrapper injects each tier's primary model id as
  // ANTHROPIC_DEFAULT_*_MODEL, so the request model can be a backend id that carries
  // no opus/sonnet/haiku keyword — recover its tier by matching the assigned ids
  // before falling back to keyword classification.
  for (const slot of Object.keys(map)) {
    if ((map[slot] || []).some((e) => e.model === requested)) return map[slot];
  }
  const slot = claudeSlot(requested);
  return (map[slot] && map[slot].length) ? map[slot] : (map.default || []);
}

function isRateLimited(resp) {
  try { return resp.status === 429 || resp.headers.get("x-hub-rate-limited") === "1"; } catch { return resp && resp.status === 429; }
}

// earliest epoch-ms the response says it'll be usable again (x-hub-retry-after-ms, else retry-after seconds)
function rateLimitResetMs(resp) {
  try {
    const xr = parseInt(resp.headers.get("x-hub-retry-after-ms"), 10);
    if (!Number.isNaN(xr) && xr > 0) return Date.now() + xr;
    const ra = parseInt(resp.headers.get("retry-after"), 10);
    if (!Number.isNaN(ra) && ra > 0) return Date.now() + ra * 1000;
  } catch {}
  return 0;
}

// Final response when every model in the chain is rate-limited. Return a NATIVE
// Anthropic 429 so Claude Code renders its own rate-limit UI ("session/usage limit —
// resets X") — the same regardless of which provider(s) the tier maps to. Prefer the
// real upstream 429 (claude-code carries the exact unified-* headers); synthesize the
// native shape from the reset for a non-claude provider that gave up differently.
async function rateLimitFinal(lastResp, resetMs) {
  // Keep the real upstream 429's rate-limit headers when present (claude-code carries
  // the exact unified-* reset), but always replace the body with a clear, actionable
  // message that includes the reset — the same wording regardless of provider.
  let reset = resetMs || 0;
  const headers = {};
  if (lastResp && lastResp.status === 429) {
    Object.assign(headers, Object.fromEntries(lastResp.headers));
    delete headers["content-encoding"]; delete headers["content-length"];
    delete headers["x-hub-rate-limited"]; delete headers["x-hub-retry-after-ms"];
    for (const k of ["anthropic-ratelimit-unified-5h-reset", "anthropic-ratelimit-unified-reset"]) {
      const s = parseInt(headers[k], 10);
      if (!Number.isNaN(s) && s * 1000 > reset) reset = s * 1000;
    }
  }
  const mins = reset > Date.now() ? Math.max(1, Math.round((reset - Date.now()) / 60000)) : 0;
  const message = mins
    ? "Rate limit reached — resets in ~" + mins + "m. Add a fallback model in cc -> Providers, or wait."
    : "Rate limit reached. Try again later, or add a fallback model in cc -> Providers.";
  headers["content-type"] = "application/json";
  headers["retry-after"] = String(reset > Date.now() ? Math.round((reset - Date.now()) / 1000) : 60);
  if (!headers["anthropic-ratelimit-unified-status"]) headers["anthropic-ratelimit-unified-status"] = "rejected";
  if (!headers["anthropic-ratelimit-unified-reset"]) headers["anthropic-ratelimit-unified-reset"] = String(Math.floor((reset || Date.now()) / 1000));
  return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message } }), { status: 429, headers });
}

// Load a provider's handler module, RELOADING it when the deployed file changes.
// This daemon is long-lived and Node caches imports by path, so without an mtime
// cache-bust a provider update (e.g. new 403 handling) would never take effect until
// the proxy restarts. Cache by provider; re-import only when the file's mtime moves.
let HANDLER_CACHE = {};
async function loadHandler(providerName) {
  const match = readDeployedProviders(REPOS_DIR).find((p) => p.provider === providerName);
  if (!match || !existsSync(match.handlerPath)) return null;
  const path = match.handlerPath;
  let mtime = 0;
  try { mtime = statSync(path).mtimeMs; } catch {}
  const cached = HANDLER_CACHE[providerName];
  if (cached && cached.path === path && cached.mtime === mtime) return cached.mod;
  const mod = await import(pathToFileURL(path).href + "?v=" + mtime);
  HANDLER_CACHE[providerName] = { path, mtime, mod };
  return mod;
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ type: "error", error: { type: "loader_proxy_error", message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function route(request) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return new Response("ok", { status: 200 });

  const chain = await resolveAssignment(request);
  if (!chain.length) {
    return errorResponse(503, "No provider/model assigned for this Claude tier. Run cc auth -> Providers.");
  }

  // Try the tier's models in order; advance to the next only when one is rate-limited,
  // so a chain stops only once EVERY model in it is exhausted.
  let lastResp = null;
  let resetMs = 0;
  for (const assigned of chain) {
    let mod;
    try { mod = await loadHandler(assigned.provider); }
    catch (e) { log("handler load failed for " + assigned.provider + ": " + (e && e.message)); mod = null; }
    if (!mod || typeof mod.handle !== "function") {
      lastResp = errorResponse(503, "Provider '" + assigned.provider + "' has no proxy handler installed.");
      continue;
    }
    let resp;
    try {
      resp = await mod.handle(request, { configDir: CONFIG_DIR, log, model: assigned.model });
    } catch (e) {
      log("handler error for " + assigned.provider + ": " + (e && e.message));
      lastResp = errorResponse(502, "Provider handler failed: " + (e && e.message));
      continue;
    }
    lastResp = resp;
    if (isRateLimited(resp)) {
      const ms = rateLimitResetMs(resp);
      if (ms > resetMs) resetMs = ms;
      log("rate-limited on " + assigned.provider + "/" + assigned.model + " — trying next fallback");
      continue;
    }
    return resp; // success or a non-rate-limit error — surface it
  }

  // Every model in the chain was rate-limited (or unavailable) — hand Claude a native
  // 429 so it renders its own rate-limit UI, consistent across providers.
  if ((lastResp && lastResp.status === 429) || resetMs > Date.now()) {
    return await rateLimitFinal(lastResp, resetMs);
  }
  return lastResp || errorResponse(503, "No provider handler available for this Claude tier.");
}

// Node http server that adapts a node req -> web Request and a web Response ->
// node res, so the routing/handler contract (web Request in, web Response out)
// stays identical while the daemon runs under Node (always on PATH, unlike bun).
const server = createServer((nodeReq, nodeRes) => {
  const method = (nodeReq.method || "GET").toUpperCase();
  const skipBody = method === "GET" || method === "HEAD";
  const chunks = [];
  nodeReq.on("data", (chunk) => { chunks.push(chunk); });
  nodeReq.on("end", async () => {
    try {
      const bodyBuffer = skipBody ? undefined : Buffer.concat(chunks);
      const webReq = new Request("http://127.0.0.1:" + PORT + nodeReq.url, {
        method,
        headers: nodeReq.headers,
        body: skipBody ? undefined : bodyBuffer,
        duplex: "half",
      });
      const webRes = await route(webReq);
      // undici's fetch (used by provider handlers) transparently DECOMPRESSES the
      // upstream body but leaves content-encoding/content-length in place. Forwarding
      // those onto the already-decoded body makes the claude CLI try to gunzip plain
      // text -> "Decompression error: ZlibError". Strip both; Node re-chunks the body.
      const outHeaders = Object.fromEntries(webRes.headers);
      delete outHeaders["content-encoding"];
      delete outHeaders["content-length"];
      nodeRes.writeHead(webRes.status, outHeaders);
      if (webRes.body) {
        // SSE / streaming responses MUST pipe (never buffer) so streaming works.
        Readable.fromWeb(webRes.body).pipe(nodeRes);
      } else {
        nodeRes.end(Buffer.from(await webRes.arrayBuffer()));
      }
    } catch (e) {
      nodeRes.writeHead(502, { "content-type": "application/json" });
      nodeRes.end(JSON.stringify({ type: "error", error: { message: String((e && e.message) || e) } }));
    }
  });
});

// Stamp a start-marker with THIS daemon's launch time. The cc wrapper compares
// proxy.js's mtime against it and restarts the daemon when proxy.js is newer — a
// healthy daemon is otherwise never replaced, so proxy/handler code fixes would only
// take effect after a manual kill or a machine reboot.
function stampStartMarker() {
  try {
    const logsDir = join(CONFIG_DIR, "logs");
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, ".proxy-started"), new Date().toISOString());
  } catch {}
}

server.listen(PORT, "127.0.0.1", () => { stampStartMarker(); log("Loader proxy listening on 127.0.0.1:" + PORT); });
