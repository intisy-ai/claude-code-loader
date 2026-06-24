import { existsSync, writeFileSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath, pathToFileURL } from "url";

const START_TIME = new Date().toISOString().replace(/:/g, "-").split(".")[0];

let PLUGIN_CONFIG: Record<string, unknown> | null = null;
function getPluginConfig(configDir: string): Record<string, unknown> {
  if (PLUGIN_CONFIG !== null) return PLUGIN_CONFIG;
  try {
    const preferred = join(configDir, "config", "claude-code-loader.json");
    const fallback  = join(configDir, "claude-code-loader.json");
    const p = existsSync(preferred) ? preferred : existsSync(fallback) ? fallback : null;
    PLUGIN_CONFIG = p ? JSON.parse(readFileSync(p, "utf-8")) : {};
  } catch { PLUGIN_CONFIG = {}; }
  return PLUGIN_CONFIG;
}

function writeLog(configDir: string, message: string, isError: boolean = false) {
  const loggingEnabled = getPluginConfig(configDir).logging !== false;
  try {
    if (loggingEnabled) {
      const date = new Date();
      const dateStr = date.toISOString().split("T")[0];
      const logsDir = join(configDir, "logs", dateStr);
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
      const logFile = join(logsDir, `claude-code-loader-${START_TIME}.log`);
      const prefix = isError ? "[ERROR]" : "[INFO]";
      const logMsg = "[" + date.toISOString() + "] " + prefix + " " + message + "\n";
      appendFileSync(logFile, logMsg);
    }
  } catch (e) {}
}

function getAppConfigDir() {
  const home = homedir();
  const directPath = join(home, ".claude");
  const configPath = join(home, ".config", "claude");
  return existsSync(directPath) ? directPath : configPath;
}

