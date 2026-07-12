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
import { resolveModelMap, normalizeChain, claudeTiers, anthropicProfile } from "../core-proxy/dist/index.js";
import * as caps from "./claude-caps.js";

const profile = anthropicProfile();

// Mapping slots are DETECTED from the claude-code catalog (new families like
// Fable appear automatically) + the Default slot. Re-read per render/key.
function slots() {
  return claudeTiers(configDir(), profile)
    .map((tier) => ({ key: tier, label: tier.charAt(0).toUpperCase() + tier.slice(1) }))
    .concat([{ key: "default", label: "Default" }]);
}

// compact provenance tag for leaderboard scores ("score 50 · AA"); the full
// source name renders in the list footer.
function scoreTag(source) { return source ? "AA" : ""; }

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
          const scores = (cache[provider].scores) || {};
          const scoreSource = cache[provider].scoreSource || "";
          for (const model of Object.keys(cached)) {
            out.push({ provider, model, name: (cached[model] && cached[model].name) || model, id: provider + "/" + model, score: typeof scores[model] === "number" ? scores[model] : undefined, scoreSource });
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
  // Seed with EVERY declared provider (each repo's authProviders) so a provider with no
  // models yet — e.g. antigravity, whose models are fetched at login — is still listed and
  // selectable. Deriving the list purely from model rows (allEntries) hid model-less providers.
  let repos = [];
  try { repos = readdirSync(reposDir()); } catch { repos = []; }
  for (const repo of repos) {
    try {
      const pkg = JSON.parse(readFileSync(join(reposDir(), repo, "package.json"), "utf8"));
      const declared = (pkg.claudeHub && pkg.claudeHub.authProviders) || pkg.authProviders || [];
      for (const p of declared) {
        const name = p.name || repo;
        if (counts[name] === undefined) { counts[name] = 0; order.push(name); }
      }
    } catch {}
  }
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

const tab = { mode: "slots", cursor: 0, editingSlot: "opus", editingProvider: "", search: "", pickCursor: 0, chainCursor: 0, mapCursor: 0 };
const menu = createAccountMenu();

// Map EVERY tier to the given provider at once. Per tier: the provider's best
// model matching the tier keyword; if the provider has no such model, the one
// whose leaderboard score is CLOSEST to the tier's reference model (the current
// mapping's primary, else the tier's native model), so e.g. a haiku-less provider
// still gets a comparable-quality assignment. Default follows the top tier's pick
// (never a raw catalog head, which surprised as ANTHROPIC_MODEL).
function mapAllTiers(providerName, tuiApi) {
  const all = allEntries().filter((e) => !/-auto$/.test(e.model));
  const entries = all.filter((e) => e.provider === providerName);
  if (!entries.length) { try { if (tuiApi.flash) tuiApi.flash("No models in " + providerName + " — log in / refresh first"); } catch {} return; }
  const currentMap = resolveModelMap(configDir(), profile);
  const scoreOf = (provider, model) => { const m = all.find((e) => e.provider === provider && e.model === model); return m && typeof m.score === "number" ? m.score : undefined; };
  const mapped = [];
  let firstPick = null;
  for (const slot of slots()) {
    if (slot.key === "default") continue;
    let pick = entries.find((e) => e.model.toLowerCase().indexOf(slot.key) >= 0);
    if (!pick) {
      const current = (currentMap[slot.key] || [])[0];
      const ref = (current && scoreOf(current.provider, current.model))
        ?? (all.find((e) => e.model.toLowerCase().indexOf(slot.key) >= 0 && typeof e.score === "number") || {}).score;
      const scored = entries.filter((e) => typeof e.score === "number");
      if (typeof ref === "number" && scored.length) {
        pick = scored.reduce((best, e) => (Math.abs(e.score - ref) < Math.abs(best.score - ref) ? e : best));
      } else {
        pick = entries[0];
      }
    }
    if (!pick) continue;
    writeChain(slot.key, [{ provider: pick.provider, model: pick.model }]);
    mapped.push(slot.key);
    if (!firstPick) firstPick = pick;
  }
  if (firstPick) { writeChain("default", [{ provider: firstPick.provider, model: firstPick.model }]); mapped.push("default"); }
  try { if (tuiApi.flash) tuiApi.flash(mapped.length ? "Mapped " + mapped.join(", ") + " -> " + providerName : "No " + providerName + " models match any tier"); } catch {}
}

// Wipe the stored mapping: every tier reverts to auto-derivation (the app's own
// models first), shown as "(auto)" in the overview.
function resetMapping(tuiApi) {
  const cfg = readConfig();
  delete cfg.modelMap;
  writeConfig(cfg);
  try { if (tuiApi.flash) tuiApi.flash("Mapping reset — all tiers auto-derive again"); } catch {}
}

// the raw stored fallback chain for a tier (ordered [{provider,model}, ...])
function storedChain(slot) {
  return normalizeChain((readConfig().modelMap || {})[slot]);
}
function writeChain(slot, chain) {
  const cfg = readConfig();
  cfg.modelMap = cfg.modelMap || {};
  if (chain.length) cfg.modelMap[slot] = chain; else delete cfg.modelMap[slot];
  writeConfig(cfg);
}

// model row + category header share the same left inset (text at column 4); the
// selection ">" sits in the gutter to the left so text never shifts.
function modelRow(h, e, sel) {
  const gutter = sel ? (h.ACCENT + "❯ " + h.RST) : "  ";
  const body = sel ? (h.BG_SEL + h.BOLD + h.WHITE) : h.GRAY;
  // trailing leaderboard quality score + its source tag (full source in the footer)
  const tag = scoreTag(e.scoreSource);
  const score = typeof e.score === "number" ? h.DIM + "  · score " + Math.round(e.score) + (tag ? " · " + tag : "") + h.RST : "";
  h.pushBody("  " + gutter + body + e.model + h.RST + h.GRAY + "  " + e.name + h.RST + score, sel);
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
  const src = (selectable.find((e) => e.scoreSource) || {}).scoreSource;
  if (src) h.pushFoot("  " + h.DIM + "Scores: " + src + h.RST);
  h.pushFoot("  " + h.DIM + "Type to filter   ^v Move   " + (tab.mode === "pick" ? "Enter Select   " : "") + "Tab Favorite   Esc Back" + h.RST);
}

function routingLabel() {
  const providerRouting = readConfig()[profile.routingKey] !== false;   // default true
  return "Routing: " + (providerRouting ? "[Provider setup]" : "[Claude account]") + "  (r to toggle)";
}

function renderSlots(h) {
  // Effective (healed) mapping: a stale/unset tier auto-derives to the current catalog
  // and is marked "(auto)"; a still-valid explicit choice is shown as-is.
  const SLOTS = slots();
  const map = resolveModelMap(configDir(), profile);
  const provs = uniqueProviders();
  h.pushBody("  " + h.DIM + routingLabel() + h.RST, false);
  h.pushBody("", false);   // separate the routing line from the model-mapping block
  h.pushBody("  " + h.BOLD + h.WHITE + "Claude model mapping" + h.RST, false);
  h.pushBody("  " + h.DIM + "Assign each Claude tier to a provider model." + h.RST, false);
  h.pushBody("", false);
  SLOTS.forEach((slot, i) => {
    const sel = tab.cursor === i;
    const chain = map[slot.key] || [];
    const primary = chain[0];
    let value;
    if (!primary) value = h.DIM + "(unset)" + h.RST;
    else {
      value = h.ACCENT + primary.provider + " / " + primary.model + h.RST + (primary.derived ? h.DIM + " (auto)" + h.RST : "");
      if (chain.length > 1) value += h.DIM + "  +" + (chain.length - 1) + " fallback" + (chain.length - 1 === 1 ? "" : "s") + h.RST;
    }
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
  h.pushFoot("  " + h.DIM + "^v Move   Enter (tier=edit chain · provider=accounts)   M Map all tiers   R Routing   Tab Switch   Q Quit" + h.RST);
}

// items shown in the chain editor: [Add model], each chain entry, then [Clear chain].
function chainItems(slot) {
  const chain = storedChain(slot);
  const items = [{ kind: "add" }];
  chain.forEach((e, idx) => items.push({ kind: "entry", e, idx }));
  if (chain.length) items.push({ kind: "clear" });
  return items;
}

function renderChain(h) {
  const slot = slots().find((s) => s.key === tab.editingSlot) || { label: tab.editingSlot, key: tab.editingSlot };
  const items = chainItems(slot.key);
  if (tab.chainCursor >= items.length) tab.chainCursor = items.length - 1;
  if (tab.chainCursor < 0) tab.chainCursor = 0;
  h.pushBody("  " + h.BOLD + h.WHITE + slot.label + " model chain" + h.RST, false);
  h.pushBody("  " + h.DIM + "Tried top-to-bottom; only advances to the next when one is rate-limited." + h.RST, false);
  h.pushBody("", false);
  // provider/model -> leaderboard score (+ source tag), like the picker
  const scoreByKey = {};
  let chainScoreSource = "";
  for (const e of allEntries()) {
    if (typeof e.score === "number") scoreByKey[e.provider + "/" + e.model] = e.score;
    if (!chainScoreSource && e.scoreSource) chainScoreSource = e.scoreSource;
  }
  const chainTag = scoreTag(chainScoreSource);
  items.forEach((it, i) => {
    const sel = i === tab.chainCursor;
    const gutter = sel ? (h.ACCENT + "❯ " + h.RST) : "  ";
    const body = sel ? (h.BG_SEL + h.BOLD + h.WHITE) : h.GRAY;
    let text;
    if (it.kind === "add") text = (sel ? body : h.ACCENT) + "+ Add model" + h.RST;
    else if (it.kind === "clear") text = body + "Clear chain" + h.RST;
    else {
      const sc = scoreByKey[it.e.provider + "/" + it.e.model];
      const scoreStr = typeof sc === "number" ? h.DIM + "  · score " + Math.round(sc) + (chainTag ? " · " + chainTag : "") + h.RST : "";
      text = body + h.pad(it.idx === 0 ? "primary" : "fallback", 9) + h.RST + h.GRAY + it.e.provider + " / " + it.e.model + h.RST + scoreStr + (sel ? h.DIM + "  (Enter removes)" + h.RST : "");
    }
    h.pushBody("  " + gutter + text, sel);
  });
  if (storedChain(slot.key).length === 0) {
    const primary = (resolveModelMap(configDir(), profile)[slot.key] || [])[0];
    h.pushBody("", false);
    h.pushBody("  " + h.DIM + (primary ? "auto: " + primary.provider + " / " + primary.model : "no models available — log in / refresh") + h.RST, false);
  }
  h.pushBody("", false);
  h.pushFoot("  " + h.GRAY + "─".repeat(h.barW) + h.RST);
  if (chainScoreSource) h.pushFoot("  " + h.DIM + "Scores: " + chainScoreSource + h.RST);
  h.pushFoot("  " + h.DIM + "^v Move   Enter (add / remove / clear)   Esc Back" + h.RST);
}

// provider picker for "Map all tiers" + the reset-to-defaults entry
function renderMapAll(h) {
  const provs = uniqueProviders();
  h.pushBody("  " + h.BOLD + h.WHITE + "Map all tiers to one provider" + h.RST, false);
  h.pushBody("  " + h.DIM + "Each tier gets the provider's matching model; tiers without a match get the closest-scoring model." + h.RST, false);
  h.pushBody("", false);
  provs.forEach((p, i) => {
    const sel = tab.mapCursor === i;
    const gutter = sel ? (h.ACCENT + "❯ " + h.RST) : "  ";
    h.pushBody("  " + gutter + (sel ? h.BG_SEL + h.BOLD + h.WHITE : h.GRAY) + p.name + h.RST + h.DIM + "  (" + p.count + " model" + (p.count === 1 ? "" : "s") + ")" + h.RST, sel);
  });
  h.pushBody("", false);
  const selReset = tab.mapCursor === provs.length;
  const gutter = selReset ? (h.ACCENT + "❯ " + h.RST) : "  ";
  h.pushBody("  " + gutter + (selReset ? h.BG_SEL + h.BOLD + h.WHITE : h.ACCENT) + "Reset mapping to defaults" + h.RST + h.DIM + "  (all tiers auto-derive)" + h.RST, selReset);
  h.pushBody("", false);
  h.pushFoot("  " + h.GRAY + "─".repeat(h.barW) + h.RST);
  h.pushFoot("  " + h.DIM + "^v Move   Enter Apply   Esc Back" + h.RST);
}

function render(state, h) {
  if (menu.render(h)) return;   // in-tab account/quota menu owns the tab while open
  if (tab.mode === "pick") { const slot = slots().find((s) => s.key === tab.editingSlot); renderList(h, "Add to " + (slot ? slot.label : "") + " chain", buildList(allEntries())); }
  else if (tab.mode === "mapall") renderMapAll(h);
  else if (tab.mode === "chain") renderChain(h);
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
    const SLOTS = slots();
    const provs = uniqueProviders();
    const total = SLOTS.length + provs.length;
    if (key === "up" || key === "w") { tab.cursor = (tab.cursor - 1 + total) % total; return; }
    if (key === "down" || key === "s") { tab.cursor = (tab.cursor + 1) % total; return; }
    if (key === "r" || key === "R") {
      // flip routing mode: providers proxy setup vs native Claude account login.
      const cfg = readConfig();
      const nowRouting = !(cfg[profile.routingKey] !== false);
      cfg[profile.routingKey] = nowRouting;
      writeConfig(cfg);
      try {
        if (tuiApi.flash) tuiApi.flash(nowRouting ? "Routing: provider setup" : "Routing: Claude account (restart cc)");
      } catch {}
      return;
    }
    if (key === "a" && tab.cursor >= SLOTS.length) { openAccounts(provs[tab.cursor - SLOTS.length].name, tuiApi); return; }
    if (key === "m" || key === "M") {
      // open the map-all picker: choose the provider explicitly (or reset)
      tab.mode = "mapall"; tab.mapCursor = 0;
      return;
    }
    if (key === "enter" || key === "space") {
      if (tab.cursor < SLOTS.length) {
        // a Claude tier -> edit its model chain (primary + ordered fallbacks)
        tab.editingSlot = SLOTS[tab.cursor].key; tab.mode = "chain"; tab.chainCursor = 0;
        if (tuiApi && tuiApi.setTextInput) tuiApi.setTextInput(false);
      } else {
        // a provider -> open its account/quota menu in-tab (OpenCode parity)
        openAccounts(provs[tab.cursor - SLOTS.length].name, tuiApi);
      }
    }
    return;
  }

  if (tab.mode === "mapall") {
    const provs = uniqueProviders();
    const total = provs.length + 1;   // + Reset entry
    if (key === "up" || key === "w") { tab.mapCursor = (tab.mapCursor - 1 + total) % total; return; }
    if (key === "down" || key === "s") { tab.mapCursor = (tab.mapCursor + 1) % total; return; }
    if (key === "escape") { tab.mode = "slots"; return; }
    if (key === "enter" || key === "space") {
      if (tab.mapCursor < provs.length) mapAllTiers(provs[tab.mapCursor].name, tuiApi);
      else resetMapping(tuiApi);
      tab.mode = "slots";
    }
    return;
  }

  if (tab.mode === "chain") {
    const items = chainItems(tab.editingSlot);
    if (key === "up" || key === "w") { tab.chainCursor = (tab.chainCursor - 1 + items.length) % items.length; return; }
    if (key === "down" || key === "s") { tab.chainCursor = (tab.chainCursor + 1) % items.length; return; }
    if (key === "escape") { tab.mode = "slots"; return; }
    if (key === "enter" || key === "space") {
      const it = items[tab.chainCursor];
      if (!it || it.kind === "add") {
        // open the picker to append a model to this tier's chain
        tab.search = ""; tab.pickCursor = 0; tab.mode = "pick";
        if (tuiApi && tuiApi.setTextInput) tuiApi.setTextInput(true);
      } else if (it.kind === "clear") {
        writeChain(tab.editingSlot, []); tab.chainCursor = 0;
        try { if (tuiApi.flash) tuiApi.flash("Cleared " + tab.editingSlot + " chain"); } catch {}
      } else {
        const chain = storedChain(tab.editingSlot);
        chain.splice(it.idx, 1);
        writeChain(tab.editingSlot, chain);
        tab.chainCursor = Math.max(0, tab.chainCursor - 1);
      }
    }
    return;
  }

  // pick / browse (text-input): cursor lands on models only. Picker returns to the
  // chain editor it was opened from; browse returns to the slots overview.
  const close = () => { tab.mode = (tab.mode === "pick") ? "chain" : "slots"; if (tuiApi.setTextInput) tuiApi.setTextInput(false); };
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
    close();   // back to the chain editor
    if (e) {
      const chain = storedChain(tab.editingSlot);
      if (!chain.some((x) => x.provider === e.provider && x.model === e.model)) {
        chain.push({ provider: e.provider, model: e.model });
        writeChain(tab.editingSlot, chain);
      }
      tab.chainCursor = chain.length;   // land on the new entry / Clear
      try { if (tuiApi.flash) tuiApi.flash(tab.editingSlot + " += " + e.provider + " / " + e.model); } catch {}
    }
    return;
  }
  if (typeof key === "string" && key.length === 1) { tab.search += key; tab.pickCursor = 0; }
}

export default function (tuiApi) {
  tuiApi.registerTab({ id: "providers", label: "Providers", render, handleKey });
  // Register the Claude-specific implementations of core-loader's generic
  // app-capability contract (session titles, foreign-plugin listing, plugin
  // marketplaces, MCP servers) — see src/claude-caps.ts. Guarded: an
  // older/unbumped core-loader submodule may not carry registerCapabilities yet.
  if (tuiApi && typeof tuiApi.registerCapabilities === "function") {
    tuiApi.registerCapabilities({
      listSessions: caps.listSessions,
      foreignPlugins: caps.foreignPlugins,
      marketplaces: caps.marketplaces,
      marketplacePlugins: caps.marketplacePlugins,
      addMarketplace: caps.addMarketplace,
      installAppPlugin: caps.installAppPlugin,
      setForeignPluginEnabled: caps.setForeignPluginEnabled,
      uninstallForeignPlugin: caps.uninstallForeignPlugin,
      mcpServers: caps.mcpServers,
      addMcpServer: caps.addMcpServer,
    });
  }
}
