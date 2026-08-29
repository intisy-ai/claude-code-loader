// `cc auth login`: a minimal provider selector (raw-stdin), then the chosen
// provider's shared account menu (its menu() export), mirroring OpenCode's
// oc auth login. Standalone blocking flow (owns stdin); not the loader TUI.
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { readDeployedProviders } from "@intisy-ai/basekit/loader/loader-runtime.js";
import { loaderConfigDir, loaderReposDir } from "@intisy-ai/basekit/loader/app-home.js";

const APP_HOME = join(homedir(), ".claude");
function configDir() { return loaderConfigDir(APP_HOME); }

/** One provider this selector can open, and the handler module that answers for it. */
interface ProviderChoice {
  /** The provider's name, which is what the row shows. */
  name: string;
  /** Its handler file's absolute path. */
  handler: string;
}
function reposDir() { return loaderReposDir(APP_HOME); }

function providers(): ProviderChoice[] {
  const out: ProviderChoice[] = [];
  for (const entry of readDeployedProviders(reposDir())) {
    if (existsSync(entry.handlerPath) && !out.find((x) => x.name === entry.provider)) {
      out.push({ name: entry.provider, handler: entry.handlerPath });
    }
  }
  return out;
}

function pick(title: string, options: ProviderChoice[]): Promise<ProviderChoice | null> {
  return new Promise<ProviderChoice | null>((resolve) => {
    if (!process.stdin.isTTY || options.length <= 1) { resolve(options[0] || null); return; }
    const { stdin, stderr } = process;
    let cursor = 0, drawn = 0;
    const render = () => {
      if (drawn) stderr.write("\x1b[" + drawn + "A");
      let n = 0;
      const line = (s: string) => { stderr.write("\x1b[2K" + s + "\n"); n++; };
      line("\x1b[2m┌  \x1b[0m" + title);
      options.forEach((o: ProviderChoice, i: number) => line("\x1b[36m│\x1b[0m  " + (i === cursor ? "\x1b[32m●\x1b[0m " + o.name : "\x1b[2m○ " + o.name + "\x1b[0m")));
      line("\x1b[36m└\x1b[0m  \x1b[2m↑↓ select · Enter confirm · Esc cancel\x1b[0m");
      drawn = n;
    };
    const wasRaw = stdin.isRaw;
    const done = (val: ProviderChoice | null) => { try { stdin.removeListener("data", onKey); stdin.setRawMode(wasRaw); stdin.pause(); } catch {} stderr.write("\x1b[?25h"); resolve(val); };
    const onKey = (d: Buffer) => {
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
  } catch (e) { process.stdout.write("Account menu failed: " + (e instanceof Error ? e.message : e) + "\n"); }
  process.exit(0);
})();
