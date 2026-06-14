// @ts-nocheck
// Custom TUI tab (loaded via HUB_TUI_EXTENSION): map each Claude tier to a
// provider model. Picking a slot opens one list with every provider as a
// non-interactive category header and its (selectable) models listed below.
// Favorites (Tab) are pinned to a section on top AND kept in their category.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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

function allEntries() {
  const out = [];
  let repos = [];
  try { repos = readdirSync(reposDir()); } catch { return out; }
  for (const repo of repos) {
    try {
      const pkg = JSON.parse(readFileSync(join(reposDir(), repo, "package.json"), "utf8"));
      const declared = (pkg.claudeHub && pkg.claudeHub.authProviders) || pkg.authProviders || [];
      for (const p of declared) {
        const provider = p.name || repo;
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

function uniqueProviders() {
  const order = [];
  const counts = {};
  for (const e of allEntries()) {
    if (counts[e.provider] === undefined) { counts[e.provider] = 0; order.push(e.provider); }
    counts[e.provider]++;
  }
  return order.map((name) => ({ name, count: counts[name] }));
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

// no search: favorited models pinned in a Favorites section AND still shown in
// their provider category. searching: matches grouped by provider, no favorites
// section (search behaves as if favorites don't exist).
function buildPick() {
  const favSet = new Set(readConfig().favorites || []);
  const q = tab.search.toLowerCase();
  const match = (e) => (e.model + " " + e.name).toLowerCase().indexOf(q) >= 0;
  const entries = allEntries().filter(match);
  const favs = q ? [] : entries.filter((e) => favSet.has(e.id));
  const groups = groupByProvider(entries);
  const selectable = favs.concat(...groups.map((g) => g.items));
  return { favSet, favs, groups, selectable };
}

const tab = { mode: "slots", slotCursor: 0, editingSlot: "opus", search: "", pickCursor: 0 };

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
  const provs = uniqueProviders();
  h.pushBody("  " + h.MAGENTA + "#" + h.GRAY + " Providers (" + provs.length + ")" + h.RST, false);
  if (provs.length === 0) h.pushBody("    " + h.GRAY + "None installed." + h.RST, false);
  provs.forEach((p) => h.pushBody("    " + h.GRAY + p.name + h.DIM + "  (" + p.count + " model" + (p.count === 1 ? "" : "s") + ")" + h.RST, false));
  h.pushBody("", false);
  h.pushFoot("  " + h.GRAY + "-".repeat(h.barW) + h.RST);
  h.pushFoot("  " + h.DIM + "^v Move   Enter Assign   Tab Switch   Q Quit" + h.RST);
}

function renderPick(h) {
  const { favSet, favs, groups, selectable } = buildPick();
  if (tab.pickCursor >= selectable.length) tab.pickCursor = Math.max(0, selectable.length - 1);
  const slot = SLOTS.find((s) => s.key === tab.editingSlot);
  h.pushBody("  " + h.MAGENTA + "#" + h.GRAY + " Assign " + (slot ? slot.label : "") + " " + h.RST +
    h.BG_SEL + " Search: " + tab.search + "_ " + h.RST, false);
  if (selectable.length === 0) h.pushBody("  " + h.GRAY + "No matching models." + h.RST, false);

  let i = 0;
  const row = (e) => {
    const sel = i === tab.pickCursor;
    const arrow = sel ? (h.YELLOW + ">" + h.RST) : " ";
    const star = favSet.has(e.id) ? (h.YELLOW + "★" + h.RST) : " ";
    h.pushBody("  " + arrow + " " + star + " " + (sel ? h.BG_SEL + h.BOLD + h.WHITE : h.GRAY) + e.model + h.RST + h.GRAY + "  " + e.name + h.RST, sel);
    i++;
  };
  if (favs.length) { h.pushBody("  " + h.YELLOW + "★ " + h.RST + h.GRAY + "Favorites" + h.RST, false); favs.forEach(row); }
  for (const g of groups) { h.pushBody("  " + h.GRAY + g.provider + h.RST, false); g.items.forEach(row); }

  h.pushBody("", false);
  h.pushFoot("  " + h.GRAY + "-".repeat(h.barW) + h.RST);
  h.pushFoot("  " + h.DIM + "Type to filter   ^v Move   Enter Select   Tab ★ Favorite   Esc Cancel" + h.RST);
}

function render(state, h) {
  if (tab.mode === "pick") renderPick(h);
  else renderSlots(h);
}

function handleKey(key, state, tuiApi) {
  if (tab.mode === "slots") {
    if (key === "up" || key === "w") { tab.slotCursor = (tab.slotCursor - 1 + SLOTS.length) % SLOTS.length; return; }
    if (key === "down" || key === "s") { tab.slotCursor = (tab.slotCursor + 1) % SLOTS.length; return; }
    if (key === "enter" || key === "space") {
      tab.editingSlot = SLOTS[tab.slotCursor].key;
      tab.mode = "pick"; tab.search = ""; tab.pickCursor = 0;
      if (tuiApi && tuiApi.setTextInput) tuiApi.setTextInput(true);
    }
    return;
  }
  // pick mode (raw text routed in via S.mode=tabinput); cursor lands on models only
  const close = () => { tab.mode = "slots"; if (tuiApi.setTextInput) tuiApi.setTextInput(false); };
  if (key === "escape") { close(); return; }
  if (key === "up") { tab.pickCursor = Math.max(0, tab.pickCursor - 1); return; }
  if (key === "down") { tab.pickCursor = Math.min(buildPick().selectable.length - 1, tab.pickCursor + 1); return; }
  if (key === "backspace") { tab.search = tab.search.slice(0, -1); tab.pickCursor = 0; return; }
  if (key === "tab") {
    const e = buildPick().selectable[tab.pickCursor];
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
    const e = buildPick().selectable[tab.pickCursor];
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
