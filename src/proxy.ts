#!/usr/bin/env node
// Always-on proxy the `cc` wrapper points ANTHROPIC_BASE_URL at. The generic
// daemon scaffolding (config-dir logging, start-marker, dynamic provider
// resolver, listen) now lives in basekit/loader's startLoaderProxy so it isn't
// duplicated per loader; this entry only supplies the Claude specifics: the
// anthropicProfile + createProxyServer/makeDynamicResolver from claude-code-proxy,
// the :34567 default port, and the Claude config-dir default.
import { join } from "path";
import { homedir } from "os";
import { startLoaderProxy } from "@intisy-ai/basekit/loader/proxy-runner.js";
import { createProxyServer, anthropicProfile, makeDynamicResolver } from "@intisy-ai/claude-code-proxy";
import { publishNotification, emitEvent, setActivityContext } from "@intisy-ai/basekit";
import type { ActivitySpec, Impact } from "@intisy-ai/basekit";

// The proxy engine describes an event more loosely than core records one (its `impact` is any
// string), and this loader is the seam between the two vocabularies, so it narrows rather than
// asserting: an impact the recorder does not know is dropped instead of being filed under itself.
const IMPACTS: Impact[] = ["debug", "info", "notice", "warning", "error"];
function asActivitySpec(spec: { topic: string; action: string; impact?: string; details?: unknown }): ActivitySpec {
  const impact = IMPACTS.find((known) => known === spec.impact);
  return { ...spec, ...(impact ? { impact } : { impact: undefined }) } as ActivitySpec;
}

const PORT = parseInt(process.env.HUB_PROXY_PORT || "34567", 10);
const CONFIG_DIR = process.env.HUB_CONFIG_DIR || join(homedir(), ".claude");

// This process is the proxy daemon and nothing else, so naming the entry once is
// accurate for every event it emits, including basekit/proxy's per-request ones.
setActivityContext({ entry: "proxy" });

startLoaderProxy({
  createProxyServer,
  makeDynamicResolver,
  profile: anthropicProfile(),
  configDir: CONFIG_DIR,
  port: PORT,
  notify: (message, level) => publishNotification(message, level || "warning", "core-proxy"),
  emitActivity: (spec) => emitEvent(asActivitySpec(spec), "core-proxy"),
});
