// model-rates.mjs — the ONE pricing function.
//
// Every cost number Garrison reports goes through priceUsage() over the single
// hand-maintained table at data/model-rates.json. Both sides of any comparison
// call it: the conversation ledger's per-stretch aggregate and the plain Claude
// Code transcript parser. There is deliberately no second code path — a
// benchmark whose two sides are priced by two functions measures the functions.
//
// Three rules the rest of the system depends on:
//
//   - An unknown model is UNPRICED, never zero. {usd: null, unpriced: true}.
//     A silent zero teaches every consumer that the most expensive route is free.
//   - Token classes are priced separately. Cache reads are a tenth of input and
//     cache writes are a premium; collapsing them into one "tokens" number is
//     wrong by an order of magnitude on a cache-heavy agent run.
//   - The table carries `rates_updated`. Stale prices stay visible rather than
//     silently drifting from reality.
//
// Provider usage blocks differ in shape. normalizeAnthropicUsage() and
// normalizeOpenAiUsage() map each into the same five fields so the pricing
// function itself never learns a provider.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** data/model-rates.json, resolved from this module's real path. The package is
 *  symlinked into node_modules/@garrison/claude-pty, and Node resolves
 *  import.meta.url through the link, so this lands in the checkout's data/. */
export const DEFAULT_RATES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "data",
  "model-rates.json"
);

const TOKEN_CLASSES = ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"];

/** The five token classes, all zero. The shape every usage object in the system
 *  uses — one place to add a class if a provider ever grows one. */
export function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
  };
}

const USAGE_FIELDS = Object.keys(emptyUsage());

/** Sum usage objects field-wise. Non-numeric fields contribute zero. */
export function addUsage(...parts) {
  const out = emptyUsage();
  for (const part of parts) {
    if (!part) continue;
    for (const f of USAGE_FIELDS) {
      const v = part[f];
      if (typeof v === "number" && Number.isFinite(v)) out[f] += v;
    }
  }
  return out;
}

export function usageIsEmpty(usage) {
  return USAGE_FIELDS.every((f) => !(typeof usage?.[f] === "number" && usage[f] > 0));
}

export function totalTokens(usage) {
  return USAGE_FIELDS.reduce((n, f) => n + (typeof usage?.[f] === "number" ? usage[f] : 0), 0);
}

// ── provider usage → the common shape ───────────────────────────────────────

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * An Anthropic/Agent-SDK usage block → the common shape.
 *
 * cache_creation_input_tokens is the TOTAL of both TTLs. When the TTL split
 * (cache_creation.ephemeral_5m_input_tokens / ephemeral_1h_input_tokens) is
 * present we use it, because 1h writes cost 2x input against 5m's 1.25x and
 * guessing the cheaper one understates a long-lived agent. When it is absent we
 * attribute the whole total to the 5m class and say so via `ttlSplit: false` —
 * that is the SDK's own default TTL, and an unflagged guess is the thing to
 * avoid, not the guess itself.
 */
export function normalizeAnthropicUsage(raw) {
  const u = raw ?? {};
  const creation = u.cache_creation ?? {};
  const write5m = num(creation.ephemeral_5m_input_tokens);
  const write1h = num(creation.ephemeral_1h_input_tokens);
  const splitTotal = write5m + write1h;
  const creationTotal = num(u.cache_creation_input_tokens);
  const ttlSplit = splitTotal > 0;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheWrite5mTokens: ttlSplit ? write5m : creationTotal,
    cacheWrite1hTokens: ttlSplit ? write1h : 0,
    cacheReadTokens: num(u.cache_read_input_tokens),
    ttlSplit,
  };
}

/**
 * An OpenAI-shaped usage block → the common shape.
 *
 * prompt_tokens is INCLUSIVE of the cached portion, unlike Anthropic's
 * input_tokens which excludes it — so the cached count is subtracted out to get
 * the uncached remainder. OpenAI charges no cache-write premium (a write bills
 * at the base input rate), so both write classes stay zero and the table's
 * cacheWrite* entries for OpenAI models equal their input rate.
 */
export function normalizeOpenAiUsage(raw) {
  const u = raw ?? {};
  const cached = num(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? u.cache_read_input_tokens);
  const prompt = num(u.prompt_tokens ?? u.input_tokens);
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: num(u.completion_tokens ?? u.output_tokens),
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: cached,
  };
}

// ── the rate table ──────────────────────────────────────────────────────────

let cache = null;

/**
 * Load the table, memoised on (path, mtime, override mtime) so a dashboard poll
 * never re-parses it and a price correction never needs a redeploy.
 *
 * An operator override at $GARRISON_HOME/conversations/model-rates.json is
 * merged OVER the repo table, per model.
 */
