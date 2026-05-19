#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { homedir } from "os";

var HOME = homedir();
var CONFIG_DIR = join(HOME, ".claude");
var DB_PATH = join(HOME, ".local", "share", "claude", "claude.db");
var CONFIG_FOLDER = join(CONFIG_DIR, "config");
var CACHE_DIR = join(CONFIG_DIR, "cache");
var CONFIG_PATH = join(CONFIG_FOLDER, "oc-config.json");
var UPDATE_CHECK_PATH = join(CACHE_DIR, "oc-last-update-check");
var PLUGINS_JSON = join(CONFIG_FOLDER, "plugins.json");
var REPOS_DIR = join(CONFIG_DIR, "repos");
var PLUGINS_DIR = join(CONFIG_DIR, "plugin");

// ---------------------------------------------------------------------------
// Folder name helper: <creator>/<repo-name> to avoid collisions
// ---------------------------------------------------------------------------

function loadNpmPlugins() {
  var ocPath = join(CONFIG_DIR, "claude.json");
  if (!existsSync(ocPath)) return [];
  try {
    var raw = readFileSync(ocPath, "utf-8");
    var stripped = raw.replace(/^\s*\/\/[^\n]*/gm, "");
    var oc = JSON.parse(stripped);
    var plugins = oc.plugin || [];
    return plugins
      .filter(function(p) { return typeof p === "string"; })
      .map(function(p) {
        var name = p.replace(/@[^@\/]+$/, "") || p;
        var version = "";
        try {
          // Claude Code installs npm plugins into ~/.cache/claude/node_modules
          var cachePkg = join(homedir(), ".cache", "claude", "node_modules", name, "package.json");
          // Fallback: config-local node_modules, then global npm, then local repos
          var globalNpm = process.platform === "win32"
            ? join(homedir(), "AppData", "Roaming", "npm", "node_modules")
            : join("/usr", "lib", "node_modules");
          var repoPkg = join(CONFIG_DIR, "repos", "intisy", name, "package.json");
          var pkgPath = existsSync(cachePkg) ? cachePkg
            : existsSync(join(CONFIG_DIR, "node_modules", name, "package.json")) ? join(CONFIG_DIR, "node_modules", name, "package.json")
            : existsSync(repoPkg) ? repoPkg
            : join(globalNpm, name, "package.json");
          if (existsSync(pkgPath)) {
            version = JSON.parse(readFileSync(pkgPath, "utf-8")).version || "";
          }
        } catch {}
        return { name: name, version: version, raw: p };
      });
  } catch { return []; }
}

function getFolderName(plugin) {
  var match = (plugin.url || "").match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
  if (match) return match[1] + "/" + plugin.name;
  return plugin.name;
}

// ---------------------------------------------------------------------------
// Migration: move legacy config files into config/
// ---------------------------------------------------------------------------

function migrateConfigs() {
  if (!existsSync(CONFIG_FOLDER)) try { mkdirSync(CONFIG_FOLDER, { recursive: true }); } catch {}
  var legacyConfig = join(CONFIG_DIR, "oc-config.json");
  if (existsSync(legacyConfig) && !existsSync(CONFIG_PATH)) {
    try { copyFileSync(legacyConfig, CONFIG_PATH); } catch {}
  }
  var legacyPlugins = join(CONFIG_DIR, "plugins.json");
  if (existsSync(legacyPlugins) && !existsSync(PLUGINS_JSON)) {
    try { copyFileSync(legacyPlugins, PLUGINS_JSON); try { unlinkSync(legacyPlugins); } catch {} } catch {}
  }
}

migrateConfigs();

// ---------------------------------------------------------------------------
// Auto-update Claude Code itself
// ---------------------------------------------------------------------------

function checkForUpdates() {
  try {
    var legacyCheck = join(CONFIG_DIR, "oc-last-update-check");
    if (!existsSync(UPDATE_CHECK_PATH) && existsSync(legacyCheck)) {
      try {
        if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
        copyFileSync(legacyCheck, UPDATE_CHECK_PATH);
      } catch {}
    }
    if (existsSync(UPDATE_CHECK_PATH)) {
      var lastCheck = parseInt(readFileSync(UPDATE_CHECK_PATH, "utf-8").trim(), 10);
      if (Date.now() - lastCheck < 86400000) return;
    }

    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(UPDATE_CHECK_PATH, String(Date.now()));

      var installed = execSync("claude --version", { encoding: "utf-8", timeout: 10000 }).trim();
      var latest = execSync("npm view @anthropic-ai/claude-code version", { encoding: "utf-8", timeout: 15000 }).trim();
  
      if (!latest || !installed || latest === installed) return;
  
      process.stderr.write("\x1b[33m  > Updating Claude Code: " + installed + " -> " + latest + "\x1b[0m\n");
      execSync("npm install -g @anthropic-ai/claude-code@latest", { stdio: "inherit", timeout: 120000 });
    process.stderr.write("\x1b[32m  > Updated to " + latest + "\x1b[0m\n\n");
  } catch (e) {}
}

checkForUpdates();

// ---------------------------------------------------------------------------
// Project launcher data
// ---------------------------------------------------------------------------

