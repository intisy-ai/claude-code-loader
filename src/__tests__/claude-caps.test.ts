// Unit tests for the pure helpers in src/claude-caps.ts. Runs under this
// plugin's vitest suite (vitest.config.ts include: src/**/*.test.{ts,js}), so
// CI's `npx vitest run` collects it alongside contract.test.ts. Imports the
// helpers from SOURCE (no dist dependency) — vitest resolves the .ts.
import { test, expect } from "vitest";
import { groupSessions, pickAiTitle, parseEnabledPlugins, parseMarketplaces } from "../claude-caps.js";

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
  expect(out.map((s) => s.id)).toEqual(["s1", "s2", "s4"]); // lastUsed desc: 300, 200, 50
});

test("groupSessions: title is the session's earliest prompt (first prompt)", () => {
  const out = groupSessions(historyEntries, DIR);
  expect(out.find((s) => s.id === "s1").title).toBe("first prompt of s1");
});

test("groupSessions: lastUsed is the max timestamp; count is entries in the group", () => {
  const out = groupSessions(historyEntries, DIR);
  const s1 = out.find((s) => s.id === "s1");
  expect(s1.lastUsed).toBe(300);
  expect(s1.count).toBe(2);
});

test("groupSessions: a session with no prompt gets a placeholder title", () => {
  const out = groupSessions(historyEntries, DIR);
  expect(out.find((s) => s.id === "s4").title).toBe("(no prompt)");
});

test("groupSessions: entries from other projects are excluded", () => {
  const out = groupSessions(historyEntries, DIR);
  expect(out.some((s) => s.id === "s3")).toBe(false);
});

// ---- pickAiTitle ------------------------------------------------------------

test("pickAiTitle: returns null for empty/nullish transcript text", () => {
  expect(pickAiTitle("")).toBe(null);
  expect(pickAiTitle(null)).toBe(null);
});

test("pickAiTitle: returns null when no ai-title line is present", () => {
  const text = [
    JSON.stringify({ type: "user", message: "hi" }),
    JSON.stringify({ type: "assistant", message: "hello" }),
  ].join("\n");
  expect(pickAiTitle(text)).toBe(null);
});

test("pickAiTitle: the LAST ai-title line wins", () => {
  const text = [
    JSON.stringify({ type: "ai-title", aiTitle: "First title", sessionId: "s1" }),
    JSON.stringify({ type: "user", message: "more chat" }),
    JSON.stringify({ type: "ai-title", aiTitle: "Final title", sessionId: "s1" }),
  ].join("\n");
  expect(pickAiTitle(text)).toBe("Final title");
});

test("pickAiTitle: skips malformed/non-JSON lines", () => {
  const text = [
    "not json at all",
    JSON.stringify({ type: "ai-title", aiTitle: "Real title" }),
    "",
  ].join("\n");
  expect(pickAiTitle(text)).toBe("Real title");
});

// ---- parseEnabledPlugins -----------------------------------------------------

test("parseEnabledPlugins: splits name@marketplace and carries the enabled bool", () => {
  const settings = { enabledPlugins: { "ecc@intisy-ai/marketplace": true, "superpowers@obra": false } };
  const out = parseEnabledPlugins(settings, null);
  const ecc = out.find((p) => p.name === "ecc");
  const sp = out.find((p) => p.name === "superpowers");
  expect(ecc.source).toBe("intisy-ai/marketplace");
  expect(ecc.enabled).toBe(true);
  expect(sp.source).toBe("obra");
  expect(sp.enabled).toBe(false);
});

test("parseEnabledPlugins: splits on the LAST @ so an @-containing name keeps its marketplace", () => {
  const settings = { enabledPlugins: { "@scope/pkg@intisy-ai/marketplace": true } };
  const out = parseEnabledPlugins(settings, null);
  expect(out[0].name).toBe("@scope/pkg");
  expect(out[0].source).toBe("intisy-ai/marketplace");
});

test("parseEnabledPlugins: looks up version from installed_plugins.json", () => {
  const settings = { enabledPlugins: { "ecc@intisy-ai/marketplace": true } };
  const installed = { version: 2, plugins: { "ecc@intisy-ai/marketplace": [{ version: "1.2.3" }] } };
  const out = parseEnabledPlugins(settings, installed);
  expect(out[0].version).toBe("1.2.3");
});

test("parseEnabledPlugins: version is null when not present in installed_plugins.json", () => {
  const settings = { enabledPlugins: { "ecc@intisy-ai/marketplace": true } };
  const out = parseEnabledPlugins(settings, {});
  expect(out[0].version).toBe(null);
});

test("parseEnabledPlugins: returns [] when enabledPlugins is absent", () => {
  expect(parseEnabledPlugins({}, {})).toEqual([]);
  expect(parseEnabledPlugins(null, null)).toEqual([]);
});

// ---- parseMarketplaces --------------------------------------------------------

test("parseMarketplaces: extracts repo/url source from known_marketplaces.json shape", () => {
  const known = {
    official: { source: { source: "github", repo: "intisy-ai/marketplace" }, lastUpdated: 1 },
    custom: { source: { source: "git", url: "https://example.com/repo.git" } },
  };
  const out = parseMarketplaces(known, null);
  expect(out.find((m) => m.name === "official").source).toBe("intisy-ai/marketplace");
  expect(out.find((m) => m.name === "custom").source).toBe("https://example.com/repo.git");
});

test("parseMarketplaces: merges settings.json's extraKnownMarketplaces, deduped by name (known wins)", () => {
  const known = { official: { source: { repo: "intisy-ai/marketplace" } } };
  const extra = {
    official: { source: { repo: "duplicate-should-be-ignored" } },
    mine: { source: { url: "https://example.com/mine.git" } },
  };
  const out = parseMarketplaces(known, extra);
  expect(out.length).toBe(2);
  expect(out.find((m) => m.name === "official").source).toBe("intisy-ai/marketplace");
  expect(out.find((m) => m.name === "mine").source).toBe("https://example.com/mine.git");
});

test("parseMarketplaces: returns [] for absent/empty inputs", () => {
  expect(parseMarketplaces(null, null)).toEqual([]);
  expect(parseMarketplaces({}, {})).toEqual([]);
});