// Resolve plugin-updater the same way in both loaders: the bare specifier first,
// then known install locations (skipped if absent). A path must be a file:// URL
// for dynamic import (notably on Windows), hence pathToFileURL.
async function loadUpdater(): Promise<any> {
  try {
    return await import("plugin-updater");
  } catch {
    // opencode installs npm plugins into its package cache, off the deployed
    // plugin's resolution path; this candidate is simply absent under Claude.
    const candidates = [
      join(homedir(), ".cache", "opencode", "packages", "plugin-updater@latest", "node_modules", "plugin-updater", "dist", "index.js"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return await import(pathToFileURL(candidate).href);
    }
    throw new Error("plugin-updater not resolvable");
  }
}

async function runEarlyLaunchHooks(configDir: string) {
  if (process.env.PLUGIN_UPDATER_ACTIVATION === "1") {
    writeLog(configDir, "Updates driven by plugin-updater (activation context), skipping earlyLaunch");
    return;
  }
  try {
    const updater: any = await loadUpdater();
    const gitPlugins = updater.getPlugins(configDir);
    writeLog(configDir, "Running plugin-updater earlyLaunch for " + gitPlugins.length + " plugins");
    await updater.earlyLaunch(configDir, gitPlugins);
    writeLog(configDir, "plugin-updater earlyLaunch complete");
  } catch (e) {
    writeLog(configDir, "plugin-updater not available, skipping updates: " + e);
  }
}

function getBinDir() {
  return join(homedir(), ".local", "bin");
}

function installCcWrapper(configDir: string) {
  const binDir = getBinDir();
  if (!existsSync(binDir)) try { mkdirSync(binDir, { recursive: true }); } catch {}

  const pluginDir = dirname(fileURLToPath(import.meta.url));
  // the custom Providers/model-mapping tab; runs from the repo clone's dist/
  const extPath = join(configDir, "repos", "claude-code-loader", "dist", "tui-extension.js");
  const authPath = join(configDir, "repos", "claude-code-loader", "dist", "auth-login.js");
  const tuiCandidates = [
    join(configDir, "repos", "claude-code-loader", "core", "dist", "tui.js"),
  ];
  writeLog(configDir, "Installing cc wrapper with runtime TUI resolution");

  if (process.platform === "win32") {
    const cmdPath = join(binDir, "cc.cmd");
    const cmdLines = [
      "@echo off",
      "setlocal",
      'set "HUB_CONFIG_DIR=%USERPROFILE%\\.claude"',
      "set HUB_APP_NAME=Claude Code",
      "set HUB_CLI_CMD=claude",
      "set HUB_NPM_PKG=@anthropic-ai/claude-code",
      `set "HUB_TUI_EXTENSION=${extPath}"`,
      'set "ANTHROPIC_BASE_URL=http://127.0.0.1:34567"',
      'set "ANTHROPIC_API_KEY=sk-ant-loader-proxy"',
      'set "_args=%*"',
      // `cc auth ...` -> provider selector + account menu (fallback: Providers tab)
      `if "%1"=="auth" ( if exist "${authPath}" ( bun run "${authPath}" & exit /b %errorlevel% ) else ( set "HUB_OPEN_TAB=providers" & set "_args=" ) )`,
    ];
    for (const candidate of tuiCandidates) {
      cmdLines.push(`if exist "${candidate}" ( bun run "${candidate}" %_args% & exit /b %errorlevel% )`);
    }
    cmdLines.push("claude %*");
    writeFileSync(cmdPath, cmdLines.join("\r\n") + "\r\n", "utf-8");
    try { const fs = require("fs"); fs.unlinkSync(join(binDir, "cc")); } catch {}
  } else {
    const shPath = join(binDir, "cc");
    const lines = [
      "#!/usr/bin/env bash",
      'export PATH="$HOME/.bun/bin:$PATH"',
      'export HUB_CONFIG_DIR="$HOME/.claude"',
      'export HUB_APP_NAME="Claude Code"',
      'export HUB_CLI_CMD="claude"',
      'export HUB_NPM_PKG="@anthropic-ai/claude-code"',
      `export HUB_TUI_EXTENSION="${extPath}"`,
      // route through the always-on loader proxy so login/onboarding is skipped;
      // only when it answers, so a missing proxy never breaks plain cc usage
      'if curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:34567/health" 2>/dev/null; then',
      '  export ANTHROPIC_BASE_URL="http://127.0.0.1:34567"',
      '  export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-loader-proxy}"',
      'fi',
      'TUI=""',
      "for candidate in \\",
      ...tuiCandidates.map((candidate, index) =>
        `  "${candidate}"${index < tuiCandidates.length - 1 ? " \\" : "; do"}`),
      '  if [ -f "$candidate" ]; then TUI="$candidate"; break; fi',
      "done",
      'if [ -z "$TUI" ] || ! command -v bun >/dev/null 2>&1; then exec claude "$@"; fi',
      // `cc auth ...` -> provider selector + account menu (fallback: Providers tab)
      `if [ "$1" = "auth" ]; then if [ -f "${authPath}" ]; then exec bun run "${authPath}"; else export HUB_OPEN_TAB="providers"; set --; fi; fi`,
      'export CC_OUTPUT="${TEMP:-${TMPDIR:-/tmp}}/cc-dir-$$.txt"',
      'bun run "$TUI" "$@"',
      "EXIT=$?",
      'if [ $EXIT -eq 42 ]; then',
      '  rm -f "$CC_OUTPUT"',
      '  exec claude "$@"',
      "fi",
      'if [ $EXIT -eq 0 ] && [ -f "$CC_OUTPUT" ]; then',
      '  DIR=$(cat "$CC_OUTPUT")',
      '  rm -f "$CC_OUTPUT"',
      '  if [ -n "$DIR" ]; then cd "$DIR" && exec claude; fi',
      "fi",
      'rm -f "$CC_OUTPUT"',
      "exit $EXIT",
    ];
    writeFileSync(shPath, lines.join("\n") + "\n", { mode: 0o755 });
    try { require("child_process").execSync(`chmod +x "${shPath}"`); } catch {}
    try { const fs = require("fs"); fs.unlinkSync(join(binDir, "cc.cmd")); } catch {}
  }

  writeLog(configDir, "Wrapper installed successfully");
}

export async function cleanup(configDir?: string) {
  // opencode invokes every exported function as a plugin hook, passing a context
  // object — return an inert plugin instance then, and only clean up when
  // plugin-updater calls us with an explicit configDir string
  if (typeof configDir !== "string") return {};
  const resolvedConfigDir = configDir;
  const binDir = getBinDir();
  const filesToRemove = [join(binDir, "cc"), join(binDir, "cc.cmd")];
  for (const f of filesToRemove) {
    try {
      if (existsSync(f)) {
        const { unlinkSync } = await import("fs");
        unlinkSync(f);
        writeLog(resolvedConfigDir, "cleanup: removed " + f);
      }
    } catch (e) {
      writeLog(resolvedConfigDir, "cleanup: failed to remove " + f + ": " + e, true);
    }
  }
}

export async function activate() {
  const configDir = getAppConfigDir();
  writeLog(configDir, "Claude Loader activating");

  try {
    await runEarlyLaunchHooks(configDir);
  } catch (e) {
    writeLog(configDir, "Failed during earlyLaunch hooks: " + e, true);
  }

  try {
    installCcWrapper(configDir);
  } catch (e) {
    writeLog(configDir, "Failed to install cc wrapper: " + e, true);
  }

  writeLog(configDir, "Claude Loader activation complete");
  return {};
}

