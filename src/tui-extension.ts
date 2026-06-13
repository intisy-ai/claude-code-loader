// @ts-nocheck
// Custom TUI tab (loaded via HUB_TUI_EXTENSION): map each Claude model tier to a
// {provider, model} chosen from a searchable picker over all installed providers.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const SLOTS = [
  { key: "opus", label: "Opus" },
  { key: "sonnet", label: "Sonnet" },
  { key: "haiku", label: "Haiku" },
  { key: "default", label: "Default" },
];
const WINDOW = 12;

function configDir() { return process.env.HUB_CONFIG_DIR || join(homedir(), ".claude"); }
function reposDir() { return join(configDir(), "repos"); }
// the loader config the proxy reads, not core-loader's oc-config.json
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

// flat list of every installed provider's models: { provider, model, name }
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
          out.push({ provider, model, name });
        }
      }
    } catch {}
  }
  return out;
}

function filtered(search) {
  const q = (search || "").toLowerCase();
  if (!q) return allEntries();
  return allEntries().filter((e) =>
    (e.provider + " " + e.model + " " + e.name).toLowerCase().indexOf(q) >= 0);
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
  h.pushFoot("  " + h.GRAY + "-".repeat(h.barW) + h.RST);
  h.pushFoot("  " + h.DIM + "^v Move   Enter Assign   Tab Switch   Q Quit" + h.RST);
}

function renderPick(h) {
  const list = filtered(tab.search);
  if (tab.pickCursor >= list.length) tab.pickCursor = Math.max(0, list.length - 1);
  const slot = SLOTS.find((s) => s.key === tab.editingSlot);
  h.pushBody("  " + h.MAGENTA + "#" + h.GRAY + " Assign " + (slot ? slot.label : "") + " " + h.RST +
    h.BG_SEL + " Search: " + tab.search + "_ " + h.RST, false);
  if (list.length === 0) {
    h.pushBody("  " + h.GRAY + "No matching models." + h.RST, false);
  }
  const start = Math.max(0, Math.min(tab.pickCursor - Math.floor(WINDOW / 2), Math.max(0, list.length - WINDOW)));
  for (let i = start; i < Math.min(list.length, start + WINDOW); i++) {
    const e = list[i];
    const sel = i === tab.pickCursor;
    const arrow = sel ? (h.YELLOW + " > " + h.RST) : "   ";
    h.pushBody("  " + (sel ? h.BG_SEL : "") + arrow + (sel ? h.BOLD + h.WHITE : h.GRAY) +
      e.provider + " / " + e.model + h.RST + h.GRAY + "  " + e.name + h.RST, sel);
  }
  h.pushBody("", false);
  h.pushFoot("  " + h.GRAY + "-".repeat(h.barW) + h.RST);
  h.pushFoot("  " + h.DIM + "Type to filter   ^v Move   Enter Select   Esc Cancel" + h.RST);
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
  // pick mode (raw text routed in via S.mode=tabinput)
  if (key === "escape") { tab.mode = "slots"; if (tuiApi.setTextInput) tuiApi.setTextInput(false); return; }
  if (key === "up") { tab.pickCursor = Math.max(0, tab.pickCursor - 1); return; }
  if (key === "down") { tab.pickCursor = tab.pickCursor + 1; return; }
  if (key === "backspace") { tab.search = tab.search.slice(0, -1); tab.pickCursor = 0; return; }
  if (key === "enter") {
    const list = filtered(tab.search);
    const e = list[tab.pickCursor];
    // close first so a side-effect failure can never leave the menu stuck open
    tab.mode = "slots";
    if (tuiApi.setTextInput) tuiApi.setTextInput(false);
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
