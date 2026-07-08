# Marketplace Redesign + App-Plugin Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the loader's flat 276-item marketplace into a fast, unified, clickable **two-level** browser (marketplaces → their plugins, each with a count); unify the Add buttons; make native "App plugins" interactive; and seed popular marketplaces by default. Stay app-agnostic (capability-driven).

**Architecture:** All app specifics stay behind `S.capabilities` (registered by each loader's tui-extension). The Marketplace tab becomes: **Level 1** a list of marketplaces (the loader's own `intisy-ai (official)` + `community`, the app's registered marketplaces, and seeded defaults) each with a plugin count + unified Add actions; **Level 2** drill into a marketplace to browse/install its plugins. "App plugins" (native, via `foreignPlugins`) become selectable with an enable/disable/uninstall actions menu.

**Tech Stack:** TypeScript (`tsc` core-loader / esbuild loaders); the `claude` CLI for Claude plugin mutations; GitHub raw fetch for seeded marketplaces' `marketplace.json`.

## Global Constraints

- **No app-specific logic in core-loader** for these features — everything via capabilities. New capability keys are registered by the loader's tui-extension (Claude implements; opencode registers only what it supports).
- **Two-level model:** Level 1 = marketplaces (with counts); Level 2 = a single marketplace's plugins. `intisy-ai (official)` and `community` are marketplaces too, each with a count.
- **Add buttons unified:** same placement (top of the tab) and the **MCP "＋ Add MCP server" accent color/style** applied to `＋ Add plugin (git URL)`, `＋ Add marketplace`, and `＋ Add MCP server`. (Read the exact style the MCP add row uses in `views/mcp.ts` and apply it to the marketplace add rows.)
- `// @ts-nocheck` ES5 style in `core-loader/src/*` and `*/tui-extension.ts` + adapters. No `dist/` committed. Repo git identity (no `-c` flags).
- Propagation: core-loader build+push → bump submodule in both loaders → build → push. Verify in agentbox `c4a33107f93e`.

## Capability contract v2 (additions)

```
marketplaces(): Array<{ name, source, count }>        // count = # plugins (may be 0 if unknown)
marketplacePlugins(name): Array<{ id, name, description, source }>   // a marketplace's plugins (drill-in)
setForeignPluginEnabled(nameAtMarketplace, enabled): { ok, error? }
uninstallForeignPlugin(nameAtMarketplace): { ok, error? }
```
Unregistered keys ⇒ that affordance is absent.

## Seed catalog (verified repos; DO NOT display literal star counts — the research source was unreliable)

`DEFAULT_MARKETPLACES` (name → github owner/repo), shown in Level 1 for every user even if not added to the app:
- `claude-plugins-official` → `anthropics/claude-plugins-official`
- `claude-plugins-community` → `anthropics/claude-plugins-community`
- `superpowers` → `obra/superpowers-marketplace`
- `wshobson-agents` → `wshobson/agents`
- `claude-code-templates` → `davila7/claude-code-templates`
- `ecc` → `affaan-m/ECC`
- `xiaolai` → `xiaolai/claude-plugin-marketplace`
- `claude-mem` → `thedotmack/claude-mem`

(Counts come from each repo's `.claude-plugin/marketplace.json` `plugins` array, fetched + cached — see Task 4. A seed the user already has via the app is de-duplicated by name.)

---

### Task 1: Capability contract v2 (Claude adapter + opencode adapter + core-loader types)

**Files:** `loaders/claude-code-loader/src/claude-caps.ts` (+ its vitest), `loaders/opencode-loader/src/opencode-caps.ts` (no-op for new keys), `loaders/claude-code-loader/src/tui-extension.ts` + opencode's (register the new keys).

- `marketplaces()`: add `count` = length of the marketplace's plugin list (read the cloned marketplace at `known_marketplaces.json[name].installLocation` → `.claude-plugin/marketplace.json` `plugins.length`; 0 if unreadable).
- `marketplacePlugins(name)`: read that cloned marketplace's `.claude-plugin/marketplace.json` → `[{id: name, name, description, source: marketplaceName}]`. `[]` on failure.
- `setForeignPluginEnabled(key, enabled)`: `claude plugin ${enabled?"enable":"disable"} ${key}` via `execFileSync` → `{ok}`/`{ok:false,error}`.
- `uninstallForeignPlugin(key)`: `claude plugin uninstall ${key}` via `execFileSync`.
- opencode adapter: does NOT register any of these (marketplaces/foreign plugins absent under opencode).
- Unit-test the new pure parsing (marketplace.json → plugin list; count) under vitest (`src/__tests__/`).

- [ ] Implement + register (guarded) + tests + build. Commit.

### Task 2: Marketplace Level-1 list (marketplaces + counts + unified Add rows)

**Files:** `core-loader/src/marketplace.ts`, `src/views/plugins.ts`, `src/input.ts`, `src/state.ts`.

- Build the Level-1 item list: the loader's own marketplaces `{name:"intisy-ai (official)", count: OFFICIAL count}` + `{name:"community", count}` + `capabilities.marketplaces()` + seeded defaults (Task 4), deduped by name. Each row: name + `(N plugins)`.
- Leading unified Add action rows (isAction, MCP-add color): `＋ Add plugin (git URL)` (always) + `＋ Add marketplace` (when `addMarketplace` present).
- `S.mkLevel` = `"markets" | "plugins"`; Level 1 lists marketplaces; Enter on a marketplace → set `S.mkMarket = name`, `S.mkLevel="plugins"`.
- Keep the existing install machinery for Level 2.

- [ ] Implement + build. Commit.

### Task 3: Marketplace Level-2 drill-in (a marketplace's plugins) + fast nav

**Files:** `core-loader/src/marketplace.ts`, `src/views/plugins.ts`, `src/input.ts`.

- Level 2 renders `S.mkMarket`'s plugins: for `intisy-ai`/`community` use the existing loader catalog filtered to that group; for a capability marketplace use `capabilities.marketplacePlugins(name)`; for a seeded default use the fetched/cached list (Task 4). Reuse existing search + install (multi-select) + install-method logic.
- `Esc` at Level 2 → back to Level 1.
- Fast nav: a key (e.g. `[`/`]` or PgUp/PgDn) to jump between category headers within a long marketplace; Level 1 itself is short so it's already fast.

- [ ] Implement + build. Commit.

### Task 4: Seed default marketplaces (fetch + cache their plugin lists)

**Files:** `core-loader/src/marketplace.ts` (+ `env.ts` for the `DEFAULT_MARKETPLACES` data array).

- Add `DEFAULT_MARKETPLACES` (the seed list above) to `env.ts`.
- Fetch each seed's `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/.claude-plugin/marketplace.json`, parse `plugins` → `[{id,name,description,source}]`; cache under the existing catalog cache (respect `catalogCacheHours`). Async, non-blocking (like `fetchCatalogsAsync`); Level 1 shows the marketplace immediately with count "…" until fetched, then the real count.
- De-dupe a seed that the user already has via `capabilities.marketplaces()` (by name/repo) so it isn't listed twice.

- [ ] Implement + build. Commit.

### Task 5: Unify Add-button style across Marketplace + MCP

**Files:** `core-loader/src/views/plugins.ts`, `src/views/mcp.ts`.

- Read the exact style the MCP `＋ Add MCP server` row renders with; apply the identical accent color/format to the marketplace `＋ Add plugin (git URL)` / `＋ Add marketplace` rows. Consistent leading placement.

- [ ] Implement + build. Commit.

### Task 6: App plugins interactive (Installed tab) + Claude actions

**Files:** `core-loader/src/views/plugins.ts`, `src/input.ts`, `src/state.ts`; `loaders/claude-code-loader/src/claude-caps.ts`.

- Make the "App plugins" section rows SELECTABLE (extend the Installed cursor to span updater-managed plugins + app plugins, or a sub-cursor). Enter → an actions menu: `Enable`/`Disable` (toggle via `setForeignPluginEnabled`), `Uninstall` (via `uninstallForeignPlugin`, behind a confirm). Show details (version, marketplace).
- Guard: actions only when the capabilities are registered; otherwise the section stays read-only (opencode).
- After an action, refresh `foreignPlugins()`.

- [ ] Implement + build. Commit.

### Task 7: Propagate + verify

- [ ] Build+push core-loader; bump submodule in both loaders; build+push both. Publish plugin-updater only if changed (not expected).
- [ ] Live-verify in agentbox: Level 1 lists marketplaces with counts (official/community + claude-plugins-official + seeded defaults); drill into one shows its plugins; Add buttons share the MCP-add color; App plugins are selectable with enable/disable/uninstall; opencode shows none of the marketplace UI.

## Self-Review
- Clickable drill-in (decided) → Tasks 2+3. Counts per marketplace incl. official/community → Task 2. Fast nav → short Level 1 + Task 3 jump. Unify add color → Task 5. App-plugin actions (enable/disable/uninstall) → Task 6. Seed defaults → Task 4. Capability-driven, no core app-specifics → Task 1 + guards. ✓
- Open risk: seeded-marketplace fetch depends on the `.claude-plugin/marketplace.json` path being at repo HEAD — Task 4 must fail gracefully (count "?", empty drill-in) when a repo differs.
