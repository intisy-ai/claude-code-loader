// Universal plugin contract via core's shared test-kit. The loader is app-specific
// (Claude only) and deploys its commands in activate() via deployLoaderCommands,
// so the kit calls that export rather than a bare load.
import { runPluginContract } from "../../core/src/testing.js";

runPluginContract({
  name: "claude-code-loader",
  entry: "dist/plugin.js",
  configName: "claude-code-loader",
  app: "claude",
  commands: ["claude-code-loader-config", "plugins", "accounts"],
  deploy: { module: "dist/commands.js", fn: "deployLoaderCommands", arg: "claude" },
  actions: [["plugins"], ["accounts"]],
});
