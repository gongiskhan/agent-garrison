// conversation-metrics.mjs — per-stretch instrumentation over the conversation
// store (Conversations plan, Task 5).
//
// Every metric is computed from ledger events; a missing field is a missing
// metric, so the launcher's event vocabulary is the contract. Costs are LIST
// RATES (USD per million tokens) — the subscription pays the actual bill, but
// list rates are the honest comparison yardstick the improver diets on.
//
// Two hard rules:
//   - An unknown model yields {usd: null, unpriced: true} — NEVER 0. A silent
//     zero teaches the improver that the most expensive route is free.
//   - Incremental reads: per-conversation aggregates cache at
//     <conversation>/.metrics.json keyed on {lastIndex, mtime}; a dashboard
//     poll must never re-parse every JSONL (the monitor-lsof lesson).
import path from "node:path";
import { readFileSync, writeFileSync, statSync, renameSync } from "node:fs";
import { openConversation, listConversations, conversationDir } from "./conversation-store.mjs";
import {
  loadModelRates,
  priceUsage,
  priceAggregate,
  aggregateUsageRows,
  emptyUsage,
  addUsage,
} from "./model-rates.mjs";

// The rate table moved to data/model-rates.json + model-rates.mjs so that BOTH
// sides of a cost comparison price through one function (see that module's
// header). What is left here is the ledger-shaped view over it.
//
// `MODEL_COSTS` and `loadModelCosts` survive as thin adapters onto the shared
// table: they were the repo's rate surface and callers still exist.

/** The shared table in the old {input, output, cacheRead, cacheWrite} shape. */
export function loadModelCosts(env = process.env) {
  const rates = loadModelRates(env);
  const out = {};
  for (const [k, r] of Object.entries(rates.models ?? {})) {
    out[k] = { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite5m };
  }
  for (const [alias, target] of Object.entries(rates.aliases ?? {})) {
    if (out[target] && !out[alias]) out[alias] = out[target];
  }
  return out;
}

export const MODEL_COSTS = loadModelCosts();

/**
 * Price ONE stretch.
 *
 * The exact path takes `usage` — the five token classes summed from the
 * stretch's `usage` ledger rows — and returns a single number.
 *
 * The legacy path takes only the un-split cumulative `usedTokens` scalar, which
 * cannot be priced exactly: the same token costs 0.1x as a cache read and 5x as
 * output. That path still returns the honest BAND it always did (input rate as
 * the floor, output rate as the ceiling) rather than inventing a point estimate.
 * A conversation recorded before per-call capture existed reads through it.
 */
export function priceStretch({ model, usedTokens, usage = null, byModel = null }, costs = MODEL_COSTS, env = process.env) {
  if (byModel && Object.keys(byModel).length) {
    const priced = priceAggregate({ byModel }, { fallbackModel: model, env });
    return priced.unpriced
      ? { usd: null, unpriced: true, reason: priced.reason }
      : { usd: priced.usd, usdLow: priced.usd, usdHigh: priced.usd, unpriced: false, exact: true };
  }
  if (usage) {
    const priced = priceUsage(usage, { model, env });
    return priced.unpriced
      ? { usd: null, unpriced: true, reason: priced.reason }
      : { usd: priced.usd, usdLow: priced.usd, usdHigh: priced.usd, unpriced: false, exact: true, breakdown: priced.breakdown };
  }
  if (typeof usedTokens !== "number" || usedTokens <= 0) {
    return { usd: null, unpriced: true, reason: "no usage reported" };
  }
  const id = String(model ?? "").toLowerCase();
  const undated = id.replace(/-\d{8}$/, "");
  const rate =
    costs[model] ??
    costs[id] ??
    costs[undated] ??
    Object.entries(costs)
      .filter(([k]) => id.startsWith(`${k}-`) || id === k)
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1] ??
    null;
  if (!rate) return { usd: null, unpriced: true, reason: `no list rate for model ${model}` };
  const m = usedTokens / 1_000_000;
  return {
    usd: null, // no single number is honest for an un-split counter…
    usdLow: m * rate.input,
    usdHigh: m * rate.output,
    unpriced: false,
  };
}