export function loadModelRates(env = process.env) {
  const file = env.GARRISON_MODEL_RATES?.trim() || DEFAULT_RATES_PATH;
  const home = env.GARRISON_HOME?.trim() || path.join(env.HOME ?? "", ".garrison");
  const overrideFile = path.join(home, "conversations", "model-rates.json");
  const stamp = (p) => {
    try {
      const s = statSync(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "-";
    }
  };
  const key = `${file}|${stamp(file)}|${overrideFile}|${stamp(overrideFile)}`;
  if (cache?.key === key) return cache.rates;

  let base;
  try {
    base = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    // Loud but non-fatal: everything downstream reports unpriced with this
    // reason rather than reporting a confident zero.
    const rates = { rates_updated: null, stamp: key, models: {}, aliases: {}, error: `rate table unreadable at ${file}: ${err.message}` };
    cache = { key, rates };
    return rates;
  }
  let models = { ...(base.models ?? {}) };
  let aliases = { ...(base.aliases ?? {}) };
  try {
    const override = JSON.parse(readFileSync(overrideFile, "utf8"));
    models = { ...models, ...(override.models ?? override) };
    aliases = { ...aliases, ...(override.aliases ?? {}) };
  } catch {
    /* no override, or unreadable — the repo table stands */
  }
  const rates = {
    rates_updated: base.rates_updated ?? null,
    // Identity of the loaded table, override included. Downstream caches key on
    // this: `rates_updated` alone misses an operator override edit, and a price
    // correction that re-prices nothing is worse than no correction.
    stamp: key,
    currency: base.currency ?? "USD",
    unit: base.unit ?? "per_million_tokens",
    sources: base.sources ?? [],
    models,
    aliases,
    error: null,
  };
  cache = { key, rates };
  return rates;
}

/** Test seam: drop the memoised table. */
export function clearModelRatesCache() {
  cache = null;
}

/**
 * Resolve a provider-reported model id to a rate row.
 *
 * Exact → alias → date suffix stripped → the longest table key that prefixes
 * the id. Never a fuzzy guess beyond that: an unknown family stays unpriced
 * rather than borrowing a neighbour's rate.
 */
export function resolveModelRate(model, rates) {
  const table = rates?.models ?? {};
  if (!model) return { rate: null, resolved: null };
  const raw = String(model);
  const id = raw.toLowerCase();
  const alias = rates?.aliases ?? {};
  const via = (key) => (table[key] ? { rate: table[key], resolved: key } : null);

  const hit =
    via(raw) ||
    via(id) ||
    (alias[raw] && via(alias[raw])) ||
    (alias[id] && via(alias[id])) ||
    via(id.replace(/-\d{8}$/, ""));
  if (hit) return hit;

  const prefix = Object.keys(table)
    .filter((k) => id === k.toLowerCase() || id.startsWith(`${k.toLowerCase()}-`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? { rate: table[prefix], resolved: prefix } : { rate: null, resolved: null };
}

/**
 * Price a usage object. THE cost function — every caller on every side.
 *
 * @returns {{usd: number|null, unpriced: boolean, reason: string|null,
 *            model: string|null, resolvedModel: string|null,
 *            ratesUpdated: string|null, breakdown: Record<string, number>}}
 */
export function priceUsage(usage, { model, rates = null, env = process.env } = {}) {
  const table = rates ?? loadModelRates(env);
  const u = { ...emptyUsage(), ...(usage ?? {}) };
  const modelId = model ?? usage?.model ?? null;

  if (table.error) {
    return { usd: null, unpriced: true, reason: table.error, model: modelId, resolvedModel: null, ratesUpdated: null, breakdown: {} };
  }
  const { rate, resolved } = resolveModelRate(modelId, table);
  if (!rate) {
    return {
      usd: null,
      unpriced: true,
      reason: modelId ? `no list rate for model ${modelId}` : "no model reported",
      model: modelId,
      resolvedModel: null,
      ratesUpdated: table.rates_updated ?? null,
      breakdown: {},
    };
  }
  if (usageIsEmpty(u)) {
    return {
      usd: null,
      unpriced: true,
      reason: "no usage reported",
      model: modelId,
      resolvedModel: resolved,
      ratesUpdated: table.rates_updated ?? null,
      breakdown: {},
    };
  }

  const field = {
    input: "inputTokens",
    output: "outputTokens",
    cacheWrite5m: "cacheWrite5mTokens",
    cacheWrite1h: "cacheWrite1hTokens",
    cacheRead: "cacheReadTokens",
  };
  const breakdown = {};
  let usd = 0;
  for (const cls of TOKEN_CLASSES) {
    const tokens = u[field[cls]];
    const perM = rate[cls];
    if (!(typeof tokens === "number" && tokens > 0)) continue;
    if (typeof perM !== "number") {
      return {
        usd: null,
        unpriced: true,
        reason: `rate table has no ${cls} price for ${resolved}`,
        model: modelId,
        resolvedModel: resolved,
        ratesUpdated: table.rates_updated ?? null,
        breakdown: {},
      };
    }
    const cost = (tokens / 1_000_000) * perM;
    breakdown[cls] = cost;
    usd += cost;
  }
  return {
    usd,
    unpriced: false,
    reason: null,
    model: modelId,
    resolvedModel: resolved,
    ratesUpdated: table.rates_updated ?? null,
    breakdown,
  };
}

// ── provider rows → one aggregate ───────────────────────────────────────────
//
// A `usage` ledger row is whatever the provider said, tagged with `source`.
// This is the one place that knows what each source means:
//
//   assistant      one Anthropic API call (the per-call record)
//   result         the Agent SDK's end-of-turn envelope — the SAME tokens the
//                  assistant rows already describe, plus total_cost_usd. Summed
//                  ALONGSIDE the assistant rows it would double the bill, so it
//                  is used for the cross-check and only as a fallback basis.
//   codex-rollout  one codex API call, read from the session rollout
//   codex-stdout   one codex exec, aggregate — blind to subagent threads
//
// Attribution is per model: a stretch that spawns a cheaper subagent bills two
// rates, and one blended number would be wrong for both.

const CODEX_SOURCES = new Set(["codex-rollout", "codex-stdout"]);

/** One provider row → the common five-field shape, by its `source`. */
export function normalizeUsageRow(row) {
  const src = row?.source ?? "assistant";
  if (CODEX_SOURCES.has(src)) return normalizeCodexUsage(row?.usage);
  return normalizeAnthropicUsage(row?.usage);
}

/**
 * A codex usage block → the common shape. Codex follows the OpenAI convention:
 * `cached_input_tokens` is a SUBSET of `input_tokens` (so the uncached remainder
 * is the difference) and `reasoning_output_tokens` a subset of `output_tokens`
 * (so it is not added). `cache_write_input_tokens` is reported separately and
 * priced at the base input rate, which is what OpenAI charges for a cache write.
 */
export function normalizeCodexUsage(raw) {
  const u = raw ?? {};
  const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const cached = n(u.cached_input_tokens);
  const input = n(u.input_tokens);
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: n(u.output_tokens),
    cacheWrite5mTokens: n(u.cache_write_input_tokens),
    cacheWrite1hTokens: 0,
    cacheReadTokens: cached,
  };
}

/**
 * Fold `usage` rows into one attributed aggregate.
 *
 * @returns {{usage: object, apiCalls: number, basis: string|null,
 *            byModel: Record<string, {usage: object, apiCalls: number}>,
 *            sdkCostUsd: number|null, ttlSplit: boolean, sources: string[],
 *            subagentsInvisible: boolean}}
 */
export function aggregateUsageRows(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const assistant = list.filter((r) => r.source === "assistant");
  const results = list.filter((r) => r.source === "result");
  const provider = list.filter((r) => r.source !== "assistant" && r.source !== "result");

  // WHICH ROWS ARE THE TOTAL, and why it is not the obvious answer.
  //
  // The Agent SDK's `assistant` envelope is emitted while the message is still
  // streaming, so its `output_tokens` is a PARTIAL snapshot. Measured on a live
  // stretch: three assistant rows summed to 20 output tokens against a settled
  // 624, while their input (2788), cache write (61310) and cache read (189847)
  // matched the settled totals EXACTLY. Summing assistant rows therefore
  // under-reports output by ~30x, and output is the expensive class.
  //
  // So when the turn envelope is present it IS the total — it is exact on all
  // four classes and its `modelUsage` additionally attributes work the assistant
  // stream never surfaces (a subagent on another model). The assistant rows stay
  // in the ledger as the per-call record; they are counted only when no envelope
  // exists. A lane with neither (codex) uses its own provider rows.
  let basis = null;
  let counted = [];
  if (results.length) {
    counted = [...results, ...provider];
    basis = provider.length ? "mixed" : "result";
  } else if (assistant.length || provider.length) {
    counted = [...assistant, ...provider];
    basis = assistant.length && provider.length ? "mixed" : assistant.length ? "assistant" : "provider";
  }

  const byModel = {};
  let usage = emptyUsage();
  let ttlSplit = false;
  // Per-model CALL counts come from the per-call rows, which is the only place a
  // call is one row. The turn envelope's `modelUsage` attributes tokens per
  // model but is one entry per TURN, so counting it would report "3 calls" for a
  // 35-call stretch.
  const callsByModel = {};
  for (const row of assistant) {
    const k = row.model ?? "(unreported)";
    callsByModel[k] = (callsByModel[k] ?? 0) + 1;
  }
  for (const row of counted) {
    const u = normalizeUsageRow(row);
    if (u.ttlSplit) ttlSplit = true;
    usage = addUsage(usage, u);
    // `modelUsage` is the SDK's own per-model split of this envelope. Prefer it:
    // a turn's headline model is not the only model it billed. It carries no
    // cache TTL split, so the envelope's own 5m/1h ratio is applied to each
    // model's cache-creation share.
    const perModel = row.modelUsage && typeof row.modelUsage === "object" ? Object.entries(row.modelUsage) : null;
    if (perModel && perModel.length) {
      const w5 = u.cacheWrite5mTokens;
      const w1 = u.cacheWrite1hTokens;
      const wTotal = w5 + w1;
      for (const [model, mu] of perModel) {
        const create = Number(mu?.cacheCreationInputTokens ?? 0) || 0;
        const share = wTotal > 0 ? create / wTotal : 0;
        const entry = {
          inputTokens: Number(mu?.inputTokens ?? 0) || 0,
          outputTokens: Number(mu?.outputTokens ?? 0) || 0,
          cacheWrite5mTokens: wTotal > 0 ? Math.round(w5 * share) : create,
          cacheWrite1hTokens: wTotal > 0 ? Math.round(w1 * share) : 0,
          cacheReadTokens: Number(mu?.cacheReadInputTokens ?? 0) || 0,
        };
        if (!byModel[model]) byModel[model] = { usage: emptyUsage(), apiCalls: 0 };
        byModel[model].usage = addUsage(byModel[model].usage, entry);
        byModel[model].apiCalls += 1;
      }
      continue;
    }
    const key = row.model ?? "(unreported)";
    if (!byModel[key]) byModel[key] = { usage: emptyUsage(), apiCalls: 0 };
    byModel[key].usage = addUsage(byModel[key].usage, u);
    byModel[key].apiCalls += 1;
  }

  // apiCalls counts the per-call record, which survives even when the envelope
  // is what gets summed — otherwise a turn reports "1 call" for six.
  const apiCalls = assistant.length ? assistant.length + provider.length : counted.length;
  // Prefer the real per-call count per model over the envelope count.
  for (const [model, entry] of Object.entries(byModel)) {
    if (callsByModel[model] != null) entry.apiCalls = callsByModel[model];
  }

  let sdkCostUsd = null;
  for (const r of results) {
    if (typeof r.sdkCostUsd === "number") sdkCostUsd = (sdkCostUsd ?? 0) + r.sdkCostUsd;
  }

  return {
    usage,
    apiCalls,
    basis,
    byModel,
    sdkCostUsd,
    ttlSplit,
    sources: [...new Set(list.map((r) => r.source).filter(Boolean))],
    subagentsInvisible: list.some((r) => r.subagentsInvisible === true),
  };
}

/**
 * Price an aggregate, per model, then sum. A model with no list rate leaves the
 * total UNPRICED and names itself — a partial sum silently understates.
 */
export function priceAggregate(agg, { rates = null, env = process.env, fallbackModel = null } = {}) {
  const table = rates ?? loadModelRates(env);
  const models = Object.keys(agg?.byModel ?? {});
  if (!models.length) {
    return { usd: null, unpriced: true, reason: "no usage reported", byModel: {}, unpricedModels: [] };
  }
  const byModel = {};
  const unpricedModels = [];
  let usd = 0;
  for (const key of models) {
    const entry = agg.byModel[key];
    const modelId = key === "(unreported)" ? fallbackModel : key;
    const priced = priceUsage(entry.usage, { model: modelId, rates: table, env });
    byModel[key] = { ...priced, apiCalls: entry.apiCalls, usage: entry.usage };
    if (priced.unpriced) unpricedModels.push(modelId ?? key);
    else usd += priced.usd;
  }
  if (unpricedModels.length) {
    return {
      usd: null,
      unpriced: true,
      reason: `no list rate for ${unpricedModels.join(", ")}`,
      byModel,
      unpricedModels,
      ratesUpdated: table.rates_updated ?? null,
    };
  }
  return { usd, unpriced: false, reason: null, byModel, unpricedModels: [], ratesUpdated: table.rates_updated ?? null };
}
