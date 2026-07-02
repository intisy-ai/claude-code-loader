// @ts-nocheck
// Custom TUI tab (loaded via HUB_TUI_EXTENSION). Main view: the Claude tier
// mapping + a selectable provider list. Enter a tier -> assign picker (all
// providers, grouped). Enter a provider -> browse that provider's models.
// Both list views: bold category headers, favorites pinned on top (and kept in
// their category), Tab toggles a favorite, search ignores the favorites section.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createAccountMenu } from "../core-loader/dist/account-menu.js";

const SLOTS = [
  { key: "opus", label: "Opus" },
  { key: "sonnet", label: "Sonnet" },
  { key: "haiku", label: "Haiku" },
  { key: "default", label: "Default" },
];

function configDir() { return process.env.HUB_CONFIG_DIR || join(homedir(), ".claude"); }
function reposDir() { return join(configDir(), "repos"); }
function configPath() { return join(configDir(), "config", "claude-code-loader.json"); }

function readConfig() {
  try { if (existsSync(configPath())) return JSON.parse(readFileSync(configPath(), "utf8")); } catch {}
  return {};
}

function writeConfig(cfg) {
  try {
    const dir = join(configDir(), "config");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
  } catch {}
}

// the live catalog core-auth fetched per provider (configDir/config/models.json;
// falls back to the pre-rename core-auth-models.json during the transition)
function modelCache() {
  for (const f of ["models.json", "core-auth-models.json"]) {
    try {
      const p = join(configDir(), "config", f);
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) || {};
    } catch {}
  }
  return {};
}

function allEntries() {
  const out = [];
  let repos = [];
  try { repos = readdirSync(reposDir()); } catch { return out; }
  const cache = modelCache();
  for (const repo of repos) {
    try {
      const pkg = JSON.parse(readFileSync(join(reposDir(), repo, "package.json"), "utf8"));
      const declared = (pkg.claudeHub && pkg.claudeHub.authProviders) || pkg.authProviders || [];
      for (const p of declared) {
        const provider = p.name || repo;
        const cached = cache[provider] && cache[provider].models;
        if (cached) {
          // prefer the live/cached catalog core-auth wrote at login
          for (const model of Object.keys(cached)) {
            out.push({ provider, model, name: (cached[model] && cached[model].name) || model, id: provider + "/" + model });
          }
        } else {
          // fall back to any static list the package still declares
          for (const m of (p.models || [])) {
            const model = typeof m === "string" ? m : m.id;
            const name = typeof m === "string" ? m : (m.name || m.id);
            out.push({ provider, model, name, id: provider + "/" + model });
          }
        }
      }
    } catch {}
  }
  return out;
}

function uniqueProviders() {
  const order = [];
  const counts = {};
  for (const e of allEntries()) {
    if (counts[e.provider] === undefined) { counts[e.provider] = 0; order.push(e.provider); }
    counts[e.provider]++;
  }
  return order.map((name) => ({ name, count: counts[name] }));
}

function resolveHandlerPath(providerName) {
  let repos = [];
  try { repos = readdirSync(reposDir()); } catch { return null; }
  for (const repo of repos) {
    try {
      const pkg = JSON.parse(readFileSync(join(reposDir(), repo, "package.json"), "utf8"));
      const declared = (pkg.claudeHub && pkg.claudeHub.authProviders) || pkg.authProviders || [];
      const match = declared.find((p) => (p.name || repo) === providerName);
      if (match && match.handler) return join(reposDir(), repo, match.handler);
    } catch {}
  }
  return null;
}

// open the provider's account/quota menu natively in-tab (shared with the
// OpenCode loader via core-loader's account-menu) — accounts, login, and the
// combined/per-account quota all render inside the loader chrome.
function openAccounts(providerName, tuiApi) {
  menu.open(resolveHandlerPath(providerName), tuiApi, providerName);
}

function groupByProvider(entries) {
  const groups = [];
  const by = {};
  for (const e of entries) {
    if (!by[e.provider]) { by[e.provider] = { provider: e.provider, items: [] }; groups.push(by[e.provider]); }
    by[e.provider].items.push(e);
  }
  return groups;
}

