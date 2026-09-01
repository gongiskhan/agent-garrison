#!/usr/bin/env node
// JOB 3. Numbers and quoted evidence from data already collected. No new runs,
// no interpretation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  priceUsage, emptyUsage, addUsage, normalizeUsageRow, aggregateUsageRows, openConversation,
} from "/home/ggomes/dev/garrison/packages/claude-pty/src/index.mjs";

const HOME = os.homedir();
const RUNS = path.join(HOME, "bench", "runs");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const A = [1, 2, 3, 4].map((i) => J(path.join(RUNS, `armA-${i}.measure.json`)));
const B = [1, 2, 3, 4].map((i) => J(path.join(RUNS, `armB-${i}.measure.json`)));

const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length < 2 ? 0 : Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  return { n: xs.length, median: s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2,
    min: s[0], max: s[s.length - 1], mean, sd, cv: mean ? sd / mean : 0 };
};

// ── per-model split, both arms ────────────────────────────────────────────
const perModel = [];
for (const r of A) {
  const store = openConversation(r.conversationId, { role: "bench" });
  const { events } = store.range({ fromIndex: 0, limit: 500_000 });
  const byStretch = new Map();
  for (const e of events) {
    if (e.kind !== "usage") continue;
    const k = e.stretch ?? "(none)";
    if (!byStretch.has(k)) byStretch.set(k, { duty: e.duty, rows: [] });
    byStretch.get(k).rows.push(e.payload);
  }
  const acc = {};
  for (const { rows } of byStretch.values()) {
    const agg = aggregateUsageRows(rows);
    for (const [m, entry] of Object.entries(agg.byModel ?? {})) {
      acc[m] ??= { usage: emptyUsage(), requests: 0 };
      acc[m].usage = addUsage(acc[m].usage, entry.usage);
      acc[m].requests += entry.apiCalls;
    }
  }
  for (const [model, v] of Object.entries(acc)) {
    perModel.push({ run: `A-${r.run}`, model, requests: v.requests, ...v.usage,
      cacheWriteTokens: v.usage.cacheWrite5mTokens + v.usage.cacheWrite1hTokens,
      costUsd: priceUsage(v.usage, { model }).usd ?? null });
  }
}
for (const r of B) {
  for (const [model, requests] of Object.entries(r.requestsByModel)) {
    perModel.push({ run: `B-${r.run}`, model, requests,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens,
      costUsd: r.costUsd });
  }
}

// Sonnet vs haiku share of Arm A.
const aRows = perModel.filter((x) => x.run.startsWith("A-"));
const shareOf = (pred) => {
  const req = aRows.filter(pred).reduce((a, b) => a + b.requests, 0);
  const usd = aRows.filter(pred).reduce((a, b) => a + (b.costUsd ?? 0), 0);
  return { requests: req, costUsd: usd };
};
const totalA = { requests: aRows.reduce((a, b) => a + b.requests, 0), costUsd: aRows.reduce((a, b) => a + (b.costUsd ?? 0), 0) };
const armAShare = {
  total: totalA,
  sonnet: shareOf((x) => x.model.includes("sonnet")),
  haiku: shareOf((x) => x.model.includes("haiku")),
  other: shareOf((x) => !x.model.includes("sonnet") && !x.model.includes("haiku")),
};

