// @ts-nocheck
// Claude adapter for core-loader's app-capability contract (see
// libs/core-loader "S.capabilities" / tuiApi.registerCapabilities). Every
// Claude-specific file path/shape lives here so core-loader stays generic.
// Pure helpers (groupSessions/pickAiTitle/parseEnabledPlugins/parseMarketplaces)
// are exported standalone and unit-tested with plain-object inputs; the I/O
// wrappers below them read the real ~/.claude files and never throw into the
// TUI (every read is try/catch-guarded with a sensible empty fallback).

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Pure helpers (no fs access) — unit-tested in test/claude-caps.test.js
// ---------------------------------------------------------------------------

// Group history.jsonl entries belonging to `dir` by sessionId. title is the
// display text of the earliest-timestamped entry in the group (the session's
// first prompt); AI-title enrichment happens in the listSessions() I/O
// wrapper, which overwrites title when a transcript ai-title is found.
export function groupSessions(historyEntries, dir) {
  const groups = {};
  const order = [];
  (historyEntries || []).forEach((e) => {
    if (!e || e.project !== dir || !e.sessionId) return;
    let g = groups[e.sessionId];
    if (!g) {
      g = { id: e.sessionId, count: 0, lastUsed: -Infinity, firstTs: Infinity, firstPrompt: null };
      groups[e.sessionId] = g;
      order.push(e.sessionId);
    }
    g.count++;
    const ts = typeof e.timestamp === "number" ? e.timestamp : 0;
    if (ts > g.lastUsed) g.lastUsed = ts;
    if (ts < g.firstTs) { g.firstTs = ts; g.firstPrompt = e.display || null; }
  });
  const out = order.map((id) => {
    const g = groups[id];
    return { id, title: g.firstPrompt || "(no prompt)", lastUsed: g.lastUsed, count: g.count };
  });
  out.sort((a, b) => b.lastUsed - a.lastUsed);
  return out;
}

// Last `{"type":"ai-title","aiTitle":...}` line in a transcript's raw text, or
// null when none is present. Malformed/non-JSON lines are skipped.
export function pickAiTitle(transcriptText) {
  if (!transcriptText) return null;
  const lines = String(transcriptText).split("\n");
  let last = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch (e) { continue; }
    if (obj && obj.type === "ai-title" && obj.aiTitle) last = obj.aiTitle;
  }
  return last;
}

// settings.json's enabledPlugins = {"name@marketplace": bool}; version is
// looked up in plugins/installed_plugins.json's {plugins:{"name@marketplace":[{version}]}}.
export function parseEnabledPlugins(settingsObj, installedObj) {
  const out = [];
  const enabled = (settingsObj && settingsObj.enabledPlugins) || {};
  const installedPlugins = (installedObj && installedObj.plugins) || {};
  Object.keys(enabled).forEach((key) => {
    // split on the LAST "@" so a plugin name that itself contains "@" still
    // yields the trailing marketplace as the source.
    const idx = key.lastIndexOf("@");
    const name = idx >= 0 ? key.slice(0, idx) : key;
    const source = idx >= 0 ? key.slice(idx + 1) : "";
    let version = null;
    const installedEntry = installedPlugins[key];
    if (Array.isArray(installedEntry) && installedEntry[0] && installedEntry[0].version) version = installedEntry[0].version;
    out.push({ name, source, enabled: !!enabled[key], version });
  });
  return out;
}

function marketplaceSource(entry) {
  if (!entry) return "";
  const src = entry.source;
  if (!src) return "";
  if (typeof src === "string") return src;
  return src.repo || src.url || JSON.stringify(src);
}

// Merge known_marketplaces.json + settings.json's extraKnownMarketplaces
// (same shape), deduped by name (known wins on collision).
export function parseMarketplaces(knownObj, extraObj) {
  const out = [];
  const seen = {};
  const addAll = (obj) => {
    if (!obj || typeof obj !== "object") return;
    Object.keys(obj).forEach((name) => {
      if (seen[name]) return;
      seen[name] = true;
      out.push({ name, source: marketplaceSource(obj[name]) });
    });
  };
  addAll(knownObj);
  addAll(extraObj);
  return out;
}

// A marketplace's cloned .claude-plugin/marketplace.json -> its plugin count.
// 0 for any missing/malformed input (unreadable clone, no plugins array, etc).
export function countPlugins(marketplaceJsonObj) {
  const plugins = marketplaceJsonObj && marketplaceJsonObj.plugins;
  return Array.isArray(plugins) ? plugins.length : 0;
}

// A marketplace's cloned .claude-plugin/marketplace.json -> its plugin list,
// tagged with the marketplace name as `source` (drill-in display shape).
// Entries are parsed defensively: real marketplace.json plugin entries carry
// at least `name`, usually `description`/`source`/`version`/etc (see
// ecc's .claude-plugin/marketplace.json for the reference shape).
export function parseMarketplacePlugins(marketplaceJsonObj, name) {
  const plugins = marketplaceJsonObj && marketplaceJsonObj.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.map((e) => ({
    id: (e && e.name) || "",
    name: (e && e.name) || "",
    description: (e && e.description) || "",
    source: name,
  }));
}

// ---------------------------------------------------------------------------
// I/O wrappers — read the real ~/.claude (or HUB_CONFIG_DIR) files.
// ---------------------------------------------------------------------------

