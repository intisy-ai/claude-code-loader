# App Capabilities Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the loader's app-specific features (session titles, foreign-plugin listing, plugin marketplaces, MCP servers) pluggable per app via a capability interface, so core-loader stays generic and a new app (Aider, Codex, …) is a new thin loader — not a core edit.

**Architecture:** core-loader exposes `tuiApi.registerCapabilities(obj)`; each loader's `tui-extension` (already loaded at boot via `HUB_TUI_EXTENSION`) registers its implementation. core-loader UI renders a feature only when the running app registered that capability. Claude implements all; opencode implements the MCP subset + the generic add-plugin path.

**Tech Stack:** TypeScript compiled with `tsc` (core-loader) / esbuild-bundled (loaders); Node built-in `node:test`; the `claude` CLI for Claude marketplace/MCP writes.

## Global Constraints

- **core-loader must contain NO app-specific file paths or app-name branches for these features.** All app specifics live behind capabilities registered by the loader's extension. (Existing `APP_NAME` uses for tab labels/paths may remain; do not add new ones for these four features.)
- **`core-loader/src/*` and `*/tui-extension.ts` are `// @ts-nocheck` ES5-ish style** (`var`/`function`, no TS types). Match the file you edit.
- A capability that is not registered ⇒ its UI is simply absent (no error, no empty section).
- **A generic "Add plugin (git URL)" action is available for EVERY app** (installs via the updater) — independent of whether the app has a marketplace.
- `dist/` is never committed (gitignored). Use the repo's git identity (no `-c user.email`/`--author`).
- Propagation: core-loader change → build → push → bump submodule in each loader → build → push.
- Verify live in agentbox `c4a33107f93e` (Claude) where possible.

## Capability Contract (the reusable interface)

`S.capabilities` is a plain object; a loader registers a subset. All functions are synchronous unless noted. Shapes:

```
listSessions(dir): Array<{ id, title, lastUsed, count }>        // enables the session picker
foreignPlugins(): Array<{ name, source, enabled, version }>     // read-only "App plugins" section
marketplaces(): Array<{ name, source }>                         // marketplace list
addMarketplace(input): { ok: boolean, error?: string }          // add a marketplace (input = url or owner/repo)
mcpServers(): Array<{ name, transport, detail }>                // MCP server list
addMcpServer(spec): { ok: boolean, error?: string }            // spec = { name, transport, target } (target = URL or command)
```

Unregistered keys are simply `undefined`.

---

### Task 1: Capability registry in core-loader

**Files:**
- Modify: `libs/core-loader/src/state.ts` (add `capabilities: {}`)
- Modify: `libs/core-loader/src/tui.ts` (add `registerCapabilities` to `tuiApi`)

**Interfaces:**
- Produces: `S.capabilities` (object), `tuiApi.registerCapabilities(obj)` (merges into `S.capabilities`).

- [ ] **Step 1: Add state field.** In `state.ts`, after `customTabs: [],`, add:

```js
  // App-specific feature implementations registered by the active loader's tui-extension
  // at boot (see tuiApi.registerCapabilities). Generic UI renders a feature only when its
  // key is present, so core-loader carries no app-specific logic for these features.
  capabilities: {},
```

- [ ] **Step 2: Add the registrar.** In `tui.ts`, in the `tuiApi` object literal (which already has `registerTab`, `loadPlugins`, `flash`, `runBlocking`, …), add:

```js
  registerCapabilities: function(caps) {
    if (caps && typeof caps === "object") {
      for (var k in caps) { if (Object.prototype.hasOwnProperty.call(caps, k)) S.capabilities[k] = caps[k]; }
    }
  },
```

- [ ] **Step 3: Build to verify it compiles.** Run: `cd libs/core-loader && npm run build` → tsc exits 0.

- [ ] **Step 4: Commit.**
```bash
cd libs/core-loader && git add src/state.ts src/tui.ts
git commit -m "feat(caps): capability registry (S.capabilities + tuiApi.registerCapabilities)"
```

---

### Task 2: Move session logic behind `listSessions`; make the picker generic

Removes Claude specifics from core-loader's picker; the Claude adapter will supply `listSessions` in Task 6.