// ── per-stretch table for Arm A ───────────────────────────────────────────
const stretches = [];
for (const r of A) {
  const store = openConversation(r.conversationId, { role: "bench" });
  const { events } = store.range({ fromIndex: 0, limit: 500_000 });
  const order = [];
  const meta = new Map();
  for (const e of events) {
    if (e.kind === "stretch-started") {
      order.push(e.stretch);
      meta.set(e.stretch, { ordinal: e.payload?.ordinal, duty: e.payload?.duty, model: e.payload?.target?.model, targetId: e.payload?.target?.id });
    }
  }
  const rows = new Map();
  for (const e of events) {
    if (e.kind !== "usage") continue;
    if (!rows.has(e.stretch)) rows.set(e.stretch, []);
    rows.get(e.stretch).push(e.payload);
  }
  for (const id of order) {
    const m = meta.get(id) ?? {};
    const agg = aggregateUsageRows(rows.get(id) ?? []);
    const model = Object.keys(agg.byModel ?? {})[0] ?? m.model;
    const cost = priceUsage(agg.usage, { model }).usd;
    const first = (rows.get(id) ?? []).find((x) => x.source === "assistant" || x.source === "codex-rollout");
    const fu = first ? normalizeUsageRow(first) : null;
    stretches.push({
      run: `A-${r.run}`, ordinal: m.ordinal, duty: m.duty, model, target: m.targetId,
      requests: agg.apiCalls,
      inputTokens: agg.usage.inputTokens, outputTokens: agg.usage.outputTokens,
      cacheReadTokens: agg.usage.cacheReadTokens,
      cacheWriteTokens: agg.usage.cacheWrite5mTokens + agg.usage.cacheWrite1hTokens,
      costUsd: cost,
      firstCallPrefix: fu ? fu.inputTokens + fu.cacheWrite5mTokens + fu.cacheWrite1hTokens + fu.cacheReadTokens : null,
    });
  }
}
const costPerStretch = stats(stretches.map((s) => s.costUsd).filter((x) => typeof x === "number"));
const byDuty = {};
for (const s of stretches) {
  byDuty[s.duty] ??= [];
  if (typeof s.costUsd === "number") byDuty[s.duty].push(s.costUsd);
}
const perDuty = Object.fromEntries(Object.entries(byDuty).map(([d, xs]) => [d, stats(xs)]));

// ── the extra cycles in runs 3 and 4 ──────────────────────────────────────
// A positional diff is misleading: one inserted stretch shifts everything after
// it. What the 6-stretch run "did not have" is a MULTISET difference - which
// duties occur more times - and the extra occurrences are the later ones.
const seqOf = (run) => stretches.filter((s) => s.run === run);
const countBy = (rows) => rows.reduce((m, r) => (m[r.duty] = (m[r.duty] ?? 0) + 1, m), {});
const base = seqOf("A-2");
const baseCount = countBy(base);
const extra = {
  baseline: { run: "A-2", sequence: base.map((s) => s.duty), counts: baseCount },
  runs: [],
};
for (const rn of [3, 4]) {
  const rows = seqOf(`A-${rn}`);
  const counts = countBy(rows);
  const duties = [...new Set([...Object.keys(counts), ...Object.keys(baseCount)])];
  const surplus = {}; const missing = {};
  for (const dty of duties) {
    const diff = (counts[dty] ?? 0) - (baseCount[dty] ?? 0);
    if (diff > 0) surplus[dty] = diff;
    if (diff < 0) missing[dty] = -diff;
  }
  // The extra occurrences of a duty are its LAST `diff` occurrences.
  const extraStretches = [];
  for (const [dty, diff] of Object.entries(surplus)) {
    const occurrences = rows.filter((s) => s.duty === dty);
    extraStretches.push(...occurrences.slice(occurrences.length - diff));
  }
  extraStretches.sort((a, b) => a.ordinal - b.ordinal);

  const r = A.find((x) => x.run === rn);
  const store = openConversation(r.conversationId, { role: "bench" });
  const { events } = store.range({ fromIndex: 0, limit: 500_000 });
  const detailed = extraStretches.map((st) => {
    const startIdx = events.findIndex((e) => e.kind === "stretch-started" && e.payload?.ordinal === st.ordinal);
    let precededBy = null;
    for (let i = startIdx - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.kind === "policy-rewrite") {
        precededBy = { kind: "policy-rewrite", seq: e.seq, payload: e.payload };
        break;
      }
      if (e.kind === "handoff") {
        precededBy = { kind: "handoff", seq: e.seq, duty: e.payload?.duty, status: e.payload?.status,
          next: e.payload?.nextSteps?.next, why: e.payload?.nextSteps?.why,
          summary: String(e.payload?.summary ?? "").slice(0, 900) };
        break;
      }
    }
    return { ordinal: st.ordinal, duty: st.duty, model: st.model, requests: st.requests, costUsd: st.costUsd, precededBy };
  });
  extra.runs.push({ run: `A-${rn}`, sequence: rows.map((s) => s.duty), counts, surplus, missing,
    extraStretches: detailed,
    extraCostUsd: detailed.reduce((a, b) => a + (b.costUsd ?? 0), 0),
    extraRequests: detailed.reduce((a, b) => a + b.requests, 0) });
}

