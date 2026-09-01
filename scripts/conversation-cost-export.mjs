#!/usr/bin/env node
// conversation-cost-export.mjs — one JSON object describing what a piece of work
// cost, for either side of a comparison.
//
//   --conversation <id>            a Garrison conversation, from its L3 ledger
//   --claude-session <session-id>  a plain Claude Code session, from its transcript
//   --transcript <path>            ... or point straight at the JSONL
//
// Both sides price through the SAME function (priceUsage over
// data/model-rates.json). That is the whole point: a benchmark whose two sides
// are priced by two code paths measures the code paths.
//
// The transcript parser exists because Claude Code records usage in a shape that
// punishes the obvious reading. Three rules, each measured rather than assumed:
//
//   1. ONE RECORD PER CONTENT BLOCK, each repeating the full usage. Summing
//      records over-counts ~2.5x (measured: 3998 assistant records, 2009 unique
//      message ids, 3,765,442 naive output tokens against 1,487,720 real).
//      Group by message.id.
//   2. TAKE THE PER-FIELD MAX within a group, not the first record. Subagent
//      transcripts write partial snapshots (output_tokens 1, 1, 251 for one
//      message); first-wins undercounts a subagent file 14x, and filtering on a
//      terminal stop_reason drops the 38-of-43 messages that never get one.
//   3. RECURSE INTO SUBAGENTS. `<enc-cwd>/<session>/subagents/**/agent-*.jsonl`
//      is 39% of transcript bytes and, on a measured session, 55% of the spend.
//      A `projects/*/*.jsonl` glob silently reports the parent only.
//
// What this CANNOT see, and says so rather than quietly absorbing: a compaction
// emits no usage record at all, so its full-context input call is missing from
// any transcript-derived total. `compactions` is reported so the reader can
// judge how much is missing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  priceUsage,
  resolveModelRate,
  normalizeUsageRow,
  aggregateUsageRows,
  emptyUsage,
  addUsage,
  normalizeAnthropicUsage,
  loadModelRates,
  openConversation,
  computeConversationMetrics,
} from "@garrison/claude-pty";

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { runLabel: "", taskId: "", pretty: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--conversation") out.conversation = next();
    else if (a === "--claude-session") out.claudeSession = next();
    else if (a === "--transcript") out.transcript = next();
    else if (a === "--cwd") out.cwd = next();
    else if (a === "--run-label") out.runLabel = next();
    else if (a === "--task-id") out.taskId = next();
    else if (a === "--compact") out.pretty = false;
    else if (a === "--percall") out.percall = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
  }
  return out;
}

const USAGE_TEXT = `conversation-cost-export — one cost object per run

  node scripts/conversation-cost-export.mjs --conversation <id> [--run-label L] [--task-id T]
  node scripts/conversation-cost-export.mjs --claude-session <session-id> [--cwd <dir>]
  node scripts/conversation-cost-export.mjs --transcript <path/to/session.jsonl>

  --compact   one-line JSON instead of indented
  --percall   also print the per-call rows and the worked arithmetic that
              reproduces the total, with cache writes split by TTL (a 1h write
              is 2x base input, a 5m write 1.25x - printing one rate for both
              is how a published hand-check fails to reproduce its own total)
`;

// ── the Garrison side ───────────────────────────────────────────────────────

