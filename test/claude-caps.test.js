// Unit tests for the pure helpers in src/claude-caps.ts, run against the
// esbuild-bundled dist/claude-caps.js (a standalone entry point — see
// build.mjs) via Node's built-in test runner: `node --test test/claude-caps.test.js`.
// Package.json declares "type":"module", so this file is loaded as ESM.
import test from "node:test";
import assert from "node:assert";
import { groupSessions, pickAiTitle, parseEnabledPlugins, parseMarketplaces } from "../dist/claude-caps.js";

// ---- groupSessions ---------------------------------------------------------

const DIR = "/home/u/proj";
const OTHER = "/home/u/other";
const historyEntries = [
  { project: DIR, sessionId: "s1", display: "first prompt of s1", timestamp: 100 },
  { project: DIR, sessionId: "s1", display: "later prompt of s1", timestamp: 300 },
  { project: DIR, sessionId: "s2", display: "only prompt of s2", timestamp: 200 },
  { project: OTHER, sessionId: "s3", display: "belongs to other", timestamp: 999 },
  { project: DIR, sessionId: "s4", timestamp: 50 }, // no display
];

test("groupSessions: groups by sessionId for the given dir only, newest first", () => {
  const out = groupSessions(historyEntries, DIR);
  assert.deepStrictEqual(out.map((s) => s.id), ["s1", "s2", "s4"]); // lastUsed desc: 300, 200, 50
});

test("groupSessions: title is the session's earliest prompt (first prompt)", () => {
  const out = groupSessions(historyEntries, DIR);
  const s1 = out.find((s) => s.id === "s1");
  assert.strictEqual(s1.title, "first prompt of s1");
});

test("groupSessions: lastUsed is the max timestamp; count is entries in the group", () => {
  const out = groupSessions(historyEntries, DIR);
  const s1 = out.find((s) => s.id === "s1");
  assert.strictEqual(s1.lastUsed, 300);
  assert.strictEqual(s1.count, 2);
});

test("groupSessions: a session with no prompt gets a placeholder title", () => {
  const out = groupSessions(historyEntries, DIR);
  const s4 = out.find((s) => s.id === "s4");
  assert.strictEqual(s4.title, "(no prompt)");
});

test("groupSessions: entries from other projects are excluded", () => {
  const out = groupSessions(historyEntries, DIR);
  assert.ok(!out.some((s) => s.id === "s3"));
});

// ---- pickAiTitle ------------------------------------------------------------

test("pickAiTitle: returns null for empty/nullish transcript text", () => {
  assert.strictEqual(pickAiTitle(""), null);
  assert.strictEqual(pickAiTitle(null), null);
});

test("pickAiTitle: returns null when no ai-title line is present", () => {
  const text = [
    JSON.stringify({ type: "user", message: "hi" }),
    JSON.stringify({ type: "assistant", message: "hello" }),
  ].join("\n");
  assert.strictEqual(pickAiTitle(text), null);
});

test("pickAiTitle: the LAST ai-title line wins", () => {
  const text = [
    JSON.stringify({ type: "ai-title", aiTitle: "First title", sessionId: "s1" }),
    JSON.stringify({ type: "user", message: "more chat" }),
    JSON.stringify({ type: "ai-title", aiTitle: "Final title", sessionId: "s1" }),
  ].join("\n");
  assert.strictEqual(pickAiTitle(text), "Final title");
});

test("pickAiTitle: skips malformed/non-JSON lines", () => {
  const text = [
    "not json at all",
    JSON.stringify({ type: "ai-title", aiTitle: "Real title" }),
    "",
  ].join("\n");
  assert.strictEqual(pickAiTitle(text), "Real title");
});

// ---- parseEnabledPlugins -----------------------------------------------------

test("parseEnabledPlugins: splits name@marketplace and carries the enabled bool", () => {
  const settings = { enabledPlugins: { "ecc@intisy-ai/marketplace": true, "superpowers@obra": false } };
  const out = parseEnabledPlugins(settings, null);
  const ecc = out.find((p) => p.name === "ecc");
  const sp = out.find((p) => p.name === "superpowers");
  assert.strictEqual(ecc.source, "intisy-ai/marketplace");
  assert.strictEqual(ecc.enabled, true);
  assert.strictEqual(sp.source, "obra");
  assert.strictEqual(sp.enabled, false);
});

test("parseEnabledPlugins: looks up version from installed_plugins.json", () => {
  const settings = { enabledPlugins: { "ecc@intisy-ai/marketplace": true } };
  const installed = { version: 2, plugins: { "ecc@intisy-ai/marketplace": [{ version: "1.2.3" }] } };
  const out = parseEnabledPlugins(settings, installed);
  assert.strictEqual(out[0].version, "1.2.3");
});

test("parseEnabledPlugins: version is null when not present in installed_plugins.json", () => {
  const settings = { enabledPlugins: { "ecc@intisy-ai/marketplace": true } };
  const out = parseEnabledPlugins(settings, {});
  assert.strictEqual(out[0].version, null);
});

test("parseEnabledPlugins: returns [] when enabledPlugins is absent", () => {
  assert.deepStrictEqual(parseEnabledPlugins({}, {}), []);
  assert.deepStrictEqual(parseEnabledPlugins(null, null), []);
});

// ---- parseMarketplaces --------------------------------------------------------

test("parseMarketplaces: extracts repo/url source from known_marketplaces.json shape", () => {
  const known = {
    official: { source: { source: "github", repo: "intisy-ai/marketplace" }, lastUpdated: 1 },
    custom: { source: { source: "git", url: "https://example.com/repo.git" } },
  };
  const out = parseMarketplaces(known, null);
  assert.strictEqual(out.find((m) => m.name === "official").source, "intisy-ai/marketplace");
  assert.strictEqual(out.find((m) => m.name === "custom").source, "https://example.com/repo.git");
});

test("parseMarketplaces: merges settings.json's extraKnownMarketplaces, deduped by name", () => {
  const known = { official: { source: { repo: "intisy-ai/marketplace" } } };
  const extra = {
    official: { source: { repo: "duplicate-should-be-ignored" } },
    mine: { source: { url: "https://example.com/mine.git" } },
  };
  const out = parseMarketplaces(known, extra);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out.find((m) => m.name === "official").source, "intisy-ai/marketplace");
  assert.strictEqual(out.find((m) => m.name === "mine").source, "https://example.com/mine.git");
});

test("parseMarketplaces: returns [] for absent/empty inputs", () => {
  assert.deepStrictEqual(parseMarketplaces(null, null), []);
  assert.deepStrictEqual(parseMarketplaces({}, {}), []);
});
