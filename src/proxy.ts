#!/usr/bin/env node
// @ts-nocheck
// Always-on proxy the `cc` wrapper points ANTHROPIC_BASE_URL at. The generic
// daemon scaffolding (config-dir logging, start-marker, dynamic provider
// resolver, listen) now lives in core-loader's startLoaderProxy so it isn't
// duplicated per loader; this entry only supplies the Claude specifics: the
// anthropicProfile + createProxyServer/makeDynamicResolver from claude-code-proxy,
// the :34567 default port, and the Claude config-dir default.
import { join } from "path";
import { homedir } from "os";
import { startLoaderProxy } from "@intisy-ai/core-loader/dist/proxy-runner.js";
import { createProxyServer, anthropicProfile, makeDynamicResolver } from "@intisy-ai/claude-code-proxy";
import { publishNotification, emitEvent, setActivityContext } from "@intisy-ai/core";

const PORT = parseInt(process.env.HUB_PROXY_PORT || "34567", 10);
const CONFIG_DIR = process.env.HUB_CONFIG_DIR || join(homedir(), ".claude");

// This process is the proxy daemon and nothing else, so naming the entry once is
// accurate for every event it emits, including core-proxy's per-request ones.
setActivityContext({ entry: "proxy" });

startLoaderProxy({
  createProxyServer,
  makeDynamicResolver,
  profile: anthropicProfile(),
  configDir: CONFIG_DIR,
  port: PORT,
  notify: (message, level) => publishNotification(message, level || "warning", "core-proxy"),
  emitActivity: (spec) => emitEvent(spec, "core-proxy"),
});
