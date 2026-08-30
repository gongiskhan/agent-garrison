#!/usr/bin/env node
// One measurement record per run, in the same shape for both arms.
//
// Arm A reads the conversation ledger, whose `usage` rows are the provider's
// own blocks captured per API call at the runtime adapter. Arm B reads the
// measurement proxy, which captures the provider's own blocks off the wire.
// Both are priced by the SAME priceUsage over data/model-rates.json, and the
// proxy was checked against the CLI's own total_cost_usd before the campaign.
//
//   usage: collect.mjs armA <n> | collect.mjs armB <n>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  priceUsage, emptyUsage, addUsage, normalizeUsageRow, normalizeAnthropicUsage,
  aggregateUsageRows, loadModelRates, openConversation,
} from "/home/ggomes/dev/garrison/packages/claude-pty/src/index.mjs";

const arm = process.argv[2];
const n = process.argv[3];
const RUNS = path.join(os.homedir(), "bench", "runs");
const read = (p, d = null) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return d; } };

function priceByModel(byModel) {
  let usd = 0;
  const unpriced = [];
  for (const [model, u] of Object.entries(byModel)) {
    const p = priceUsage(u, { model });
    if (p.usd == null) unpriced.push(model); else usd += p.usd;
  }
  return { usd, unpriced };
}

function collectArmA(n) {
  const run = JSON.parse(read(path.join(RUNS, `armA-${n}.run.json`), "{}"));
  const store = openConversation(run.conversationId, { role: "bench" });
  const { events } = store.range({ fromIndex: 0, limit: 500_000 });

  const byStretch = new Map();
  for (const e of events) {
    if (e.kind !== "usage") continue;
    const k = e.stretch ?? "(none)";
    if (!byStretch.has(k)) byStretch.set(k, []);
    byStretch.get(k).push(e.payload);
  }
  const byModel = {};
  const callsByModel = {};
  let apiRequests = 0;
  let firstCacheRead = null;
  for (const rows of byStretch.values()) {
    const agg = aggregateUsageRows(rows);
    apiRequests += agg.apiCalls;
    for (const [m, entry] of Object.entries(agg.byModel ?? {})) {
      byModel[m] = addUsage(byModel[m] ?? emptyUsage(), entry.usage);
      callsByModel[m] = (callsByModel[m] ?? 0) + entry.apiCalls;
    }
    const first = rows.find((r) => r.source === "assistant" || r.source === "codex-rollout");
    if (firstCacheRead === null && first) {
      const u = normalizeUsageRow(first);
      firstCacheRead = u.cacheReadTokens;
    }
  }
  let total = emptyUsage();
  for (const u of Object.values(byModel)) total = addUsage(total, u);

  let assistantTurns = 0;
  const toolCalls = {};
  let toolSearches = 0;
  let sawServerToolUse = false;
  const seenMsg = new Set();
  for (const e of events) {
    if (e.kind !== "session-event") continue;
    const p = e.payload ?? {};
    if (p.role === "assistant" && p.id && !seenMsg.has(p.id)) { seenMsg.add(p.id); assistantTurns += 1; }
    for (const b of p.blocks ?? []) {
      if (b?.type === "tool_use") {
        const name = b.name ?? "?";
        if (String(name).includes("tool_search")) toolSearches += 1;
        else toolCalls[name] = (toolCalls[name] ?? 0) + 1;
      } else if (b?.type === "server_tool_use") { toolSearches += 1; sawServerToolUse = true; }
    }
  }
  const stretches = events.filter((e) => e.kind === "stretch-started").length;
  const { usd, unpriced } = priceByModel(byModel);
  return {
    arm: "A", run: Number(n), conversationId: run.conversationId,
    dir: path.join(os.homedir(), "dev", `armA-${n}`),
    startCommand: "npm install && npm start",
    measuredFrom: "conversation ledger (per-API-call usage events)",
    started: run.started, ended: run.ended, wallClockSeconds: run.seconds,
    costUsd: usd, unpricedModels: unpriced,
    inputTokens: total.inputTokens, outputTokens: total.outputTokens,
    cacheReadTokens: total.cacheReadTokens,
    cacheWriteTokens: total.cacheWrite5mTokens + total.cacheWrite1hTokens,
    apiRequests, assistantTurns,
    toolCalls: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    toolCallsByName: toolCalls,
    // The ledger renders tool_use blocks; it does not carry the server-side
    // `server_tool_use` block a tool search produces. A zero here would be a
    // claim the instrument cannot make, so it reports null unless one was seen.
    toolSearches: sawServerToolUse ? toolSearches : null,
    toolSearchesNote: sawServerToolUse ? null : "not visible in the conversation ledger; Arm A tool-search counts are unavailable from this instrument",
    stretches,
    requestsByModel: callsByModel,
    firstRequestCacheRead: firstCacheRead,
    cacheState: firstCacheRead > 0 ? "warm" : "cold",
    ratesUpdated: loadModelRates().rates_updated,
  };
}

