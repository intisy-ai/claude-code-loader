import { existsSync, writeFileSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const START_TIME = new Date().toISOString().replace(/:/g, "-").split(".")[0];

function writeLog(configDir: string, message: string, isError: boolean = false) {
  try {
    const date = new Date();
    const dateStr = date.toISOString().split("T")[0];
    const logsDir = join(configDir, "logs", dateStr);
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, `loader-${START_TIME}.log`);
    const prefix = isError ? "[ERROR]" : "[INFO]";
    const logMsg = "[" + date.toISOString() + "] " + prefix + " " + message + "\n";
    appendFileSync(logFile, logMsg);
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
  if (!existsSync(pluginsJsonPath)) {
    writeLog(configDir, "No plugins.json found at " + pluginsJsonPath);
    return;
  }

  let plugins: any[] = [];
  try {
    plugins = JSON.parse(readFileSync(pluginsJsonPath, "utf-8"));
  } catch (e) {
    writeLog(configDir, "Failed to parse plugins.json: " + e, true);
    return;
  }

  writeLog(configDir, "Found " + plugins.length + " plugins in plugins.json");

  for (const plugin of plugins) {
    if (plugin.enabled === false) continue;

    let mod: any = null;
    const namesToTry = [plugin.name];

    for (const pName of namesToTry) {
      try {
        mod = await import(pName);
        writeLog(configDir, "Loaded " + pName + " via NPM resolution");
        break;
      } catch (e1) {
        const singleFile = join(configDir, "plugin", `${pName}.js`);
        if (existsSync(singleFile)) {
          try {
            mod = await import("file://" + singleFile.replace(/\\/g, "/"));
            writeLog(configDir, "Loaded " + pName + " from single-file plugin");
            break;
          } catch (e) {}
        }
        const dirFile = join(configDir, "plugin", pName, "index.js");
        if (existsSync(dirFile)) {
          try {
            mod = await import("file://" + dirFile.replace(/\\/g, "/"));
            writeLog(configDir, "Loaded " + pName + " from directory plugin");
            break;
          } catch (e) {}
        }
      }
    }

    if (mod) {
      try {
        const p = mod.default || mod;
        if (typeof p.earlyLaunch === "function") {
          writeLog(configDir, "Running earlyLaunch for " + plugin.name);
          await p.earlyLaunch(configDir, plugins);
          writeLog(configDir, "Finished earlyLaunch for " + plugin.name);
        }
      } catch (e) {
        writeLog(configDir, "Failed earlyLaunch for " + plugin.name + ": " + e, true);
      }
    } else {
      writeLog(configDir, "Could not load plugin: " + plugin.name, true);
    }
  }
}

function getBinDir() {
  return join(homedir(), ".local", "bin");
}

function installCcWrapper(configDir: string) {
  const binDir = getBinDir();
  if (!existsSync(binDir)) try { mkdirSync(binDir, { recursive: true }); } catch {}

  const binTuiPath = join(configDir, "repos", "claude-loader", "dist", "cc-tui.js");
  if (!existsSync(binTuiPath)) {
    writeLog(configDir, "cc-tui.js not found at " + binTuiPath + ", skipping wrapper install");
    return;
  }

  writeLog(configDir, "Installing cc wrapper pointing to " + binTuiPath);

  if (process.platform === "win32") {
    const cmdPath = join(binDir, "cc.cmd");
    const tuiEscaped = binTuiPath.replace(/\\/g, "\\\\");
    writeFileSync(cmdPath, `@echo off\r\nbun run "${tuiEscaped}" %*\r\n`, "utf-8");
    try { const fs = require("fs"); fs.unlinkSync(join(binDir, "cc")); } catch {}
  } else {
    const shPath = join(binDir, "cc");
    const lines = [
      "#!/usr/bin/env bash",
      'export PATH="$HOME/.bun/bin:$PATH"',
      'export CC_OUTPUT="${TEMP:-${TMPDIR:-/tmp}}/cc-dir-$$.txt"',
      `bun run "${binTuiPath}" "$@"`,
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

export async function activate() {
  const configDir = getAppConfigDir();
  writeLog(configDir, "Claude Launcher activating");

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

  writeLog(configDir, "Claude Launcher activation complete");
  return {};
}
