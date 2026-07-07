#!/usr/bin/env node
// @ts-nocheck
// Always-on proxy the `cc` wrapper points ANTHROPIC_BASE_URL at; routes each
// request to the {provider, model} assigned to its Claude tier (opus/sonnet/haiku)
// in the loader config, discovered from repos/ via claudeHub.authProviders.

import { existsSync, readFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
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

// the {provider, model} the cc Providers tab assigned to the request's Claude tier
async function resolveAssignment(request) {
  let requested = "";
  try { requested = ((await request.clone().json()) || {}).model || ""; } catch {}
  // Healed mapping: stale/unset tiers auto-derive to the current catalog, so routing
  // tracks a model refresh even if the stored mapping was never re-assigned.
  const map = resolveModelMap(CONFIG_DIR);
  // Exact-id match first: the cc wrapper injects each tier's mapped model id as
  // ANTHROPIC_DEFAULT_*_MODEL, so the request model can be a backend id that carries
  // no opus/sonnet/haiku keyword — recover its tier by matching the assigned ids
  // before falling back to keyword classification.
  for (const slot of Object.keys(map)) {
    if (map[slot] && map[slot].model && map[slot].model === requested) return map[slot];
  }
  return map[claudeSlot(requested)] || map.default || null;
}

let HANDLER_CACHE = {};
function resolveHandler(providerName) {
  if (HANDLER_CACHE[providerName] !== undefined) return HANDLER_CACHE[providerName];
  const match = readDeployedProviders(REPOS_DIR).find((p) => p.provider === providerName);
  const resolved = match ? match.handlerPath : null;
  HANDLER_CACHE[providerName] = resolved;
  return resolved;
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

  const assigned = await resolveAssignment(request);
  if (!assigned || !assigned.provider) {
    return errorResponse(503, "No provider/model assigned for this Claude tier. Run cc auth -> Providers.");
  }
  const handlerPath = resolveHandler(assigned.provider);
  if (!handlerPath || !existsSync(handlerPath)) {
    return errorResponse(503, "Provider '" + assigned.provider + "' has no proxy handler installed.");
  }
  try {
    const mod = await import(handlerPath);
    if (typeof mod.handle !== "function") return errorResponse(500, "Provider '" + assigned.provider + "' handler exports no handle()");
    return await mod.handle(request, { configDir: CONFIG_DIR, log, model: assigned.model });
  } catch (e) {
    log("handler error for " + assigned.provider + ": " + (e && e.message));
    return errorResponse(502, "Provider handler failed: " + (e && e.message));
  }
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

server.listen(PORT, "127.0.0.1", () => log("Loader proxy listening on 127.0.0.1:" + PORT));