**Files:**
- Modify: `libs/core-loader/src/projects.ts` (delete `groupSessions`/`parseHistoryText`/`sessionsFromHistory`/`querySessions`; `queryProjects` keeps its own inline history read; add a thin `listSessions(dir)` that calls the capability)
- Modify: `libs/core-loader/src/input.ts` (`enterSessions` uses `S.capabilities.listSessions` instead of `querySessions`/`APP_NAME`)
- Delete: `libs/core-loader/test/sessions.test.js` (its unit targets move to the Claude adapter in Task 6)
- Modify: `libs/core-loader/src/projects.ts` — `queryProjects`'s Claude branch currently calls `parseHistoryText`; inline the parse back so removing the session helpers doesn't break it.

**Interfaces:**
- Consumes: `S.capabilities.listSessions` (Task 1 registry; Claude impl in Task 6).
- Produces: `listSessions(dir)` in projects.ts (wrapper): `var fn = S.capabilities.listSessions; return typeof fn === "function" ? (fn(dir) || []) : [];`

- [ ] **Step 1:** In `projects.ts`, restore `queryProjects`'s Claude branch to parse inline (no `parseHistoryText` dependency): read `history.jsonl`, `split("\n").filter(Boolean)`, per-line `JSON.parse` in try/catch, aggregate by project (exact prior logic before the DRY refactor). Then DELETE `parseHistoryText`, `groupSessions`, `sessionsFromHistory`, `querySessions`, and `openProjectSession`'s dependency on them stays (it only uses `sessionPayload`/`outputDir`). Keep `sessionPayload`, `openProjectSession`.
- [ ] **Step 2:** Add:
```js
// Sessions for a project dir come from the active app's capability (absent -> none).
export function listSessions(dir) {
  var fn = S.capabilities && S.capabilities.listSessions;
  try { return typeof fn === "function" ? (fn(dir) || []) : []; } catch (e) { return []; }
}
```
- [ ] **Step 3:** In `input.ts`, change `enterSessions` to use `listSessions` and drop the `APP_NAME` gate:
```js
function enterSessions(dir, here) {
  var sessions = listSessions(dir);
  if (!sessions.length) {
    if (here) { cleanup(); process.exit(42); } else { openProjectSession(dir, null); }
    return;
  }
  S.sessionItems = sessions; S.scursor = 0; S.sessionDir = dir; S.sessionHere = here;
  S.mode = "sessions"; S.scrollOff = 0;
}
```
Update the import: replace `querySessions` with `listSessions` in the projects.js import; drop the `APP_NAME` import if now unused.
- [ ] **Step 4:** Delete `libs/core-loader/test/sessions.test.js`.
- [ ] **Step 5:** Build: `npm run build` → tsc exits 0.
- [ ] **Step 6: Commit.**
```bash
git add -A && git commit -m "refactor(sessions): picker reads S.capabilities.listSessions; core-loader carries no session app-specifics"
```

---

### Task 3: Generic "App plugins" section (foreignPlugins)

**Files:**
- Modify: `libs/core-loader/src/views/plugins.ts` (render a read-only section after the updater-managed list when `S.capabilities.foreignPlugins` exists)

**Interfaces:**
- Consumes: `S.capabilities.foreignPlugins()` → `[{ name, source, enabled, version }]`.

- [ ] **Step 1:** In `buildPlugins`, after the existing installed-plugin rows are pushed (Installed sub-page only, and only when `hasUpdater` so the gate still governs the top), add:
```js
  var fp = S.capabilities && S.capabilities.foreignPlugins;
  if (S.pluginSubPage === "installed" && typeof fp === "function") {
    var foreign = [];
    try { foreign = fp() || []; } catch (e) { foreign = []; }
    if (foreign.length) {
      pushBody("", false);
      pushBody("  " + BOLD + WHITE + "App plugins" + RST + GRAY + " (managed by " + APP_NAME + ")" + RST, false);
      for (var fi = 0; fi < foreign.length; fi++) {
        var it = foreign[fi];
        var state = it.enabled === false ? (BAD + "disabled" + RST) : (OK + "enabled" + RST);
        var ver = it.version ? (GRAY + " v" + it.version + RST) : "";
        pushBody("    " + DIM + trunc(it.name, cols - 24) + RST + "  " + state + ver, false);
      }
    }
  }
```
(These rows are non-selectable — informational. Do not change `S.pluginItems`/cursor math.)
- [ ] **Step 2:** Build `npm run build` → tsc 0.
- [ ] **Step 3: Commit.** `git add src/views/plugins.ts && git commit -m "feat(caps): read-only 'App plugins' section via foreignPlugins capability"`

