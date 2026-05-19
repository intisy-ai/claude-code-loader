#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync, spawnSync, spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const REPOS_DIR = join(CLAUDE_DIR, "repos");

// List of default plugins to ensure are installed
const defaultPlugins = [
  "intisy/claude-antigravity-auth",
  "intisy/claude-credit-dashboard",
  "intisy/claude-wakatime"
];

function setupEnv() {
  console.log("[\x1b[36mcc\x1b[0m] Ensuring Antigravity environment is configured...");
  const isWin = process.platform === "win32";
  
  if (isWin) {
    if (process.env.ANTHROPIC_API_KEY !== "sk-ant-api03-antigravity-dummy-key-000000000000000000000000000000") {
      execSync('setx ANTHROPIC_API_KEY "sk-ant-api03-antigravity-dummy-key-000000000000000000000000000000"', { stdio: "ignore" });
      process.env.ANTHROPIC_API_KEY = "sk-ant-api03-antigravity-dummy-key-000000000000000000000000000000";
      console.log("[\x1b[36mcc\x1b[0m] Set ANTHROPIC_API_KEY globally.");
    }
    if (process.env.ANTHROPIC_BASE_URL !== "http://127.0.0.1:8080") {
      execSync('setx ANTHROPIC_BASE_URL "http://127.0.0.1:8080"', { stdio: "ignore" });
      process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8080";
      console.log("[\x1b[36mcc\x1b[0m] Set ANTHROPIC_BASE_URL globally.");
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
const proxyScript = join(REPOS_DIR, "intisy", "claude-antigravity-auth", "scripts", "proxy.js");
if (existsSync(proxyScript)) {
  // Spawn completely detached so it never blocks the terminal
  const child = spawn("node", [proxyScript], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

// 4. Run the TUI
const tuiScript = join(dirname(__dirname), "scripts", "cc-tui.js");
try {
  const tmpFile = join(HOME, `.cc-output-${Date.now()}.tmp`);
  process.env.CC_OUTPUT = tmpFile;
  
  // Pass command line arguments correctly
  const args = process.argv.slice(2);
  
  spawnSync("node", [tuiScript, ...args], { stdio: "inherit" });
  
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
