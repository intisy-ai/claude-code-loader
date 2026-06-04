import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function getAppConfigDir() {
  const home = homedir();
  const directPath = join(home, ".claude");
  const configPath = join(home, ".config", "claude");
  return existsSync(directPath) ? directPath : configPath;
}

// ---------------------------------------------------------------------------
// General Bootstrapper
// ---------------------------------------------------------------------------
async function runEarlyLaunchHooks(configDir: string) {
  const pluginsJsonPath = join(configDir, "config", "plugins.json");
  if (!existsSync(pluginsJsonPath)) return;

  let plugins: any[] = [];
  try {
    plugins = JSON.parse(readFileSync(pluginsJsonPath, "utf-8"));
  } catch (e) {
    console.error("[Claude Hub] Failed to parse plugins.json", e);
    return;
  }

  for (const plugin of plugins) {
    if (plugin.enabled === false) continue;
    
    let mod: any = null;
    const namesToTry = [plugin.name];
    if (plugin.name === "plugin-updater") namesToTry.push("claude-plugin-updater");
    
    for (const pName of namesToTry) {
      try {
        // 1. Try NPM resolution
        mod = await import(pName);
        break;
      } catch (e1) {
        // 2. Try single-file plugin
        const singleFile = join(configDir, "plugin", `${pName}.js`);
        if (existsSync(singleFile)) {
          try { mod = await import("file://" + singleFile.replace(/\\/g, "/")); break; } catch (e) {}
        }
        // 3. Try directory plugin
        const dirFile = join(configDir, "plugin", pName, "index.js");
        if (existsSync(dirFile)) {
          try { mod = await import("file://" + dirFile.replace(/\\/g, "/")); break; } catch (e) {}
        }
      }
    }

    if (mod) {
      try {
        const p = mod.default || mod;
        if (typeof p.earlyLaunch === "function") {
          await p.earlyLaunch(configDir, plugins);
        }
        
        // TEMPORARY: Ensure plugin-updater still handles updates since we removed hardcoded update loops
        if (plugin.name === "plugin-updater" && typeof p.updatePlugin === "function") {
          for (const pl of plugins) {
            if (pl.url && pl.enabled !== false && pl.type !== "npm") {
              p.updatePlugin(pl.name, pl.url, pl.branch || null, pl.commit || null);
              p.deployToExecutionDir(pl.name, join(configDir, "plugin"));
            }
          }
        }
      } catch (e) {
        console.error(`[Claude Hub] Failed to run earlyLaunch for ${plugin.name}`, e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Install / remove the `cc` shell command
// ---------------------------------------------------------------------------
function getBinDir(configDir: string) {
  return join(configDir, "bin");
}

async function installCcCommand() {
  const configDir = getAppConfigDir();
  await runEarlyLaunchHooks(configDir);

  const binDir = getBinDir(configDir);
  if (!existsSync(binDir)) try { mkdirSync(binDir, { recursive: true }); } catch {}
  
  // Point to the compiled cc-tui.js inside the repos directory
  const binTuiPath = join(configDir, "repos", "claude-hub", "dist", "cc-tui.js");
  if (!existsSync(binTuiPath)) return; // Wait for updater to succeed next time

  const tuiPathEscaped = binTuiPath.replace(/\\/g, "\\\\");

  if (process.platform === "win32") {
    const cmdPath = join(binDir, "cc.cmd");
    const cmdContent = `@echo off\nnode "${tuiPathEscaped}" %*`;
    writeFileSync(cmdPath, cmdContent, "utf-8");
    import("fs").then(fs => { try { fs.unlinkSync(join(binDir, "cc")); } catch {} }).catch(()=>{});
  } else {
    const shPath = join(binDir, "cc");
    const shContent = `#!/bin/sh\nnode "${tuiPathEscaped}" "$@"`;
    writeFileSync(shPath, shContent, "utf-8");
    import("child_process").then(cp => { try { cp.execSync(`chmod +x "${shPath}"`); } catch {} }).catch(()=>{});
    import("fs").then(fs => { try { fs.unlinkSync(join(binDir, "cc.cmd")); } catch {} }).catch(()=>{});
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
  return {};
}