function collectArmB(n) {
  const base = path.join(RUNS, `armB-${n}`);
  const rows = read(`${base}.proxy.jsonl`, "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const priced = rows.filter((r) => r.usage);
  const byModel = {};
  const callsByModel = {};
  const toolCalls = {};
  let toolSearches = 0;
  for (const r of priced) {
    const m = r.model ?? "unknown";
    byModel[m] = addUsage(byModel[m] ?? emptyUsage(), normalizeAnthropicUsage(r.usage));
    callsByModel[m] = (callsByModel[m] ?? 0) + 1;
    for (const b of r.blocks ?? []) {
      if (typeof b !== "string") continue;
      if (b.startsWith("server_tool_use:") || b.includes("tool_search")) toolSearches += 1;
      else if (b.startsWith("tool_use:")) {
        const name = b.slice("tool_use:".length);
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
      }
    }
  }
  let total = emptyUsage();
  for (const u of Object.values(byModel)) total = addUsage(total, u);
  const { usd, unpriced } = priceByModel(byModel);
  const cliRaw = read(`${base}.result.json`, "");
  let cli = null;
  try { cli = JSON.parse(cliRaw); } catch { /* the CLI may have failed */ }
  const firstRead = priced.length ? (priced[0].usage.cache_read_input_tokens ?? 0) : null;
  return {
    arm: "B", run: Number(n), sessionId: cli?.session_id ?? null,
    dir: path.join(os.homedir(), "dev", `armB-${n}`),
    startCommand: "npm install && npm start",
    measuredFrom: "measurement proxy (per-request usage off the wire)",
    started: read(`${base}.start`), ended: read(`${base}.end`),
    wallClockSeconds: Number(read(`${base}.seconds`, "0")),
    costUsd: usd, unpricedModels: unpriced,
    inputTokens: total.inputTokens, outputTokens: total.outputTokens,
    cacheReadTokens: total.cacheReadTokens,
    cacheWriteTokens: total.cacheWrite5mTokens + total.cacheWrite1hTokens,
    apiRequests: priced.length, assistantTurns: priced.length,
    toolCalls: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    toolCallsByName: toolCalls, toolSearches,
    stretches: 1,
    requestsByModel: callsByModel,
    firstRequestCacheRead: firstRead,
    cacheState: firstRead > 0 ? "warm" : "cold",
    // The CLI's own figure, as an independent check on the proxy.
    cliReportedCostUsd: cli?.total_cost_usd ?? null,
    cliNumTurns: cli?.num_turns ?? null,
    cliIsError: cli?.is_error ?? null,
    ratesUpdated: loadModelRates().rates_updated,
  };
}

const record = arm === "A" || arm === "armA" ? collectArmA(n) : collectArmB(n);
const out = path.join(RUNS, `${record.arm === "A" ? "armA" : "armB"}-${n}.measure.json`);
fs.writeFileSync(out, `${JSON.stringify(record, null, 1)}\n`);
console.log(JSON.stringify(record, null, 1));