// favorites pinned on top AND kept in their provider category (listed twice);
// while searching the favorites section is dropped.
function buildList(entries) {
  const favSet = new Set(readConfig().favorites || []);
  const q = tab.search.toLowerCase();
  const filtered = entries.filter((e) => (e.model + " " + e.name).toLowerCase().indexOf(q) >= 0);
  const favs = q ? [] : filtered.filter((e) => favSet.has(e.id));
  const groups = groupByProvider(filtered);
  const selectable = favs.concat(...groups.map((g) => g.items));
  return { favSet, favs, groups, selectable };
}

const tab = { mode: "slots", cursor: 0, editingSlot: "opus", editingProvider: "", search: "", pickCursor: 0 };
const menu = createAccountMenu();

// model row + category header share the same left inset (text at column 4); the
// selection ">" sits in the gutter to the left so text never shifts.
function modelRow(h, e, sel) {
  const gutter = sel ? (h.ACCENT + "❯ " + h.RST) : "  ";
  const body = sel ? (h.BG_SEL + h.BOLD + h.WHITE) : h.GRAY;
  h.pushBody("  " + gutter + body + e.model + h.RST + h.GRAY + "  " + e.name + h.RST, sel);
}
function catHeader(h, label, first) {
  if (!first) h.pushBody("", false);          // newline between categories
  // bold + a distinct colour: bold alone is invisible on bright-black (GRAY)
  h.pushBody("    " + h.BOLD + h.ACCENT + label + h.RST, false);
}

function renderList(h, title, built) {
  const { favs, groups, selectable } = built;
  h.pushBody("  " + h.BOLD + h.WHITE + "" + title + " " + h.RST +
    h.BG_SEL + " Search: " + tab.search + "_ " + h.RST, false);
  if (selectable.length === 0) h.pushBody("  " + h.GRAY + "No matching models." + h.RST, false);
  let i = 0;
  let first = true;
  const rows = (items) => items.forEach((e) => { modelRow(h, e, i === tab.pickCursor); i++; });
  if (favs.length) { catHeader(h, "Favorites", first); first = false; rows(favs); }
  for (const g of groups) { catHeader(h, g.provider, first); first = false; rows(g.items); }
  h.pushBody("", false);
  h.pushFoot("  " + h.GRAY + "─".repeat(h.barW) + h.RST);
  h.pushFoot("  " + h.DIM + "Type to filter   ^v Move   " + (tab.mode === "pick" ? "Enter Select   " : "") + "Tab Favorite   Esc Back" + h.RST);
}

function renderSlots(h) {
  const map = readConfig().modelMap || {};
  const provs = uniqueProviders();
  h.pushBody("  " + h.BOLD + h.WHITE + "Claude model mapping" + h.RST, false);
  h.pushBody("  " + h.DIM + "Assign each Claude tier to a provider model." + h.RST, false);
  h.pushBody("", false);
  SLOTS.forEach((slot, i) => {
    const sel = tab.cursor === i;
    const a = map[slot.key];
    const value = a && a.provider ? (h.ACCENT + a.provider + " / " + a.model + h.RST) : (h.DIM + "(unset)" + h.RST);
    const gutter = sel ? (h.ACCENT + "❯ " + h.RST) : "  ";
    h.pushBody("  " + gutter + (sel ? h.BG_SEL + h.BOLD + h.WHITE : h.GRAY) + h.pad(slot.label, 10) + h.RST + h.GRAY + " -> " + h.RST + value, sel);
  });
  h.pushBody("", false);
  h.pushBody("  " + h.BOLD + h.WHITE + "Providers (" + provs.length + ")" + h.RST, false);
  if (provs.length === 0) h.pushBody("    " + h.GRAY + "None installed." + h.RST, false);
  provs.forEach((p, j) => {
    const sel = tab.cursor === SLOTS.length + j;
    const gutter = sel ? (h.ACCENT + "❯ " + h.RST) : "  ";
    h.pushBody("  " + gutter + (sel ? h.BG_SEL + h.BOLD + h.WHITE : h.GRAY) + p.name + h.RST + h.DIM + "  (" + p.count + " model" + (p.count === 1 ? "" : "s") + ")" + h.RST, sel);
  });
  h.pushBody("", false);
  h.pushFoot("  " + h.GRAY + "─".repeat(h.barW) + h.RST);
  h.pushFoot("  " + h.DIM + "^v Move   Enter Models   a Accounts + Quota   Tab Switch   Q Quit" + h.RST);
}

