#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync, spawnSync, spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
process.env.HUB_CONFIG_DIR = join(HOME, '.claude');
process.env.HUB_APP_NAME = 'Claude Code';
process.env.HUB_CLI_CMD = 'cc';
process.env.HUB_NPM_PKG = '@anthropic-ai/claude-code';
const CLAUDE_DIR = join(HOME, ".claude");
const REPOS_DIR = join(CLAUDE_DIR, "repos");

// List of default plugins to ensure are installed
const defaultPlugins = [
  "intisy/claude-antigravity-auth",
  "intisy/claude-credit-dashboard",
  "intisy/claude-wakatime"
];

function setupEnv() {
  if (!process.argv.includes("--version") && !process.argv.includes("-v") && !process.argv.includes("--help")) { console.log("[\x1b[36mcc\x1b[0m] Ensuring Antigravity environment is configured..."); }
  const isWin = process.platform === "win32";
  
  if (isWin) {
    if (process.env.ANTHROPIC_API_KEY !== "sk-ant-api03-antigravity-dummy-key-000000000000000000000000000000") {
      spawn("setx", ["ANTHROPIC_API_KEY", "sk-ant-api03-antigravity-dummy-key-000000000000000000000000000000"], { stdio: "ignore", detached: true, windowsHide: true }).unref();
      process.env.ANTHROPIC_API_KEY = "sk-ant-api03-antigravity-dummy-key-000000000000000000000000000000";
    }
    if (process.env.ANTHROPIC_BASE_URL !== "http://127.0.0.1:8080") {
      spawn("setx", ["ANTHROPIC_BASE_URL", "http://127.0.0.1:8080"], { stdio: "ignore", detached: true, windowsHide: true }).unref();
      process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8080";
    }
  } else {
    // Basic Unix fallback (would need shell rc editing for persistence)
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-antigravity-dummy-key-000000000000000000000000000000";
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8080";
  }
}

function installPlugins() {
  if (!existsSync(REPOS_DIR)) {
    mkdirSync(REPOS_DIR, { recursive: true });
  }

  for (const plugin of defaultPlugins) {
    const pluginDir = join(REPOS_DIR, ...plugin.split("/"));
    if (!existsSync(pluginDir)) {
      console.log(`[\x1b[36mcc\x1b[0m] Installing plugin: ${plugin}...`);
      const parentDir = dirname(pluginDir);
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
      
      try {
        execSync(`git clone https://github.com/${plugin}.git "${pluginDir}"`, { stdio: "inherit" });
      } catch (e) {
        console.log(`[\x1b[31mcc\x1b[0m] Failed to clone ${plugin}.`);
      }
    }
  }
}

// 1. Install missing plugins
installPlugins();

// 2. Setup Env Variables
setupEnv();

// 3. Start proxy immediately if antigravity is installed (to be safe for this session)
const proxyScript = join(REPOS_DIR, "intisy", "claude-antigravity-auth", "scripts", "proxy.ts");
if (existsSync(proxyScript)) {
  const { openSync } = await import("fs");
  
  // Kill any existing proxy to ensure we run the latest code
  if (process.platform === "win32") {
    try {
      execSync('FOR /F "tokens=5" %a IN (\'netstat -aon ^| findstr :8080 ^| findstr LISTENING\') DO taskkill /F /PID %a', { stdio: 'ignore' });
    } catch (e) {}
  }

  const out = openSync(join(HOME, 'proxy-spawn.log'), 'a');
  const err = openSync(join(HOME, 'proxy-spawn.err'), 'a');
  const child = spawn((process.platform === "win32" ? "C:\\\\Users\\\\finn\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\bun\\\\bin\\\\bun.exe" : "bun"), ["run", proxyScript], { windowsHide: true,
    detached: true,
    stdio: ['ignore', out, err]
  });
  child.unref();

  // Wait 1 second to ensure the proxy binds to port 8080 before Claude Code connects
  const start = Date.now();
  while (Date.now() - start < 1000) {
    // block synchronously to delay the TUI and Claude Code launch
  }
}

// 4. Run the TUI
const tuiScript = join(dirname(__dirname), "core", "tui.js");
try {
  const tmpFile = join(HOME, `.cc-output-${Date.now()}.tmp`);
  process.env.CC_OUTPUT = tmpFile; process.env.HUB_OUTPUT = tmpFile;
  
  // Pass command line arguments correctly
  const args = process.argv.slice(2);
  
  spawnSync((process.platform === "win32" ? "C:\\\\Users\\\\finn\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\bun\\\\bin\\\\bun.exe" : "bun"), ["run", tuiScript, ...args], { stdio: "inherit" });
  
  if (existsSync(tmpFile)) {
    const targetDir = readFileSync(tmpFile, "utf-8").trim();
    unlinkSync(tmpFile);
    if (targetDir) {
      console.log(`[\x1b[36mcc\x1b[0m] Launching Claude in: ${targetDir}`);
      spawnSync("claude", args, { cwd: targetDir, stdio: "inherit", shell: true });
    }
  }

} catch (e) {
  console.error("Error running TUI", e);
}

