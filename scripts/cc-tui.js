#!/usr/bin/env node

/**
 * cc-tui.js - Interactive project picker TUI for Claude Code.
 *
 * Lists recently used projects and lets the user pick one.
 * Writes the selected directory to CC_OUTPUT for the shell wrapper.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");

function discoverProjects() {
  const seen = new Set();
  const projects = [];

  // From projects directory
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

  // From sessions
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

async function main() {
  const args = process.argv.slice(2);
  const outPath = process.env.CC_OUTPUT;

  // If the user passed explicit arguments (like --help or -p), skip the TUI 
  // and launch Claude in the current directory immediately.
  if (args.length > 0) {
    if (outPath) writeFileSync(outPath, process.cwd(), "utf-8");
    process.exit(0);
  }

  const projects = discoverProjects();

  if (projects.length === 0) {
    console.log("[\x1b[36mcc\x1b[0m] No previous projects found. Launching Claude in current directory...");
    if (outPath) writeFileSync(outPath, process.cwd(), "utf-8");
    process.exit(0);
  }

  console.log("\n  \x1b[1mClaude Code - Project Switcher\x1b[0m\n");
  projects.forEach((p, i) => {
    const num = String(i + 1).padStart(3);
    const exists = existsSync(p.path) ? "" : " \x1b[31m(missing)\x1b[0m";
    console.log(`  ${num}. \x1b[36m${p.name}\x1b[0m${exists}`);
    console.log(`       ${p.path}`);
  });
  console.log(`\n  ${String(projects.length + 1).padStart(3)}. \x1b[33mCustom path...\x1b[0m\n`);

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  const answer = await new Promise(resolve => {
    rl.question("  Select project [1]: ", resolve);
  });
  rl.close();

  const choice = parseInt(answer || "1", 10);

  let selectedPath;
  if (choice === projects.length + 1) {
    const rl2 = createInterface({ input: process.stdin, output: process.stderr });
    selectedPath = await new Promise(resolve => {
      rl2.question("  Enter path: ", resolve);
    });
    rl2.close();
  } else if (choice >= 1 && choice <= projects.length) {
    selectedPath = projects[choice - 1].path;
  } else {
    console.error("  Invalid selection.");
    process.exit(1);
  }

  if (!selectedPath || !existsSync(selectedPath)) {
    console.error(`  Path not found: ${selectedPath}`);
    process.exit(1);
  }

  // Write selected path to output file for shell wrapper
  const outputFile = process.env.CC_OUTPUT;
  if (outputFile) {
    writeFileSync(outputFile, selectedPath, "utf-8");
  } else {
    console.log(selectedPath);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
