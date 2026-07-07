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

// Normalize a stored slot value into an ordered chain: legacy single {provider,model}
// -> [obj]; an array stays; anything else -> []. First entry is the primary, the rest
// are ordered fallbacks the proxy tries when earlier ones are rate-limited.
export function normalizeChain(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((e) => e && e.provider && e.model);
}

// Effective tier -> ORDERED CHAIN of {provider, model, name, derived}. Each stored
// entry is kept while its model still exists in the catalog; a fully stale/unset tier
// auto-derives one primary (preferring the provider the user chose, else any) by tier
// keyword. "default" follows an explicit valid chain, else opus. "-auto" ids skipped.
export function resolveModelMap(configDir) {
  const stored = readModelMap(configDir);
  const catalog = catalogEntries(configDir).filter((e) => !/-auto$/.test(e.model));
  const has = (provider, model) => catalog.some((e) => e.provider === provider && e.model === model);
  const nameOf = (provider, model) => { const m = catalog.find((e) => e.provider === provider && e.model === model); return (m && m.name) || model; };
  const deriveIn = (entries, keyword) => entries.find((e) => keyword && e.model.toLowerCase().indexOf(keyword) >= 0) || null;

  const pick = (slot, keyword) => {
    const chain = normalizeChain(stored[slot]);
    const out = [];
    for (const e of chain) {
      if (has(e.provider, e.model)) out.push({ provider: e.provider, model: e.model, name: nameOf(e.provider, e.model), derived: false });
    }
    if (out.length) return out;
    // Whole chain stale/unset — derive one primary. Prefer the provider the user chose
    // (only its model id changed) so e.g. a claude-code opus heals to the current
    // claude-code opus, not another provider that merely also has an "opus".
    const preferred = chain[0] && chain[0].provider;
    const inProvider = preferred ? catalog.filter((e) => e.provider === preferred) : [];
    const d = deriveIn(inProvider, keyword) || deriveIn(catalog, keyword);
    return d ? [{ provider: d.provider, model: d.model, name: nameOf(d.provider, d.model), derived: true }] : [];
  };

  const eff = {
    opus: pick("opus", TIER_KEYWORD.opus),
    sonnet: pick("sonnet", TIER_KEYWORD.sonnet),
    haiku: pick("haiku", TIER_KEYWORD.haiku),
  };
  const dflt = pick("default", null);
  eff.default = dflt.length ? dflt : eff.opus.map((e) => ({ ...e, derived: true }));
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
    const primary = (eff[slot] || [])[0];   // the tier's primary drives /model display
    if (!primary || !primary.model) return;
    pairs.push({ key: modelVar, value: primary.model });
    pairs.push({ key: nameVar, value: primary.name });
  };
  set("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME");
  set("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME");
  set("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME");
  const dflt = (eff.default || [])[0];
  if (dflt && dflt.model) pairs.push({ key: "ANTHROPIC_MODEL", value: dflt.model });
  return pairs;
}
