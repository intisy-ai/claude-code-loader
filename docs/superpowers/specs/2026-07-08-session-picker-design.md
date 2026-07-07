# Session Picker Design

**Date:** 2026-07-08
**Status:** Approved

## Goal

After a user selects a project in the claude-code loader, let them resume an
existing Claude session or start a new one — an in-loader picker that matches
the built-in session selection opencode offers natively.

## Scope

- **Claude Code only.** Gated on `APP_NAME === "Claude Code"`. opencode keeps
  its current behavior (it already has native session selection), so the
  opencode-loader launch path is untouched.
- Shared TUI logic lives in `core-loader` (used by both loaders); the guard
  keeps the new sub-mode dormant under opencode.

## Architecture

A new `sessions` sub-mode in the core-loader TUI. When the user picks a
project's "Open" action (or "Open here"), the loader groups the existing
`~/.claude/history.jsonl` by `sessionId` for that project directory and shows
the list. The choice is handed to the `cc` wrapper through the existing
`$CC_OUTPUT` file, extended with an optional second line carrying the chosen
`sessionId`. The wrapper runs `claude --resume "<id>"` when a session was
chosen, or plain `claude` for a new one.

No transcript files are parsed — `history.jsonl` already carries every field
needed (`display`, `timestamp`, `project`, `sessionId`).

## Components

Each unit has one responsibility and a small, well-defined interface.

### `core-loader/src/projects.ts`

- `querySessions(dir)` → `Array<{ id, title, lastUsed, count }>`
  - Reads `history.jsonl`, keeps entries whose `project === dir`, groups by
    `sessionId`.
  - `title` = the session's **first** prompt (`display` at the earliest
    `timestamp`) — it identifies what the session was about.
  - `lastUsed` = the max `timestamp` in the group; `count` = number of prompts.
  - Sorted by `lastUsed` descending. Returns `[]` on any read/parse failure.
- `openProjectSession(dir, id)` — writes the output payload (see Wrapper
  Protocol) and exits 0. `id` null/empty ⇒ new session.

### `core-loader/src/views/projects.ts`

- `buildSessions(pushBody, pushFoot, cols, barW)` — renders:
  - a top "＋ New session" row (cursor index 0),
  - one row per session: truncated `title` in the name column, relative time
    (via existing `timeAgo`) right-aligned,
  - footer hints: `↑↓ move · enter select · esc back`.
  - Reuses the existing row/selection styling helpers for visual consistency.

### `core-loader/src/input.ts`

- New `S.mode === "sessions"` handler: `↑/↓` move `S.scursor` within
  `[0, sessionItems.length]`; `enter` ⇒ `openProjectSession(S.sessionDir, id)`
  where `id` is null for row 0 else `S.sessionItems[scursor-1].id`; `esc` ⇒
  back to the project list (`S.mode = "list"`).
- The "open" action and the "Open here" row route into the sub-mode **only**
  when `APP_NAME === "Claude Code"` and `querySessions(dir).length > 0`;
  otherwise they launch fresh exactly as today.
- `o` (quick key) is unchanged — always an instant fresh open.

### `core-loader/src/state.ts`

- Add `sessionItems: []`, `scursor: 0`, `sessionDir: ""` to the shared state
  object.

### `claude-code-loader/src/plugin.ts` (the `cc` wrapper)

- Both the POSIX (`sh`) and Windows (`cmd`) wrappers read `$CC_OUTPUT`:
  - line 1 = `DIR` (as today),
  - line 2 = optional `SESSION_ID`.
  - `cd "$DIR"` then `exec claude --resume "$SESSION_ID"` if the id is
    non-empty, else `exec claude`.
- Backward compatible: a dir-only file behaves exactly as today.

## Wrapper Protocol

`$CC_OUTPUT` file contents:

```
<project-dir>
<session-id-or-empty>
```

- Dir only (no second line) ⇒ new session (current behavior).
- Second line present and non-empty ⇒ `claude --resume "<session-id>"`.

"Open here" (current directory) with a chosen session routes through
`$CC_OUTPUT` (dir = cwd) rather than the exit-42 path, so the id survives.
"New session here" keeps the exit-42 path so the wrapper still forwards the
user's own `cc` arguments (e.g. `--dangerously-skip-permissions`).

## Data Flow

1. Project list → `enter` → action menu → **Open**.
2. `querySessions(dir)`: empty ⇒ launch fresh (skip the picker); else enter
   `sessions` sub-mode with `S.sessionDir = dir`, `S.sessionItems = sessions`.
3. `enter` on a row → `openProjectSession(dir, id|null)` writes `$CC_OUTPUT`,
   exits 0.
4. Wrapper: `cd dir && exec claude [--resume id]`.

## Error Handling

- Missing / unreadable `history.jsonl`, or JSON parse errors → `querySessions`
  returns `[]` → fresh launch (picker skipped).
- Zero sessions for a project → picker skipped, fresh launch.
- `esc` in the picker → return to the project list, no launch.
- A stale/deleted `sessionId` → surfaced by Claude's own `--resume` error;
  the loader does not pre-validate ids.

## Testing

- Unit test `querySessions` against a fixture `history.jsonl`: correct
  grouping by `sessionId`, title taken from the first prompt, recency
  ordering, mixed-project isolation, and `[]` on a missing file.
- Wrapper change verified live in the agentbox container: resume launches
  `claude --resume <id>` in the right dir; new launches plain `claude`.

## Out of Scope

- Renaming / deleting sessions from the loader.
- Session previews or transcript rendering.
- Any opencode-loader change (native session handling already exists).