function exportConversation(id, { runLabel, taskId, env = process.env }) {
  const store = openConversation(id, { role: "cost-export", env });
  const { events } = store.range({ fromIndex: 0, limit: 200_000 });
  if (!events.length) throw new Error(`conversation ${id} has no events`);
  const metrics = computeConversationMetrics(events, {});

  const times = events.map((e) => Date.parse(e.ts)).filter((n) => Number.isFinite(n));
  const wall = times.length ? (Math.max(...times) - Math.min(...times)) / 1000 : 0;

  // Garrison compacts by construction: a stretch is a fresh session that boots
  // from an L1 summary, so there is no in-session compaction to count. What IS
  // countable is the summary being trimmed for size, which is the same pressure
  // showing up in a different place.
  const compactions = events.filter((e) => e.kind === "summary-trimmed").length;

  const stretches = metrics.perStretch.map((s) => ({
    duty: s.duty ?? "",
    model: s.observedModel ?? s.model ?? "",
    effort: s.effort ?? "",
    api_calls: s.apiCalls ?? 0,
    input_tokens: s.usage?.inputTokens ?? 0,
    output_tokens: s.usage?.outputTokens ?? 0,
    cache_write_tokens: (s.usage?.cacheWrite5mTokens ?? 0) + (s.usage?.cacheWrite1hTokens ?? 0),
    cache_read_tokens: s.usage?.cacheReadTokens ?? 0,
    cost_usd: s.cost?.exact ? s.cost.usd : null,
  }));

  // The per-call rows, straight off the ledger, so --percall prints the actual
  // record rather than a reconstruction. `result` rows are the settled total for
  // a stretch and are the ones the totals come from; assistant rows are the
  // per-call record and would double-count if summed alongside them.
  const percall = [];
  for (const e of events) {
    if (e.kind !== "usage") continue;
    const p = e.payload ?? {};
    percall.push({
      stretch: e.stretch ?? null,
      duty: e.duty ?? null,
      source: p.source ?? "",
      model: p.model ?? null,
      callId: p.callId ?? null,
      usage: normalizeUsageRow(p),
      // The raw row, kept so the working below can run the SAME aggregator the
      // exported total came from rather than a second, divergent summation.
      raw: p,
    });
  }

  const u = metrics.usage ?? emptyUsage();
  return {
    _percall: percall,
    run_label: runLabel,
    side: "garrison",
    task_id: taskId,
    source: "sdk-stream",
    wall_clock_seconds: Math.round(wall),
    api_calls: metrics.apiCalls ?? 0,
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_write_tokens: u.cacheWrite5mTokens + u.cacheWrite1hTokens,
    cache_read_tokens: u.cacheReadTokens,
    total_cost_usd: metrics.totalCostUsd ?? 0,
    compactions,
    stretches,
    _meta: {
      conversation_id: id,
      unpriced_stretches: metrics.unpricedStretches ?? 0,
      sdk_reported_cost_usd: metrics.sdkCostUsd ?? null,
      cache_read_share: metrics.cacheReadShare ?? 0,
      rates_updated: loadModelRates(env).rates_updated ?? null,
      by_model: Object.fromEntries(
        Object.entries(metrics.byModel ?? {}).map(([m, v]) => [m, { api_calls: v.apiCalls, usd: v.usd }])
      ),
    },
  };
}

// ── the Claude Code side ────────────────────────────────────────────────────

export function claudeProjectsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"), "projects");
}

/** cwd → project directory name. Lossy and NOT invertible: every non-alphanumeric
 *  becomes a dash, so `a-b`, `a_b` and `a.b` collide. Only ever used forwards. */
export function encodeCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

/** The main transcript plus every nested subagent transcript. Missing the nested
 *  tier under-reports a measured session by 55%. */
export function findTranscripts(sessionId, { env = process.env, cwd = null } = {}) {
  const root = claudeProjectsDir(env);
  const dirs = cwd ? [path.join(root, encodeCwd(cwd))] : safeReaddir(root).map((d) => path.join(root, d));
  const files = [];
  for (const dir of dirs) {
    const main = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(main)) files.push(main);
    const subRoot = path.join(dir, sessionId, "subagents");
    if (fs.existsSync(subRoot)) files.push(...walkJsonl(subRoot));
  }
  return files;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function walkJsonl(dir) {
  const out = [];
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkJsonl(full));
    else if (entry.endsWith(".jsonl") && entry !== "journal.jsonl") out.push(full);
  }
  return out;
}

