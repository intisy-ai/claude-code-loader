#!/usr/bin/env node
// @ts-nocheck
// Always-on proxy the `cc` wrapper points ANTHROPIC_BASE_URL at. The generic
// daemon scaffolding (config-dir logging, start-marker, dynamic provider
// resolver, listen) now lives in core-loader's startLoaderProxy so it isn't
// duplicated per loader; this entry only supplies the Claude specifics: the
// anthropicProfile + createProxyServer/makeDynamicResolver from claude-code-proxy,
// the :34567 default port, and the Claude/opencode config-dir resolution.
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { startLoaderProxy } from "../core-loader/dist/proxy-runner.js";
import { createProxyServer, anthropicProfile, makeDynamicResolver } from "../claude-code-proxy/dist/index.js";

const PORT = parseInt(process.env.HUB_PROXY_PORT || "34567", 10);
const CONFIG_DIR = process.env.HUB_CONFIG_DIR
  || (existsSync(join(homedir(), ".claude")) ? join(homedir(), ".claude") : join(homedir(), ".config", "opencode"));

startLoaderProxy({ createProxyServer, makeDynamicResolver, profile: anthropicProfile(), configDir: CONFIG_DIR, port: PORT });
