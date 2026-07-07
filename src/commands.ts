// @ts-nocheck
// Cross-app slash-commands for claude-code-loader. The shared engine lives in
// core-loader (makeLoaderCommands); this only wires the app-specific bits: the
// Claude command dir, the loader's runtime entry, and the `cc auth` hint.
import { join } from "path";
import { existsSync } from "fs";
import { runConfigCli } from "../core/dist/index.js";
import { makeLoaderCommands } from "../core-loader/dist/loader-commands.js";

function loaderEntry(configDir) {
  const candidates = [
    join(configDir, "repos", "claude-code-loader", "dist", "plugin.js"),
  ];
  return candidates.find((c) => existsSync(c)) || candidates[0];
}

const commands = makeLoaderCommands({
  plugin: "claude-code-loader",
  commandDir: "commands",
  loaderEntry,
  runConfigCli,
  authHint: "tell the user to run `cc auth`",
});

export const deployLoaderCommands = commands.deployLoaderCommands;
export const maybeRunCli = commands.maybeRunCli;
