#!/usr/bin/env node
// @ts-nocheck
// Always-on proxy the `cc` wrapper points ANTHROPIC_BASE_URL at; thin entry over
// core-proxy's shared routing engine (tier->provider chains, rate-limit fallback,
// model rewrite, native-429 synthesis, node<->web adapter) — the actual logic that
// used to live here now lives in core-proxy/src, parameterized by the Anthropic
// RoutingProfile so it can be shared with other loaders/the dashboard sidecar.
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { readDeployedProviders } from "../core-loader/dist/loader-runtime.js";
import { createProxyServer, anthropicProfile, makeDynamicResolver } from "../claude-code-proxy/dist/index.js";

const PORT = parseInt(process.env.HUB_PROXY_PORT || "34567", 10);
const CONFIG_DIR = process.env.HUB_CONFIG_DIR
  || (existsSync(join(homedir(), ".claude")) ? join(homedir(), ".claude") : join(homedir(), ".config", "opencode"));
const REPOS_DIR = join(CONFIG_DIR, "repos");
const START_TIME = new Date().toISOString().replace(/:/g, "-").split(".")[0];

function log(message) {
  try {
    const dateStr = new Date().toISOString().split("T")[0];
    const logsDir = join(CONFIG_DIR, "logs", dateStr);
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, "loader-proxy-" + START_TIME + ".log"), "[" + new Date().toISOString() + "] " + message + "\n");
  } catch {}
}

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

const resolveHandler = makeDynamicResolver(() =>
  readDeployedProviders(REPOS_DIR).map((p) => ({ provider: p.provider, handlerPath: p.handlerPath }))
);

const server = createProxyServer({ configDir: CONFIG_DIR, profile: anthropicProfile(), port: PORT, log, resolveHandler });

server.listen().then(() => {
  stampStartMarker();
  log("Loader proxy listening on 127.0.0.1:" + PORT);
});
