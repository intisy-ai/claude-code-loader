import { existsSync, writeFileSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath, pathToFileURL } from "url";
// @ts-ignore — generated bundle, no .d.ts
import { maybeRunCli, deployLoaderCommands } from "./commands.js";
// @ts-ignore — generated bundle, no .d.ts
import { makeWriteLog, defineConfig, defineReadme, maybeRunReadmeCli } from "../core/dist/index.js";

// Slash-command invocations shell in as `node <this file> <action>`; handle them
// first and exit, so command/config runs never go through plugin activation.
// Register config defaults BEFORE the CLI guard so `config schema` sees them (no write).
defineConfig("claude-code-loader", {
  logging: true,
  auto_update_check: true,
  update_check_delay_ms: 1500,
  update_check_interval_hours: 24,
  catalog_cache_hours: 6,
  default_tab: "projects",
});

defineReadme({
  description:
    "TUI launcher and `cc` shell command for [Claude Code](https://github.com/anthropics/claude-code). " +
    "It installs a `cc` command that opens an interactive TUI for switching projects, managing plugins, " +
    "and signing in to providers, and runs an always-on local **proxy** that routes Claude requests through " +
    "provider accounts (e.g. claude-code-auth subscription accounts, antigravity) with rate-limit failover. " +
    "It also drives [plugin-updater](https://github.com/intisy-ai/plugin-updater) on startup.",
  architecture: `flowchart TD
    START[Claude Code startup] -->|activate| PLUGIN[plugin.js]
    PLUGIN -->|earlyLaunch| UPDATER[plugin-updater]
    PLUGIN -->|install| CCBIN["cc / cc.cmd in ~/.local/bin"]
    PLUGIN -->|deployCommands| CMDS["/claude-code-loader-config, /plugins, /accounts"]
    DAEMON["proxy.js daemon :34567"] -->|route| PROVIDERS[(core-auth providers)]
    CCBIN -->|run cc| TUI["core-loader TUI (bun run tui.js)"]
    CCBIN -->|"cc auth"| AUTH[auth-login.js — provider + account menu]
    CCBIN -->|"ANTHROPIC_BASE_URL=:34567"| DAEMON
    TUI --> PROV[Providers tab — tui-extension.js]`,
  structure: {
    src: [
      "`plugin.ts` — the Claude Code plugin entry (`activate`/`cleanup`); installs the `cc` wrapper, runs plugin-updater, deploys commands. Also acts as the command CLI (`node plugin.js <config|plugins|accounts>`).",
      "`proxy.ts` — the always-on proxy daemon (`claudeHub.daemon`, port 34567) that routes Claude requests through provider accounts.",
      "`auth-login.ts` — `cc auth` provider selector + account menu.",
      "`tui-extension.ts` — the custom Providers/model-mapping tab.",
      "`commands.ts` — cross-app slash-command definitions + their CLI actions.",
    ],
    dist: [
      "`plugin.js` — compiled plugin entry.",
      "`proxy.js` — compiled proxy daemon.",
      "`auth-login.js` — compiled auth-login helper.",
      "`tui-extension.js` — compiled Providers tab extension.",
      "`commands.js` — compiled command definitions.",
    ],
  },
  commands: [
    { name: "claude-code-loader-config", description: "View/change loader config (`claude-code-loader.json`): `list`, `get <key>`, `set <key> <value>`. 100% of the config is reachable here.", argumentHint: "list | get <key> | set <key> <value>" },
    { name: "plugins", description: "List the loader-managed plugins and their state (from `plugins.json`)." },
    { name: "accounts", description: "List signed-in accounts across all providers (from the core-auth store)." },
  ],
  dependencies: [
    "core-loader",
    "core",
    "plugin-updater",
    "Bun",
    "core-auth provider (e.g. claude-code-auth)",
  ],
  extraSections: [
    {
      id: "requirements",
      title: "Requirements",
      after: "structure",
      body: "- [Bun](https://bun.sh/) runtime (the TUI and proxy run under Bun).",
    },
    {
      id: "usage",
      title: "Usage",
      after: "installation",
      body:
        "```bash\n" +
        "cc              # Launch the TUI\n" +
        "cc auth         # Provider selector + account menu (sign in to claude-code-auth, antigravity, …)\n" +
        "cc <project>    # Open a project directly\n" +
        "```\n\n" +
        "The `cc` wrapper points `ANTHROPIC_BASE_URL` at the local proxy (`http://127.0.0.1:34567`) only when the proxy is healthy, so plain `claude` usage is never broken when the loader is absent.",
    },
  ],
});

if (maybeRunReadmeCli("claude-code-loader")) process.exit(0);

if (await maybeRunCli(getAppConfigDir())) {
  process.exit(0);
}

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

// Delegate to the shared core logger: loader lines get the [claude-code-loader] prefix,
// per-plugin color, and the GLOBAL console toggle; core also does the file write
// (respecting claude-code-loader.json `logging`). Signature kept for existing callers.
function writeLog(configDir: string, message: string, isError: boolean = false) {
  makeWriteLog("claude-code-loader", configDir)(message, isError);
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
    // core-loader is the post-rename location; the bare "core" path remains as a
    // fallback so already-deployed (pre-rename) installs keep resolving the TUI.
    join(configDir, "repos", "claude-code-loader", "core-loader", "dist", "tui.js"),
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

  try {
    deployLoaderCommands(configDir);
  } catch (e) {
    writeLog(configDir, "Failed to deploy loader commands: " + e, true);
  }

  writeLog(configDir, "Claude Loader activation complete");
  return {};
}

