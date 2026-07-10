// @ts-nocheck
// Shared Claude tier -> provider-model resolution, used by the proxy (routing), the
// Providers tab (display), and the cc wrapper (model env injection). Self-heals: a
// stored mapping whose model no longer exists in the live catalog (e.g. after a model
// refresh) is auto-re-derived to the current best model for that tier, so the mapping
// tracks Claude Code's models without the user re-assigning. Pure fs/path only — no
// core deps — so it stays inlinable into the self-contained proxy bundle.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

function configFolder(configDir) { return join(configDir, "config"); }

// Claude tiers are DETECTED from the claude-code catalog (family token of each
// model id, e.g. claude-fable-5 -> "fable"), so new families appear as mapping
// slots automatically. Known families keep a familiar order; unknown ones follow.
const TIER_DISPLAY_ORDER = ["opus", "sonnet", "haiku", "fable"];
const TIER_FALLBACK = ["opus", "sonnet", "haiku"];   // pre-login only (no catalog yet)

export function claudeTiers(configDir) {
  const cc = modelCache(configDir)["claude-code"];
  const ids = (cc && cc.ranking && cc.ranking.length) ? cc.ranking : Object.keys((cc && cc.models) || {});
  const tiers = [];
  for (const id of ids) {
    const m = /^claude-([a-z]+)-\d/.exec(String(id));
    if (m && !tiers.includes(m[1])) tiers.push(m[1]);
  }
  if (!tiers.length) return TIER_FALLBACK.slice();
  tiers.sort((a, b) => {
    const ia = TIER_DISPLAY_ORDER.indexOf(a), ib = TIER_DISPLAY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return tiers;
}

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
          const scores = (cache[provider].scores) || {};
          for (const model of order) {
            if (!cached[model]) continue;
            out.push({ provider, model, name: (cached[model] && cached[model].name) || model, score: typeof scores[model] === "number" ? scores[model] : undefined });
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
// entry is kept while its model still exists in the catalog; a fully stale tier
// heals ONLY within the provider the user chose — never silently to a different
// provider (an Opus->antigravity mapping must not become claude-code and then gate
// on claude accounts). When the chosen provider has no catalog at all, the stored
// entry passes through untouched (the catalog may simply not be fetched yet; if
// the model is really gone the provider reports its own clear error). Only a tier
// with NO stored choice derives from the whole catalog. "-auto" ids skipped.
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
      const providerKnown = catalog.some((c) => c.provider === e.provider);
      if (has(e.provider, e.model)) out.push({ provider: e.provider, model: e.model, name: nameOf(e.provider, e.model), derived: false });
      else if (!providerKnown) out.push({ provider: e.provider, model: e.model, name: e.model, derived: false });
    }
    if (out.length) return out;
    // Whole chain stale — heal WITHIN the chosen provider (only its model id
    // changed); cross-provider derivation is reserved for unset tiers.
    const preferred = chain[0] && chain[0].provider;
    if (preferred) {
      const d = deriveIn(catalog.filter((e) => e.provider === preferred), keyword);
      return d ? [{ provider: d.provider, model: d.model, name: nameOf(d.provider, d.model), derived: true }] : [];
    }
    const d = deriveIn(catalog, keyword);
    return d ? [{ provider: d.provider, model: d.model, name: nameOf(d.provider, d.model), derived: true }] : [];
  };

  const eff = {};
  const tiers = claudeTiers(configDir);
  for (const tier of tiers) eff[tier] = pick(tier, tier);
  const dflt = pick("default", null);
  const first = tiers.find((t) => (eff[t] || []).length);
  eff.default = dflt.length ? dflt : (first ? eff[first].map((e) => ({ ...e, derived: true })) : []);
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
  for (const tier of Object.keys(eff)) {
    if (tier === "default") continue;
    const primary = (eff[tier] || [])[0];   // the tier's primary drives /model display
    if (!primary || !primary.model) continue;
    const upper = tier.toUpperCase();       // e.g. FABLE -> ANTHROPIC_DEFAULT_FABLE_MODEL
    pairs.push({ key: "ANTHROPIC_DEFAULT_" + upper + "_MODEL", value: primary.model });
    pairs.push({ key: "ANTHROPIC_DEFAULT_" + upper + "_MODEL_NAME", value: primary.name });
  }
  const dflt = (eff.default || [])[0];
  if (dflt && dflt.model) pairs.push({ key: "ANTHROPIC_MODEL", value: dflt.model });
  return pairs;
}