// ── cold-start tax ────────────────────────────────────────────────────────
const coldStart = [...A, ...B].map((r) => {
  let firstCost = null;
  let firstUsage = null;
  if (r.arm === "A") {
    const store = openConversation(r.conversationId, { role: "bench" });
    const { events } = store.range({ fromIndex: 0, limit: 500_000 });
    const f = events.find((e) => e.kind === "usage" && (e.payload.source === "assistant" || e.payload.source === "codex-rollout"));
    if (f) { firstUsage = normalizeUsageRow(f.payload); firstCost = priceUsage(firstUsage, { model: f.payload.model }).usd; }
  } else {
    const rows = fs.readFileSync(path.join(RUNS, `armB-${r.run}.proxy.jsonl`), "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const f = rows.find((x) => x.usage);
    if (f) {
      firstUsage = normalizeUsageRow({ usage: f.usage });
      firstCost = priceUsage(firstUsage, { model: f.model }).usd;
    }
  }
  return {
    run: `${r.arm}-${r.run}`, cacheState: r.cacheState,
    cacheWriteTokens: r.cacheWriteTokens, cacheReadTokens: r.cacheReadTokens,
    writeToReadRatio: r.cacheReadTokens ? r.cacheWriteTokens / r.cacheReadTokens : null,
    firstRequest: firstUsage ? {
      inputTokens: firstUsage.inputTokens, cacheWriteTokens: firstUsage.cacheWrite5mTokens + firstUsage.cacheWrite1hTokens,
      cacheReadTokens: firstUsage.cacheReadTokens,
      prefixTokens: firstUsage.inputTokens + firstUsage.cacheWrite5mTokens + firstUsage.cacheWrite1hTokens + firstUsage.cacheReadTokens,
      costUsd: firstCost,
    } : null,
  };
});

// ── decomposition tax ─────────────────────────────────────────────────────
const decomposition = [...A, ...B].map((r) => ({
  run: `${r.arm}-${r.run}`, arm: r.arm, stretches: r.stretches,
  apiRequests: r.apiRequests, assistantTurns: r.assistantTurns,
  toolCalls: r.toolCalls, toolSearches: r.toolSearches,
  toolCallsPerStretch: r.stretches ? r.toolCalls / r.stretches : null,
  requestsPerStretch: r.stretches ? r.apiRequests / r.stretches : null,
  turnsPerRequest: r.apiRequests ? r.assistantTurns / r.apiRequests : null,
}));

const out = { perModel, armAShare, stretches, costPerStretch, perDuty, extra, coldStart, decomposition,
  perRunCvReference: { armA: { cost: 0.263, requests: 0.281 }, armB: { cost: 0.081, requests: 0.100 } } };
fs.writeFileSync(path.join(HOME, "bench", "reanalysis.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log("wrote ~/bench/reanalysis.json");
console.log(`stretches: ${stretches.length}, cost/stretch median $${costPerStretch.median.toFixed(4)} CV ${(costPerStretch.cv * 100).toFixed(1)}%`);
console.log(`Arm A share — sonnet ${armAShare.sonnet.requests} req $${armAShare.sonnet.costUsd.toFixed(4)}, haiku ${armAShare.haiku.requests} req $${armAShare.haiku.costUsd.toFixed(4)}, other ${armAShare.other.requests} req $${armAShare.other.costUsd.toFixed(4)}`);
