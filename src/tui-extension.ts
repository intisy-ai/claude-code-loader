// @ts-nocheck
// Custom TUI tab (loaded via HUB_TUI_EXTENSION): map each Claude tier to a
// provider model. slot -> provider list -> that provider's models (searchable).
// Favorites (Tab) pin to a section at the top of each list.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const SLOTS = [
  { key: "opus", label: "Opus" },
  { key: "sonnet", label: "Sonnet" },
  { key: "haiku", label: "Haiku" },
  { key: "default", label: "Default" },
];
const WINDOW = 14;

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

function providersList() {
  const out = [];
  const seen = {};
  let repos = [];
  try { repos = readdirSync(reposDir()); } catch { return out; }
  for (const repo of repos) {
    try {
      const pkg = JSON.parse(readFileSync(join(reposDir(), repo, "package.json"), "utf8"));
      const declared = (pkg.claudeHub && pkg.claudeHub.authProviders) || pkg.authProviders || [];
      for (const p of declared) {
        const name = p.name || repo;
        if (seen[name]) continue;
        seen[name] = true;
        out.push({ name });
      }
    } catch {}
  }
  return out;
}

function modelsFor(provider) {
  const out = [];
  let repos = [];
  try { repos = readdirSync(reposDir()); } catch { return out; }
  for (const repo of repos) {
    try {
      const pkg = JSON.parse(readFileSync(join(reposDir(), repo, "package.json"), "utf8"));
      const declared = (pkg.claudeHub && pkg.claudeHub.authProviders) || pkg.authProviders || [];
      for (const p of declared) {
        if ((p.name || repo) !== provider) continue;
        for (const m of (p.models || [])) {
          const model = typeof m === "string" ? m : m.id;
          const name = typeof m === "string" ? m : (m.name || m.id);
          out.push({ provider, model, name, id: provider + "/" + model });
        }
      }
    } catch {}
  }
  return out;
}

const tab = {
  mode: "slots", slotCursor: 0, editingSlot: "opus",
  provCursor: 0, editingProvider: "",
  search: "", modelCursor: 0,
};

// --- shared rendering helpers ---
function catHeader(h, label) {
  // category labels: indented, soft colour (not purple), star kept yellow
  h.pushBody("    " + h.YELLOW + "★ " + h.RST + h.GRAY + label + h.RST, false);
}

function windowed(items, cursor) {
  const start = Math.max(0, Math.min(cursor - Math.floor(WINDOW / 2), Math.max(0, items.length - WINDOW)));
  return { start, end: Math.min(items.length, start + WINDOW) };
}

// --- providers level ---
function buildProviders() {
  const favSet = new Set(readConfig().favoriteProviders || []);
  const provs = providersList();
  const favs = provs.filter((p) => favSet.has(p.name));
  const rest = provs.filter((p) => !favSet.has(p.name));
  return { favSet, favs, rest, selectable: favs.concat(rest) };
}

function renderProviders(h) {
  const { favSet, favs, rest, selectable } = buildProviders();
  if (tab.provCursor >= selectable.length) tab.provCursor = Math.max(0, selectable.length - 1);
  const slot = SLOTS.find((s) => s.key === tab.editingSlot);
  h.pushBody("  " + h.MAGENTA + "#" + h.GRAY + " Provider for " + (slot ? slot.label : "") + h.RST, false);
  if (selectable.length === 0) h.pushBody("  " + h.GRAY + "No providers installed." + h.RST, false);
  const { start, end } = windowed(selectable, tab.provCursor);
  let i = 0;
  const row = (p) => {
    if (i >= start && i < end) {
      const sel = i === tab.provCursor;
      const star = favSet.has(p.name) ? (h.YELLOW + "★ " + h.RST) : "  ";
      const arrow = sel ? (h.YELLOW + " > " + h.RST) : "   ";
      h.pushBody("  " + (sel ? h.BG_SEL : "") + arrow + star + (sel ? h.BOLD + h.WHITE : h.GRAY) + p.name + h.RST, sel);
    }
    i++;
  };
  if (favs.length && start === 0) catHeader(h, "Favorites");
  favs.forEach(row);
  rest.forEach(row);
  h.pushBody("", false);
  h.pushFoot("  " + h.GRAY + "-".repeat(h.barW) + h.RST);
  h.pushFoot("  " + h.DIM + "^v Move   Enter Open   Tab ★ Favorite   Esc Back" + h.RST);
}

// --- models level ---
function buildModels() {
  const favSet = new Set(readConfig().favorites || []);
  const q = tab.search.toLowerCase();
  const match = (m) => (m.model + " " + m.name).toLowerCase().indexOf(q) >= 0;
  const all = modelsFor(tab.editingProvider).filter(match);
  if (q) return { favSet, searching: true, favs: [], rest: all, selectable: all };
  const favs = all.filter((m) => favSet.has(m.id));
  const rest = all.filter((m) => !favSet.has(m.id));
  return { favSet, searching: false, favs, rest, selectable: favs.concat(rest) };
}

