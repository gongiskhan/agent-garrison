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

// USD per MILLION tokens, list rates (cached from the Claude API docs,
// 2026-08-26): input / output / cacheRead (~0.1x input) / cacheWrite (1.25x
// input, 5-minute TTL). Aliases map to their current resolution. OpenAI
// models ride the ChatGPT-plan subscription and are deliberately UNPRICED
// here — add them to the override file if a list rate ever matters.
export const MODEL_COSTS = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  haiku: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-5": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  sonnet: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-5": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  opus: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-fable-5": { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5 },
  fable: { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5 },
};

/** Merge the operator's override file OVER the static map — a price correction
 *  must not need a redeploy, and a network lookup must not make metrics fail. */
export function loadModelCosts(env = process.env) {
  const home = env.GARRISON_HOME?.trim() || path.join(process.env.HOME ?? "", ".garrison");
  try {
    const override = JSON.parse(readFileSync(path.join(home, "conversations", "model-costs.json"), "utf8"));
    return { ...MODEL_COSTS, ...override };
  } catch {
    return MODEL_COSTS;
  }
}

/** Price a stretch. usedTokens is the adapters' single cumulative counter
 *  (input+output un-split on most lanes), so the honest estimate prices it at
 *  the OUTPUT rate ceiling and the INPUT rate floor and reports the band. */
export function priceStretch({ model, usedTokens }, costs = MODEL_COSTS) {
  if (typeof usedTokens !== "number" || usedTokens <= 0) {
    return { usd: null, unpriced: true, reason: "no usage reported" };
  }
  // Providers report DATED ids (claude-haiku-4-5-20251001) while the table
  // keys the family — exact first, then the date suffix stripped, then the
  // longest table key that prefixes the id. Never a fuzzy guess beyond that:
  // an unknown family stays unpriced rather than borrowing a neighbour's rate.
  const id = String(model ?? "").toLowerCase();
  const undated = id.replace(/-\d{8}$/, "");
  const rate = costs[model] ?? costs[id] ?? costs[undated] ??
    Object.entries(costs)
      .filter(([k]) => id.startsWith(`${k}-`) || id === k)
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? null;
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

export function computeConversationMetrics(events, { costs = MODEL_COSTS } = {}) {
  const stretches = [];
  const byStretch = new Map();
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
      case "stretch-ended": {
        const rec = byStretch.get(e.payload?.stretchId ?? e.stretch);
        if (rec) {
          rec.outcome = e.payload?.outcome ?? null;
          rec.usedTokens = e.payload?.usedTokens ?? null;
          rec.costUnknown = e.payload?.costUnknown ?? rec.usedTokens == null;
          rec.durationMs = e.payload?.durationMs ?? null;
          rec.next = e.payload?.next ?? null;
          rec.cost = priceStretch({ model: rec.model, usedTokens: rec.usedTokens }, costs);
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
  return {
    stretches: stretches.length,
    perStretch: stretches,
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
      (acc[k] ??= { stretches: 0, usedTokens: 0, escalations: 0 });
      acc[k].stretches += 1;
      acc[k].usedTokens += s.usedTokens ?? 0;
      return acc;
    }, {}),
  };
}

/** Cached per-conversation metrics: recompute only when the log grew. */
export function conversationMetrics(conversationId, { env = process.env, costs } = {}) {
  const store = openConversation(conversationId, { role: "metrics", env });
  const cacheFile = path.join(store.dir, ".metrics.json");
  let mtime = null;
  try {
    mtime = statSync(store.logFile).mtimeMs;
  } catch {
    /* no log yet */
  }
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (cached.mtime === mtime) return cached.metrics;
  } catch {
    /* recompute */
  }
  const { events } = store.range({ fromIndex: 0, limit: 100_000 });
  const metrics = computeConversationMetrics(events, { costs: costs ?? loadModelCosts(env) });
  try {
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mtime, metrics }));
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
  const totals = { conversations: 0, stretches: 0, usdLow: 0, usdHigh: 0, unpricedStretches: 0, repeatedFailures: 0, digs: 0 };
  for (const { id, mtime } of listConversations(env)) {
    if (since && mtime && mtime < since) continue;
    const m = conversationMetrics(id, { env, costs });
    if (!m.stretches) continue;
    totals.conversations += 1;
    totals.stretches += m.stretches;
    totals.usdLow += m.usdLow;
    totals.usdHigh += m.usdHigh;
    totals.unpricedStretches += m.unpricedStretches;
    totals.digs += m.digs;
    if (m.repeatedFailure) totals.repeatedFailures += 1;
    for (const s of m.perStretch) {
      const key = groupBy === "model" ? (s.model ?? "unknown") : groupBy === "chosenBy" ? (s.chosenBy ?? "unknown") : (s.duty ?? "unknown");
      (groups[key] ??= { stretches: 0, usedTokens: 0, usdLow: 0, usdHigh: 0, unpriced: 0, escalated: 0 });
      groups[key].stretches += 1;
      groups[key].usedTokens += s.usedTokens ?? 0;
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