function* records(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      yield JSON.parse(t);
    } catch {
      /* a torn final line */
    }
  }
}

const MAX_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
];

/**
 * Parse a set of transcript files into deduped per-API-call usage rows.
 * Grouped by message.id; per-field MAX within a group; `<synthetic>` dropped.
 */
export function parseTranscripts(files) {
  const byId = new Map();
  let compactions = 0;
  let first = Infinity;
  let last = -Infinity;
  let sawAssistant = 0;

  for (const file of files) {
    for (const rec of records(file)) {
      const ts = Date.parse(rec?.timestamp ?? "");
      if (Number.isFinite(ts)) {
        if (ts < first) first = ts;
        if (ts > last) last = ts;
      }
      // A compaction emits no usage record; only its metadata marks it.
      if (rec?.compactMetadata || rec?.isCompactSummary === true || rec?.subtype === "compact_boundary") {
        compactions += 1;
      }
      if (rec?.type !== "assistant") continue;
      const msg = rec.message;
      if (!msg || typeof msg !== "object") continue;
      if (msg.model === "<synthetic>") continue;
      const usage = msg.usage;
      if (!usage || typeof usage !== "object") continue;
      sawAssistant += 1;
      const id = msg.id ?? rec.requestId ?? rec.uuid;
      if (!id) continue;
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, { id, model: msg.model ?? null, usage: { ...usage } });
        continue;
      }
      // Per-field MAX: a later record for the same message can carry a larger
      // partial (subagent lanes stream them) or be byte-identical (main lanes).
      for (const f of MAX_FIELDS) {
        const a = Number(prev.usage[f] ?? 0);
        const b = Number(usage[f] ?? 0);
        if (Number.isFinite(b) && b > (Number.isFinite(a) ? a : 0)) prev.usage[f] = b;
      }
      const prevCc = prev.usage.cache_creation ?? {};
      const curCc = usage.cache_creation ?? {};
      const cc = { ...prevCc };
      for (const f of ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]) {
        const a = Number(cc[f] ?? 0);
        const b = Number(curCc[f] ?? 0);
        if (Number.isFinite(b) && b > (Number.isFinite(a) ? a : 0)) cc[f] = b;
      }
      if (Object.keys(cc).length) prev.usage.cache_creation = cc;
      if (Array.isArray(usage.iterations) && usage.iterations.length > (prev.usage.iterations?.length ?? 0)) {
        prev.usage.iterations = usage.iterations;
      }
      if (!prev.model && msg.model) prev.model = msg.model;
    }
  }

  // One row per API call. A fallback retry records BOTH attempts in
  // `iterations[]` while the top-level usage reflects only the last one, so a
  // multi-iteration message is expanded element-wise — otherwise the failed
  // attempt's tokens (a measured 253k cache read in one case) vanish.
  const rows = [];
  for (const entry of byId.values()) {
    const iters = Array.isArray(entry.usage.iterations) ? entry.usage.iterations : [];
    if (iters.length > 1) {
      for (const it of iters) rows.push({ id: entry.id, model: it.model ?? entry.model, usage: it });
    } else {
      rows.push({ id: entry.id, model: entry.model, usage: entry.usage });
    }
  }
  return {
    rows,
    compactions,
    assistantRecords: sawAssistant,
    wallSeconds: Number.isFinite(first) && Number.isFinite(last) && last > first ? (last - first) / 1000 : 0,
  };
}

