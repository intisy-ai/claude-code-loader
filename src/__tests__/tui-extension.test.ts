// uniqueProviders() routes through basekit/loader's readDeployedProviders, which merges each
// plugin's package.json-declared authProviders with the lanes materialized into THIS home's
// cache/dynamic-providers.json (a map keyed by deployed plugin id; custom-auth's per-endpoint
// providers land there). Isolated temp HUB_CONFIG_DIR, never the real ~/.claude.
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { uniqueProviders } from "../tui-extension.js";
import tuiExtension from "../tui-extension.js";
import { profileTiers, anthropicProfile } from "@intisy-ai/claude-code-proxy";

let homeDir;
let prevConfigDir;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "claude-code-loader-providers-"));
  prevConfigDir = process.env.HUB_CONFIG_DIR;
  process.env.HUB_CONFIG_DIR = homeDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.HUB_CONFIG_DIR;
  else process.env.HUB_CONFIG_DIR = prevConfigDir;
  rmSync(homeDir, { recursive: true, force: true });
});

function writeRepo(repo, pkg) {
  const repoDir = join(homeDir, "repos", repo);
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "package.json"), JSON.stringify(pkg));
}

// Mirrors what a plugin materializes into the home when the user configures an endpoint:
// one map entry per deployed plugin id, each holding the lanes it has added.
function writeDynamicLanes(pluginId, lanes) {
  const cacheDir = join(homeDir, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const manifestPath = join(cacheDir, "dynamic-providers.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  manifest[pluginId] = lanes;
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

test("uniqueProviders: includes a provider materialized only via the home's dynamic-providers cache", () => {
  writeRepo("custom-auth", { claudeHub: { authProviders: [] } });
  writeDynamicLanes("custom-auth", [{ name: "my-endpoint", repo: "custom-auth", handler: "dist/dynamic.js" }]);

  const names = uniqueProviders().map((p) => p.name);
  expect(names).toContain("my-endpoint");
});

test("the tab extension's default export awaits proxy init before returning, so a sync routing call right after it succeeds", async () => {
  const registered = [];
  const tuiApi = { registerTab: (tab) => registered.push(tab) };

  await tuiExtension(tuiApi);

  expect(registered.some((t) => t.id === "providers")).toBe(true);
  expect(() => profileTiers(homeDir, anthropicProfile())).not.toThrow();
});

test("uniqueProviders: still lists a package.json-declared provider alongside the dynamic one", () => {
  writeRepo("stub-auth", { claudeHub: { authProviders: [{ name: "stub", handler: "dist/handler.js" }] } });
  writeRepo("custom-auth", { claudeHub: { authProviders: [] } });
  writeDynamicLanes("custom-auth", [{ name: "my-endpoint", repo: "custom-auth", handler: "dist/dynamic.js" }]);

  const names = uniqueProviders().map((p) => p.name);
  expect(names).toContain("stub");
  expect(names).toContain("my-endpoint");
});

// A provider asks its context for this and never imports core-auth, so a loader that stopped
// registering it would leave every provider unable to provide the capability it declared.
test("the extension offers basekit/auth's provider helpers as a host service", async () => {
  const registered = {};
  const tuiApi = {
    registerTab: () => {},
    registerCapabilities: (caps) => Object.assign(registered, caps),
  };

  await tuiExtension(tuiApi);

  const support = registered.services.find((service) => service.id === "provider-support");
  expect(support).toBeDefined();
  const capability = support.implementation.capability({ id: "stub", label: "Stub", models: {}, handleIr: async () => ({}) });
  expect(capability.id).toBe("stub");
  expect(typeof support.implementation.printAccounts).toBe("function");
});
