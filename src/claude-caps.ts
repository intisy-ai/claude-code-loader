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
import { loaderConfigDir } from "@intisy-ai/core-loader/dist/app-home.js";
import { readDeployedManifests } from "@intisy-ai/api/host";
import { homePaths } from "@intisy-ai/core-loader/dist/home-paths.js";
import type { HomePaths } from "@intisy-ai/core-loader/dist/home-paths.js";
import type {
  CapabilityMarketplace,
  CapabilityMarketplacePlugin,
  CapabilityMcpServer,
  CapabilityResult,
  ForeignPlugin,
  McpServerDraft,
  SessionEntry,
} from "@intisy-ai/core-loader/dist/app-capabilities.js";

/** One line of this app's own history file. */
interface HistoryEntry {
  /** The project directory it belongs to. */
  project?: string;
  /** The session it belongs to. */
  sessionId?: string;
  /** When it happened, in epoch milliseconds. */
  timestamp?: number;
  /** The prompt text, which is what a session is titled by until an ai-title lands. */
  display?: string;
}

/** One session while it is being grouped, before it becomes a row. */
interface SessionGroup {
  /** The session id. */
  id: string;
  /** How many history entries it holds. */
  count: number;
  /** The newest of their timestamps. */
  lastUsed: number;
  /** The oldest of them, which is what picks the first prompt. */
  firstTs: number;
  /** That first prompt. */
  firstPrompt: string | null;
}

/** One marketplace as this app's own config declares it. */
interface KnownMarketplace {
  /** Where it came from: a repo, a URL, or an object holding either. */
  source?: string | { repo?: string; url?: string };
  /** Where its clone lives, which is what a plugin count is read from. */
  installLocation?: string;
}

/** A cloned marketplace's own manifest, as far as this adapter reads it. */
interface MarketplaceManifest {
  /** The plugins it offers. */
  plugins?: Array<{ name?: string; description?: string }>;
}

/** The part of this app's settings file this adapter reads. */
interface AppSettings {
  /** Each installed plugin's enabled state, keyed `name@marketplace`. */
  enabledPlugins?: Record<string, boolean>;
  /** Marketplaces declared here rather than in the marketplace file. */
  extraKnownMarketplaces?: Record<string, KnownMarketplace>;
}

/** The installed-plugin record this app keeps beside its settings. */
interface InstalledPlugins {
  /** Each installed plugin's versions, keyed `name@marketplace`. */
  plugins?: Record<string, Array<{ version?: string }>>;
}

/** The little of a deployed plugin's manifest a capability lookup needs. */
interface ManifestLike {
  /** The plugin's id. */
  id: string;
  /** What it declares it provides. */
  capabilities?: string[];
}

/** Which plugin owns a capability, and where it was installed from when that is known. */
interface CapabilityOwner {
  /** The owning plugin's id. */
  id: string;
  /** Its clone URL, when this home's plugin list names one. */
  url: string | undefined;
}

const APP_HOME = join(homedir(), ".claude");

// ---------------------------------------------------------------------------
// Pure helpers (no fs access), unit-tested in src/__tests__/claude-caps.test.ts
// ---------------------------------------------------------------------------

