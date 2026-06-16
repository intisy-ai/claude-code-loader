// @ts-nocheck
// `cc auth login`: a minimal provider selector (raw-stdin), then the chosen
// provider's shared account menu (its menu() export) — mirrors OpenCode's
// oc auth login. Standalone blocking flow (owns stdin); not the loader TUI.
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function configDir() { return process.env.HUB_CONFIG_DIR || join(homedir(), ".claude"); }
function reposDir() { return join(configDir(), "repos"); }

function providers() {
  const out = [];
  let repos = [];
  try { repos = readdirSync(reposDir()); } catch { return out; }
  for (const repo of repos) {
    try {
      const pkg = JSON.parse(readFileSync(join(reposDir(), repo, "package.json"), "utf8"));
      const declared = (pkg.claudeHub && pkg.claudeHub.authProviders) || pkg.authProviders || [];
      for (const p of declared) {
        const name = p.name || repo;
        const handler = p.handler ? join(reposDir(), repo, p.handler) : null;
        if (handler && existsSync(handler) && !out.find((x) => x.name === name)) out.push({ name, handler });
      }
    } catch {}
  }
  return out;
}

function pick(title, options) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || options.length <= 1) { resolve(options[0] || null); return; }
    const { stdin, stderr } = process;
    let cursor = 0, drawn = 0;
    const render = () => {
      if (drawn) stderr.write("\x1b[" + drawn + "A");
      let n = 0;
      const line = (s) => { stderr.write("\x1b[2K" + s + "\n"); n++; };
      line("\x1b[2m┌  \x1b[0m" + title);
      options.forEach((o, i) => line("\x1b[36m│\x1b[0m  " + (i === cursor ? "\x1b[32m●\x1b[0m " + o.name : "\x1b[2m○ " + o.name + "\x1b[0m")));
      line("\x1b[36m└\x1b[0m  \x1b[2m↑↓ select · Enter confirm · Esc cancel\x1b[0m");
      drawn = n;
    };
    const wasRaw = stdin.isRaw;
    const done = (val) => { try { stdin.removeListener("data", onKey); stdin.setRawMode(wasRaw); stdin.pause(); } catch {} stderr.write("\x1b[?25h"); resolve(val); };
    const onKey = (d) => {
      const s = d.toString();
      if (s === "\x1b[A" || s === "\x1bOA") { cursor = (cursor - 1 + options.length) % options.length; render(); }
      else if (s === "\x1b[B" || s === "\x1bOB") { cursor = (cursor + 1) % options.length; render(); }
      else if (s === "\r" || s === "\n") done(options[cursor]);
      else if (s === "\x03" || s === "\x1b") done(null);
    };
    try { stdin.setRawMode(true); } catch {}
    stdin.resume(); stderr.write("\x1b[?25l"); render(); stdin.on("data", onKey);
  });
}

(async () => {
  const provs = providers();
  if (!provs.length) { process.stdout.write("No providers installed. Add one to plugins.json.\n"); process.exit(0); }
  const chosen = await pick("Select provider", provs);
  if (!chosen) process.exit(0);
  try {
    const mod = await import(chosen.handler);
    if (typeof mod.menu === "function") await mod.menu();
    else process.stdout.write(chosen.name + " has no account menu.\n");
  } catch (e) { process.stdout.write("Account menu failed: " + (e && e.message || e) + "\n"); }
  process.exit(0);
})();