function renderModels(h) {
  const { favSet, searching, favs, rest, selectable } = buildModels();
  if (tab.modelCursor >= selectable.length) tab.modelCursor = Math.max(0, selectable.length - 1);
  const slot = SLOTS.find((s) => s.key === tab.editingSlot);
  h.pushBody("  " + h.MAGENTA + "#" + h.GRAY + " " + (slot ? slot.label : "") + " <- " + tab.editingProvider + " " + h.RST +
    h.BG_SEL + " Search: " + tab.search + "_ " + h.RST, false);
  if (selectable.length === 0) h.pushBody("  " + h.GRAY + "No matching models." + h.RST, false);
  const { start, end } = windowed(selectable, tab.modelCursor);
  let i = 0;
  const row = (m) => {
    if (i >= start && i < end) {
      const sel = i === tab.modelCursor;
      const star = favSet.has(m.id) ? (h.YELLOW + "★ " + h.RST) : "  ";
      const arrow = sel ? (h.YELLOW + " > " + h.RST) : "   ";
      h.pushBody("  " + (sel ? h.BG_SEL : "") + arrow + star + (sel ? h.BOLD + h.WHITE : h.GRAY) + m.model + h.RST + h.GRAY + "  " + m.name + h.RST, sel);
    }
    i++;
  };
  // when searching, search as if favorites don't exist (one flat list, no section)
  if (!searching && favs.length && start === 0) catHeader(h, "Favorites");
  favs.forEach(row);
  rest.forEach(row);
  h.pushBody("", false);
  h.pushFoot("  " + h.GRAY + "-".repeat(h.barW) + h.RST);
  h.pushFoot("  " + h.DIM + "Type to filter   ^v Move   Enter Select   Tab ★ Favorite   Esc Back" + h.RST);
}

function renderSlots(h) {
  const map = readConfig().modelMap || {};
  h.pushBody("  " + h.MAGENTA + "#" + h.GRAY + " Claude model mapping" + h.RST, false);
  h.pushBody("  " + h.DIM + "Assign each Claude tier to a provider model." + h.RST, false);
  h.pushBody("", false);
  SLOTS.forEach((slot, i) => {
    const sel = tab.slotCursor === i;
    const a = map[slot.key];
    const value = a && a.provider ? (h.CYAN + a.provider + " / " + a.model + h.RST) : (h.DIM + "(unset)" + h.RST);
    const arrow = sel ? (h.YELLOW + " > " + h.RST) : "   ";
    h.pushBody("  " + (sel ? h.BG_SEL : "") + arrow + (sel ? h.BOLD + h.WHITE : h.GRAY) + h.pad(slot.label, 10) + h.RST + h.GRAY + " -> " + h.RST + value, sel);
  });
  h.pushBody("", false);
  h.pushFoot("  " + h.GRAY + "-".repeat(h.barW) + h.RST);
  h.pushFoot("  " + h.DIM + "^v Move   Enter Assign   Tab Switch   Q Quit" + h.RST);
}

function render(state, h) {
  if (tab.mode === "providers") renderProviders(h);
  else if (tab.mode === "models") renderModels(h);
  else renderSlots(h);
}

function toggleFav(listKey, id) {
  const cfg = readConfig();
  const set = new Set(cfg[listKey] || []);
  if (set.has(id)) set.delete(id); else set.add(id);
  cfg[listKey] = Array.from(set);
  writeConfig(cfg);
}

function handleKey(key, state, tuiApi) {
  if (tab.mode === "slots") {
    if (key === "up" || key === "w") { tab.slotCursor = (tab.slotCursor - 1 + SLOTS.length) % SLOTS.length; return; }
    if (key === "down" || key === "s") { tab.slotCursor = (tab.slotCursor + 1) % SLOTS.length; return; }
    if (key === "enter" || key === "space") {
      tab.editingSlot = SLOTS[tab.slotCursor].key;
      tab.mode = "providers"; tab.provCursor = 0;
      if (tuiApi && tuiApi.setTextInput) tuiApi.setTextInput(true);
    }
    return;
  }

  if (tab.mode === "providers") {
    const sel = buildProviders().selectable;
    if (key === "escape") { tab.mode = "slots"; if (tuiApi.setTextInput) tuiApi.setTextInput(false); return; }
    if (key === "up") { tab.provCursor = Math.max(0, tab.provCursor - 1); return; }
    if (key === "down") { tab.provCursor = Math.min(sel.length - 1, tab.provCursor + 1); return; }
    if (key === "tab") { const p = sel[tab.provCursor]; if (p) toggleFav("favoriteProviders", p.name); return; }
    if (key === "enter") {
      const p = sel[tab.provCursor];
      if (p) { tab.editingProvider = p.name; tab.mode = "models"; tab.search = ""; tab.modelCursor = 0; }
    }
    return;
  }

  // models
  if (key === "escape") { tab.mode = "providers"; return; }   // back up a level (stays in text-input)
  if (key === "up") { tab.modelCursor = Math.max(0, tab.modelCursor - 1); return; }
  if (key === "down") { const n = buildModels().selectable.length; tab.modelCursor = Math.min(n - 1, tab.modelCursor + 1); return; }
  if (key === "backspace") { tab.search = tab.search.slice(0, -1); tab.modelCursor = 0; return; }
  if (key === "tab") { const m = buildModels().selectable[tab.modelCursor]; if (m) toggleFav("favorites", m.id); return; }
  if (key === "enter") {
    const m = buildModels().selectable[tab.modelCursor];
    tab.mode = "slots";
    if (tuiApi.setTextInput) tuiApi.setTextInput(false);
    if (m) {
      const cfg = readConfig();
      cfg.modelMap = cfg.modelMap || {};
      cfg.modelMap[tab.editingSlot] = { provider: m.provider, model: m.model };
      writeConfig(cfg);
      try { if (tuiApi.flash) tuiApi.flash(tab.editingSlot + " -> " + m.provider + " / " + m.model); } catch {}
    }
    return;
  }
  if (typeof key === "string" && key.length === 1) { tab.search += key; tab.modelCursor = 0; }
}

export default function (tuiApi) {
  tuiApi.registerTab({ id: "providers", label: "Providers", render, handleKey });
}
