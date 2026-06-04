
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

module.exports = function(tuiApi) {
  // Only register the Provider tab if we are running from the cc launcher
  // (HUB_APP_NAME is set to Claude Code in cc.js)
  if (process.env.HUB_APP_NAME !== "Claude Code") {
    return;
  }

  const HOME = os.homedir();
  const ACCOUNTS_FILE = path.join(HOME, '.config', 'opencode', 'config', 'anthropic-accounts.json');
  let accounts = [];
  let providerCursor = 0;

  function loadAccounts() {
    try {
      if (fs.existsSync(ACCOUNTS_FILE)) {
        const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
        accounts = data.accounts || [];
      } else {
        accounts = [];
      }
    } catch(e) {
      accounts = [];
    }
  }

  // Load accounts initially
  loadAccounts();

  tuiApi.registerTab({
    id: "provider",
    label: "Provider",
    render: function(state, helper) {
      // Re-load accounts to ensure we have the latest state
      loadAccounts();
      
      helper.pushBody("  " + helper.MAGENTA + "#" + helper.GRAY + " Claude Code Accounts" + helper.RST, false);
      
      const items = [];
      for (let i = 0; i < accounts.length; i++) {
        let acc = accounts[i];
        let status = "active";
        if (acc.coolingDownUntil && acc.coolingDownUntil > Date.now()) {
          status = "rate-limited";
        }
        items.push({ 
          label: acc.email || `Account ${i+1}`, 
          detail: status,
          isAccount: true,
          index: i
        });
      }
      
      items.push({ label: "Add New Account", detail: "Sign in with browser", action: "add" });
      if (accounts.length > 0) {
        items.push({ label: "Delete All Accounts", detail: "Remove all saved tokens", action: "deleteAll" });
      }

      // Render items
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isSel = i === providerCursor;
        const arrow = isSel ? (helper.YELLOW + " > " + helper.RST) : "   ";
        const bg = isSel ? helper.BG_SEL : "";
        const c1 = isSel ? (helper.BOLD + helper.WHITE) : helper.DIM;
        const c2 = isSel ? helper.WHITE : helper.GRAY;
        
        let label = item.label;
        if (item.isAccount) {
          // If this is the currently selected account, mark it
          // Note: In cc-auth.js, there is no single "selected" account, they are just listed
          // The hub proxy automatically cycles them or uses the first available
        }
        
        helper.pushBody("  " + bg + arrow + c1 + helper.pad(helper.trunc(label, 30), 30) + helper.RST + bg + "  " + c2 + item.detail + helper.RST, isSel);
      }
      
      helper.pushBody("", false);
      if (state.message) {
        helper.pushFoot("  " + helper.GREEN + "  " + helper.trunc(state.message, state.cols - 5) + helper.RST);
      }
      helper.pushFoot("  " + helper.GRAY + "-".repeat(helper.barW) + helper.RST);
      helper.pushFoot("  " + helper.DIM + "^v" + helper.RST + "/" + helper.DIM + "WS" + helper.RST + " Move  " +
        helper.DIM + "Enter" + helper.RST + " Select  " +
        helper.DIM + "Tab" + helper.RST + " Switch  " +
        helper.DIM + "Q" + helper.RST + " Quit");
    },
    handleKey: function(key, state, api) {
      // Re-load accounts to ensure accurate item count
      loadAccounts();
      const numItems = accounts.length + (accounts.length > 0 ? 2 : 1);
      
      if (key === "up" || key === "w") {
        providerCursor = Math.max(0, providerCursor - 1);
      } else if (key === "down" || key === "s") {
        providerCursor = Math.min(numItems - 1, providerCursor + 1);
      } else if (key === "enter" || key === "space") {
        if (providerCursor < accounts.length) {
          // Selected an account - open manage menu via cc auth login
          api.flash("Managing account " + (accounts[providerCursor].email || `Account ${providerCursor+1}`));
          try {
            // Drop out of TUI and run cc auth login
            spawnSync("cc", ["auth", "login"], { stdio: "inherit", shell: true });
            loadAccounts();
          } catch(e) {}
        } else {
          // Add or Delete All
          const actionItemIdx = providerCursor - accounts.length;
          if (actionItemIdx === 0) { // Add New Account
            api.flash("Opening browser for login...");
            try {
              spawnSync("cc", ["auth", "login"], { stdio: "inherit", shell: true });
              loadAccounts();
            } catch(e) {}
          } else if (actionItemIdx === 1) { // Delete All Accounts
            try {
              const dir = path.dirname(ACCOUNTS_FILE);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ version: 1, accounts: [] }, null, 2), 'utf-8');
              loadAccounts();
              providerCursor = 0;
              api.flash("All accounts deleted");
            } catch(e) {}
          }
        }
      }
    }
  });
};
// @ts-nocheck
