import { existsSync, writeFileSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

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

async function runEarlyLaunchHooks(configDir: string) {
  const pluginsJsonPath = join(configDir, "config", "plugins.json");
  let gitPlugins: any[] = [];
  if (existsSync(pluginsJsonPath)) {
    try {
      gitPlugins = JSON.parse(readFileSync(pluginsJsonPath, "utf-8"));
      writeLog(configDir, "Found " + gitPlugins.length + " git plugins in plugins.json");
    } catch (e) {
      writeLog(configDir, "Failed to parse plugins.json: " + e, true);
    }
  }

  try {
    const updater = await import("plugin-updater");
    writeLog(configDir, "Running plugin-updater earlyLaunch");
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
  // resolved at every cc invocation, not at install time, so the wrapper
  // works as soon as any copy of the TUI exists and never goes stale
  const tuiCandidates = [
    join(pluginDir, "cc-tui.js"),
    join(configDir, "repos", "claude-code-loader", "core", "dist", "tui.js"),
  ];
  writeLog(configDir, "Installing cc wrapper with runtime TUI resolution");

  if (process.platform === "win32") {
    const cmdPath = join(binDir, "cc.cmd");
    const cmdLines = ["@echo off", "setlocal"];
    for (const candidate of tuiCandidates) {
      cmdLines.push(`if exist "${candidate}" ( bun run "${candidate}" %* & exit /b %errorlevel% )`);
    }
    cmdLines.push("claude %*");
    writeFileSync(cmdPath, cmdLines.join("\r\n") + "\r\n", "utf-8");
    try { const fs = require("fs"); fs.unlinkSync(join(binDir, "cc")); } catch {}
  } else {
    const shPath = join(binDir, "cc");
    const lines = [
      "#!/usr/bin/env bash",
      'export PATH="$HOME/.bun/bin:$PATH"',
      'TUI=""',
      "for candidate in \\",
      ...tuiCandidates.map((candidate, index) =>
        `  "${candidate}"${index < tuiCandidates.length - 1 ? " \\" : "; do"}`),
      '  if [ -f "$candidate" ]; then TUI="$candidate"; break; fi',
      "done",
      'if [ -z "$TUI" ] || ! command -v bun >/dev/null 2>&1; then exec claude "$@"; fi',
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

