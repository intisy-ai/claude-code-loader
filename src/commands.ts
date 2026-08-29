// Cross-app slash-commands for claude-code-loader. The shared engine lives in
// basekit/loader (makeLoaderCommands); this only wires the app-specific bits: the
// Claude command dir, the loader's runtime entry, and the `cc auth` hint.
import { join } from "path";
import { existsSync } from "fs";
import { runConfigCli, runAllConfigCli, applyManifestDeclarations, appPaths, getAppDescriptor } from "@intisy-ai/basekit";
import { readDeployedManifests } from "@intisy/bayonet/host";
import { makeLoaderCommands } from "@intisy-ai/basekit/loader/loader-commands.js";
import { busDrain } from "./notify-drain.js";

/**
 * Where this loader's runtime entry lives in one home.
 *
 * @param configDir the home to look in.
 * @returns the first candidate that exists, or the first candidate when none does.
 */
function loaderEntry(configDir: string): string {
  const candidates = [
    join(configDir, "repos", "claude-code-loader", "dist", "plugin.js"),
  ];
  return candidates.find((c) => existsSync(c)) || candidates[0];
}

// Registers what every installed plugin declares, and answers with the ones that ship settings.
// A plugin declares what its settings ARE; serving them is this loader's job, so nothing is spawned
// and a plugin that cannot even be built still has editable settings.
function configTargets(configDir: string): string[] {
  try {
    const pluginDir = appPaths(configDir, getAppDescriptor("claude") ?? null).plugin;
    const manifests = readDeployedManifests(pluginDir).loaded.map((entry) => entry.manifest);
    return applyManifestDeclarations(manifests, configDir)
      .filter((applied) => applied.settings.length > 0)
      // The config NAME, not the plugin id: a plugin whose settings file predates its repository
      // name is served under the file it actually reads.
      .map((applied) => applied.configName);
  } catch {
    return [];
  }
}

const commands = makeLoaderCommands({
  plugin: "claude-code-loader",
  commandDir: "commands",
  loaderEntry,
  runConfigCli,
  runAllConfigCli,
  configTargets,
  authHint: "tell the user to run `cc auth`",
  busDrain,
});

/** Writes this loader's slash-command files into the app's command directory. */
export const deployLoaderCommands = commands.deployLoaderCommands;
/** Answers one of those commands, saying whether the invocation was one of them. */
export const maybeRunCli = commands.maybeRunCli;
export { loaderEntry };