function render(state, h) {
  if (menu.render(h)) return;   // in-tab account/quota menu owns the tab while open
  if (tab.mode === "pick") { const slot = SLOTS.find((s) => s.key === tab.editingSlot); renderList(h, "Assign " + (slot ? slot.label : ""), buildList(allEntries())); }
  else if (tab.mode === "browse") renderList(h, tab.editingProvider + " models", buildList(allEntries().filter((e) => e.provider === tab.editingProvider)));
  else renderSlots(h);
}

function currentList() {
  if (tab.mode === "pick") return buildList(allEntries());
  return buildList(allEntries().filter((e) => e.provider === tab.editingProvider));
}

function handleKey(key, state, tuiApi) {
  if (menu.handleKey(key, tuiApi)) return;   // account/quota menu consumes keys while open
  if (tab.mode === "slots") {
    const provs = uniqueProviders();
    const total = SLOTS.length + provs.length;
    if (key === "up" || key === "w") { tab.cursor = (tab.cursor - 1 + total) % total; return; }
    if (key === "down" || key === "s") { tab.cursor = (tab.cursor + 1) % total; return; }
    if (key === "a" && tab.cursor >= SLOTS.length) { openAccounts(provs[tab.cursor - SLOTS.length].name, tuiApi); return; }
    if (key === "enter" || key === "space") {
      tab.search = ""; tab.pickCursor = 0;
      if (tab.cursor < SLOTS.length) { tab.editingSlot = SLOTS[tab.cursor].key; tab.mode = "pick"; }
      else { tab.editingProvider = provs[tab.cursor - SLOTS.length].name; tab.mode = "browse"; }
      if (tuiApi && tuiApi.setTextInput) tuiApi.setTextInput(true);
    }
    return;
  }

  // pick / browse (text-input): cursor lands on models only
  const close = () => { tab.mode = "slots"; if (tuiApi.setTextInput) tuiApi.setTextInput(false); };
  if (key === "escape") { close(); return; }
  if (key === "up") { tab.pickCursor = Math.max(0, tab.pickCursor - 1); return; }
  if (key === "down") { tab.pickCursor = Math.min(currentList().selectable.length - 1, tab.pickCursor + 1); return; }
  if (key === "backspace") { tab.search = tab.search.slice(0, -1); tab.pickCursor = 0; return; }
  if (key === "tab") {
    const e = currentList().selectable[tab.pickCursor];
    if (e) {
      const cfg = readConfig();
      const favs = new Set(cfg.favorites || []);
      if (favs.has(e.id)) favs.delete(e.id); else favs.add(e.id);
      cfg.favorites = Array.from(favs);
      writeConfig(cfg);
    }
    return;
  }
  if (key === "enter") {
    if (tab.mode !== "pick") return;   // browse mode: nothing to assign
    const e = currentList().selectable[tab.pickCursor];
    close();
    if (e) {
      const cfg = readConfig();
      cfg.modelMap = cfg.modelMap || {};
      cfg.modelMap[tab.editingSlot] = { provider: e.provider, model: e.model };
      writeConfig(cfg);
      try { if (tuiApi.flash) tuiApi.flash(tab.editingSlot + " -> " + e.provider + " / " + e.model); } catch {}
    }
    return;
  }
  if (typeof key === "string" && key.length === 1) { tab.search += key; tab.pickCursor = 0; }
}

export default function (tuiApi) {
  tuiApi.registerTab({ id: "providers", label: "Providers", render, handleKey });
}