// Group history.jsonl entries belonging to `dir` by sessionId. title is the
// display text of the earliest-timestamped entry in the group (the session's
// first prompt); AI-title enrichment happens in the listSessions() I/O
// wrapper, which overwrites title when a transcript ai-title is found.
export function groupSessions(historyEntries: HistoryEntry[] | null | undefined, dir: string): SessionEntry[] {
  const groups: Record<string, SessionGroup> = {};
  const order: string[] = [];
  (historyEntries || []).forEach((e) => {
    if (!e || e.project !== dir || !e.sessionId) return;
    let g: SessionGroup | undefined = groups[e.sessionId];
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
export function pickAiTitle(transcriptText: string | null | undefined): string | null {
  if (!transcriptText) return null;
  const lines = String(transcriptText).split("\n");
  let last: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: { type?: string; aiTitle?: string };
    try { obj = JSON.parse(trimmed); } catch (e) { continue; }
    if (obj && obj.type === "ai-title" && obj.aiTitle) last = obj.aiTitle;
  }
  return last;
}

// settings.json's enabledPlugins = {"name@marketplace": bool}; version is
// looked up in plugins/installed_plugins.json's {plugins:{"name@marketplace":[{version}]}}.
export function parseEnabledPlugins(settingsObj: AppSettings | null | undefined, installedObj: InstalledPlugins | null | undefined): ForeignPlugin[] {
  const out: ForeignPlugin[] = [];
  const enabled = (settingsObj && settingsObj.enabledPlugins) || {};
  const installedPlugins = (installedObj && installedObj.plugins) || {};
  Object.keys(enabled).forEach((key) => {
    // split on the LAST "@" so a plugin name that itself contains "@" still
    // yields the trailing marketplace as the source.
    const idx = key.lastIndexOf("@");
    const name = idx >= 0 ? key.slice(0, idx) : key;
    const source = idx >= 0 ? key.slice(idx + 1) : "";
    let version: string | undefined;
    const installedEntry = installedPlugins[key];
    if (Array.isArray(installedEntry) && installedEntry[0] && installedEntry[0].version) version = installedEntry[0].version;
    out.push({ name, source, enabled: !!enabled[key], version });
  });
  return out;
}

function marketplaceSource(entry: KnownMarketplace | null | undefined): string {
  if (!entry) return "";
  const src = entry.source;
  if (!src) return "";
  if (typeof src === "string") return src;
  return src.repo || src.url || JSON.stringify(src);
}

// Merge known_marketplaces.json + settings.json's extraKnownMarketplaces
// (same shape), deduped by name (known wins on collision).
export function parseMarketplaces(knownObj: Record<string, KnownMarketplace> | null | undefined, extraObj: Record<string, KnownMarketplace> | null | undefined): Array<{ name: string; source: string }> {
  const out: Array<{ name: string; source: string }> = [];
  const seen: Record<string, boolean> = {};
  const addAll = (obj: Record<string, KnownMarketplace> | null | undefined) => {
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
export function countPlugins(marketplaceJsonObj: MarketplaceManifest | null | undefined): number {
  const plugins = marketplaceJsonObj && marketplaceJsonObj.plugins;
  return Array.isArray(plugins) ? plugins.length : 0;
}

// A marketplace's cloned .claude-plugin/marketplace.json -> its plugin list,
// tagged with the marketplace name as `source` (drill-in display shape).
// Entries are parsed defensively: real marketplace.json plugin entries carry
// at least `name`, usually `description`/`source`/`version`/etc (see
// ecc's .claude-plugin/marketplace.json for the reference shape).
export function parseMarketplacePlugins(marketplaceJsonObj: MarketplaceManifest | null | undefined, name: string): CapabilityMarketplacePlugin[] {
  const plugins = marketplaceJsonObj && marketplaceJsonObj.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.map((e) => ({
    id: (e && e.name) || "",
    name: (e && e.name) || "",
    description: (e && e.description) || "",
    source: name,
  }));
}

// Which deployed plugin provides a capability, given what a home's manifests declare. A capability
// id is the only key: no plugin is named here, and an id this loader has never heard of answers
// exactly like one it has.
export function ownerOfCapability(manifests: ManifestLike[] | null | undefined, capabilityId: string, urlFor?: (id: string) => string | undefined): CapabilityOwner | null {
  for (const manifest of manifests || []) {
    const declared = (manifest && manifest.capabilities) || [];
    if (declared.indexOf(capabilityId) === -1) continue;
    return { id: manifest.id, url: urlFor ? urlFor(manifest.id) : undefined };
  }
  return null;
}

function urlFromPluginList(paths: HomePaths, id: string): string | undefined {
  try {
    const listed = JSON.parse(readFileSync(join(paths.configFolder, "plugins.json"), "utf8"));
    const entry = ((listed || []) as Array<{ name?: string; url?: string }>).find((item) => item && item.name === id);
    return entry && typeof entry.url === "string" ? entry.url : undefined;
  } catch {
    return undefined;
  }
}

// The plugin that provides a capability in THIS home, read from the manifest sidecars deploy
// writes beside each bundle. Never throws into the TUI: an unreadable home answers null, which
// every caller already renders as "nothing offers this".
export function pluginByCapability(capabilityId: string): CapabilityOwner | null {
  try {
    const paths = homePaths(loaderConfigDir(APP_HOME));
    const manifests = readDeployedManifests(paths.pluginDir).loaded.map((entry) => entry.manifest) as ManifestLike[];
    return ownerOfCapability(manifests, capabilityId, (id) => urlFromPluginList(paths, id));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// I/O wrappers: read the real ~/.claude (or HUB_CONFIG_DIR) files.
// ---------------------------------------------------------------------------

function configDir() { return loaderConfigDir(APP_HOME); }

function readJsonSafe<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch (e) { return null; }
}

// ai-title is appended late in a transcript; for large files only the final
// ~256KB is read so a long-running session doesn't slow the TUI down.
function readTranscriptText(path: string): string {
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
function findTranscriptPath(sessionId: string): string | null {
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

export function listSessions(dir: string): SessionEntry[] {
  try {
    const histPath = join(configDir(), "history.jsonl");
    let text = "";
    try { text = readFileSync(histPath, "utf8"); } catch (e) { text = ""; }
    const entries: HistoryEntry[] = [];
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

export function foreignPlugins(): ForeignPlugin[] {
  try {
    const settings = readJsonSafe<AppSettings>(join(configDir(), "settings.json")) || {};
    const installed = readJsonSafe<InstalledPlugins>(join(configDir(), "plugins", "installed_plugins.json")) || {};
    return parseEnabledPlugins(settings, installed);
  } catch (e) { return []; }
}

// name -> {source, installLocation} from known_marketplaces.json +
// settings.json's extraKnownMarketplaces (known wins on collision).
function marketplaceEntries(): { known: Record<string, KnownMarketplace>; extra: Record<string, KnownMarketplace>; entries: Record<string, KnownMarketplace> } {
  const known = readJsonSafe<Record<string, KnownMarketplace>>(join(configDir(), "plugins", "known_marketplaces.json")) || {};
  const settings = readJsonSafe<AppSettings>(join(configDir(), "settings.json")) || {};
  const extra = (settings && typeof settings.extraKnownMarketplaces === "object") ? settings.extraKnownMarketplaces : {};
  const out: Record<string, KnownMarketplace> = {};
  [known, extra].forEach((obj) => {
    if (!obj || typeof obj !== "object") return;
    Object.keys(obj).forEach((name) => { if (!(name in out)) out[name] = obj[name]; });
  });
  return { known, extra, entries: out };
}

// installLocation's cloned .claude-plugin/marketplace.json, or null if the
// marketplace/clone/file is missing or unparsable.
function readMarketplaceJson(entry: KnownMarketplace | null | undefined): MarketplaceManifest | null {
  const loc = entry && entry.installLocation;
  if (!loc) return null;
  return readJsonSafe<MarketplaceManifest>(join(loc, ".claude-plugin", "marketplace.json"));
}

export function marketplaces(): CapabilityMarketplace[] {
  try {
    const { known, extra, entries } = marketplaceEntries();
    return parseMarketplaces(known, extra).map((m) => ({
      name: m.name,
      source: m.source,
      count: countPlugins(readMarketplaceJson(entries[m.name])),
    }));
  } catch (e) { return []; }
}

export function marketplacePlugins(name: string): CapabilityMarketplacePlugin[] {
  try {
    const { entries } = marketplaceEntries();
    return parseMarketplacePlugins(readMarketplaceJson(entries[name]), name);
  } catch (e) { return []; }
}

// Enable/disable an installed foreign plugin (key = "name@marketplace") via
// the CLI so `claude`'s own state stays authoritative.
export function setForeignPluginEnabled(key: string, enabled: boolean): CapabilityResult {
  try {
    execFileSync("claude", ["plugin", enabled ? "enable" : "disable", key], { stdio: "pipe" });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
}

export function uninstallForeignPlugin(key: string): CapabilityResult {
  try {
    execFileSync("claude", ["plugin", "uninstall", key], { stdio: "pipe" });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
}

// The supported way to register a marketplace so a running `claude` picks it
// up (writes go through the CLI, not a hand-rolled JSON edit).
export function addMarketplace(input: string): CapabilityResult {
  try {
    execFileSync("claude", ["plugin", "marketplace", "add", input], { stdio: "pipe" });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
}

// Install a plugin browsed via a capability-registered marketplace (a Level-2
// row from marketplacePlugins()). `pluginId` is the plugin's name within that
// marketplace; `marketplace` is the marketplace name it was drilled into from.
export function installAppPlugin(pluginId: string, marketplace: string): CapabilityResult {
  try {
    execFileSync("claude", ["plugin", "install", pluginId + "@" + marketplace], { stdio: "pipe" });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
}

export function mcpServers(): CapabilityMcpServer[] {
  try {
    const cfg = readJsonSafe<{ mcpServers?: Record<string, { type?: string; command?: string; url?: string }> }>(join(homedir(), ".claude.json")) || {};
    const servers = cfg.mcpServers || {};
    return Object.keys(servers).map((name): CapabilityMcpServer => {
      const c = servers[name] || {};
      const transport = c.type || (c.command ? "stdio" : "http");
      const detail = c.url || c.command || "";
      return { name, transport, detail };
    });
  } catch (e) { return []; }
}

export function addMcpServer(spec: McpServerDraft | null): CapabilityResult {
  try {
    const name = spec && spec.name;
    const transport = spec && spec.transport;
    const target = spec && spec.target;
    const args = transport === "http"
      ? ["mcp", "add", "--scope", "user", "--transport", "http", String(name), String(target)]
      : ["mcp", "add", "--scope", "user", "--transport", "stdio", String(name), "--", String(target)];
    execFileSync("claude", args, { stdio: "pipe" });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
}
