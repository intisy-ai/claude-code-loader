import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Run Plugin Updater
// ---------------------------------------------------------------------------
async function runUpdater() {
  const configDir = join(homedir(), ".config", "claude");
  const updaterPath = join(configDir, "plugin", "plugin-updater", "index.js");
  if (existsSync(updaterPath)) {
    try {
      const updaterModule = await import("file://" + updaterPath.replace(/\\/g, "/"));
      const updater = updaterModule.default || updaterModule;
      
      if (typeof updater.earlyLaunch === 'function') {
        updater.earlyLaunch(configDir);
      }

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
          console.error("[Claude Hub] Failed to parse plugins.json", e);
        }
      }
    } catch (e) {
      console.error("[Claude Hub] Failed to run plugin-updater", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Install / remove the `cc` shell command
// ---------------------------------------------------------------------------
function getBinDir() {
  return join(homedir(), ".local", "bin");
}

async function installCcCommand() {
  await runUpdater();

  const binDir = getBinDir();
  if (!existsSync(binDir)) try { mkdirSync(binDir, { recursive: true }); } catch {}
  
  const configDir = join(homedir(), ".config", "claude");
  const binTuiPath = join(configDir, "plugin", "claude-hub", "cc-tui.js");
  if (!existsSync(binTuiPath)) return; // Wait for updater to succeed next time

  const tuiPathEscaped = binTuiPath.replace(/\\/g, "\\\\");

  if (process.platform === "win32") {
    const cmdPath = join(binDir, "cc.cmd");
    const cmdContent = `@echo off\nnode "${tuiPathEscaped}" %*`;
    writeFileSync(cmdPath, cmdContent, "utf-8");
  } else {
    const shPath = join(binDir, "cc");
    const shContent = `#!/bin/sh\nnode "${tuiPathEscaped}" "$@"`;
    writeFileSync(shPath, shContent, "utf-8");
    try { import("child_process").then(cp => cp.execSync(`chmod +x "${shPath}"`)); } catch {}
  }

  // Remove old command format if it exists
  if (process.platform === "win32") {
    try { import("fs").then(fs => fs.unlinkSync(join(binDir, "cc"))); } catch {}
  } else {
    try { import("fs").then(fs => fs.unlinkSync(join(binDir, "cc.cmd"))); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Extension Hook
// ---------------------------------------------------------------------------
export async function activate() {
  try {
    await installCcCommand();
  } catch (e) {
    console.error("[Claude Hub] Failed to initialize:", e);
  }
}