---

### Task 4: Generic marketplaces + "Add plugin by URL"

**Files:**
- Modify: `libs/core-loader/src/views/plugins.ts` (Marketplace sub-page: prepend an "App marketplaces" section from `marketplaces()`, and an "Add plugin (git URL)" + "Add marketplace" action row when the capability exists)
- Modify: `libs/core-loader/src/input.ts` (handle the two new actions: prompt for input via the existing `S.mode = "input"` text flow, then call `addMarketplace` or the updater install)

**Interfaces:**
- Consumes: `S.capabilities.marketplaces()`, `S.capabilities.addMarketplace(input)`.
- Reuses: the existing marketplace install path for "Add plugin by URL" (`installMarketplacePlugin`/updater) — an implementer reads `marketplace.ts` for the exact call; the git-URL install is `plugin-updater add <url>` via the same mechanism the CLI `plugins install` uses.

- [ ] **Step 1:** In `buildPlugins` Marketplace branch, before the catalog list, render (when `S.capabilities.marketplaces`):
```js
  var mfn = S.capabilities && S.capabilities.marketplaces;
  if (typeof mfn === "function") {
    var mkts = []; try { mkts = mfn() || []; } catch (e) {}
    pushBody("  " + BOLD + WHITE + "Marketplaces" + RST, false);
    if (!mkts.length) pushBody("    " + GRAY + "None." + RST, false);
    for (var mi = 0; mi < mkts.length; mi++) pushBody("    " + DIM + trunc(mkts[mi].name, 28) + RST + GRAY + "  " + trunc(mkts[mi].source || "", cols - 36) + RST, false);
    pushBody("", false);
  }
```
- [ ] **Step 2:** Add two selectable action rows at the top of the Marketplace list — "＋ Add plugin (git URL)" (always) and "＋ Add marketplace" (only when `S.capabilities.addMarketplace`). Wire them into the marketplace cursor/selection so Enter triggers input mode. An implementer reads how the Marketplace list builds its selectable items (`marketplace.ts`/`views/plugins.ts`) and adds these as leading entries with distinct action keys `add_plugin_url` / `add_marketplace`.
- [ ] **Step 3:** In `input.ts` marketplace handling: on `add_plugin_url` or `add_marketplace`, set `S.mode = "input"`, stash which action, prompt label "Git URL:" / "Marketplace (url or owner/repo):". On confirm: `add_plugin_url` → run the updater install for that URL (same code path as the CLI `plugins install <url>`); `add_marketplace` → `S.capabilities.addMarketplace(input)`, then `flash(res.ok ? "Added" : ("Failed: " + res.error))`.
- [ ] **Step 4:** Build → tsc 0.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(caps): marketplace listing + add-marketplace + generic add-plugin-by-URL"`

---

### Task 5: Generic MCP list + add

**Files:**
- Modify: `libs/core-loader/src/views/mcp.ts` (list from `mcpServers()` when present; add an "＋ Add MCP server" action when `addMcpServer` present)
- Modify: `libs/core-loader/src/input.ts` (MCP add flow: prompt name → transport (http/stdio) → target, then `addMcpServer`)

**Interfaces:**
- Consumes: `S.capabilities.mcpServers()`, `S.capabilities.addMcpServer({ name, transport, target })`.
- Note: the existing MCP tab reads `MCP_CONFIG_PATH` (`~/.claude/.mcp.json`), which Claude does NOT read. When `mcpServers` capability is present, PREFER it over the legacy file read for the listing.

- [ ] **Step 1:** In `buildMcp`, when `S.capabilities.mcpServers` exists, source the list from it (`[{name, transport, detail}]`) instead of `loadMcpConfig()`. Render each: name, transport, detail (dimmed).
- [ ] **Step 2:** Add an "＋ Add MCP server" selectable row when `S.capabilities.addMcpServer` exists. Enter → multi-step input (name, then a two-choice transport select http/stdio, then target). Reuse the existing `S.mode === "input"` pattern; a small step counter in `S` (e.g. `S.mcpAddStep`, `S.mcpAddDraft`) sequences the prompts.
- [ ] **Step 3:** On completion call `S.capabilities.addMcpServer(draft)`, `flash` the result.
- [ ] **Step 4:** Build → tsc 0.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(caps): MCP server listing + add via mcpServers/addMcpServer capabilities"`

