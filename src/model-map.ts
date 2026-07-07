// @ts-nocheck
// Shared Claude tier -> provider-model resolution, used by the proxy (routing), the
// Providers tab (display), and the cc wrapper (model env injection). Self-heals: a
// stored mapping whose model no longer exists in the live catalog (e.g. after a model
// refresh) is auto-re-derived to the current best model for that tier, so the mapping
// tracks Claude Code's models without the user re-assigning. Pure fs/path only — no
// core deps — so it stays inlinable into the self-contained proxy bundle.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const TIER_KEYWORD = { opus: "opus", sonnet: "sonnet", haiku: "haiku" };

function configFolder(configDir) { return join(configDir, "config"); }

export function readModelMap(configDir) {
  try {
    const p = join(configFolder(configDir), "claude-code-loader.json");
    if (existsSync(p)) return (JSON.parse(readFileSync(p, "utf8")).modelMap) || {};
  } catch {}
  return {};
}

// core-auth writes the live per-provider catalog here on login / "Refresh models".
function modelCache(configDir) {
  for (const f of ["models.json", "core-auth-models.json"]) {
    try {
      const p = join(configFolder(configDir), f);
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) || {};
    } catch {}
  }
  return {};
}

// Live catalog [{provider, model, name}] from each deployed provider's authProviders,
// preferring core-auth's fetched cache, else the package's static list.
export function catalogEntries(configDir) {
  const out = [];
  const reposDir = join(configDir, "repos");
  let repos = [];
  try { repos = readdirSync(reposDir); } catch { return out; }
  const cache = modelCache(configDir);
  for (const repo of repos) {
    try {
      const pkg = JSON.parse(readFileSync(join(reposDir, repo, "package.json"), "utf8"));
      const declared = (pkg.claudeHub && pkg.claudeHub.authProviders) || pkg.authProviders || [];
      for (const p of declared) {
        const provider = p.name || repo;
        const cached = cache[provider] && cache[provider].models;
        if (cached) {
          // ranking (best first) if core-auth computed one, else catalog order
          const order = (cache[provider].ranking && cache[provider].ranking.length) ? cache[provider].ranking : Object.keys(cached);
          for (const model of order) {
            if (!cached[model]) continue;
            out.push({ provider, model, name: (cached[model] && cached[model].name) || model });
          }
        } else {
          for (const m of (p.models || [])) {
            const model = typeof m === "string" ? m : m.id;
            out.push({ provider, model, name: typeof m === "string" ? m : (m.name || m.id) });
          }
        }
      }
    } catch {}
  }
  return out;
}

// Effective tier -> {provider, model, name, derived} map. Keeps the user's stored
// choice while its model still exists in the catalog; otherwise auto-derives the first
// catalog entry whose id carries the tier keyword (catalog order = provider ranking).
// "default" follows an explicit valid choice, else opus. The synthetic "-auto" ids are
// skipped so a tier never resolves to Auto.
export function resolveModelMap(configDir) {
  const stored = readModelMap(configDir);
  const catalog = catalogEntries(configDir).filter((e) => !/-auto$/.test(e.model));
  const has = (provider, model) => catalog.some((e) => e.provider === provider && e.model === model);
  const deriveIn = (entries, keyword) => entries.find((e) => e.model.toLowerCase().indexOf(keyword) >= 0) || null;

  const pick = (slot, keyword) => {
    const s = stored[slot];
    if (s && s.provider && s.model && has(s.provider, s.model)) return { provider: s.provider, model: s.model, derived: false };
    // Re-derive a stale/unset slot. Prefer the provider the user actually chose (only
    // its model id changed) so a claude-code slot heals to the current claude-code
    // model for this tier — NOT another provider that merely also has an "opus".
    // Catalog order is the provider's ranking, so the first keyword match is the best.
    const inProvider = s && s.provider ? catalog.filter((e) => e.provider === s.provider) : [];
    const d = deriveIn(inProvider, keyword) || deriveIn(catalog, keyword);
    return d ? { provider: d.provider, model: d.model, derived: true } : null;
  };

  const eff = {
    opus: pick("opus", TIER_KEYWORD.opus),
    sonnet: pick("sonnet", TIER_KEYWORD.sonnet),
    haiku: pick("haiku", TIER_KEYWORD.haiku),
  };
  const sd = stored.default;
  eff.default = (sd && sd.provider && sd.model && has(sd.provider, sd.model))
    ? { provider: sd.provider, model: sd.model, derived: false }
    : (eff.opus ? { ...eff.opus, derived: true } : null);

  for (const slot of Object.keys(eff)) {
    if (!eff[slot]) continue;
    const match = catalog.find((e) => e.provider === eff[slot].provider && e.model === eff[slot].model);
    eff[slot].name = (match && match.name) || eff[slot].model;
  }
  return eff;
}

// {key,value} env pairs the cc wrapper exports so Claude Code's /model shows the
// mapped models as custom Opus/Sonnet/Haiku entries (real names via *_NAME) and uses
// the default tier as the session default. Only third-party base URLs (our proxy)
// honor the *_NAME/*_DESCRIPTION display vars, which is exactly how the wrapper
// launches. Values (display names) can contain spaces/parens, so the caller quotes
// per shell — hence pairs, not pre-joined lines.
export function modelEnvPairs(configDir) {
  const eff = resolveModelMap(configDir);
  const pairs = [];
  const set = (slot, modelVar, nameVar) => {
    if (!eff[slot] || !eff[slot].model) return;
    pairs.push({ key: modelVar, value: eff[slot].model });
    pairs.push({ key: nameVar, value: eff[slot].name });
  };
  set("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME");
  set("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME");
  set("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME");
  if (eff.default && eff.default.model) pairs.push({ key: "ANTHROPIC_MODEL", value: eff.default.model });
  return pairs;
}
