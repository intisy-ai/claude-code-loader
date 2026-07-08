# claude-code-loader

[![npm version](https://img.shields.io/npm/v/claude-code-loader)](https://www.npmjs.com/package/claude-code-loader)
[![npm downloads](https://img.shields.io/npm/dm/claude-code-loader)](https://www.npmjs.com/package/claude-code-loader)
[![CI](https://img.shields.io/github/actions/workflow/status/intisy-ai/claude-code-loader/publish.yml)](https://github.com/intisy-ai/claude-code-loader/actions)

TUI launcher and `cc` shell command for [Claude Code](https://github.com/anthropics/claude-code). It installs a `cc` command that opens an interactive TUI for switching projects, managing plugins, and signing in to providers, and runs an always-on local **proxy** that routes Claude requests through provider accounts (e.g. claude-code-auth subscription accounts, antigravity) with rate-limit failover. It also drives [plugin-updater](https://github.com/intisy-ai/plugin-updater) on startup.

## Under-the-Hood Architecture

```mermaid
flowchart TD
    START[Claude Code startup] -->|activate| PLUGIN[plugin.js]
    PLUGIN -->|earlyLaunch| UPDATER[plugin-updater]
    PLUGIN -->|install| CCBIN["cc / cc.cmd in ~/.local/bin"]
    PLUGIN -->|deployCommands| CMDS["/claude-code-loader-config, /plugins, /accounts"]
    DAEMON["proxy.js daemon :34567"] -->|route| PROVIDERS[(core-auth providers)]
    CCBIN -->|run cc| TUI["core-loader TUI (node tui.js)"]
    CCBIN -->|"cc auth"| AUTH[auth-login.js — provider + account menu]
    CCBIN -->|"ANTHROPIC_BASE_URL=:34567"| DAEMON
    TUI --> PROV[Providers tab — tui-extension.js]
```

## Structure

- `src/`
  - `plugin.ts` — the Claude Code plugin entry (`activate`/`cleanup`); installs the `cc` wrapper, runs plugin-updater, deploys commands. Also acts as the command CLI (`node plugin.js <config|plugins|accounts>`).
  - `proxy.ts` — the always-on proxy daemon (`claudeHub.daemon`, port 34567) that routes Claude requests through provider accounts.
  - `auth-login.ts` — `cc auth` provider selector + account menu.
  - `tui-extension.ts` — the custom Providers/model-mapping tab.
  - `commands.ts` — cross-app slash-command definitions + their CLI actions.
- `dist/`
  - `plugin.js` — compiled plugin entry.
  - `proxy.js` — compiled proxy daemon.
  - `auth-login.js` — compiled auth-login helper.
  - `tui-extension.js` — compiled Providers tab extension.
  - `commands.js` — compiled command definitions.

## Requirements

- Node.js 20+ (the TUI, proxy, and CLI all run under Node — no Bun required; Node 22+'s built-in `node:sqlite` reads the session DB, with `bun:sqlite` as a fallback when run under Bun).

## Installation

### Via plugin-updater (recommended)

```bash
npx plugin-updater@latest init https://github.com/intisy-ai/claude-code-loader
```

### Via npm

```bash
npm install claude-code-loader
```

## Usage

```bash
cc              # Launch the TUI
cc auth         # Provider selector + account menu (sign in to claude-code-auth, antigravity, …)
cc <project>    # Open a project directly
```

The `cc` wrapper points `ANTHROPIC_BASE_URL` at the local proxy (`http://127.0.0.1:34567`) only when the proxy is healthy, so plain `claude` usage is never broken when the loader is absent.

## Configuration

Config file: `<configDir>/config/claude-code-loader.json` (edit via the loader or `/claude-code-loader-config set`).

```json
{
  "logging": true,
  "auto_update_check": true,
  "update_check_delay_ms": 1500,
  "update_check_interval_hours": 24,
  "catalog_cache_hours": 6,
  "default_tab": "projects",
  "providerRouting": true
}
```

| Key | Default |
| --- | --- |
| `logging` | `true` |
| `auto_update_check` | `true` |
| `update_check_delay_ms` | `1500` |
| `update_check_interval_hours` | `24` |
| `catalog_cache_hours` | `6` |
| `default_tab` | `"projects"` |
| `providerRouting` | `true` |

## Commands

| Command | Description | Arguments |
| --- | --- | --- |
| `/claude-code-loader-config` | View/change loader config (`claude-code-loader.json`): `list`, `get <key>`, `set <key> <value>`. 100% of the config is reachable here. | `list | get <key> | set <key> <value>` |
| `/plugins` | List the loader-managed plugins and their state (from `plugins.json`). |  |
| `/accounts` | List signed-in accounts across all providers (from the core-auth store). |  |

## Dependencies

- `core-loader`
- `core`
- `plugin-updater`
- `Bun`
- `core-auth provider (e.g. claude-code-auth)`

## Logging

Logs are written to `<configDir>/logs/YYYY-MM-DD/claude-code-loader-HH-MM-SS.log` and are toggled by
this plugin's `logging` config (default on). Console mirroring is global, off by default,
and controlled by the shared `config/settings.json` `logConsole` flag.

## License

MIT.