function exportClaudeSession({ sessionId, transcript, cwd, runLabel, taskId, env = process.env }) {
  const files = transcript ? [transcript] : findTranscripts(sessionId, { env, cwd });
  if (!files.length) throw new Error(`no transcript found for session ${sessionId}`);
  const parsed = parseTranscripts(files);
  if (!parsed.rows.length) throw new Error(`transcript for ${sessionId} carries no usage`);

  let usage = emptyUsage();
  let cost = 0;
  const unpriced = [];
  const byModel = {};
  for (const row of parsed.rows) {
    const u = normalizeAnthropicUsage(row.usage);
    usage = addUsage(usage, u);
    const priced = priceUsage(u, { model: row.model, env });
    const key = row.model ?? "(unreported)";
    (byModel[key] ??= { api_calls: 0, usd: 0, unpriced: false });
    byModel[key].api_calls += 1;
    if (priced.unpriced) {
      byModel[key].unpriced = true;
      if (!unpriced.includes(key)) unpriced.push(key);
    } else {
      cost += priced.usd;
      byModel[key].usd += priced.usd;
    }
  }

  return {
    _percall: parsed.rows.map((r) => ({
      source: "transcript", model: r.model, callId: r.id, usage: normalizeAnthropicUsage(r.usage),
      // Same reason as the conversation side: the working runs the shared
      // aggregator over the raw rows, not a second summation of its own.
      raw: { source: "transcript", model: r.model, usage: r.usage },
    })),
    run_label: runLabel,
    side: "claude-code",
    task_id: taskId,
    source: "jsonl-transcript",
    wall_clock_seconds: Math.round(parsed.wallSeconds),
    api_calls: parsed.rows.length,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_write_tokens: usage.cacheWrite5mTokens + usage.cacheWrite1hTokens,
    cache_read_tokens: usage.cacheReadTokens,
    total_cost_usd: cost,
    compactions: parsed.compactions,
    // A plain Claude Code session is one stretch by construction: one model, one
    // context, start to finish. The array shape is kept so both sides parse the
    // same, and so the difference in shape is visible rather than argued.
    stretches: [
      {
        duty: "",
        model: Object.keys(byModel)[0] ?? "",
        effort: "",
        api_calls: parsed.rows.length,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_write_tokens: usage.cacheWrite5mTokens + usage.cacheWrite1hTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cost_usd: unpriced.length ? null : cost,
      },
    ],
    _meta: {
      session_id: sessionId ?? null,
      transcript_files: files,
      transcript_count: files.length,
      assistant_records: parsed.assistantRecords,
      deduped_api_calls: parsed.rows.length,
      unpriced_models: unpriced,
      rates_updated: loadModelRates(env).rates_updated ?? null,
      by_model: byModel,
    },
  };
}

// ── per-call rows + the arithmetic that reproduces the total ────────────────
//
// The round-one report printed a hand-check that did not reproduce its own
// total: it applied the 5-minute cache-write rate to writes that were actually
// 1-hour writes (2x base input, not 1.25x). The total was right and the printed
// working was wrong, which is the worst combination - a reader checking the
// arithmetic concludes the number is wrong. So the working is no longer typed
// by hand: it is printed here, per token class, from the same rate table and
// the same rows the total came from.

