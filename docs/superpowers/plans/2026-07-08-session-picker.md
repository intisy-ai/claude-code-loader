# Session Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a user selects a project in the claude-code loader, let them resume an existing Claude session or start a new one, in an in-loader picker.

**Architecture:** A new `sessions` sub-mode inside the shared `core-loader` TUI (gated on `APP_NAME === "Claude Code"`). Session data is grouped from the existing `~/.claude/history.jsonl`. The choice reaches the `cc` wrapper via the existing `$CC_OUTPUT` file, extended with an optional 2nd line = `sessionId`; the wrapper runs `claude --resume "<id>"` or plain `claude`.

**Tech Stack:** TypeScript compiled with `tsc` (core-loader) / esbuild-bundled (loaders); Node built-in `node:test` for the one unit test; POSIX `sh` + Windows `cmd` wrapper scripts.

## Global Constraints

- **Claude-only.** Every new behavior is gated on `APP_NAME === "Claude Code"`. The opencode-loader launch path and behavior must be byte-for-byte unchanged (opencode has native session selection).
- **Match the surrounding TUI style.** `core-loader/src/*` files begin with `// @ts-nocheck` and are written in ES5-ish JS (`var`, `function`, no type annotations). New code in those files MUST match — do NOT introduce TS types or `let`/`const`/arrow-only style that clashes with the file.
- **Never commit `dist/`** (gitignored everywhere).
- **Never delete existing code** — this plan only adds functions and extends wrappers; `openProject` stays as-is.
- **Wrapper backward compatibility:** a `$CC_OUTPUT` file with only a dir line must behave exactly as today.
- **Never override git identity** (use the repo's configured `finn@birich.de`; no `-c user.email`/`--author`).
- **Propagation model:** core-loader change → `npm run build` → commit + push core-loader → in each loader `git -C core-loader fetch && reset --hard <sha>` → `npm run build` → commit pointer bump → push.

---

### Task 1: Session grouping + query (core-loader)

**Files:**
- Modify: `libs/core-loader/src/projects.ts` (add two exported functions after `queryProjects`)
- Create: `libs/core-loader/test/sessions.test.js` (Node built-in test runner; CommonJS — core-loader has no `"type": "module"` and tsc emits CommonJS)

**Interfaces:**
- Consumes: existing module imports already present in `projects.ts` (`existsSync`, `readFileSync`, `join`, `APP_NAME`, `CONFIG_DIR`).
- Produces:
  - `groupSessions(entries, dir)` → `Array<{ id: string, title: string, lastUsed: number, count: number }>` — pure, newest-first.
  - `querySessions(dir)` → same shape; reads `history.jsonl`, returns `[]` for non-Claude apps or on any failure.

- [ ] **Step 1: Write the failing test**

Create `libs/core-loader/test/sessions.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { groupSessions } = require("../dist/projects.js");

const DIR = "/home/u/proj";
const OTHER = "/home/u/other";
const entries = [
  { project: DIR,   sessionId: "s1", display: "first prompt of s1",  timestamp: 100 },
  { project: DIR,   sessionId: "s1", display: "later prompt of s1",  timestamp: 300 },
  { project: DIR,   sessionId: "s2", display: "only prompt of s2",   timestamp: 200 },
  { project: OTHER, sessionId: "s3", display: "belongs to other",    timestamp: 999 },
  { project: DIR,   sessionId: "s4", timestamp: 50 }, // no display
];

test("groups by sessionId for the given dir only", () => {
  const out = groupSessions(entries, DIR);
  assert.deepStrictEqual(out.map((s) => s.id), ["s1", "s2", "s4"]); // by lastUsed desc: 300,200,50
});

test("title is the session's earliest prompt", () => {
  const out = groupSessions(entries, DIR);
  const s1 = out.find((s) => s.id === "s1");
  assert.strictEqual(s1.title, "first prompt of s1");
});

test("lastUsed is the max timestamp; count is entries in the group", () => {
  const out = groupSessions(entries, DIR);
  const s1 = out.find((s) => s.id === "s1");
  assert.strictEqual(s1.lastUsed, 300);
  assert.strictEqual(s1.count, 2);
});

test("a session with no prompt gets a placeholder title", () => {
  const out = groupSessions(entries, DIR);
  const s4 = out.find((s) => s.id === "s4");
  assert.strictEqual(s4.title, "(no prompt)");
});

test("entries from other projects are excluded", () => {
  const out = groupSessions(entries, DIR);
  assert.ok(!out.some((s) => s.id === "s3"));
});
```

- [ ] **Step 2: Build then run the test to verify it fails**

Run: `cd libs/core-loader && npm run build && node --test test/`
Expected: FAIL — `groupSessions is not a function` (not yet exported).

- [ ] **Step 3: Implement `groupSessions` and `querySessions`**

In `libs/core-loader/src/projects.ts`, add immediately after the `queryProjects` function (keep the file's `var`/`function` style):

```js
// Group Claude history entries into per-session summaries for ONE project dir.
// Pure (no I/O) so it is unit-testable. entries: parsed history.jsonl objects
// ({project, sessionId, display, timestamp}). Returns newest-first; title = the
// session's EARLIEST prompt (what it was about).
export function groupSessions(entries, dir) {
  var groups = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e || e.project !== dir || !e.sessionId) continue;
    var g = groups[e.sessionId];
    if (!g) { g = groups[e.sessionId] = { id: e.sessionId, title: "", lastUsed: 0, count: 0, firstTs: Infinity }; }
    g.count++;
    var ts = typeof e.timestamp === "number" ? e.timestamp : (Date.parse(e.timestamp) || 0);
    if (ts > g.lastUsed) g.lastUsed = ts;
    if (ts <= g.firstTs && typeof e.display === "string" && e.display) { g.firstTs = ts; g.title = e.display; }
  }
  var out = Object.keys(groups).map(function (k) {
    var g = groups[k];
    return { id: g.id, title: g.title || "(no prompt)", lastUsed: g.lastUsed, count: g.count };
  });
  out.sort(function (a, b) { return b.lastUsed - a.lastUsed; });
  return out;
}

// Read the Claude history and return the session summaries for one project dir.
// Claude only; returns [] for any other app or on any read/parse failure.
export function querySessions(dir) {
  if (APP_NAME !== "Claude Code") return [];
  var historyPath = join(CONFIG_DIR, "history.jsonl");
  if (!existsSync(historyPath)) return [];
  try {
    var lines = readFileSync(historyPath, "utf8").split("\n").filter(Boolean);
    var entries = [];
    for (var i = 0; i < lines.length; i++) {
      try { entries.push(JSON.parse(lines[i])); } catch (e) {}
    }
    return groupSessions(entries, dir);
  } catch (e) { return []; }
}
```

- [ ] **Step 4: Build then run the test to verify it passes**

Run: `cd libs/core-loader && npm run build && node --test test/`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd libs/core-loader
git add src/projects.ts test/sessions.test.js
git commit -m "feat(sessions): groupSessions + querySessions from history.jsonl"
```

---

### Task 2: Session sub-mode state + view (core-loader)

**Files:**
- Modify: `libs/core-loader/src/state.ts` (add 3 fields)
- Modify: `libs/core-loader/src/views/projects.ts` (add `buildSessions`; branch `buildProjects` into it)

**Interfaces:**
- Consumes: `S.sessionItems` / `S.scursor` / `S.sessionDir` (added here); `querySessions` result shape from Task 1.
- Produces: `buildSessions(pushBody, pushFoot, cols, barW)` render fn (module-internal, called by `buildProjects`); `S.mode === "sessions"` renders it.

- [ ] **Step 1: Add state fields**

In `libs/core-loader/src/state.ts`, inside the `// Projects page` block (after `chpathDir: "",` on line 29), add:

```js
  // Session picker sub-mode (Claude only): the chosen project's sessions,
  // the cursor within them, the dir being opened, and whether it was reached
  // via "Open here" (so a new session preserves the exit-42 arg-forwarding path).
  sessionItems: [],
  scursor: 0,
  sessionDir: "",
  sessionHere: false,
```

- [ ] **Step 2: Add the `buildSessions` view**

In `libs/core-loader/src/views/projects.ts`, add this function above `buildProjects` (all imports it uses — `RST, BOLD, DIM, GRAY, WHITE, BG_SEL, pad, trunc, timeAgo, ACCENT, rule, S, hints` — are already imported at the top of the file):

```js
export function buildSessions(pushBody, pushFoot, cols, barW) {
  var nameW = Math.min(46, Math.max(20, cols - 18));
  var proj = (S.sessionDir || "").split(/[\\/]/).pop() || S.sessionDir;
  pushBody("  " + BOLD + WHITE + "Sessions" + RST + GRAY + " · " + trunc(proj, cols - 16) + RST, false);
  pushBody("", false);

  // Row 0: start a new session.
  var selNew = S.scursor === 0;
  var newArrow = selNew ? (ACCENT + " ❯ " + RST) : "   ";
  var newBg = selNew ? BG_SEL : "";
  var newStyle = selNew ? (BOLD + WHITE) : DIM;
  pushBody("  " + newBg + newArrow + newStyle + "＋ New session" + RST, selNew);

  for (var i = 0; i < S.sessionItems.length; i++) {
    var it = S.sessionItems[i];
    var sel = S.scursor === i + 1;
    var arrow = sel ? (ACCENT + " ❯ " + RST) : "   ";
    var bg = sel ? BG_SEL : "";
    var nameStyle = sel ? (BOLD + WHITE) : DIM;
    var timeStr = GRAY + pad(timeAgo(it.lastUsed), 9) + RST;
    pushBody("  " + bg + arrow + nameStyle + pad(trunc(it.title, nameW), nameW) + RST + bg + timeStr + RST, sel);
  }

  pushBody("", false);
  pushFoot("  " + rule(barW));
  pushFoot(hints([["↑↓", "move"], ["enter", "select"], ["esc", "back"]]));
}
```

- [ ] **Step 3: Branch `buildProjects` into the sub-mode**

In `libs/core-loader/src/views/projects.ts`, as the FIRST statement inside `buildProjects` (before `var nameW = ...`), add:

```js
  if (S.mode === "sessions") { buildSessions(pushBody, pushFoot, cols, barW); return; }
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd libs/core-loader && npm run build`
Expected: tsc exits 0, no errors.

- [ ] **Step 5: Commit**

```bash
cd libs/core-loader
git add src/state.ts src/views/projects.ts
git commit -m "feat(sessions): session picker state + buildSessions view"
```

---

### Task 3: Input routing + launch (core-loader)

**Files:**
- Modify: `libs/core-loader/src/projects.ts` (add `openProjectSession`)
- Modify: `libs/core-loader/src/input.ts` (import additions; `enterSessions` helper; route "Open"/"Open here"; `sessions` key handler)

**Interfaces:**
- Consumes: `querySessions` (Task 1), `S.sessionItems/scursor/sessionDir/sessionHere` (Task 2), existing `cleanup`, `outputDir`, `openProject`.
- Produces: `openProjectSession(dir, sessionId)` — writes the wrapper payload and exits; new `S.mode === "sessions"` key handling.

- [ ] **Step 1: Add `openProjectSession`**

In `libs/core-loader/src/projects.ts`, add after `openProject` (line 152):

```js
// Emit the launch payload for the cc wrapper: line 1 = dir, optional line 2 =
// sessionId. A null/empty id writes the dir alone (identical to openProject, so
// the wrapper starts a fresh session). Uses the same CC_OUTPUT channel.
export function openProjectSession(dir, sessionId) {
  cleanup();
  outputDir(sessionId ? (dir + "\n" + sessionId) : dir);
  process.exit(0);
}
```

- [ ] **Step 2: Add imports in `input.ts`**

In `libs/core-loader/src/input.ts`:
- Add `APP_NAME` to the env import. Find the existing env import line and add `APP_NAME` (if `input.ts` has no env import yet, add `import { APP_NAME } from "./env.js";` near the other imports).
- Extend the projects import (line 14) to include `openProjectSession` and `querySessions`:

```js
import { openProject, openProjectSession, querySessions, togglePin, hideItem, unhideAll, changeProjectPath, outputDir, getActions } from "./projects.js";
```

- [ ] **Step 3: Add the `enterSessions` helper**

In `libs/core-loader/src/input.ts`, add this helper near the top of the file (module scope, after imports):

```js
// Open a project through the session picker (Claude only). With no prior
// sessions, launch fresh immediately: "Open here" keeps the exit-42 path so the
// wrapper forwards the user's own cc args; a project row writes its dir.
function enterSessions(dir, here) {
  var sessions = APP_NAME === "Claude Code" ? querySessions(dir) : [];
  if (sessions.length === 0) {
    if (here) { cleanup(); process.exit(42); }
    else { openProjectSession(dir, null); }
    return;
  }
  S.sessionItems = sessions;
  S.scursor = 0;
  S.sessionDir = dir;
  S.sessionHere = here;
  S.mode = "sessions";
  S.scrollOff = 0;
}
```

- [ ] **Step 4: Route "Open here" and the "open" action into the picker**

In `libs/core-loader/src/input.ts`, in the `S.page === "projects"` list-mode block, change the Enter-on-"open-here"-row branch. Replace:

```js
    else if (key === "enter" || key === "space") {
      if (S.cursor === S.items.length) { cleanup(); process.exit(42); }
      else if (S.items.length > 0) { S.mode = "actions"; S.acursor = 0; }
    }
```

with:

```js
    else if (key === "enter" || key === "space") {
      if (S.cursor === S.items.length) { enterSessions(process.cwd(), true); }
      else if (S.items.length > 0) { S.mode = "actions"; S.acursor = 0; }
    }
```

In the `S.mode === "actions"` block, change the `open` action. Replace:

```js
      if (action === "open") { openProject(S.items[S.cursor]); }
```

with:

```js
      if (action === "open") { enterSessions(S.items[S.cursor].dir, false); }
```

(The `o` quick-key branch stays untouched — it remains an instant fresh open.)

- [ ] **Step 5: Add the `sessions` key handler**

In `libs/core-loader/src/input.ts`, add a new branch to `handleProjectKey`. Place it after the `S.mode === "actions"` block and before the `S.mode === "input"` block (so it is reached while on the projects page):

```js
  } else if (S.mode === "sessions") {
    var n = S.sessionItems.length;
    if (key === "up" || key === "w") { S.scursor = Math.max(0, S.scursor - 1); }
    else if (key === "down" || key === "s") { S.scursor = Math.min(n, S.scursor + 1); }
    else if (key === "enter" || key === "space") {
      if (S.scursor === 0) {
        if (S.sessionHere) { cleanup(); process.exit(42); }
        else { openProjectSession(S.sessionDir, null); }
      } else {
        openProjectSession(S.sessionDir, S.sessionItems[S.scursor - 1].id);
      }
    }
    else if (key === "escape" || key === "q") { S.mode = "list"; }
```

Note: match the exact `if/else if` chaining of the surrounding `handleProjectKey` — this branch must slot into the same `if (S.mode === ...) { } else if (...) { }` ladder. Read the file first and align the braces.

- [ ] **Step 6: Build to verify it compiles**

Run: `cd libs/core-loader && npm run build`
Expected: tsc exits 0.

- [ ] **Step 7: Commit**

```bash
cd libs/core-loader
git add src/projects.ts src/input.ts
git commit -m "feat(sessions): route Open/Open-here into the picker; launch --resume"
```

---

### Task 4: `cc` wrapper protocol — sh + cmd (claude-code-loader)

**Files:**
- Modify: `loaders/claude-code-loader/src/plugin.ts` (both wrapper generators)

**Interfaces:**
- Consumes: the `$CC_OUTPUT` payload written by `openProjectSession` (line 1 = dir, optional line 2 = sessionId).
- Produces: wrappers that `cd` into the dir and `exec claude --resume "<id>"` when the id line is present, else `exec claude`.

**Context — pre-existing gap:** the Windows `cmd` wrapper today runs the TUI and `exit /b`s WITHOUT reading `$CC_OUTPUT`, so opening a project never launches Claude on Windows. This task wires the full dir(+session) flow into `cmd`, mirroring the `sh` wrapper.

- [ ] **Step 1: Extend the `sh` wrapper to read the session line**

In `loaders/claude-code-loader/src/plugin.ts`, in the `sh` wrapper array, replace the CC_OUTPUT dir block (currently):

```js
      'if [ $EXIT -eq 0 ] && [ -f "$CC_OUTPUT" ]; then',
      '  DIR=$(cat "$CC_OUTPUT")',
      '  rm -f "$CC_OUTPUT"',
      '  if [ -n "$DIR" ]; then cd "$DIR" && ensure_proxy && exec claude; fi',
      "fi",
```

with:

```js
      'if [ $EXIT -eq 0 ] && [ -f "$CC_OUTPUT" ]; then',
      '  DIR=$(sed -n 1p "$CC_OUTPUT")',
      '  SESSION=$(sed -n 2p "$CC_OUTPUT")',
      '  rm -f "$CC_OUTPUT"',
      '  if [ -n "$DIR" ]; then',
      '    cd "$DIR" && ensure_proxy',
      '    if [ -n "$SESSION" ]; then exec claude --resume "$SESSION"; else exec claude; fi',
      '  fi',
      "fi",
```

- [ ] **Step 2: Wire the `cmd` wrapper to consume `$CC_OUTPUT` (dir + session)**

In `loaders/claude-code-loader/src/plugin.ts`, in the Windows branch (`if (process.platform === "win32")`), replace the TUI-run section. Currently:

```js
      'set "_args=%*"',
      // `cc auth ...` -> provider selector + account menu (fallback: Providers tab)
      `if "%1"=="auth" ( if exist "${authPath}" ( node "${authPath}" & exit /b %errorlevel% ) else ( set "HUB_OPEN_TAB=providers" & set "_args=" ) )`,
    ];
    for (const candidate of tuiCandidates) {
      cmdLines.push(`if exist "${candidate}" ( node "${candidate}" %_args% & exit /b %errorlevel% )`);
    }
    cmdLines.push("claude %*");
```

Replace with:

```js
      'set "_args=%*"',
      // `cc auth ...` -> provider selector + account menu (fallback: Providers tab)
      `if "%1"=="auth" ( if exist "${authPath}" ( node "${authPath}" & exit /b %errorlevel% ) else ( set "HUB_OPEN_TAB=providers" & set "_args=" ) )`,
      // The TUI writes the chosen project dir (line 1) + optional session id (line 2)
      // to this file; we read it back after the TUI exits and launch claude there.
      'set "CC_OUTPUT=%TEMP%\\cc-dir-%RANDOM%%RANDOM%.txt"',
      'set "_TUI="',
    ];
    for (const candidate of tuiCandidates) {
      cmdLines.push(`if not defined _TUI if exist "${candidate}" set "_TUI=${candidate}"`);
    }
    cmdLines.push(
      // No TUI available -> plain passthrough.
      'if not defined _TUI ( claude %* & exit /b %errorlevel% )',
      'node "%_TUI%" %_args%',
      'set "EXIT=%errorlevel%"',
      // 42 = "New session here": forward the user's own args, like the sh wrapper.
      'if "%EXIT%"=="42" ( del "%CC_OUTPUT%" 2>NUL & claude %* & exit /b %errorlevel% )',
      'if not "%EXIT%"=="0" ( del "%CC_OUTPUT%" 2>NUL & exit /b %EXIT% )',
      'if not exist "%CC_OUTPUT%" ( exit /b %EXIT% )',
      'set "DIR="',
      'set /p DIR=<"%CC_OUTPUT%"',
      // second line (session id) via `more +1`; empty when the file has one line.
      'set "SESSION="',
      'more +1 "%CC_OUTPUT%" > "%CC_OUTPUT%.2" 2>NUL',
      'set /p SESSION=<"%CC_OUTPUT%.2"',
      'del "%CC_OUTPUT%" "%CC_OUTPUT%.2" 2>NUL',
      'if "%DIR%"=="" ( exit /b %EXIT% )',
      'cd /d "%DIR%"',
      'if not "%SESSION%"=="" ( claude --resume "%SESSION%" & exit /b %errorlevel% )',
      'claude & exit /b %errorlevel%'
    );
```

- [ ] **Step 3: Build the loader**

Run: `cd loaders/claude-code-loader && npm run build`
Expected: esbuild bundles, postbuild writes README, exit 0.

- [ ] **Step 4: Verify the generated wrappers contain the new logic**

Run:
```bash
cd loaders/claude-code-loader
grep -n "sed -n 2p\|--resume" dist/plugin.js | head
```
Expected: matches showing the `SESSION=$(sed -n 2p ...)` and `claude --resume` lines are present in the bundled output.

- [ ] **Step 5: Commit**

```bash
cd loaders/claude-code-loader
git add src/plugin.ts
git commit -m "feat(sessions): cc wrapper passes --resume; wire cmd CC_OUTPUT flow (Windows project-open)"
```

---

### Task 5: Propagate core-loader + live verification

**Files:**
- Modify: `loaders/claude-code-loader` (core-loader submodule pointer)
- Modify: `loaders/opencode-loader` (core-loader submodule pointer)

**Interfaces:** none (integration + verification only).

- [ ] **Step 1: Push core-loader**

```bash
cd libs/core-loader
npm run build
git push origin master
git rev-parse --short HEAD   # record as <CL_SHA>
```

- [ ] **Step 2: Advance + rebuild claude-code-loader**

```bash
cd loaders/claude-code-loader/core-loader
git fetch origin && git reset --hard <CL_SHA>
cd ..
npm run build
git add core-loader dist README.md 2>/dev/null; git add -A
git commit -m "chore: bump core-loader -> <CL_SHA> (session picker)"
git push origin master
```
(Note: `dist/` is gitignored — `git add -A` will only stage the submodule pointer + any source/README; that is expected.)

- [ ] **Step 3: Advance + rebuild opencode-loader (guard-only; behavior unchanged)**

```bash
cd loaders/opencode-loader/core-loader
git fetch origin && git reset --hard <CL_SHA>
cd ..
npm run build
git add -A
git commit -m "chore: bump core-loader -> <CL_SHA> (session picker; opencode path unchanged)"
git push origin main
```

- [ ] **Step 4: Live-verify in the agentbox container (Claude app)**

In a Claude-app agentbox with prior session history:
1. Launch the loader (`cc`), Projects tab, pick a project with ≥1 session, Enter → **Open**.
   Expected: the Sessions sub-mode lists "＋ New session" + prior sessions (title + relative time).
2. Select a prior session → Enter.
   Expected: the wrapper runs `claude --resume <id>` in that dir (the resumed conversation loads).
3. Re-open, select "＋ New session".
   Expected: a fresh `claude` in that dir.
4. Pick a project with **0** sessions, Enter → Open.
   Expected: launches fresh immediately (no one-item picker).
5. Confirm opencode-loader still opens projects exactly as before (no session sub-mode).

Verification command to confirm the deployed wrapper (inside the container):
```bash
grep -n "sed -n 2p\|--resume" ~/.local/bin/cc
```
Expected: present.

- [ ] **Step 5: Windows spot-check (user)**

On Windows/PowerShell, after the loader updates: open a project → pick a session → confirm `claude --resume` launches in the dir, and "＋ New session" launches fresh. (This also confirms the newly-wired `cmd` project-open flow.)

---

## Self-Review

**Spec coverage:**
- Loader-native session list → Tasks 1 (data) + 2 (view) + 3 (routing). ✓
- Title = first prompt; recency order → `groupSessions` + tests. ✓
- Picker only when Claude + ≥1 session; else fresh → `enterSessions`. ✓
- `o` stays instant fresh → untouched. ✓
- "Open here" gets the picker, new-session-here keeps exit-42 → `enterSessions(cwd, true)` + `sessionHere`. ✓
- Wrapper protocol (dir + optional session), backward compatible → Task 4 (sh + cmd). ✓
- opencode untouched → `APP_NAME` guard + Task 5 Step 3/4.5. ✓
- Unit test for grouping → Task 1. ✓
- Error handling (missing/parse/0 sessions/esc/stale id) → `querySessions` returns `[]`, `enterSessions` fresh-launch, esc→list. ✓

**Placeholder scan:** none — every code step has complete code.

**Type/name consistency:** `groupSessions`/`querySessions`/`openProjectSession` and the session object keys (`id`, `title`, `lastUsed`, `count`) and state fields (`sessionItems`, `scursor`, `sessionDir`, `sessionHere`) are used identically across Tasks 1–3. ✓