function loadConfig() {
  try { if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch {}
  // Legacy fallback
  var legacy = join(CONFIG_DIR, "oc-config.json");
  try { if (existsSync(legacy)) return JSON.parse(readFileSync(legacy, "utf-8")); } catch {}
  return { pinned: [], hidden: [] };
}
function saveConfig(cfg) {
  try {
    if (!existsSync(CONFIG_FOLDER)) mkdirSync(CONFIG_FOLDER, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {}
}

function queryProjects() {
  try {
    var cacheDir = join(homedir(), "AppData", "Local", "claude-cli-nodejs", "Cache");
    if (!existsSync(cacheDir)) return [];
    var dirs = readdirSync(cacheDir, { withFileTypes: true })
      .filter(function(d) { return d.isDirectory(); })
      .map(function(d) {
        var stat = statSync(join(cacheDir, d.name));
        // Parse "C--Users-..." back to "C:\Users\..."
        var path = d.name.replace(/^([A-Z])--/, "$1:\\").replace(/--/g, "\\").replace(/-/g, "\\");
        return {
          directory: path,
          last_used: stat.mtimeMs,
          sessions: 1
        };
      });
    dirs.sort(function(a, b) { return b.last_used - a.last_used; });
    return dirs.slice(0, 30);
  } catch (e) {
    return [];
  }
}

function timeAgo(ts) {
  if (!ts) return "--";
  var d = Date.now() - ts;
  if (d < 60000) return "now";
  if (d < 3600000) return Math.floor(d / 60000) + "m ago";
  if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
  return Math.floor(d / 86400000) + "d ago";
}

function shortPath(dir) {
  var h = HOME.replace(/\\/g, "/");
  var d = dir.replace(/\\/g, "/");
  if (d.startsWith(h)) d = "~" + d.substring(h.length);
  return d;
}

function pad(s, len) {
  s = String(s || "");
  while (s.length < len) s += " ";
  return s.substring(0, len);
}

function trunc(s, max) {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.substring(0, max - 1) + "…";
}

function buildList() {
  var cfg = loadConfig();
  var rows = queryProjects();
  var list = [];

  var pinnedItems = [];
  for (var dir of cfg.pinned) {
    var row = rows.find(function(r) { return r.directory === dir; });
    if (cfg.hidden.indexOf(dir) !== -1) continue;
    pinnedItems.push({
      dir: dir,
      name: dir.split(/[\\/]/).pop() || dir,
      sessions: row ? row.sessions : 0,
      lastUsed: row ? row.last_used : 0,
      pinned: true
    });
  }
  pinnedItems.sort(function(a, b) { return (b.lastUsed || 0) - (a.lastUsed || 0); });
  for (var pi = 0; pi < pinnedItems.length; pi++) { list.push(pinnedItems[pi]); }

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (cfg.pinned.indexOf(r.directory) !== -1) continue;
    if (cfg.hidden.indexOf(r.directory) !== -1) continue;
    list.push({
      dir: r.directory,
      name: r.directory.split(/[\\/]/).pop() || r.directory,
      sessions: r.sessions,
      lastUsed: r.last_used,
      pinned: false
    });
  }
  return list;
}

// ---------------------------------------------------------------------------
// Plugin data
// ---------------------------------------------------------------------------

function loadPlugins() {
  try { if (existsSync(PLUGINS_JSON)) return JSON.parse(readFileSync(PLUGINS_JSON, "utf-8")); } catch {}
  // Legacy fallback
  var legacy = join(CONFIG_DIR, "plugins.json");
  try { if (existsSync(legacy)) return JSON.parse(readFileSync(legacy, "utf-8")); } catch {}
  return [];
}

function savePlugins(plugins) {
  if (!existsSync(CONFIG_FOLDER)) try { mkdirSync(CONFIG_FOLDER, { recursive: true }); } catch {}
  writeFileSync(PLUGINS_JSON, JSON.stringify(plugins, null, 2), "utf-8");
  // Dual-write for backward compat
  try { writeFileSync(join(CONFIG_DIR, "plugins.json"), JSON.stringify(plugins, null, 2), "utf-8"); } catch {}
}

function gitText(args, cwd) {
  try {
    var out = execSync(args.join(" "), { cwd: cwd, encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    return out.trim();
  } catch { return ""; }
}

  function buildPluginList() {
    var plugins = loadPlugins();
    var list = [];
    for (var p of plugins) {
      if (!p || !p.name) continue;
      var folderName = getFolderName(p);
      if (!folderName) continue;
      var dir = join(REPOS_DIR, folderName);
      var installed = existsSync(dir);
      var deployed = installed; // Deployed state matches installed state for npm-managed plugins
      var localHead = "";
    var remoteHead = "";
    var subject = "";
    var updateAvail = false;
    var latestTag = "";
    var enabled = p.enabled !== false;

    if (installed) {
      localHead = gitText(["git", "rev-parse", "HEAD"], dir);
      subject = gitText(["git", "log", "-1", "--format=%s"], dir);
      latestTag = gitText(["git", "describe", "--tags", "--abbrev=0"], dir);
    }

    list.push({
      name: p.name,
      folderName: folderName,
      url: p.url,
      autoUpdate: p.autoUpdate !== false,
      enabled: enabled,
      installed: installed,
      deployed: deployed,
      localHead: localHead,
      remoteHead: remoteHead,
      latestTag: latestTag,
      subject: subject,
      updateAvail: updateAvail,
      hasBuild: !!(p.build || p.bundle),
      pluginFile: p.pluginFile,
      _raw: p
    });
  }
  return list;
}

function fetchPluginRemotes(pluginItems) {
  for (var p of pluginItems) {
    if (p.type === "npm" || !p.installed) continue;
    var dir = join(REPOS_DIR, p.folderName);
    gitText(["git", "fetch", "origin"], dir);
    for (var ref of ["origin/HEAD", "origin/main", "origin/master"]) {
      var h = gitText(["git", "rev-parse", ref], dir);
      if (h) { p.remoteHead = h; break; }
    }
    p.updateAvail = !!(p.localHead && p.remoteHead && p.localHead !== p.remoteHead);
  }
}

function runPluginUpdate(pluginItem) {
  var plugins = loadPlugins();
  var repo = plugins.find(function(r) { return r.name === pluginItem.name; });
  if (!repo) return "Plugin not found in plugins.json";

  var folderName = getFolderName(repo);
  var dir = join(REPOS_DIR, folderName);

  if (!existsSync(dir)) {
    var parentDir = dirname(dir);
    if (!existsSync(parentDir)) try { mkdirSync(parentDir, { recursive: true }); } catch {}
    try {
      var cloneCmd = "git clone " + repo.url + (repo.branch ? " --branch " + repo.branch : "") + " " + folderName;
            execSync(cloneCmd, { cwd: REPOS_DIR, timeout: 60000, stdio: "ignore" });
    } catch (e) { return "Clone failed: " + (e.message || e); }
  }

  try {
      if (repo.branch) {
        execSync("git fetch origin", { cwd: dir, timeout: 30000, stdio: "ignore" });
        execSync("git checkout " + repo.branch, { cwd: dir, timeout: 10000, stdio: "ignore" });
        execSync("git pull --ff-only origin " + repo.branch, { cwd: dir, timeout: 30000, stdio: "ignore" });
      } else {
        execSync("git pull --ff-only", { cwd: dir, timeout: 30000, stdio: "ignore" });
      }
    } catch {}

  if (repo.install) {
    try { execSync(repo.install.join(" "), { cwd: dir, timeout: 120000, stdio: "ignore" }); }
    catch (e) { return "Install failed"; }
  }
  if (repo.postInstall) {
    try { execSync(repo.postInstall.join(" "), { cwd: dir, timeout: 120000, stdio: "ignore" }); }
    catch (e) { return "Post-install failed"; }
  }
  if (repo.build) {
    try { execSync(repo.build.join(" "), { cwd: dir, timeout: 120000, stdio: "ignore" }); }
    catch (e) { return "Build failed"; }
  }
  if (repo.bundle) {
    try { execSync(repo.bundle.join(" "), { cwd: dir, timeout: 120000, stdio: "ignore" }); }
    catch (e) { return "Bundle failed"; }
  }

  // Claude Code plugins are NPM packages, deploy by global install
  try {
    execSync("npm install -g .", { cwd: dir, timeout: 120000, stdio: "ignore" });
  } catch (e) {
    return "NPM install failed";
  }

  return null; // success
}

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

var E = "\x1b[";
var RST = E + "0m";
var BOLD = E + "1m";
var DIM = E + "2m";
var GRAY = E + "90m";
var WHITE = E + "37m";
var YELLOW = E + "33m";
var GREEN = E + "32m";
var CYAN = E + "36m";
var RED = E + "31m";
var BLUE = E + "34m";
var MAGENTA = E + "35m";
var BG_SEL = E + "48;5;236m";
var CLR = E + "K";

var _buf = "";
function b(s) { _buf += s; }
function flush() { process.stderr.write(_buf); _buf = ""; }
function hideCur() { process.stderr.write(E + "?25l"); }
function showCur() { process.stderr.write(E + "?25h"); }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var items = buildList();

function buildCombinedPluginList() {
  var git = buildPluginList();
  var npm = loadNpmPlugins().map(function(np) {
    return {
      type: "npm",
      name: np.name,
      version: np.version,
      raw: np.raw,
      // filler fields so shared code doesn't crash
      enabled: true,
      autoUpdate: false,
      installed: !!np.version,
      deployed: !!np.version,
      updateAvail: false,
      localHead: "",
      remoteHead: "",
      latestTag: np.version || "",
      subject: "npm plugin",
      folderName: "",
      url: "",
      hasBuild: false,
      pluginFile: ""
    };
  });
  return git.concat(npm);
}

var pluginItems = buildCombinedPluginList();
var cursor = 0;
var pcursor = 0; // plugin page cursor
var mode = "list"; // "list" | "actions" | "input" | "pactions"
var page = "projects"; // "projects" | "plugins"
var acursor = 0;
var pacursor = 0; // plugin action cursor
var message = "";
var msgTimeout = null;
var scrollOff = 0;
var pscrollOff = 0;
var inputBuf = "";
var chpathDir = "";
var pluginFetched = false;
var pluginUpdating = "";
var commitItems = [];
var ccursor = 0;
var cscrollOff = 0;

function flash(msg) {
  message = msg;
  if (msgTimeout) clearTimeout(msgTimeout);
  msgTimeout = setTimeout(function() { message = ""; render(); }, 2500);
}

// ---------------------------------------------------------------------------
// Project actions
// ---------------------------------------------------------------------------

function getActions(item) {
  var a = [
    { key: "open", label: "Open in Claude Code", icon: ">" },
  ];
  if (item.pinned) {
    a.push({ key: "unpin", label: "Unpin from favorites", icon: "x" });
  } else {
    a.push({ key: "pin", label: "Pin to favorites", icon: "*" });
  }
  a.push({ key: "hide", label: "Hide from list", icon: "-" });
  a.push({ key: "chpath", label: "Change path", icon: "~" });
  a.push({ key: "unhide", label: "Show hidden projects", icon: "+" });
  a.push({ key: "cancel", label: "Cancel", icon: "<" });
  return a;
}

function getPluginActions(pitem) {
  var a = [];
  if (!pitem.enabled) {
    a.push({ key: "enable-plugin", label: "Enable plugin" });
    a.push({ key: "cancel", label: "Cancel" });
    return a;
  }
  if (pitem.updateAvail || !pitem.deployed) {
    a.push({ key: "update", label: "Update now" });
  }
  if (pitem.autoUpdate) {
    a.push({ key: "disable-auto", label: "Set to manual update" });
  } else {
    a.push({ key: "enable-auto", label: "Enable auto-update" });
  }
  a.push({ key: "update", label: "Force rebuild & deploy" });
  a.push({ key: "commits", label: "Select specific commit (Downgrade)" });
  a.push({ key: "disable-plugin", label: "Disable plugin" });
  a.push({ key: "cancel", label: "Cancel" });
  return a;
}

function outputDir(dir) {
  var outFile = process.env.OC_OUTPUT;
  if (outFile) {
    writeFileSync(outFile, dir, "utf-8");
  } else {
    process.stdout.write(dir);
  }
}

function openProject(item) {
  cleanup();
  outputDir(item.dir);
  process.exit(0);
}

function togglePin(idx) {
  var item = items[idx];
  var cfg = loadConfig();
  if (item.pinned) {
    cfg.pinned = cfg.pinned.filter(function(d) { return d !== item.dir; });
    flash("Unpinned: " + item.name);
  } else {
    cfg.pinned.push(item.dir);
    flash("Pinned: " + item.name);
  }
  saveConfig(cfg);
  items = buildList();
  if (cursor >= items.length) cursor = Math.max(0, items.length - 1);
}

function hideItem(idx) {
  var item = items[idx];
  var cfg = loadConfig();
  if (cfg.hidden.indexOf(item.dir) === -1) cfg.hidden.push(item.dir);
  cfg.pinned = cfg.pinned.filter(function(d) { return d !== item.dir; });
  saveConfig(cfg);
  flash("Hidden: " + item.name);
  items = buildList();
  if (cursor >= items.length) cursor = Math.max(0, items.length - 1);
}

function unhideAll() {
  var cfg = loadConfig();
  var count = cfg.hidden.length;
  cfg.hidden = [];
  saveConfig(cfg);
  flash("Restored " + count + " hidden project(s)");
  items = buildList();
  if (cursor >= items.length) cursor = Math.max(0, items.length - 1);
}

function getProjectId(dir) {
  try {
    var root = execSync("git rev-list --max-parents=0 HEAD", { cwd: dir, encoding: "utf-8", timeout: 5000 });
    var lines = root.trim().split("\n").filter(Boolean).map(function(x) { return x.trim(); }).sort();
    return lines[0] || null;
  } catch (e) { return null; }
}

function changeProjectPath(oldDir, newDir) {
  if (!existsSync(DB_PATH)) { flash("DB not found"); return; }
  try {
    var db = new Database(DB_PATH);
    var count = db.query("SELECT COUNT(*) as c FROM session WHERE directory = ?").get(oldDir);
    if (!count || count.c === 0) { db.close(); flash("No sessions at old path"); return; }

    var oldSess = db.query("SELECT project_id FROM session WHERE directory = ? LIMIT 1").get(oldDir);
    var oldPid = oldSess.project_id;
    var newPid = getProjectId(newDir);

    if (newPid) {
      var existing = db.query("SELECT id FROM project WHERE id = ?").get(newPid);
      if (existing) {
        db.run("UPDATE session SET project_id = ?, directory = ? WHERE directory = ?", [newPid, newDir, oldDir]);
      } else if (oldPid !== "global") {
        db.run("UPDATE project SET id = ?, worktree = ? WHERE id = ?", [newPid, newDir, oldPid]);
        db.run("UPDATE session SET project_id = ?, directory = ? WHERE directory = ?", [newPid, newDir, oldDir]);
      } else {
        var now = Date.now();
        db.run("INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, '[]')", [newPid, newDir, now, now]);
        db.run("UPDATE session SET project_id = ?, directory = ? WHERE directory = ?", [newPid, newDir, oldDir]);
      }
      try {
        var gitDir = join(newDir, ".git");
        if (existsSync(gitDir)) writeFileSync(join(gitDir, "claude"), newPid);
      } catch (e) {}
    } else {
      db.run("UPDATE session SET project_id = 'global', directory = ? WHERE directory = ?", [newDir, oldDir]);
    }

    if (oldPid !== "global" && oldPid !== newPid) {
      var rem = db.query("SELECT COUNT(*) as c FROM session WHERE project_id = ?").get(oldPid);
      if (!rem || rem.c === 0) db.run("DELETE FROM project WHERE id = ?", [oldPid]);
    }

    db.close();
    var cfg = loadConfig();
    var pidx = cfg.pinned.indexOf(oldDir);
    if (pidx !== -1) cfg.pinned[pidx] = newDir;
    var hidx = cfg.hidden.indexOf(oldDir);
    if (hidx !== -1) cfg.hidden[hidx] = newDir;
    saveConfig(cfg);
    flash("Moved " + count.c + " sessions to new path");
    items = buildList();
    if (cursor >= items.length) cursor = Math.max(0, items.length - 1);
  } catch (e) {
    flash("Error: " + (e.message || e));
  }
}

// ---------------------------------------------------------------------------
// Render: projects page
// ---------------------------------------------------------------------------

function buildProjectItem(pushBody, i, item, nameW, cols, isSelected) {
  var sel = i === cursor;
  var arrow = sel ? (YELLOW + " > " + RST) : "   ";
  var bg = sel ? BG_SEL : "";
  var nameStyle = sel ? (BOLD + WHITE) : DIM;
  var sessStr = GRAY + pad(item.sessions + " sess", 8) + RST;
  var timeStr = GRAY + pad(timeAgo(item.lastUsed), 9) + RST;
  var pinMark = item.pinned ? (YELLOW + " *" + RST) : "";

  pushBody("  " + bg + arrow + nameStyle + pad(trunc(item.name, nameW), nameW) + RST + bg + sessStr + timeStr + pinMark + RST, isSelected);

  if (sel && (mode === "list" || mode === "actions")) {
    pushBody("  " + GRAY + "     " + trunc(shortPath(item.dir), cols - 10) + RST, isSelected);
  }

  if (sel && mode === "actions") {
    pushBody("", isSelected);
    var acts = getActions(item);
    for (var j = 0; j < acts.length; j++) {
      var a = acts[j];
      var aSel = j === acursor;
      var lbl = trunc(a.label, cols - 12);
      if (aSel) {
        pushBody("    " + GREEN + "  > " + BOLD + lbl + RST, isSelected);
      } else {
        pushBody("    " + GRAY + "    " + lbl + RST, isSelected);
      }
    }
    pushBody("", isSelected);
  }
}

function buildProjects(pushBody, pushFoot, cols, barW) {
  var nameW = Math.min(28, Math.max(16, cols - 36));

  if (items.length === 0) {
    pushBody("  " + GRAY + "No projects found." + RST, false);
    pushBody("  " + GRAY + "Use Claude Code in a directory first, then come back." + RST, false);
    pushBody("", false);
    
    pushFoot("  " + GRAY + "-".repeat(barW) + RST);
    pushFoot("  " + DIM + "." + RST + " Launch here  " + DIM + "E/," + RST + " Cursor here  " + DIM + "C" + RST + " Custom path");
    pushFoot("  " + DIM + "Q" + RST + " Quit  " + DIM + "U" + RST + " Unhide all");
    return;
  }

  var pinnedCount = 0;
  for (var i = 0; i < items.length; i++) { if (items[i].pinned) pinnedCount++; }
  var recentCount = items.length - pinnedCount;

  if (pinnedCount > 0) {
    pushBody("  " + YELLOW + "*" + GRAY + " Pinned" + RST, false);
    for (var i = 0; i < pinnedCount; i++) {
      buildProjectItem(pushBody, i, items[i], nameW, cols, i === cursor);
    }
  }

  if (pinnedCount > 0 && recentCount > 0) pushBody("", false);

  if (recentCount > 0) {
    var countLabel = recentCount > 0 ? " (" + recentCount + ")" : "";
    pushBody("  " + BLUE + "~" + GRAY + " Recent" + countLabel + RST, false);
    for (var i = pinnedCount; i < items.length; i++) {
      buildProjectItem(pushBody, i, items[i], nameW, cols, i === cursor);
    }
  }

  pushBody("", false);

  if (message) {
    pushFoot("  " + GREEN + "  " + trunc(message, cols - 5) + RST);
  }
  pushFoot("  " + GRAY + "-".repeat(barW) + RST);
  
  if (mode === "input") {
    var inputLabel = chpathDir ? "New path: " : "Path: ";
    var maxInput = Math.max(10, cols - 15 - inputLabel.length);
    var displayInput = inputBuf.length > maxInput ? "…" + inputBuf.substring(inputBuf.length - maxInput + 1) : inputBuf;
    pushFoot("  " + CYAN + inputLabel + RST + displayInput + BOLD + "|" + RST);
    pushFoot("  " + DIM + "Enter" + RST + " Confirm  " + DIM + "Esc" + RST + " Cancel" + RST);
  } else if (mode === "list") {
    pushFoot("  " + DIM + "^v" + RST + "/" + DIM + "WS" + RST + " Move  " +
      DIM + "Enter" + RST + " Select  " +
      DIM + "P" + RST + " Pin  " +
      DIM + "H" + RST + " Hide  " +
      DIM + "O" + RST + " Open  " +
      DIM + "C" + RST + " Custom  " +
      DIM + "Q" + RST + " Quit" + RST);
  } else {
    pushFoot("  " + DIM + "^v" + RST + "/" + DIM + "WS" + RST + " Move  " +
      DIM + "Enter" + RST + " Confirm  " +
      DIM + "Esc" + RST + " Back" + RST);
  }
}

// ---------------------------------------------------------------------------
// Render: plugins page
// ---------------------------------------------------------------------------

function buildPluginItem(pushBody, i, pitem, nameW, cols, isSelected) {
  var sel = i === pcursor;
  var arrow = sel ? (YELLOW + " > " + RST) : "   ";
  var bg = sel ? BG_SEL : "";
  var nameStyle = sel ? (BOLD + WHITE) : DIM;

  // NPM plugins: simpler read-only row
  if (pitem.type === "npm") {
    var nvstr = pitem.version ? (GRAY + "v" + pitem.version + RST) : (GRAY + "not installed" + RST);
    pushBody("  " + bg + arrow + nameStyle + pad(trunc(pitem.name, nameW), nameW) + RST + bg + " " + CYAN + "npm" + RST + "  " + nvstr + RST, isSelected);
    if (sel) {
      var subInfo = GRAY + "     managed via npm (claude.json)" + RST;
      pushBody("  " + subInfo, isSelected);
    }
    return;
  }

  var statusParts = [];
  if (!pitem.enabled) {
    statusParts.push(RED + "disabled" + RST);
  } else if (pitem.autoUpdate) {
    statusParts.push(GREEN + "auto" + RST);
  } else {
    statusParts.push(YELLOW + "manual" + RST);
  }
  if (pitem.enabled) {
    if (pitem.updateAvail) {
      statusParts.push(CYAN + "UPDATE" + RST);
    } else if (pitem.deployed) {
      statusParts.push(GRAY + "ok" + RST);
    } else {
      statusParts.push(RED + "missing" + RST);
    }
  }

  var statusStr = statusParts.join(GRAY + " | " + RST);
  var versionStr = pitem.latestTag
    ? (GRAY + pitem.latestTag + RST)
    : (pitem.localHead ? (GRAY + pitem.localHead.substring(0, 7) + RST) : (GRAY + "---" + RST));

  pushBody("  " + bg + arrow + nameStyle + pad(trunc(pitem.name, nameW), nameW) + RST + bg + " " + statusStr + "  " + versionStr + RST, isSelected);

  if (sel) {
    var subInfo = GRAY + "     " + trunc(pitem.subject || pitem.url, cols - 10) + RST;
    pushBody("  " + subInfo, isSelected);
  }

  if (sel && mode === "pactions") {
    pushBody("", isSelected);
    var acts = getPluginActions(pitem);
    for (var j = 0; j < acts.length; j++) {
      var a = acts[j];
      var aSel = j === pacursor;
      if (aSel) {
        pushBody("    " + GREEN + "  > " + BOLD + a.label + RST, isSelected);
      } else {
        pushBody("    " + GRAY + "    " + a.label + RST, isSelected);
      }
    }
    pushBody("", isSelected);
  }
}

function buildPlugins(pushBody, pushFoot, cols, barW) {
  var nameW = Math.min(32, Math.max(20, cols - 44));

  if (mode === "pcommits") {
    pushBody("  " + MAGENTA + "#" + GRAY + " Select commit for " + pluginItems[pcursor].name + RST, false);
    for (var i = 0; i < commitItems.length; i++) {
      var c = commitItems[i];
      var sel = i === ccursor;
      var arrow = sel ? (YELLOW + " > " + RST) : "   ";
      var bg = sel ? BG_SEL : "";
      var nameStyle = sel ? (BOLD + WHITE) : DIM;
      pushBody("  " + bg + arrow + nameStyle + c.hash + RST + bg + "  " + pad(c.time, 12) + "  " + trunc(c.subject, Math.max(10, cols - 30)) + RST, sel);
    }
    pushBody("", false);
    
    if (message) {
      pushFoot("  " + GREEN + "  " + trunc(message, cols - 5) + RST);
    }
    pushFoot("  " + GRAY + "-".repeat(barW) + RST);
    pushFoot("  " + DIM + "^v" + RST + "/" + DIM + "WS" + RST + " Move  " +
      DIM + "Enter" + RST + " Checkout  " +
      DIM + "Esc" + RST + " Cancel" + RST);
    return;
  }

  if (pluginItems.length === 0) {
    pushBody("  " + GRAY + "No plugins configured." + RST, false);
    pushBody("  " + GRAY + "Add plugins to ~/.config/claude/config/plugins.json" + RST, false);
    pushBody("", false);
    
    pushFoot("  " + GRAY + "-".repeat(barW) + RST);
    pushFoot("  " + GRAY + "Q" + RST + " Quit");
    return;
  }

  var autoCount = 0, manualCount = 0, updateCount = 0, disabledCount = 0;
  for (var p of pluginItems) {
    if (p.type === "npm") continue;
    if (!p.enabled) disabledCount++;
    else if (p.autoUpdate) autoCount++; else manualCount++;
    if (p.updateAvail) updateCount++;
  }

  var npmCount = pluginItems.filter(function(p) { return p.type === "npm"; }).length;
  pushBody("  " + MAGENTA + "#" + GRAY + " Plugins " +
      GRAY + "(" + autoCount + " auto, " + manualCount + " manual, " + disabledCount + " disabled" +
      (updateCount > 0 ? ", " + CYAN + updateCount + " updates" + GRAY : "") +
      (npmCount > 0 ? ", " + GRAY + npmCount + " npm" + GRAY : "") +
      ")" + RST, false);

  if (!pluginFetched) {
    pushBody("  " + GRAY + "  Press " + RST + "F" + GRAY + " to check for updates" + RST, false);
  }

  var lastWasGit = false;
  for (var i = 0; i < pluginItems.length; i++) {
    var pitem = pluginItems[i];
    // Insert a section header when transitioning to npm plugins
    if (pitem.type === "npm" && (i === 0 || pluginItems[i - 1].type !== "npm")) {
      pushBody("", false);
      pushBody("  " + MAGENTA + "#" + GRAY + " npm plugins" + RST, false);
    }
    buildPluginItem(pushBody, i, pitem, nameW, cols, i === pcursor);
  }

  pushBody("", false);
  
  if (message) {
    pushFoot("  " + GREEN + "  " + trunc(message, cols - 5) + RST);
  }
  pushFoot("  " + GRAY + "-".repeat(barW) + RST);

  if (mode === "pactions") {
    pushFoot("  " + DIM + "^v" + RST + "/" + DIM + "WS" + RST + " Move  " +
      DIM + "Enter" + RST + " Confirm  " +
      DIM + "Esc" + RST + " Back" + RST);
  } else {
    pushFoot("  " + DIM + "^v" + RST + "/" + DIM + "WS" + RST + " Move  " +
      DIM + "Enter" + RST + " Select  " +
      DIM + "U" + RST + " Update  " +
      DIM + "A" + RST + " Update all  " +
      DIM + "D" + RST + " Disable  " +
      DIM + "Q" + RST + " Quit" + RST);
  }
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

function render() {
  var cols = process.stderr.columns || 80;
  var totalRows = (process.stderr.rows || 24) - 1;
  var barW = Math.min(56, cols - 4);

  var headLines = [];
  var bodyLines = [];
  var footLines = [];
  var selStart = 0;
  var selEnd = 0;

  function pushHead(s) { headLines.push(s); }
  function pushBody(s, isSelLine) { 
    if (isSelLine && selStart === 0) selStart = bodyLines.length;
    bodyLines.push(s); 
    if (isSelLine) selEnd = bodyLines.length;
  }
  function pushFoot(s) { footLines.push(s); }

  // 1. Build Header
  pushHead("");
  pushHead("  " + BOLD + CYAN + " Claude Code" + RST + GRAY + "  Launcher" + RST);
  pushHead("  " + GRAY + "-".repeat(barW) + RST);
  var showPluginsTab = pluginItems.length > 0;
  var projTab = page === "projects" ? (BOLD + WHITE + BG_SEL + " Projects " + RST) : (GRAY + " Projects " + RST);
  var plugTab = showPluginsTab ? (page === "plugins" ? (BOLD + WHITE + BG_SEL + " Plugins " + RST) : (GRAY + " Plugins " + RST)) : "";
  pushHead("  " + projTab + (showPluginsTab ? "  " + plugTab + "    " + DIM + "<- ->" + RST : ""));
  pushHead("");

  // 2. Build Body & Footer
  if (page === "projects") {
    buildProjects(pushBody, pushFoot, cols, barW);
  } else {
    buildPlugins(pushBody, pushFoot, cols, barW);
  }

  // 3. Viewport calculation
  var maxBody = Math.max(2, totalRows - headLines.length - footLines.length);
  
  var activeScroll = 0;
  if (page === "projects") activeScroll = scrollOff;
  else if (mode === "pcommits") activeScroll = cscrollOff;
  else activeScroll = pscrollOff;
  
  if (bodyLines.length > maxBody) {
    if (selStart < activeScroll) activeScroll = selStart;
    if (selEnd > activeScroll + maxBody) activeScroll = selEnd - maxBody;
    if (activeScroll > bodyLines.length - maxBody) activeScroll = bodyLines.length - maxBody;
    if (activeScroll < 0) activeScroll = 0;
    
    if (page === "projects") scrollOff = activeScroll;
    else if (mode === "pcommits") cscrollOff = activeScroll;
    else pscrollOff = activeScroll;
    
    var origLen = bodyLines.length;
    
    var hasAbove = activeScroll > 0;
    var hasBelow = activeScroll + maxBody < origLen;
    
    var sliceLen = maxBody;
    if (hasAbove) sliceLen--;
    if (hasBelow) sliceLen--;
    
    hasBelow = activeScroll + sliceLen < origLen;
    if (hasBelow && !hasAbove && activeScroll > 0) {
       // Re-evaluate in case reducing sliceLen triggered hasAbove
       hasAbove = true;
       sliceLen--;
       hasBelow = activeScroll + sliceLen < origLen;
    }
    
    var visibleBody = bodyLines.slice(activeScroll, activeScroll + sliceLen);
    
    if (hasAbove) {
      visibleBody.unshift("  " + GRAY + "     ^ " + activeScroll + " more" + RST);
    }
    if (hasBelow) {
      visibleBody.push("  " + GRAY + "     v " + (origLen - (activeScroll + sliceLen)) + " more" + RST);
    }
    
    bodyLines = visibleBody;
  }

  // 4. Render to screen
  _buf = E + "H"; 
  for (var h of headLines) _buf += h + CLR + "\n";
  for (var b of bodyLines) _buf += b + CLR + "\n";
  for (var f of footLines) _buf += f + CLR + "\n";
  _buf += E + "J";
  
  process.stderr.write(_buf);
  _buf = "";
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------
function handleKey(key) {
  // Page switching with left/right (only in list mode, not in actions/input)
  if ((mode === "list") && (key === "left" || key === "right")) {
    var showPluginsTab = pluginItems.length > 0;
    if (key === "left" && page === "plugins") { page = "projects"; mode = "list"; render(); return; }
    if (key === "right" && page === "projects" && showPluginsTab) { page = "plugins"; mode = "list"; render(); return; }
    return;
  }

  if (page === "projects") {
    handleProjectKey(key);
  } else {
    handlePluginKey(key);
  }
}

function handleProjectKey(key) {
  if (mode === "list") {
    if (key === "up" || key === "w") { cursor = Math.max(0, cursor - 1); }
    else if (key === "down" || key === "s") { cursor = Math.min(items.length - 1, cursor + 1); }
    else if (key === "enter" || key === "space") {
      if (items.length > 0) { mode = "actions"; acursor = 0; }
    }
    else if (key === "o") { if (items.length > 0) openProject(items[cursor]); }
    else if (key === "e") { cleanup(); try { execSync('cursor "' + (items.length > 0 ? items[cursor].dir : process.cwd()) + '"', { stdio: "ignore", windowsHide: true }); } catch(err){} process.exit(0); }
      else if (key === ",") { cleanup(); try { execSync("cursor .", { stdio: "ignore", windowsHide: true }); } catch(err){} process.exit(0); }
      else if (key === "p") { if (items.length > 0) togglePin(cursor); }
    else if (key === ".") { cleanup(); outputDir(process.cwd()); process.exit(0); }
      else if (key === "h") { if (items.length > 0) hideItem(cursor); }
    else if (key === "u") { unhideAll(); }
    else if (key === "c") { mode = "input"; inputBuf = ""; }
    else if (key === "q" || key === "escape") { cleanup(); process.exit(1); }
  } else if (mode === "actions") {
    var acts = getActions(items[cursor]);
    if (key === "up" || key === "w") { acursor = Math.max(0, acursor - 1); }
    else if (key === "down" || key === "s") { acursor = Math.min(acts.length - 1, acursor + 1); }
    else if (key === "enter" || key === "space") {
      var action = acts[acursor].key;
      if (action === "open") { openProject(items[cursor]); }
      else if (action === "pin" || action === "unpin") { togglePin(cursor); mode = "list"; }
      else if (action === "hide") { hideItem(cursor); mode = "list"; }
      else if (action === "chpath") { mode = "input"; chpathDir = items[cursor].dir; inputBuf = items[cursor].dir; }
      else if (action === "unhide") { unhideAll(); mode = "list"; }
      else { mode = "list"; }
    }
    else if (key === "escape" || key === "q" || key === "left") { mode = "list"; }
  }
}

function handlePluginKey(key) {
  if (mode === "list") {
    if (key === "up" || key === "w") { pcursor = Math.max(0, pcursor - 1); }
    else if (key === "down" || key === "s") { pcursor = Math.min(pluginItems.length - 1, pcursor + 1); }
    else if (key === "enter" || key === "space") {
      if (pluginItems.length > 0 && pluginItems[pcursor].type !== "npm") { mode = "pactions"; pacursor = 0; }
      else if (pluginItems.length > 0 && pluginItems[pcursor].type === "npm") { flash(pluginItems[pcursor].name + " is managed via npm"); }
    }
    else if (key === "f") {
      flash("Fetching remotes...");
      render();
      fetchPluginRemotes(pluginItems);
      pluginFetched = true;
      var updateCount = 0;
      for (var p of pluginItems) { if (p.updateAvail) updateCount++; }
      flash(updateCount > 0 ? updateCount + " update(s) available" : "All plugins up to date");
    }
    else if (key === "a") {
      var toUpdate = pluginItems.filter(function(p) { return p.type !== "npm" && (p.updateAvail || !p.deployed); });
      if (toUpdate.length === 0) {
        flash("All plugins are already up to date.");
      } else {
        var errors = [];
        for (var pi of toUpdate) {
          flash("Updating " + pi.name + "...");
          render();
          var e = runPluginUpdate(pi);
          if (e) errors.push(pi.name + ": " + e);
        }
        pluginItems = buildCombinedPluginList();
        if (pcursor >= pluginItems.length) pcursor = Math.max(0, pluginItems.length - 1);
        flash(errors.length > 0 ? errors.join("; ") : toUpdate.length + " plugin(s) updated. Restart Claude Code to apply.");
      }
    }
    else if (key === "u") {
      if (pluginItems.length > 0 && pluginItems[pcursor].type !== "npm") {
        var p = pluginItems[pcursor];
        flash("Updating " + p.name + "...");
        render();
        var err = runPluginUpdate(p);
        pluginItems = buildCombinedPluginList();
        if (pcursor >= pluginItems.length) pcursor = Math.max(0, pluginItems.length - 1);
        flash(err ? p.name + ": " + err : p.name + " updated. Restart Claude Code to apply.");
      }
    }
      else if (key === "d") {
        if (pluginItems.length > 0 && pluginItems[pcursor].type !== "npm") {
          var p = pluginItems[pcursor];
          var plugins = loadPlugins();
          var match = plugins.find(function(r) { return r.name === p.name; });
          if (match) { match.enabled = false; savePlugins(plugins); }
          try { execSync("npm uninstall -g " + p.name, { stdio: "ignore" }); } catch {}
          pluginItems = buildCombinedPluginList();
        if (pcursor >= pluginItems.length) pcursor = Math.max(0, pluginItems.length - 1);
        flash(p.name + " disabled. Restart Claude Code to unload.");
      }
    }
    else if (key === "q" || key === "escape") { cleanup(); process.exit(1); }
  } else if (mode === "pactions") {
    var pitem = pluginItems[pcursor];
    var acts = getPluginActions(pitem);
    if (key === "up" || key === "w") { pacursor = Math.max(0, pacursor - 1); }
    else if (key === "down" || key === "s") { pacursor = Math.min(acts.length - 1, pacursor + 1); }
    else if (key === "enter" || key === "space") {
      var action = acts[pacursor].key;
      if (action === "update") {
        flash("Updating " + pitem.name + "...");
        render();
        var err = runPluginUpdate(pitem);
        pluginItems = buildCombinedPluginList();
        if (pcursor >= pluginItems.length) pcursor = Math.max(0, pluginItems.length - 1);
        flash(err ? pitem.name + ": " + err : pitem.name + " updated. Restart Claude Code to apply.");
        mode = "list";
      }
      else if (action === "enable-auto" || action === "disable-auto") {
        var newVal = action === "enable-auto";
        pitem.autoUpdate = newVal;
        var plugins = loadPlugins();
        var match = plugins.find(function(r) { return r.name === pitem.name; });
        if (match) { match.autoUpdate = newVal; savePlugins(plugins); }
        flash(pitem.name + ": auto-update " + (newVal ? "ON" : "OFF"));
        mode = "list";
      }
      else if (action === "disable-plugin") {
        var plugins = loadPlugins();
        var match = plugins.find(function(r) { return r.name === pitem.name; });
        if (match) { match.enabled = false; savePlugins(plugins); }
        var deployedPath = join(PLUGINS_DIR, pitem.pluginFile);
        if (existsSync(deployedPath)) { try { unlinkSync(deployedPath); } catch {} }
        pluginItems = buildCombinedPluginList();
        if (pcursor >= pluginItems.length) pcursor = Math.max(0, pluginItems.length - 1);
        flash(pitem.name + " disabled. Restart Claude Code to unload.");
        mode = "list";
      }
      else if (action === "enable-plugin") {
        var plugins = loadPlugins();
        var match = plugins.find(function(r) { return r.name === pitem.name; });
        if (match) { delete match.enabled; savePlugins(plugins); }
        pluginItems = buildCombinedPluginList();
        if (pcursor >= pluginItems.length) pcursor = Math.max(0, pluginItems.length - 1);
        flash(pitem.name + " enabled. Use Update to deploy.");
        mode = "list";
      }
      else if (action === "commits") {
        var dir = join(REPOS_DIR, pitem.folderName);
        if (!existsSync(dir)) { flash("Not installed locally yet"); mode = "list"; return; }
        try {
          var log = execSync('git log -20 --format="%h|%s|%ar"', { cwd: dir, encoding: "utf-8", timeout: 5000 });
          var lines = log.trim().split("\n");
          commitItems = [];
          for (var i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            var parts = lines[i].split("|");
            if (parts.length >= 3) {
              commitItems.push({ hash: parts[0], subject: parts.slice(1, -1).join("|"), time: parts[parts.length-1] });
            }
          }
          if (commitItems.length > 0) {
            ccursor = 0; cscrollOff = 0; mode = "pcommits";
          } else {
            flash("No commits found"); mode = "list";
          }
        } catch (e) {
          flash("Failed to fetch commits"); mode = "list";
        }
      }
      else { mode = "list"; }
    }
    else if (key === "escape" || key === "q" || key === "left") { mode = "list"; }
  } else if (mode === "pcommits") {
    if (key === "up" || key === "w") { ccursor = Math.max(0, ccursor - 1); }
    else if (key === "down" || key === "s") { ccursor = Math.min(commitItems.length - 1, ccursor + 1); }
    else if (key === "escape" || key === "q" || key === "left") { mode = "list"; }
    else if (key === "enter" || key === "space") {
      var pitem = pluginItems[pcursor];
      var citem = commitItems[ccursor];
      flash("Downgrading " + pitem.name + " to " + citem.hash + "...");
      render();
      
      var dir = join(REPOS_DIR, pitem.folderName);
      try {
        execSync("git reset --hard", { cwd: dir, timeout: 15000, stdio: "ignore" });
        execSync("git checkout " + citem.hash, { cwd: dir, timeout: 15000, stdio: "ignore" });
      } catch (e) {
        flash("Checkout failed"); mode = "list"; return;
      }
      
      var plugins = loadPlugins();
      var repo = plugins.find(function(r) { return r.name === pitem.name; });
      var err = null;
      if (repo) {
        if (repo.install) {
          try { execSync(repo.install.join(" "), { cwd: dir, timeout: 120000, stdio: "ignore" }); } catch(e) { err="Install failed"; }
        }
        if (!err && repo.build) {
          try { execSync(repo.build.join(" "), { cwd: dir, timeout: 120000, stdio: "ignore" }); } catch(e) { err="Build failed"; }
        }
        if (!err && repo.bundle) {
          try { execSync(repo.bundle.join(" "), { cwd: dir, timeout: 120000, stdio: "ignore" }); } catch(e) { err="Bundle failed"; }
        }
        var outputPath = join(dir, repo.output);
        var destPath = join(PLUGINS_DIR, repo.pluginFile);
        if (!err && existsSync(outputPath)) {
          try { copyFileSync(outputPath, destPath); } catch(e) { err="Copy failed"; }
        } else if (!err) {
          err = "Build output not found";
        }
      }
      pluginItems = buildCombinedPluginList();
      if (err) flash("Error: " + err);
      else flash("Downgraded to " + citem.hash.substring(0,7));
      mode = "list";
    }
  }
}

function handleInputData(buf) {
  if (buf[0] === 27) { mode = "list"; chpathDir = ""; return; }
  if (buf[0] === 3) { cleanup(); process.exit(1); }
  if (buf[0] === 13 || buf[0] === 10) {
    var p = inputBuf.trim();
    if (p) {
      if (p.charAt(0) === "~") p = HOME + p.substring(1);
      p = p.replace(/\//g, "\\");
      if (chpathDir) {
        if (p === chpathDir) { flash("Same path, nothing changed"); mode = "list"; chpathDir = ""; return; }
        if (existsSync(p)) {
          changeProjectPath(chpathDir, p);
        } else {
          flash("Path not found: " + p);
        }
        mode = "list"; chpathDir = "";
      } else {
        if (existsSync(p)) {
          cleanup();
          outputDir(p);
          process.exit(0);
        } else {
          flash("Path not found: " + p);
          mode = "list";
        }
      }
    } else {
      mode = "list"; chpathDir = "";
    }
    return;
  }
  if (buf[0] === 127 || buf[0] === 8) {
    inputBuf = inputBuf.substring(0, inputBuf.length - 1);
    return;
  }
  if (buf[0] >= 32 && buf[0] < 127) {
    inputBuf += String.fromCharCode(buf[0]);
    return;
  }
  var s = buf.toString("utf-8");
  if (s.length > 0) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 32) inputBuf += s.charAt(i);
    }
  }
}

function parseKey(buf) {
  if (buf[0] === 27) {
    if (buf.length === 1) return "escape";
    if (buf[1] === 91) {
      if (buf[2] === 65) return "up";
      if (buf[2] === 66) return "down";
      if (buf[2] === 67) return "right";
      if (buf[2] === 68) return "left";
    }
    return null;
  }
  if (buf[0] === 13 || buf[0] === 10) return "enter";
  if (buf[0] === 32) return "space";
  if (buf[0] === 3) { cleanup(); process.exit(1); }
  var ch = String.fromCharCode(buf[0]).toLowerCase();
  if ("wsadqpchouf".indexOf(ch) !== -1) return ch;
  return null;
}

// ---------------------------------------------------------------------------
// Cleanup & startup
// ---------------------------------------------------------------------------

function cleanup() {
  showCur();
  process.stderr.write(E + "H" + E + "2J");
  try { process.stdin.setRawMode(false); } catch {}
}

process.on("exit", function() { showCur(); });
process.on("SIGINT", function() { cleanup(); process.exit(1); });
process.on("SIGTERM", function() { cleanup(); process.exit(1); });
try { process.stderr.on("resize", function() { render(); }); } catch(e) {}

// Direct argument handling (skip TUI)
var arg = process.argv[2];
if (arg) {
  if (/^\d+$/.test(arg)) {
    var idx = parseInt(arg) - 1;
    if (idx >= 0 && idx < items.length) {
      outputDir(items[idx].dir);
      process.exit(0);
    }
    process.stderr.write("Invalid number: " + arg + "\n");
    process.exit(1);
  }
  var match = items.find(function(it) { return it.name.toLowerCase().indexOf(arg.toLowerCase()) !== -1; });
  if (!match) match = items.find(function(it) { return it.dir.toLowerCase().indexOf(arg.toLowerCase()) !== -1; });
  if (match) {
    outputDir(match.dir);
    process.exit(0);
  }
  process.stderr.write("No match for: " + arg + "\n");
  process.exit(1);
}

hideCur();
render();
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", function(buf) {
  if (mode === "input") { handleInputData(buf); render(); return; }
  var key = parseKey(buf);
  if (key) { handleKey(key); render(); }
});
