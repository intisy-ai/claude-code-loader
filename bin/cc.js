#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync, spawnSync } from "child_process";
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
    if (process.env.ANTHROPIC_API_KEY !== "antigravity-dummy-key") {
      execSync('setx ANTHROPIC_API_KEY "antigravity-dummy-key"', { stdio: "ignore" });
      process.env.ANTHROPIC_API_KEY = "antigravity-dummy-key";
      console.log("[\x1b[36mcc\x1b[0m] Set ANTHROPIC_API_KEY globally.");
    }
    if (process.env.ANTHROPIC_BASE_URL !== "http://127.0.0.1:8080") {
      execSync('setx ANTHROPIC_BASE_URL "http://127.0.0.1:8080"', { stdio: "ignore" });
      process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8080";
      console.log("[\x1b[36mcc\x1b[0m] Set ANTHROPIC_BASE_URL globally.");
    }
  } else {
    // Basic Unix fallback (would need shell rc editing for persistence)
    process.env.ANTHROPIC_API_KEY = "antigravity-dummy-key";
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
  // We don't block on this
  if (process.platform === "win32") {
    execSync(`start /b /min node "${proxyScript}" >nul 2>&1`);
  } else {
    execSync(`node "${proxyScript}" >/dev/null 2>&1 &`);
  }
}

// 4. Run the TUI
const tuiScript = join(dirname(__dirname), "scripts", "cc-tui.js");
try {
  const tmpFile = join(HOME, `.cc-output-${Date.now()}.tmp`);
  process.env.CC_OUTPUT = tmpFile;
  
  spawnSync("node", [tuiScript], { stdio: "inherit" });
  
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
