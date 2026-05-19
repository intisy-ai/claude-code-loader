#!/usr/bin/env node

/**
 * claude-hub: Session launcher and project switcher for Claude Code.
 *
 * Hook script that installs the `cc` shell command (analogous to `oc` in opencode-hub).
 * The `cc` launcher opens a TUI project picker and starts Claude Code in the chosen directory.
 */

import { existsSync, writeFileSync, mkdirSync, unlinkSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const CONFIG_DIR = join(CLAUDE_DIR, "config");
const CACHE_DIR = join(CLAUDE_DIR, "cache");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const UPDATE_CHECK_PATH = join(CACHE_DIR, "cc-last-update-check");

// ---------------------------------------------------------------------------
// Install / remove the `cc` shell command
// ---------------------------------------------------------------------------

function getBinDir() {
  return join(HOME, ".local", "bin");
}

function getPluginRoot() {
  // Walk up from this script to find .claude-plugin/plugin.json
  let dir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
}

function installCcCommand() {
  const binDir = getBinDir();
  if (!existsSync(binDir)) try { mkdirSync(binDir, { recursive: true }); } catch {}

  const tuiScript = join(getPluginRoot(), "scripts", "cc-tui.js");

  if (process.platform === "win32") {
    const cmdPath = join(binDir, "cc.cmd");
    const cmdContent = '@echo off\r\n'
      + ':: Seamless Antigravity Proxy Integration\r\n'
      + 'set "PROXY=%USERPROFILE%\\.claude\\repos\\intisy\\claude-antigravity-auth\\scripts\\proxy.js"\r\n'
      + 'if exist "%PROXY%" ( start /b /min node "%PROXY%" >nul 2>&1 )\r\n'
      + 'set "tmp=%TEMP%\\cc-output-%RANDOM%.tmp"\r\n'
      + 'set "CC_OUTPUT=%tmp%"\r\n'
      + 'node "' + tuiScript + '" %*\r\n'
      + 'if exist "%tmp%" (\r\n'
      + '  set /p dir=<"%tmp%"\r\n'
      + '  del "%tmp%" 2>nul\r\n'
      + ')\r\n'
      + 'if defined dir (\r\n'
      + '  cd /d "%dir%" && claude\r\n'
      + ')\r\n';
    try { writeFileSync(cmdPath, cmdContent, "utf-8"); } catch {}
  } else {
    const shPath = join(binDir, "cc");
    const shContent = '#!/bin/sh\n'
      + '# Seamless Antigravity Proxy Integration\n'
      + 'PROXY="$HOME/.claude/repos/intisy/claude-antigravity-auth/scripts/proxy.js"\n'
      + '[ -f "$PROXY" ] && node "$PROXY" >/dev/null 2>&1 &\n'
      + 'tmp=$(mktemp)\n'
      + 'CC_OUTPUT="$tmp" node "' + tuiScript.replace(/\\/g, "\\\\") + '" "$@"\n'
      + 'dir=$(cat "$tmp" 2>/dev/null)\n'
      + 'rm -f "$tmp"\n'
      + 'if [ -n "$dir" ]; then\n'
      + '  cd "$dir" && claude\n'
      + 'fi\n';
    try { writeFileSync(shPath, shContent, { mode: 0o755 }); } catch {}
  }
}

function removeCcCommand() {
  const binDir = getBinDir();
  const files = ["cc", "cc.cmd"];
  const removed = [];
  for (const f of files) {
    const p = join(binDir, f);
    if (existsSync(p)) {
      try { unlinkSync(p); removed.push(f); } catch {}
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

function discoverProjects() {
  const projects = [];

  // Scan PROJECTS_DIR for per-project CLAUDE.md overrides
  if (existsSync(PROJECTS_DIR)) {
    try {
      for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          // Project dirs are hashed paths; try to read the settings
          const settingsPath = join(PROJECTS_DIR, entry.name, "settings.json");
          if (existsSync(settingsPath)) {
            try {
              const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
              if (s.projectPath) {
                projects.push({
                  name: s.projectPath.split(/[\\/]/).pop() || entry.name,
                  path: s.projectPath,
                  lastUsed: 0,
                });
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  // Scan sessions for recent project paths
  if (existsSync(SESSIONS_DIR)) {
    try {
      for (const file of readdirSync(SESSIONS_DIR)) {
        if (!file.endsWith(".json")) continue;
        try {
          const session = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf-8"));
          if (session.cwd && !projects.some(p => p.path === session.cwd)) {
            projects.push({
              name: session.cwd.split(/[\\/]/).pop() || session.cwd,
              path: session.cwd,
              lastUsed: session.updatedAt || 0,
            });
          }
        } catch {}
      }
    } catch {}
  }

  return projects.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

// ---------------------------------------------------------------------------
// Hook entry point: install on SessionStart
// ---------------------------------------------------------------------------

const input = process.env.CLAUDE_HOOK_INPUT;
const hookType = process.env.CLAUDE_HOOK_EVENT;

if (hookType === "SessionStart") {
  installCcCommand();
}

// Output projects list if requested via env
if (process.env.CC_LIST_PROJECTS === "1") {
  const projects = discoverProjects();
  console.log(JSON.stringify(projects, null, 2));
}