function renderPerCall(out, rows) {
  const rates = loadModelRates();
  const lines = [];
  lines.push("");
  lines.push("per-call usage rows (cache writes split by TTL):");
  lines.push("(a stretch's `result` row is its settled TOTAL; the `assistant` rows above it are");
  lines.push(" the per-call record of the same tokens. Summing both would double-count, so the");
  lines.push(" arithmetic below runs the same aggregateUsageRows the exported total came from.)");
  lines.push(
    ["model", "src", "input", "output", "cw5m", "cw1h", "cacheRead"]
      .map((h, i) => (i === 0 ? h.padEnd(28) : i === 1 ? h.padEnd(14) : h.padStart(10)))
      .join(" ")
  );
  let tot = emptyUsage();
  const byModel = new Map();
  for (const r of rows) {
    lines.push(
      [String(r.model ?? "?").slice(0, 28).padEnd(28), String(r.source ?? "").padEnd(14),
       String(r.usage.inputTokens).padStart(10), String(r.usage.outputTokens).padStart(10),
       String(r.usage.cacheWrite5mTokens).padStart(10), String(r.usage.cacheWrite1hTokens).padStart(10),
       String(r.usage.cacheReadTokens).padStart(10)].join(" ")
    );
  }
  // Per-stretch aggregation, then per-model, using the SAME rule the total used.
  const byStretch = new Map();
  for (const r of rows) {
    const k = r.stretch ?? "(single)";
    if (!byStretch.has(k)) byStretch.set(k, []);
    byStretch.get(k).push(r);
  }
  for (const list of byStretch.values()) {
    const agg = aggregateUsageRows(list.map((r) => r.raw ?? r));
    for (const [model, entry] of Object.entries(agg.byModel ?? {})) {
      byModel.set(model, addUsage(byModel.get(model) ?? emptyUsage(), entry.usage));
      tot = addUsage(tot, entry.usage);
    }
    if (!agg.byModel || !Object.keys(agg.byModel).length) {
      // No aggregator opinion (the transcript side has no source/model rows in
      // its vocabulary): the normalized per-call rows ARE the record.
      for (const r of list) {
        const m = r.model ?? "?";
        byModel.set(m, addUsage(byModel.get(m) ?? emptyUsage(), r.usage));
        tot = addUsage(tot, r.usage);
      }
    }
  }
  lines.push(
    ["TOTAL".padEnd(28), "".padEnd(14), String(tot.inputTokens).padStart(10),
     String(tot.outputTokens).padStart(10), String(tot.cacheWrite5mTokens).padStart(10),
     String(tot.cacheWrite1hTokens).padStart(10), String(tot.cacheReadTokens).padStart(10)].join(" ")
  );
  lines.push("");
  lines.push("worked arithmetic, per model, at the rates in data/model-rates.json:");
  let grand = 0;
  for (const [model, u] of byModel) {
    const { rate, resolved } = resolveModelRate(model, rates);
    if (!rate) { lines.push(`  ${model}: UNPRICED (no rate for this model)`); continue; }
    const terms = [
      ["input", u.inputTokens, rate.input],
      ["output", u.outputTokens, rate.output],
      ["cacheWrite5m", u.cacheWrite5mTokens, rate.cacheWrite5m],
      ["cacheWrite1h", u.cacheWrite1hTokens, rate.cacheWrite1h],
      ["cacheRead", u.cacheReadTokens, rate.cacheRead],
    ].filter(([, n]) => n > 0);
    const usd = priceUsage(u, { model, rates }).usd ?? 0;
    grand += usd;
    lines.push(`  ${model}${resolved && resolved !== model ? ` (priced as ${resolved})` : ""}`);
    for (const [name, n, r] of terms) {
      lines.push(`    ${name.padEnd(13)} ${String(n).padStart(10)} x $${String(r).padEnd(6)} / 1e6 = ${(n * r / 1e6).toFixed(7)}`);
    }
    lines.push(`    ${"subtotal".padEnd(13)} ${" ".repeat(10)}                    $${usd.toFixed(7)}`);
  }
  lines.push(`  TOTAL $${grand.toFixed(7)}   (reported total_cost_usd: ${out.total_cost_usd})`);
  lines.push("");
  return lines.join("\n");
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.conversation && !args.claudeSession && !args.transcript)) {
    process.stdout.write(USAGE_TEXT);
    process.exit(args.help ? 0 : 2);
  }
  const out = args.conversation
    ? exportConversation(args.conversation, { runLabel: args.runLabel, taskId: args.taskId })
    : exportClaudeSession({
        sessionId: args.claudeSession,
        transcript: args.transcript,
        cwd: args.cwd,
        runLabel: args.runLabel,
        taskId: args.taskId,
      });
  // The rows are working material for --percall, not part of the exported
  // object the brief specified - that shape is fixed and must not grow a field.
  const percall = out._percall ?? [];
  delete out._percall;
  process.stdout.write(`${JSON.stringify(out, null, args.pretty ? 2 : 0)}\n`);
  if (args.percall) process.stdout.write(renderPerCall(out, percall));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { exportConversation, exportClaudeSession };
