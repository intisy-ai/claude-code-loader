#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync, spawnSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import accountSync from "../core/account-sync.js";
const { syncAccounts, resetRateLimits } = accountSync;

// ---------------------------------------------------------------------------
// TUI-style arrow-key selector (matches tui.js visual style)
// ---------------------------------------------------------------------------
var _E = "\x1b[";
var _RST = _E + "0m";
var _DIM = _E + "2m";
var _GRAY = _E + "90m";
var _WHITE = _E + "37m";
var _BG_SEL = _E + "48;5;236m";
var _CLR = _E + "K";

function _parseKey(buf) {
  if (buf[0] === 27) {
    if (buf.length === 1) return "escape";
    if (buf[1] === 91) {
      if (buf[2] === 65) return "up";
      if (buf[2] === 66) return "down";
    }
    return null;
  }
  if (buf[0] === 13 || buf[0] === 10) return "enter";
  if (buf[0] === 3) return "ctrl-c";
  var ch = String.fromCharCode(buf[0]).toLowerCase();
  if (ch === "q") return "quit";
  return null;
}

/**
 * TUI-style interactive arrow-key selector.
 * @param {Array<{label: string, detail: string}>} items
 * @param {{title?: string, defaultIndex?: number}} opts
 * @returns {Promise<number>} selected index, or -1 if cancelled
 */
function tuiSelect(items, opts = {}) {
  return new Promise((resolve) => {
    let sel = opts.defaultIndex || 0;
    const out = process.stderr;
    const hideCur = () => out.write(_E + "?25l");
    const showCur = () => out.write(_E + "?25h");

    function render() {
      // Move cursor up to overwrite previous render (after first render)
      out.write(_E + `${items.length}A`);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (i === sel) {
          out.write(`  ${_BG_SEL}${_WHITE} \u25b8 ${item.label}  ${_DIM}(${item.detail})${_RST}${_CLR}\n`);
        } else {
          out.write(`    ${_GRAY}${item.label}  ${_DIM}(${item.detail})${_RST}${_CLR}\n`);
        }
      }
    }

    function done(result) {
      showCur();
      try { if (process.stdin.setRawMode) process.stdin.setRawMode(false); } catch {}
      process.stdin.removeListener("data", onKey);
      process.stdin.pause();
      resolve(result);
    }

    function onKey(buf) {
      const key = _parseKey(buf);
      if (key === "up") {
        sel = (sel - 1 + items.length) % items.length;
        render();
      } else if (key === "down") {
        sel = (sel + 1) % items.length;
        render();
      } else if (key === "enter") {
        done(sel);
      } else if (key === "escape" || key === "quit" || key === "ctrl-c") {
        done(-1);
      }
    }

    hideCur();
    if (opts.title) {
      out.write(`\n${opts.title}\n\n`);
    }
    // Initial render — write lines first, then subsequent renders overwrite
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (i === sel) {
        out.write(`  ${_BG_SEL}${_WHITE} \u25b8 ${item.label}  ${_DIM}(${item.detail})${_RST}${_CLR}\n`);
      } else {
        out.write(`    ${_GRAY}${item.label}  ${_DIM}(${item.detail})${_RST}${_CLR}\n`);
      }
    }

    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onKey);
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

