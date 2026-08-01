// uniqueProviders() now routes through core-loader's readDeployedProviders, so a
// provider materialized only via .dynamic-providers.json (custom-auth's per-endpoint
// providers) must show up alongside package.json-declared ones. Isolated temp
// HUB_CONFIG_DIR, never the real ~/.claude.
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { uniqueProviders } from "../tui-extension.js";

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

function writeRepo(repo, pkg, dynamicManifest) {
  const repoDir = join(homeDir, "repos", repo);
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "package.json"), JSON.stringify(pkg));
  if (dynamicManifest !== undefined) {
    writeFileSync(join(repoDir, ".dynamic-providers.json"), JSON.stringify(dynamicManifest));
  }
}

test("uniqueProviders: includes a provider materialized only via .dynamic-providers.json", () => {
  writeRepo(
    "custom-auth",
    { claudeHub: { authProviders: [] } },
    [{ name: "my-endpoint", handler: "dist/dynamic.js" }],
  );

  const names = uniqueProviders().map((p) => p.name);
  expect(names).toContain("my-endpoint");
});

test("uniqueProviders: still lists a package.json-declared provider alongside the dynamic one", () => {
  writeRepo(
    "stub-auth",
    { claudeHub: { authProviders: [{ name: "stub", handler: "dist/handler.js" }] } },
  );
  writeRepo(
    "custom-auth",
    { claudeHub: { authProviders: [] } },
    [{ name: "my-endpoint", handler: "dist/dynamic.js" }],
  );

  const names = uniqueProviders().map((p) => p.name);
  expect(names).toContain("stub");
  expect(names).toContain("my-endpoint");
});