function configDir() { return process.env.HUB_CONFIG_DIR || join(homedir(), ".claude"); }

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { return null; }
}

// ai-title is appended late in a transcript; for large files only the final
// ~256KB is read so a long-running session doesn't slow the TUI down.
function readTranscriptText(path) {
  try {
    const size = statSync(path).size;
    if (size > 1048576) {   // > 1 MiB
      const len = 256 * 1024;
      const fd = openSync(path, "r");
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      closeSync(fd);
      return buf.toString("utf8");
    }
    return readFileSync(path, "utf8");
  } catch (e) { return ""; }
}

// sessionId is unique across projects, so a linear scan of projects/* is fine.
function findTranscriptPath(sessionId) {
  try {
    const projectsDir = join(configDir(), "projects");
    const subs = readdirSync(projectsDir);
    for (const sub of subs) {
      const p = join(projectsDir, sub, sessionId + ".jsonl");
      if (existsSync(p)) return p;
    }
  } catch (e) {}
  return null;
}

export function listSessions(dir) {
  try {
    const histPath = join(configDir(), "history.jsonl");
    let text = "";
    try { text = readFileSync(histPath, "utf8"); } catch (e) { text = ""; }
    const entries = [];
    text.split("\n").forEach((line) => {
      const l = line.trim();
      if (!l) return;
      try { entries.push(JSON.parse(l)); } catch (e) {}
    });
    const groups = groupSessions(entries, dir);
    groups.forEach((g) => {
      try {
        const tp = findTranscriptPath(g.id);
        if (tp) {
          const aiTitle = pickAiTitle(readTranscriptText(tp));
          if (aiTitle) g.title = aiTitle;
        }
      } catch (e) {}
    });
    return groups;
  } catch (e) { return []; }
}

export function foreignPlugins() {
  try {
    const settings = readJsonSafe(join(configDir(), "settings.json")) || {};
    const installed = readJsonSafe(join(configDir(), "plugins", "installed_plugins.json")) || {};
    return parseEnabledPlugins(settings, installed);
  } catch (e) { return []; }
}

// name -> {source, installLocation} from known_marketplaces.json +
// settings.json's extraKnownMarketplaces (known wins on collision).
function marketplaceEntries() {
  const known = readJsonSafe(join(configDir(), "plugins", "known_marketplaces.json")) || {};
  const settings = readJsonSafe(join(configDir(), "settings.json")) || {};
  const extra = (settings && typeof settings.extraKnownMarketplaces === "object") ? settings.extraKnownMarketplaces : {};
  const out = {};
  [known, extra].forEach((obj) => {
    if (!obj || typeof obj !== "object") return;
    Object.keys(obj).forEach((name) => { if (!(name in out)) out[name] = obj[name]; });
  });
  return { known, extra, entries: out };
}

// installLocation's cloned .claude-plugin/marketplace.json, or null if the
// marketplace/clone/file is missing or unparsable.
function readMarketplaceJson(entry) {
  const loc = entry && entry.installLocation;
  if (!loc) return null;
  return readJsonSafe(join(loc, ".claude-plugin", "marketplace.json"));
}

export function marketplaces() {
  try {
    const { known, extra, entries } = marketplaceEntries();
    return parseMarketplaces(known, extra).map((m) => ({
      name: m.name,
      source: m.source,
      count: countPlugins(readMarketplaceJson(entries[m.name])),
    }));
  } catch (e) { return []; }
}

export function marketplacePlugins(name) {
  try {
    const { entries } = marketplaceEntries();
    return parseMarketplacePlugins(readMarketplaceJson(entries[name]), name);
  } catch (e) { return []; }
}

// Enable/disable an installed foreign plugin (key = "name@marketplace") via
// the CLI so `claude`'s own state stays authoritative.
export function setForeignPluginEnabled(key, enabled) {
  try {
    execFileSync("claude", ["plugin", enabled ? "enable" : "disable", key], { stdio: "pipe" });
    return { ok: true };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

export function uninstallForeignPlugin(key) {
  try {
    execFileSync("claude", ["plugin", "uninstall", key], { stdio: "pipe" });
    return { ok: true };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

// The supported way to register a marketplace so a running `claude` picks it
// up (writes go through the CLI, not a hand-rolled JSON edit).
export function addMarketplace(input) {
  try {
    execFileSync("claude", ["plugin", "marketplace", "add", input], { stdio: "pipe" });
    return { ok: true };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

export function mcpServers() {
  try {
    const cfg = readJsonSafe(join(homedir(), ".claude.json")) || {};
    const servers = cfg.mcpServers || {};
    return Object.keys(servers).map((name) => {
      const c = servers[name] || {};
      const transport = c.type || (c.command ? "stdio" : "http");
      const detail = c.url || c.command || "";
      return { name, transport, detail };
    });
  } catch (e) { return []; }
}

export function addMcpServer(spec) {
  try {
    const name = spec && spec.name;
    const transport = spec && spec.transport;
    const target = spec && spec.target;
    const args = transport === "http"
      ? ["mcp", "add", "--scope", "user", "--transport", "http", name, target]
      : ["mcp", "add", "--scope", "user", "--transport", "stdio", name, "--", target];
    execFileSync("claude", args, { stdio: "pipe" });
    return { ok: true };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}
