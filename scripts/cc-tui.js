#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import { execSync } from "child_process";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const REPOS_DIR = join(CLAUDE_DIR, "repos");

function discoverProjects() {
  const seen = new Set();
  const projects = [];

  if (existsSync(PROJECTS_DIR)) {
    try {
      for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const settingsPath = join(PROJECTS_DIR, entry.name, "settings.json");
        if (existsSync(settingsPath)) {
          try {
            const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
            if (s.projectPath && !seen.has(s.projectPath)) {
              seen.add(s.projectPath);
              projects.push({ name: s.projectPath.split(/[\\/]/).pop(), path: s.projectPath, lastUsed: 0 });
            }
          } catch {}
        }
      }
    } catch {}
  }

  if (existsSync(SESSIONS_DIR)) {
    try {
      for (const file of readdirSync(SESSIONS_DIR)) {
        if (!file.endsWith(".json")) continue;
        try {
          const session = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf-8"));
          if (session.cwd && !seen.has(session.cwd)) {
            seen.add(session.cwd);
            projects.push({ name: session.cwd.split(/[\\/]/).pop(), path: session.cwd, lastUsed: session.updatedAt || 0 });
          }
        } catch {}
      }
    } catch {}
  }

  return projects.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

function getPlugins() {
  const plugins = [];
  if (!existsSync(REPOS_DIR)) return plugins;
  
  try {
    const creators = readdirSync(REPOS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const c of creators) {
      const repos = readdirSync(join(REPOS_DIR, c.name), { withFileTypes: true }).filter(d => d.isDirectory());
      for (const r of repos) {
        const pPath = join(REPOS_DIR, c.name, r.name);
        plugins.push({
          creator: c.name,
          name: r.name,
          path: pPath
        });
      }
    }
  } catch {}
  return plugins;
}

async function askQuestion(query) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(query, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function pluginManager() {
  console.log("\n  \x1b[1mPlugin Manager\x1b[0m\n");
  const plugins = getPlugins();
  
  if (plugins.length === 0) {
    console.log("  No plugins found in ~/.claude/repos");
  } else {
    plugins.forEach((p, i) => {
      const num = String(i + 1).padStart(3);
      console.log("  $num. \x1b[36m$p.creator/$p.name\x1b[0m");
    });
  }
  
  console.log("\n  U. \x1b[33mUpdate all plugins (git pull)\x1b[0m");
  console.log("  B. \x1b[33mBack to main menu\x1b[0m\n");
  
  const answer = await askQuestion("  Select option [B]: ");
  const choice = answer.trim().toUpperCase();
  
  if (choice === "U") {
    console.log("\n  Updating plugins...");
    for (const p of plugins) {
      try {
        console.log("  -> $p.creator/$p.name");
        const branch = p.name === "claude-wakatime" ? "main" : "master";
        execSync("git pull origin $branch", { cwd: p.path, stdio: "ignore", timeout: 10000 });
        console.log("     \x1b[32mUpdated\x1b[0m");
      } catch (e) {
        console.log("     \x1b[31mFailed to update\x1b[0m");
      }
    }
    await askQuestion("\n  Press Enter to continue...");
    return pluginManager();
  } else if (choice === "B" || choice === "") {
    return; // Back to main
  } else {
    return pluginManager();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outPath = process.env.CC_OUTPUT;

  if (args.length > 0) {
    if (outPath) writeFileSync(outPath, process.cwd(), "utf-8");
    process.exit(0);
  }

  while (true) {
    const projects = discoverProjects();
    
    console.log("\n  \x1b[1mClaude Code - cc Launcher\x1b[0m\n");
    
    if (projects.length === 0) {
      console.log("  \x1b[90m(No recent projects found)\x1b[0m\n");
    } else {
      projects.forEach((p, i) => {
        const num = String(i + 1).padStart(3);
        const exists = existsSync(p.path) ? "" : " \x1b[31m(missing)\x1b[0m";
        console.log("  $num. \x1b[36m$p.name\x1b[0m$exists");
        console.log("       \x1b[90m$p.path\x1b[0m");
      });
    }
    
    const customPathIdx = projects.length + 1;
    const pluginManagerIdx = projects.length + 2;
    const currDirIdx = projects.length + 3;
    
    console.log("\n  $String(customPathIdx).padStart(3)}. \x1b[33mCustom path...\x1b[0m");
    console.log("  $String(pluginManagerIdx).padStart(3)}. \x1b[35mPlugin Manager\x1b[0m");
    console.log("  $String(currDirIdx).padStart(3)}. \x1b[32mLaunch in current directory\x1b[0m\n");

    const answer = await askQuestion("  Select option [1]: ");
    const choice = parseInt(answer || "1", 10);

    let selectedPath;
    
    if (choice === pluginManagerIdx) {
      await pluginManager();
      continue; // Refresh main menu
    } else if (choice === currDirIdx) {
      selectedPath = process.cwd();
    } else if (choice === customPathIdx) {
      selectedPath = await askQuestion("  Enter path: ");
    } else if (choice >= 1 && choice <= projects.length) {
      selectedPath = projects[choice - 1].path;
    } else {
      console.error("  Invalid selection.");
      process.exit(1);
    }

    if (!selectedPath || !existsSync(selectedPath)) {
      console.error("  Path not found: $selectedPath");
      await askQuestion("  Press Enter to continue...");
      continue;
    }

    if (outPath) {
      writeFileSync(outPath, selectedPath, "utf-8");
    } else {
      console.log(selectedPath);
    }
    break;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