---

### Task 6: Claude adapter — register all capabilities

**Files:**
- Modify: `loaders/claude-code-loader/src/tui-extension.ts` (call `tuiApi.registerCapabilities({...})` in the default export; add the Claude implementations)
- Create: `loaders/claude-code-loader/src/claude-caps.ts` (the implementations; keep tui-extension.ts focused)
- Create: `loaders/claude-code-loader/test/claude-caps.test.js` (unit-test the pure parsing: session grouping + ai-title selection + enabledPlugins parse + marketplace parse, with plain-string/temp-free inputs where possible)

**Interfaces:**
- Produces (all read `HUB_CONFIG_DIR` or `~/.claude`):
  - `listSessions(dir)`: group `history.jsonl` by sessionId (recency, count) as before; TITLE = the last `{"type":"ai-title","aiTitle":...}` in `projects/*/<id>.jsonl` (tail-read files > 1 MB: read only the final ~256 KB); fallback = the session's first prompt from history. Return `[{id,title,lastUsed,count}]` newest-first.
  - `foreignPlugins()`: from `settings.json enabledPlugins` (`{"name@marketplace": bool}`) → `[{name, source: marketplace, enabled, version}]`; version from `plugins/installed_plugins.json` when present.
  - `marketplaces()`: from `plugins/known_marketplaces.json` (+ `settings.json extraKnownMarketplaces`) → `[{name, source: repo||url}]`.
  - `addMarketplace(input)`: run `claude plugin marketplace add <input>` via `execFileSync` (returns `{ok}`/`{ok:false,error}`); this is the supported path and makes running Claude pick it up.
  - `mcpServers()`: from `~/.claude.json` top-level `mcpServers` → `[{name, transport: cfg.type||("command" in cfg?"stdio":"http"), detail: url||command}]`.
  - `addMcpServer({name, transport, target})`: `claude mcp add --scope user` (`--transport http <name> <target>` or `--transport stdio <name> -- <target...>`) via `execFileSync`; `{ok}`/`{ok:false,error}`.

- [ ] **Step 1: Write failing tests** in `test/claude-caps.test.js` for the pure helpers (export them from `claude-caps.ts`): `groupSessions(historyEntries, dir)`, `pickAiTitle(transcriptText)` (returns last aiTitle or null), `parseEnabledPlugins(settingsObj)`, `parseMarketplaces(knownObj, extraObj)`. Assert grouping/recency, last-ai-title wins, `name@marketplace` split, and marketplace source extraction. Run `npm run build && node --test test/claude-caps.test.js` → RED (helpers missing).
- [ ] **Step 2: Implement `claude-caps.ts`** with the pure helpers above + the I/O wrappers (`listSessions`/`foreignPlugins`/`marketplaces`/`addMarketplace`/`mcpServers`/`addMcpServer`) using `fs` + `child_process.execFileSync`. Keep `// @ts-nocheck` ES5 style. Tail-read guard for large transcripts.
- [ ] **Step 3:** In `tui-extension.ts` default export add, before/after `registerTab`:
```js
  var caps = require("./claude-caps.js");
  tuiApi.registerCapabilities({
    listSessions: caps.listSessions, foreignPlugins: caps.foreignPlugins,
    marketplaces: caps.marketplaces, addMarketplace: caps.addMarketplace,
    mcpServers: caps.mcpServers, addMcpServer: caps.addMcpServer,
  });
```
(Adjust import style to match the ESM bundle — esbuild handles `import * as caps from "./claude-caps.js"`.)
- [ ] **Step 4:** `npm run build` (esbuild bundles tui-extension + claude-caps into `dist/tui-extension.js`); `node --test test/claude-caps.test.js` → GREEN.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(caps): Claude adapter — sessions(ai-title)/foreignPlugins/marketplaces/mcp capabilities + tests"`

---

### Task 7: opencode adapter — MCP subset