// Self-healing bootstrap: Ensure cc.cmd exists in ~/.local/bin
// This makes the launcher robust even if the Claude Code session hooks haven't run.
function ensureCmdWrapper() {
  const binDir = join(HOME, ".local", "bin");
  if (!existsSync(binDir)) try { mkdirSync(binDir, { recursive: true }); } catch (e) {}

  // Clean up any misplaced cc.js in binDir to prevent path resolution conflicts
  const ccJsPath = join(binDir, "cc.js");
  if (existsSync(ccJsPath)) {
    try { unlinkSync(ccJsPath); } catch (e) {}
  }

  // The actual source file in the repository we want to execute
  const repoJsPath = join(HOME, ".claude", "repos", "intisy", "claude-hub", "bin", "cc.js");

  if (process.platform === "win32") {
    const cmdPath = join(binDir, "cc.cmd");
    const cmdContent = `@echo off\r\n` +
      `cd /d "%USERPROFILE%"\r\n` +
      `node "${repoJsPath}" %*\r\n`;
    try {
      if (!existsSync(cmdPath) || readFileSync(cmdPath, "utf-8") !== cmdContent) {
        writeFileSync(cmdPath, cmdContent, "utf-8");
      }
    } catch (e) {}
    // Clean up raw cc without extension which might confuse Windows shell
    const rawCc = join(binDir, "cc");
    if (existsSync(rawCc)) try { unlinkSync(rawCc); } catch (e) {}
  } else {
    const shPath = join(binDir, "cc");
    const shContent = `#!/bin/sh\nnode "${repoJsPath}" "$@"\n`;
    try {
      if (!existsSync(shPath) || readFileSync(shPath, "utf-8") !== shContent) {
        writeFileSync(shPath, shContent, { mode: 0o755 });
      }
    } catch (e) {}
  }
}
ensureCmdWrapper();

process.env.HUB_CONFIG_DIR = join(HOME, '.claude');
process.env.HUB_APP_NAME = 'Claude Code';
process.env.HUB_CLI_CMD = 'cc';
process.env.HUB_NPM_PKG = '@anthropic-ai/claude-code';
const CLAUDE_DIR = join(HOME, ".claude");
const REPOS_DIR = join(CLAUDE_DIR, "repos");
const PLUGINS_JSON = join(CLAUDE_DIR, "config", "plugins.json");

// Read plugins.json to know what the user has actually installed
function loadPlugins() {
  try {
    return JSON.parse(readFileSync(PLUGINS_JSON, "utf-8"));
  } catch (e) { return []; }
}

// Discover claudeHub configuration from all installed plugins' package.json
function discoverPluginConfigs() {
  const configs = [];
  const plugins = loadPlugins();
  for (const plugin of plugins) {
    if (!plugin.url) continue;
    const match = plugin.url.match(/github\.com\/([^/]+\/[^/]+)/i);
    if (!match) continue;
    const pluginDir = join(REPOS_DIR, ...match[1].split("/"));
    const pkgPath = join(pluginDir, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.claudeHub) {
        configs.push({ name: plugin.name, dir: pluginDir, config: pkg.claudeHub });
      }
    } catch {}
  }
  return configs;
}