// ── per-conversation aggregation (cached) ───────────────────────────────────

export function computeConversationMetrics(events, { costs = MODEL_COSTS, env = process.env } = {}) {
  const stretches = [];
  const byStretch = new Map();
  const usageRows = new Map();
  let digs = 0;
  let escalations = [];
  let delegations = { dispatched: 0, returned: 0, failed: 0, usedTokens: 0 };
  let userMessages = 0;

  for (const e of events) {
    switch (e.kind) {
      case "stretch-started": {
        const rec = {
          stretchId: e.payload?.stretchId ?? e.stretch,
          duty: e.duty ?? e.payload?.duty ?? null,
          model: e.payload?.target?.model ?? null,
          provider: e.payload?.target?.provider ?? null,
          runtime: e.payload?.target?.runtime ?? null,
          effort: e.payload?.target?.effort ?? null,
          chosenBy: e.payload?.chosenBy ?? null,
          startedAt: e.ts,
        };
        byStretch.set(rec.stretchId, rec);
        stretches.push(rec);
        break;
      }
      case "usage": {
        // Per-API-call rows. Keyed by stretch so a conversation can be re-priced
        // from the raw provider numbers without re-running anything.
        const k = e.payload?.stretchId ?? e.stretch;
        if (!k) break;
        if (!usageRows.has(k)) usageRows.set(k, []);
        usageRows.get(k).push(e.payload);
        break;
      }
      case "stretch-ended": {
        const rec = byStretch.get(e.payload?.stretchId ?? e.stretch);
        if (rec) {
          rec.outcome = e.payload?.outcome ?? null;
          rec.usedTokens = e.payload?.usedTokens ?? null;
          rec.costUnknown = e.payload?.costUnknown ?? rec.usedTokens == null;
          rec.durationMs = e.payload?.durationMs ?? null;
          rec.next = e.payload?.next ?? null;
          // Attribution comes from the OBSERVED model on the closing event, not
          // the routed one on stretch-started: a provider fallback changes which
          // model actually billed, and pricing the route would price a model that
          // never ran.
          rec.observedModel = e.payload?.model ?? null;
          rec.provider = e.payload?.provider ?? rec.provider;
          rec.runtime = e.payload?.runtime ?? rec.runtime;
          rec.target = e.payload?.target ?? null;
          rec.apiCalls = e.payload?.apiCalls ?? 0;
          rec.sdkCostUsd = typeof e.payload?.sdkCostUsd === "number" ? e.payload.sdkCostUsd : null;
          rec.usageBasis = e.payload?.usageBasis ?? null;
          rec.subagentsInvisible = e.payload?.subagentsInvisible === true;
          const rows = usageRows.get(rec.stretchId) ?? [];
          const agg = aggregateUsageRows(rows);
          rec.usage = agg.usage;
          rec.byModel = agg.byModel;
          if (!rec.apiCalls) rec.apiCalls = agg.apiCalls;
          rec.cost = agg.apiCalls
            ? priceStretch({ model: rec.observedModel ?? rec.model, byModel: agg.byModel }, costs, env)
            : priceStretch({ model: rec.observedModel ?? rec.model, usedTokens: rec.usedTokens }, costs, env);
        }
        break;
      }
      case "handoff": {
        const rec = byStretch.get(e.payload?.stretchId ?? e.stretch);
        if (rec) {
          rec.handoffStatus = e.payload?.status ?? null;
          rec.failedApproaches = Array.isArray(e.payload?.failedApproaches) ? e.payload.failedApproaches.length : 0;
        }
        break;
      }
      case "dig":
        digs += 1;
        break;
      case "escalation":
        escalations.push({ duty: e.duty ?? null, from: e.payload?.from ?? null, to: e.payload?.to ?? null, reason: e.payload?.reason ?? null });
        break;
      case "delegation-dispatched":
        delegations.dispatched += 1;
        break;
      case "delegation-returned":
        delegations.returned += 1;
        if (typeof e.payload?.usedTokens === "number") delegations.usedTokens += e.payload.usedTokens;
        break;
      case "delegation-failed":
        delegations.failed += 1;
        break;
      case "user-message":
        userMessages += 1;
        break;
      default:
        break;
    }
  }

  // Repeated failure: >=2 CONSECUTIVE stretches whose handoff carried
  // failedApproaches, or >=2 consecutive failed outcomes.
  let maxConsecutiveFailed = 0;
  let run = 0;
  for (const s of stretches) {
    const failed = (s.failedApproaches ?? 0) > 0 || s.outcome === "error" || s.handoffStatus === "failed";
    run = failed ? run + 1 : 0;
    if (run > maxConsecutiveFailed) maxConsecutiveFailed = run;
  }

  const priced = stretches.filter((s) => s.cost && !s.cost.unpriced);
  const exact = priced.filter((s) => s.cost.exact);
  // Per-model totals, priced once at the end so each model is charged its own
  // rate rather than the stretch's headline model.
  const byModel = {};
  for (const st of stretches) {
    for (const [model, entry] of Object.entries(st.byModel ?? {})) {
      (byModel[model] ??= { apiCalls: 0, usage: emptyUsage() });
      byModel[model].apiCalls += entry.apiCalls ?? 0;
      byModel[model].usage = addUsage(byModel[model].usage, entry.usage);
    }
  }
  for (const [model, entry] of Object.entries(byModel)) {
    const p = priceUsage(entry.usage, { model, env });
    entry.usd = p.unpriced ? null : p.usd;
    entry.unpriced = p.unpriced;
    if (p.unpriced) entry.reason = p.reason;
  }
  const usage = stretches.reduce((acc, s) => addUsage(acc, s.usage), emptyUsage());
  const cacheAndInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
  return {
    stretches: stretches.length,
    perStretch: stretches,
    apiCalls: stretches.reduce((a, s) => a + (s.apiCalls ?? 0), 0),
    usage,
    // The share of everything read into the model that came from cache. This is
    // the number that explains a conversation's cost: cache reads are a tenth of
    // input, so a high share means a long context is nearly free to re-read.
    cacheReadShare: cacheAndInput ? usage.cacheReadTokens / cacheAndInput : 0,
    // Exact only. A stretch priced from the legacy un-split counter contributes
    // to usdLow/usdHigh below, never to this figure.
    totalCostUsd: exact.length ? exact.reduce((a, s) => a + s.cost.usd, 0) : null,
    exactlyPricedStretches: exact.length,
    sdkCostUsd: stretches.some((s) => typeof s.sdkCostUsd === "number")
      ? stretches.reduce((a, s) => a + (s.sdkCostUsd ?? 0), 0)
      : null,
    totalUsedTokens: stretches.reduce((a, s) => a + (s.usedTokens ?? 0), 0),
    unpricedStretches: stretches.filter((s) => !s.cost || s.cost.unpriced).length,
    usdLow: priced.reduce((a, s) => a + (s.cost.usdLow ?? 0), 0),
    usdHigh: priced.reduce((a, s) => a + (s.cost.usdHigh ?? 0), 0),
    digs,
    digsPerStretch: stretches.length ? digs / stretches.length : 0,
    escalations,
    escalationRate: stretches.length ? escalations.length / stretches.length : 0,
    repeatedFailure: maxConsecutiveFailed >= 2,
    maxConsecutiveFailed,
    delegations,
    userMessages,
    chosenByMix: stretches.reduce((acc, s) => {
      const k = s.chosenBy ?? "unknown";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    byDuty: stretches.reduce((acc, s) => {
      const k = s.duty ?? "unknown";
      (acc[k] ??= { stretches: 0, usedTokens: 0, escalations: 0, apiCalls: 0, usd: 0, unpriced: 0 });
      acc[k].stretches += 1;
      acc[k].usedTokens += s.usedTokens ?? 0;
      acc[k].apiCalls += s.apiCalls ?? 0;
      if (s.cost?.exact) acc[k].usd += s.cost.usd;
      else if (!s.cost || s.cost.unpriced) acc[k].unpriced += 1;
      return acc;
    }, {}),
    // Where the money went, by the model that actually served the call.
    byModel,
  };
}

// Bump when the metrics computation changes shape or meaning. The cache is
// keyed on this AND the rate table's date, because neither a code change nor a
// price correction touches a finished log's mtime — without them, every
// conversation that stopped growing would serve its pre-change numbers forever.
export const METRICS_SCHEMA = 2;

/** Cached per-conversation metrics: recompute when the log grew, the metrics
 *  schema changed, or the rate table was updated. */
export function conversationMetrics(conversationId, { env = process.env, costs } = {}) {
  const store = openConversation(conversationId, { role: "metrics", env });
  const cacheFile = path.join(store.dir, ".metrics.json");
  let mtime = null;
  try {
    mtime = statSync(store.logFile).mtimeMs;
  } catch {
    /* no log yet */
  }
  const ratesTable = loadModelRates(env);
  const ratesStamp = ratesTable.stamp ?? ratesTable.rates_updated ?? "none";
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (cached.mtime === mtime && cached.schema === METRICS_SCHEMA && cached.rates === ratesStamp) {
      return cached.metrics;
    }
  } catch {
    /* recompute */
  }
  const { events } = store.range({ fromIndex: 0, limit: 100_000 });
  const metrics = computeConversationMetrics(events, { costs: costs ?? loadModelCosts(env), env });
  try {
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mtime, schema: METRICS_SCHEMA, rates: ratesStamp, metrics }));
    renameSync(tmp, cacheFile);
  } catch {
    /* cache is a convenience */
  }
  return metrics;
}