**Files:**
- Modify: `loaders/opencode-loader/src/tui-extension.ts` (register `{ mcpServers, addMcpServer }` for opencode's config; register nothing else)
- Create: `loaders/opencode-loader/src/opencode-caps.ts`

**Interfaces:**
- `mcpServers()`: from opencode's config (`opencode.json`/`opencode.jsonc` `mcp` block, or `~/.config/opencode/...`) → `[{name, transport, detail}]`. An implementer confirms opencode's MCP config location by reading the opencode-loader env/config modules.
- `addMcpServer(spec)`: write the server into opencode's MCP config (JSON merge). No CLI dependency required.

- [ ] **Step 1:** Read opencode-loader's config modules to find opencode's MCP config path + shape. Implement `opencode-caps.ts` (`mcpServers`, `addMcpServer`) accordingly.
- [ ] **Step 2:** In opencode `tui-extension.ts`, `tuiApi.registerCapabilities({ mcpServers: caps.mcpServers, addMcpServer: caps.addMcpServer })`.
- [ ] **Step 3:** `npm run build` → esbuild 0. Confirm opencode registers NO `listSessions`/`marketplaces`/`foreignPlugins` (so the picker/marketplace/app-plugins UI stays absent under opencode).
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(caps): opencode adapter — MCP list/add; generic add-plugin only"`

---

### Task 8: plugin-updater — silence the ESM warning

**Files:**
- Modify: `tools/plugin-updater/src/deploy.ts` (after ensuring `executionPath` exists, write a `package.json` `{"type":"module"}` into it once)

- [ ] **Step 1:** In `deployToExecutionDir`, where `executionPath` is created (`if (!fs.existsSync(executionPath)) fs.mkdirSync(...)`), also ensure a module marker:
```js
  try {
    const pkgMarker = path.join(executionPath, "package.json");
    if (!fs.existsSync(pkgMarker)) fs.writeFileSync(pkgMarker, JSON.stringify({ type: "module" }, null, 2), "utf8");
  } catch { /* non-fatal */ }
```
(Deployed plugin bundles are esbuild ESM, so declaring the dir ESM stops Node's reparse warning.)
- [ ] **Step 2:** `npm run build` + `npx vitest run` → all green.
- [ ] **Step 3: Commit + release.** Bump `package.json` to `1.5.9`; commit `fix(deploy): mark plugin execution dir as ESM (silence MODULE_TYPELESS_PACKAGE_JSON); release v1.5.9`; push; tag `v1.5.9`; push tag.

---

### Task 9: Propagate + verify

- [ ] **Step 1:** Push core-loader; record `<CL_SHA>`.
- [ ] **Step 2:** In claude-code-loader: bump `core-loader` submodule → `<CL_SHA>`, `npm run build`, commit both, push.
- [ ] **Step 3:** In opencode-loader: bump `core-loader` submodule → `<CL_SHA>`, `npm run build`, commit, push.
- [ ] **Step 4: Live-verify in agentbox (Claude):** force a clean redeploy; confirm — session picker shows AI titles; Installed tab shows the "App plugins" section (ecc, superpowers, …) with enabled state; Marketplace tab lists known marketplaces + "Add marketplace"/"Add plugin (git URL)" actions; MCP tab lists `github`/`graphify` and offers "Add MCP server"; no ESM warning on init.
- [ ] **Step 5: opencode sanity (if a container is available):** the picker/marketplace/app-plugins UI is ABSENT; the MCP list/add works against opencode config; "Add plugin (git URL)" works.

## Self-Review

- **Reusability:** every feature is gated on a capability key, registered by the loader extension; core-loader has no new app-name branches (Global Constraints). ✓
- **opencode:** registers only MCP → picker/marketplace/foreign-plugins absent; matches "session picker is in opencode itself". ✓
- **Generic add-plugin:** available for all apps (Task 4 Step 2). ✓
- **Claude specifics** (ai-title, enabledPlugins, known_marketplaces, ~/.claude.json, `claude` CLI) live only in claude-code-loader. ✓
- **Placeholders:** Tasks 4/5/7 leave the exact selectable-row/cursor wiring and opencode MCP path to the implementer to read from existing code — these are integration points with established local patterns, flagged explicitly, not vague TODOs. Contract + capability code are complete.
- **Names consistent:** capability keys (`listSessions`, `foreignPlugins`, `marketplaces`, `addMarketplace`, `mcpServers`, `addMcpServer`) identical across core-loader consumers and both adapters. ✓