// Resolve runtime binary path generically (no hardcoded paths)
function resolveRuntime(runtime) {
  if (runtime === "bun") {
    if (process.platform === "win32") {
      const candidates = [
        join(process.env.APPDATA || "", "npm", "node_modules", "bun", "bin", "bun.exe"),
        join(HOME, ".bun", "bin", "bun.exe"),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
      try {
        const found = execSync("where bun", { encoding: "utf-8" }).trim().split(/\r?\n/)[0];
        if (found) return found.trim();
      } catch {}
    }
    return "bun";
  }
  return runtime || "node";
}

// Apply environment variables declared by any plugin via claudeHub.env
// ANTHROPIC_BASE_URL is ALWAYS overridden to the hub proxy — plugins never own the base URL.
function setupEnv() {
  const configs = discoverPluginConfigs();
  const envPlugins = configs.filter(c => c.config.env);

  if (process.argv.includes("--verbose")) {
    if (envPlugins.length > 0) {
      console.log(`[\x1b[36mcc\x1b[0m] Plugin env: ${envPlugins.map(p => p.name).join(", ")}`);
    }
  }

  const HUB_PROXY_URL = "http://127.0.0.1:34500";
  const isWin = process.platform === "win32";

  for (const { config } of envPlugins) {
    for (const [key, value] of Object.entries(config.env)) {
      // Skip ANTHROPIC_BASE_URL from plugins — hub proxy owns this
      if (key === "ANTHROPIC_BASE_URL") continue;

      if (process.env[key] !== value) {
        if (isWin) {
          spawn("setx", [key, value], { stdio: "ignore", detached: true, windowsHide: true }).unref();
        }
        process.env[key] = value;
      }
    }
  }

  // Always route through hub proxy
  if (process.env.ANTHROPIC_BASE_URL !== HUB_PROXY_URL) {
    process.env.ANTHROPIC_BASE_URL = HUB_PROXY_URL;
    if (isWin) {
      spawn("setx", ["ANTHROPIC_BASE_URL", HUB_PROXY_URL], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    }
  }
}

function installPlugins() {
  if (!existsSync(REPOS_DIR)) {
    mkdirSync(REPOS_DIR, { recursive: true });
  }

  // 1. Ensure core hub is present
  const hub = "intisy/claude-hub";
  const hubDir = join(REPOS_DIR, ...hub.split("/"));
  if (!existsSync(hubDir)) {
    console.log(`[\x1b[36mcc\x1b[0m] Installing core: ${hub}...`);
    const parentDir = dirname(hubDir);
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
    try {
      execSync(`git clone https://github.com/${hub}.git "${hubDir}"`, { stdio: "inherit" });
    } catch (e) {
      console.log(`[\x1b[31mcc\x1b[0m] Failed to clone core.`);
    }
  }

  // 2. Read plugins.json and auto-bootstrap ANY plugin in the config that is missing on disk.
  // This mirrors the OpenCode auto-provisioning pattern exactly.
  const plugins = loadPlugins();
  for (const plugin of plugins) {
    if (!plugin.url) continue;
    // Extract owner/repo from URL
    const match = plugin.url.match(/github\.com\/([^/]+\/[^/]+)/i);
    if (!match) continue;
    const repoSlug = match[1];
    const pluginDir = join(REPOS_DIR, ...repoSlug.split("/"));
    
    if (!existsSync(pluginDir)) {
      console.log(`[\x1b[36mcc\x1b[0m] Auto-provisioning plugin: ${plugin.name} (${repoSlug})...`);
      const parentDir = dirname(pluginDir);
      if (!existsSync(parentDir)) try { mkdirSync(parentDir, { recursive: true }); } catch (e) {}
      try {
        execSync(`git clone https://github.com/${repoSlug}.git "${pluginDir}"`, { stdio: "inherit" });
        console.log(`[\x1b[32mcc\x1b[0m] Successfully provisioned ${plugin.name}.`);
      } catch (e) {
        console.log(`[\x1b[31mcc\x1b[0m] Failed to provision ${plugin.name}: ${e.message}`);
      }
    }
  }
}

// 1. Install missing plugins
installPlugins();

// 2. Setup Env Variables (hub proxy will override ANTHROPIC_BASE_URL after startup)
setupEnv();

// 3a. Start the hub proxy (thin reverse proxy that routes to plugin backends)
async function startHubProxy() {
  const hubProxyScript = join(dirname(fileURLToPath(import.meta.url)), "core", "hub-proxy.js");
  if (!existsSync(hubProxyScript)) return;

  // Check if already running
  try {
    execSync(`curl -s --max-time 1 http://127.0.0.1:34500/hub/status`, { stdio: 'ignore' });
    return; // Already running
  } catch {}

  // Kill any stuck process on port 34500
  if (process.platform === "win32") {
    try {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 34500 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore', windowsHide: true }
      );
    } catch {}
  }

  const { openSync } = await import("fs");
  const logOut = openSync(join(HOME, "hub-proxy.log"), 'a');
  const logErr = openSync(join(HOME, "hub-proxy.err"), 'a');
  const child = spawn("node", [hubProxyScript], {
    windowsHide: true,
    detached: true,
    stdio: ['ignore', logOut, logErr],
  });
  child.unref();

  // Wait up to 3s for hub proxy to bind
  const start = Date.now();
  let ready = false;
  while (Date.now() - start < 3000 && !ready) {
    try {
      execSync(`curl -s --max-time 1 http://127.0.0.1:34500/hub/status`, { stdio: 'ignore' });
      ready = true;
    } catch {
      const blockStart = Date.now();
      while (Date.now() - blockStart < 200) {}
    }
  }

  if (ready) {
    // Override ANTHROPIC_BASE_URL to route through hub proxy
    const hubUrl = "http://127.0.0.1:34500";
    process.env.ANTHROPIC_BASE_URL = hubUrl;
    if (process.platform === "win32") {
      spawn("setx", ["ANTHROPIC_BASE_URL", hubUrl], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    }
  }
}
await startHubProxy();

// 3b. Start any plugin daemons declared via claudeHub.daemon
async function startPluginDaemons() {
  const { openSync } = await import("fs");
  const configs = discoverPluginConfigs();

  for (const { name, dir, config } of configs) {
    const daemon = config.daemon;
    if (!daemon || !daemon.script) continue;

    const script = join(dir, daemon.script);
    if (!existsSync(script)) continue;

    // Check if daemon is already running via health check
    if (daemon.healthCheckUrl) {
      try {
        execSync(`curl -s --max-time 1 ${daemon.healthCheckUrl}`, { stdio: 'ignore' });
        continue; // Already running
      } catch (e) {
        // Not running — proceed to start
      }
    }

    // Kill any stuck process on the declared port
    if (daemon.port && process.platform === "win32") {
      try {
        execSync(
          `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${daemon.port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
          { stdio: 'ignore', windowsHide: true }
        );
      } catch (e) {}
    }

    const runtimeBin = resolveRuntime(daemon.runtime);
    const logBase = name.replace(/[^a-zA-Z0-9-]/g, '-');
    const out = openSync(join(HOME, `${logBase}-daemon.log`), 'a');
    const err = openSync(join(HOME, `${logBase}-daemon.err`), 'a');
    const child = spawn(runtimeBin, ["run", script], {
      windowsHide: true,
      detached: true,
      stdio: ['ignore', out, err]
    });
    child.unref();

    // Wait up to 5s for the daemon to bind (if health check URL provided)
    if (daemon.healthCheckUrl) {
      const start = Date.now();
      let ready = false;
      while (Date.now() - start < 5000 && !ready) {
        try {
          execSync(`curl -s --max-time 1 ${daemon.healthCheckUrl}`, { stdio: 'ignore' });
          ready = true;
        } catch (e) {
          const blockStart = Date.now();
          while (Date.now() - blockStart < 300) {}
        }
      }
    }
  }
}
await startPluginDaemons();

// 4. Handle custom auth reset command
const args = process.argv.slice(2);
const firstArg = args[0];

if (firstArg === "auth" && args[1] === "login") {
  // Discover auth providers from installed plugins' package.json
  const providers = [];
  const plugins = loadPlugins();
  for (const plugin of plugins) {
    if (!plugin.url) continue;
    const match = plugin.url.match(/github\.com\/([^/]+\/[^/]+)/i);
    if (!match) continue;
    const pluginDir = join(REPOS_DIR, ...match[1].split("/"));
    const pkgPath = join(pluginDir, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.claudeHub && Array.isArray(pkg.claudeHub.authProviders)) {
        for (const prov of pkg.claudeHub.authProviders) {
          providers.push({
            name: prov.name,
            loginScript: join(pluginDir, prov.loginScript),
            runtime: prov.runtime || "node",
            plugin: plugin.name,
          });
        }
      }
    } catch {}
  }

  if (providers.length === 0) {
    console.log("[\x1b[31mcc\x1b[0m] No auth providers found. Install a plugin that declares claudeHub.authProviders in its package.json.");
    process.exit(1);
  }

  // Always show interactive menu to allow swapping providers in the future
  let chosen;
  const authItems = [
    { label: "Claude Code (Official)", detail: "Local subscription login" },
    ...providers.map(p => ({ label: p.name, detail: `from ${p.plugin}` }))
  ];
  const idx = await tuiSelect(authItems, { title: "[\x1b[36mcc\x1b[0m] Select an auth provider:" });
  if (idx < 0) {
    console.log("[\x1b[36mcc\x1b[0m] Cancelled.");
    process.exit(0);
  }
  
  // If user selected "Claude Code (Official)" (index 0), run our custom TUI auth manager
  if (idx === 0) {
    const ccAuthPath = join(dirname(fileURLToPath(import.meta.url)), "core", "cc-auth.js");
    spawnSync("node", [ccAuthPath], { stdio: "inherit", shell: true });
    
    // Sync accounts after login
    console.log("[\x1b[36mcc\x1b[0m] Syncing accounts across all locations...");
    try {
      const result = await syncAccounts();
      console.log(`[\x1b[32mcc\x1b[0m] Synced ${result.count} accounts (source: ${result.source}).`);
    } catch (e) {}
    
    process.exit(0);
  } else {
    // A plugin provider was selected (idx - 1)
    chosen = providers[idx - 1];

    if (!existsSync(chosen.loginScript)) {
      console.log(`[\x1b[31mcc\x1b[0m] Login script not found: ${chosen.loginScript}`);
      process.exit(1);
    }

    // Determine runtime binary via generic resolver
    const runtimeBin = resolveRuntime(chosen.runtime);
    spawnSync(runtimeBin, ["run", chosen.loginScript], { stdio: "inherit" });

    // Sync accounts after login
    console.log("[\x1b[36mcc\x1b[0m] Syncing accounts across all locations...");
    try {
      const result = await syncAccounts();
      console.log(`[\x1b[32mcc\x1b[0m] Synced ${result.count} accounts (source: ${result.source}).`);
    } catch (e) {
      console.log(`[\x1b[33mcc\x1b[0m] Sync warning: ${e.message}`);
    }
    process.exit(0);
  }
}

if (firstArg === "auth" && args[1] === "reset") {
  console.log("[\x1b[36mcc\x1b[0m] Resetting all account rate limits...");
  try {
    const cleared = await resetRateLimits();
    console.log(`[\x1b[32mcc\x1b[0m] Rate limits cleared across ${cleared} file(s).`);
  } catch (e) {
    console.error("Failed to clear accounts rate limits:", e);
  }
  process.exit(0);
}

// 4b. Handle `cc model` — select which plugin backend the hub proxy routes to
if (firstArg === "model") {
  const http = await import("http");

  // Fetch current providers from hub proxy
  let hubData;
  try {
    hubData = await new Promise((resolve, reject) => {
      const req = http.get("http://127.0.0.1:34500/hub/providers", { timeout: 2000 }, (res) => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
  } catch (e) {
    console.log("[\x1b[31mcc\x1b[0m] Hub proxy is not running. Start it with `cc` first.");
    process.exit(1);
  }

  const providers = hubData.providers || [];
  if (providers.length === 0) {
    console.log("[\x1b[31mcc\x1b[0m] No model provider backends found. Install a plugin that declares claudeHub.daemon.");
    process.exit(1);
  }

  const defaultModelIdx = providers.findIndex(p => p.name === hubData.selected);
  const modelItems = providers.map(p => ({
    label: p.name + ((hubData.selected === p.name) ? " \x1b[32m◀ active\x1b[0m" : ""),
    detail: `port ${p.port}`,
  }));
  const currentLabel = hubData.selected ? `\x1b[32m${hubData.selected}\x1b[0m` : "\x1b[33m(auto — first available)\x1b[0m";
  const pidx = await tuiSelect(modelItems, {
    title: `[\x1b[36mcc\x1b[0m] Model Provider Selection\n\n  Current: ${currentLabel}`,
    defaultIndex: defaultModelIdx >= 0 ? defaultModelIdx : 0,
  });

  if (pidx < 0) {
    console.log("[\x1b[36mcc\x1b[0m] No change.");
    process.exit(0);
  }

  const selectedName = providers[pidx].name;
  try {
    await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ name: selectedName });
      const req = http.request("http://127.0.0.1:34500/hub/select", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: 2000,
      }, (res) => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.write(payload);
      req.end();
    });
    console.log(`[\x1b[32mcc\x1b[0m] Switched model provider to: ${selectedName}`);
  } catch (e) {
    console.log(`[\x1b[31mcc\x1b[0m] Failed to switch provider: ${e.message}`);
  }
  process.exit(0);
}

if (firstArg && !firstArg.startsWith('-') && existsSync(firstArg)) {
  const { statSync } = await import('fs');
  if (statSync(firstArg).isDirectory()) {
    console.log(`[\x1b[36mcc\x1b[0m] Launching Claude in: ${firstArg}`);
    spawnSync('claude', args.slice(1), { cwd: firstArg, stdio: 'inherit', shell: true });
    process.exit(0);
  }
}

// Run Plugin Updater
try {
  const configDir = join(homedir(), ".config", "claude");
  const updaterPath = join(configDir, "plugin", "plugin-updater", "index.js");
  if (existsSync(updaterPath)) {
    const updater = await import("file://" + updaterPath.replace(/\\/g, "/")).then(m => m.default || m);
    if (updater && updater.updatePlugin) {
      if (typeof updater.earlyLaunch === 'function') {
        updater.earlyLaunch(configDir);
      }

      // Update claude-hub
      updater.updatePlugin("claude-hub", "https://github.com/intisy/claude-hub.git");
      
      // Update plugins from plugins.json
      const pluginsJsonPath = join(configDir, "config", "plugins.json");
      if (existsSync(pluginsJsonPath)) {
        try {
          const plugins = JSON.parse(readFileSync(pluginsJsonPath, "utf-8"));
          for (const plugin of plugins) {
            if (plugin.url && plugin.enabled !== false && plugin.type !== "npm") {
              const branch = plugin.branch || null;
              const commit = plugin.commit || null;
              updater.updatePlugin(plugin.name, plugin.url, branch, commit);
              updater.deployToExecutionDir(plugin.name, join(configDir, "plugin"));
            }
          }
        } catch (e) {
          console.error("[\x1b[36mcc\x1b[0m] Failed to parse plugins.json", e);
        }
      }
    }
  }
} catch (e) {
  // Silent fail if updater is unavailable
}
          }
        } catch (e) {
          console.error("[\x1b[36mcc\x1b[0m] Failed to parse plugins.json", e);
        }
      }
    }
  }
} catch (e) {
  // Silent fail if updater is unavailable
}

// 5. Run the TUI
const tuiScript = join(dirname(fileURLToPath(import.meta.url)), "core", "tui.js");
try {
  const tmpFile = join(HOME, `.cc-output-${Date.now()}.tmp`);
  process.env.CC_OUTPUT = tmpFile; process.env.HUB_OUTPUT = tmpFile; process.env.CC_LAUNCHER = "1";
  
  // Pass command line arguments correctly (already declared above)
  
  const child = spawnSync(resolveRuntime("bun"), ["run", tuiScript, ...args], { stdio: "inherit" });
  
  if (child.status === 42) {
    spawnSync("claude", args, { stdio: "inherit", shell: true });
    process.exit(0);
  }
  
  if (existsSync(tmpFile)) {
    const targetDir = readFileSync(tmpFile, "utf-8").trim();
    unlinkSync(tmpFile);
    if (targetDir) {
      console.log(`[\x1b[36mcc\x1b[0m] Launching Claude in: ${targetDir}`);
      spawnSync("claude", [], { cwd: targetDir, stdio: "inherit", shell: true });
    }
  }

} catch (e) {
  console.error("Error running TUI", e);
}