/** Board-level rollup across conversations, grouped by duty|model|chosenBy. */
export function rollupMetrics({ env = process.env, groupBy = "duty", since = null } = {}) {
  const costs = loadModelCosts(env);
  const groups = {};
  const totals = { conversations: 0, stretches: 0, usd: 0, apiCalls: 0, usdLow: 0, usdHigh: 0, unpricedStretches: 0, repeatedFailures: 0, digs: 0 };
  for (const { id, mtime } of listConversations(env)) {
    if (since && mtime && mtime < since) continue;
    const m = conversationMetrics(id, { env, costs });
    if (!m.stretches) continue;
    totals.conversations += 1;
    totals.stretches += m.stretches;
    totals.usd += m.totalCostUsd ?? 0;
    totals.apiCalls += m.apiCalls ?? 0;
    totals.usdLow += m.usdLow;
    totals.usdHigh += m.usdHigh;
    totals.unpricedStretches += m.unpricedStretches;
    totals.digs += m.digs;
    if (m.repeatedFailure) totals.repeatedFailures += 1;
    for (const s of m.perStretch) {
      const key = groupBy === "model" ? (s.model ?? "unknown") : groupBy === "chosenBy" ? (s.chosenBy ?? "unknown") : (s.duty ?? "unknown");
      (groups[key] ??= { stretches: 0, usedTokens: 0, usd: 0, apiCalls: 0, usdLow: 0, usdHigh: 0, unpriced: 0, escalated: 0 });
      groups[key].stretches += 1;
      groups[key].usedTokens += s.usedTokens ?? 0;
      groups[key].apiCalls += s.apiCalls ?? 0;
      if (s.cost?.exact) groups[key].usd += s.cost.usd;
      if (s.cost && !s.cost.unpriced) {
        groups[key].usdLow += s.cost.usdLow ?? 0;
        groups[key].usdHigh += s.cost.usdHigh ?? 0;
      } else {
        groups[key].unpriced += 1;
      }
      if (s.chosenBy === "escalation-tripwire" || s.chosenBy === "escalation-forced") groups[key].escalated += 1;
    }
  }
  for (const g of Object.values(groups)) {
    g.escalationRate = g.stretches ? g.escalated / g.stretches : 0;
  }
  return { totals, groups, groupBy };
}
