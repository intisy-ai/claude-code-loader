# ⚡ Claude Hub (cc)

A high-performance session launcher, project switcher, dynamic plugin provisioner, and MCP browser for **Claude Code**.

`cc` provides a unified Terminal User Interface (TUI) to swap projects instantly, manage/discover plugins, install verified Model Context Protocol (MCP) servers with zero configuration, and orchestrate rate-limit auto-failover proxies.

---

## 🚀 One-Line Installation

Run the one-line installer in your terminal to bootstrap `cc`, configure your global environment, and register the core launcher:

### 🪟 Windows (PowerShell)
```powershell
irm https://raw.githubusercontent.com/intisy/claude-hub/main/scripts/install.ps1 | iex
```

### 🍎 macOS / 🐧 Linux (Bash)
```bash
curl -fsSL https://raw.githubusercontent.com/intisy/claude-hub/main/scripts/install.sh | sh
```

---

## ✨ Features

- **`cc` Shell Command** — The fastest way to launch Claude Code. Swap between recent workspaces instantly using an interactive list.
- **Auto-Provisioning Engine** — Decoupled bootstrapping. List your desired repositories in `~/.claude/config/plugins.json` and running `cc` automatically clones and configures them *before* Claude Code starts.
- **Unified Plugins Tab** — Easily manage installed plugins or search the GitHub community directory to discover and download new tools.
- **Zero-Config MCP Tab** — Browse and install Model Context Protocol servers instantly. Integrates a curated map of the top 50+ MCP servers (including Context7, Playwright, Filesystem, GitHub, Postgres, and Brave) using verified parameters to prevent installation syntax failures.
- **Seamless Failover Proxy Support** — Detects if `claude-antigravity-auth` is enabled in your configuration and automatically boots the dynamic multi-account failover proxy in the background, keeping your sessions alive with zero manual configuration.

---

## 🛠️ Usage

### 💻 Terminal Command
```bash
# Launch the interactive project switcher & TUI
cc

# Or bypass the TUI and open Claude Code directly in a specific directory
cc /path/to/project
```

### 💬 In-Chat TUI Navigation
Once the TUI is open, use the Arrow Keys (`←`, `→`) to switch tabs:
- **`Projects`** — Swap workspaces, pin favorites (`P`), or hide inactive directories (`H`).
- **`Plugins`** — View active tools or press `Tab` to search and install new community plugins.
- **`MCP`** — Check server connection health or press `Tab` to discover and install verified MCP servers.

---

## 📂 Configuration

Your plugins are tracked cleanly in `~/.claude/config/plugins.json`. You can share this file across machines to replicate your workspace setups instantly:

```json
[
  {
    "name": "claude-hub",
    "url": "https://github.com/intisy/claude-hub"
  },
  {
    "name": "claude-antigravity-auth",
    "url": "https://github.com/intisy/claude-antigravity-auth"
  }
]
```

## 📄 License

MIT © [intisy](https://github.com/intisy)
