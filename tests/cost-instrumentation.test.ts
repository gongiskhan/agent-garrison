// Cost instrumentation: the rules that are easy to get wrong and expensive to
// get wrong silently. Every number asserted here was measured against real
// provider output on this machine before it was written down.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-ignore — pure .mjs package module
import { priceUsage, resolveModelRate, aggregateUsageRows, normalizeAnthropicUsage, normalizeCodexUsage, loadModelRates, clearModelRatesCache, openConversation, conversationMetrics } from "../packages/claude-pty/src/index.mjs";
// @ts-ignore — pure .mjs
import { rolloutUsageRows, findRolloutFiles } from "../fittings/seed/codex-runtime/lib/codex-adapter.mjs";
// @ts-ignore — pure .mjs
import { parseTranscripts, encodeCwd } from "../scripts/conversation-cost-export.mjs";

let tmp: string;
let env: Record<string, string>;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cost-"));
  env = { ...process.env, GARRISON_HOME: tmp } as Record<string, string>;
  clearModelRatesCache();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  clearModelRatesCache();
});

describe("the rate table", () => {
  it("carries a rates_updated date so stale prices are visible", () => {
    const rates = loadModelRates(env);
    expect(rates.error).toBeNull();
    expect(rates.rates_updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("prices each token class separately at published list rates", () => {
    // Anthropic's published multipliers: output 5x input, cache read 0.1x,
    // 5m write 1.25x, 1h write 2x. Opus 5 input is $5/Mtok.
    const p = priceUsage(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
      },
      { model: "claude-opus-5", env }
    );
    expect(p.usd).toBeCloseTo(5.0, 9);
    const cacheRead = priceUsage(
      { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 1_000_000 },
      { model: "claude-opus-5", env }
    );
    expect(cacheRead.usd).toBeCloseTo(0.5, 9);
  });

  it("an unknown model is unpriced, never zero", () => {
    const p = priceUsage({ inputTokens: 1000, outputTokens: 1000 } as never, { model: "qwen2.5:3b", env });
    expect(p.usd).toBeNull();
    expect(p.unpriced).toBe(true);
  });
});

describe("provider usage → the common shape", () => {
  it("keeps the Anthropic cache TTL split when the provider reports one", () => {
    const u = normalizeAnthropicUsage({
      input_tokens: 2,
      output_tokens: 303,
      cache_creation_input_tokens: 46530,
      cache_read_input_tokens: 23422,
      cache_creation: { ephemeral_1h_input_tokens: 46530, ephemeral_5m_input_tokens: 0 },
    });
    expect(u.cacheWrite1hTokens).toBe(46530);
    expect(u.cacheWrite5mTokens).toBe(0);
    expect(u.ttlSplit).toBe(true);
  });

  it("attributes an unsplit cache write to the 5m class and says the split was absent", () => {
    const u = normalizeAnthropicUsage({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 900 });
    expect(u.cacheWrite5mTokens).toBe(900);
    expect(u.ttlSplit).toBe(false);
  });

  it("treats codex cached_input_tokens as a SUBSET of input_tokens", () => {
    // Verbatim from a live `codex exec --json` turn.completed on this machine.
    const u = normalizeCodexUsage({
      input_tokens: 15452,
      cached_input_tokens: 11008,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    });
    expect(u.inputTokens).toBe(4444); // 15452 - 11008, not 15452
    expect(u.cacheReadTokens).toBe(11008);
    expect(u.outputTokens).toBe(5);
  });
});

describe("aggregating usage rows", () => {
  it("never sums the result envelope alongside the per-call rows", () => {
    // result.usage describes the SAME tokens the assistant rows already carry,
    // and it is the settled one: an assistant envelope is emitted mid-stream, so
    // its output_tokens is a partial snapshot. Measured live: three assistant
    // rows summed to 20 output tokens against a settled 624, with input and both
    // cache classes matching exactly. The envelope is the total; the assistant
    // rows are the per-call record.
    const agg = aggregateUsageRows([
      { source: "assistant", callId: "a1", model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 20 } },
      { source: "result", callId: "r1", model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 624 }, sdkCostUsd: 0.5 },
    ]);
    expect(agg.basis).toBe("result");
    expect(agg.usage.outputTokens).toBe(624); // the settled figure, not 20 and not 644
    expect(agg.usage.inputTokens).toBe(10); // counted once
    expect(agg.apiCalls).toBe(1); // the per-call record still says one call
    expect(agg.sdkCostUsd).toBe(0.5); // still available as a cross-check
  });

  it("attributes by the envelope's modelUsage, so a subagent bills at its own rate", () => {
    const agg = aggregateUsageRows([
      {
        source: "result",
        callId: "r1",
        model: "claude-sonnet-5",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900 },
        modelUsage: {
          "claude-sonnet-5": { inputTokens: 90, outputTokens: 40, cacheReadInputTokens: 800, cacheCreationInputTokens: 0 },
          "claude-haiku-4-5": { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 },
        },
      },
    ]);
    expect(Object.keys(agg.byModel).sort()).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
    expect(agg.byModel["claude-haiku-4-5"].usage.outputTokens).toBe(10);
  });

  it("falls back to the result envelope when no per-call row was seen", () => {
    const agg = aggregateUsageRows([
      { source: "result", callId: "r1", model: "claude-opus-5", usage: { input_tokens: 7, output_tokens: 9 } },
    ]);
    expect(agg.basis).toBe("result");
    expect(agg.usage.outputTokens).toBe(9);
  });

  it("prices each model at its own rate rather than blending", () => {
    const agg = aggregateUsageRows([
      { source: "assistant", callId: "a1", model: "claude-opus-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } },
      { source: "assistant", callId: "a2", model: "claude-haiku-4-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    ]);
    expect(Object.keys(agg.byModel).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
    expect(agg.byModel["claude-opus-5"].usage.inputTokens).toBe(1_000_000);
  });
});

describe("the conversation ledger", () => {
  it("prices a stretch exactly from its usage events", () => {
    const store = openConversation("c1", { role: "test", env });
    store.append({
      kind: "stretch-started",
      duty: "implement",
      stretch: "s1",
      payload: { stretchId: "s1", duty: "implement", target: { model: "claude-opus-5", runtime: "agent-sdk" } },
    });
    store.append({
      kind: "usage",
      duty: "implement",
      stretch: "s1",
      payload: {
        stretchId: "s1",
        source: "assistant",
        callId: "a1",
        model: "claude-opus-5",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    });
    store.append({
      kind: "stretch-ended",
      duty: "implement",
      stretch: "s1",
      payload: { stretchId: "s1", outcome: "handoff", model: "claude-opus-5", apiCalls: 1, durationMs: 10 },
    });
    const m: any = conversationMetrics("c1", { env });
    expect(m.apiCalls).toBe(1);
    expect(m.totalCostUsd).toBeCloseTo(5.0, 9);
    expect(m.perStretch[0].cost.exact).toBe(true);
  });

  it("busts the metrics cache when the rate table changes", () => {
    const store = openConversation("c2", { role: "test", env });
    store.append({
      kind: "stretch-started",
      duty: "implement",
      stretch: "s1",
      payload: { stretchId: "s1", duty: "implement", target: { model: "claude-opus-5" } },
    });
    store.append({
      kind: "usage",
      duty: "implement",
      stretch: "s1",
      payload: { stretchId: "s1", source: "assistant", model: "claude-opus-5", usage: { input_tokens: 1_000_000 } },
    });
    store.append({
      kind: "stretch-ended",
      duty: "implement",
      stretch: "s1",
      payload: { stretchId: "s1", outcome: "handoff", model: "claude-opus-5", apiCalls: 1 },
    });
    const before: any = conversationMetrics("c2", { env });
    expect(before.totalCostUsd).toBeCloseTo(5.0, 9);

    // A price correction must re-price a finished conversation. The log's mtime
    // does not change, so an mtime-only cache key would serve the old number
    // forever — that was the bug this key fixes.
    mkdirSync(path.join(tmp, "conversations"), { recursive: true });
    writeFileSync(
      path.join(tmp, "conversations", "model-rates.json"),
      JSON.stringify({ models: { "claude-opus-5": { input: 50, output: 250, cacheWrite5m: 62.5, cacheWrite1h: 100, cacheRead: 5 } } })
    );
    clearModelRatesCache();
    const after: any = conversationMetrics("c2", { env });
    expect(after.totalCostUsd).toBeCloseTo(50.0, 9);
  });
});

describe("the Claude Code transcript parser", () => {
  const assistant = (id: string, model: string, usage: object, extra: object = {}) =>
    JSON.stringify({
      type: "assistant",
      uuid: `${id}-${Math.random()}`,
      timestamp: "2026-08-29T00:00:00.000Z",
      message: { id, model, usage },
      ...extra,
    });

  function transcript(lines: string[]): string {
    const file = path.join(tmp, `${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  }

  it("deduplicates the repeated per-content-block records", () => {
    // Claude Code writes one record per content block and repeats the full usage
    // on each. Summing records over-counts ~2.5x on a real session.
    const u = { input_tokens: 2, output_tokens: 303, cache_read_input_tokens: 100 };
    const file = transcript([
      assistant("msg_1", "claude-opus-5", u),
      assistant("msg_1", "claude-opus-5", u),
      assistant("msg_1", "claude-opus-5", u),
    ]);
    const parsed = parseTranscripts([file]);
    expect(parsed.assistantRecords).toBe(3);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].usage.output_tokens).toBe(303);
  });

  it("takes the per-field MAX, because subagent records are partial snapshots", () => {
    // Measured shape: the same message id streams output_tokens 1, 1, 251.
    // First-wins would report 1 and undercount the file 14x.
    const file = transcript([
      assistant("msg_2", "claude-opus-5", { input_tokens: 5, output_tokens: 1 }),
      assistant("msg_2", "claude-opus-5", { input_tokens: 5, output_tokens: 1 }),
      assistant("msg_2", "claude-opus-5", { input_tokens: 5, output_tokens: 251 }),
    ]);
    const parsed = parseTranscripts([file]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].usage.output_tokens).toBe(251);
  });

  it("drops <synthetic> records", () => {
    const file = transcript([
      assistant("msg_3", "claude-opus-5", { input_tokens: 1, output_tokens: 1 }),
      assistant("msg_4", "<synthetic>", { input_tokens: 0, output_tokens: 0 }),
    ]);
    expect(parseTranscripts([file]).rows).toHaveLength(1);
  });

  it("expands a fallback retry element-wise so the failed attempt is not lost", () => {
    // On a fallback the TOP-LEVEL usage reflects only the last iteration; the
    // refused attempt's tokens exist only inside iterations[].
    const file = transcript([
      assistant("msg_5", "claude-opus-5", {
        input_tokens: 0,
        output_tokens: 9507,
        cache_read_input_tokens: 204403,
        iterations: [
          { type: "message", model: "claude-fable-5", output_tokens: 2, cache_read_input_tokens: 253163 },
          { type: "fallback_message", model: "claude-opus-5", output_tokens: 9507, cache_read_input_tokens: 204403 },
        ],
      }),
    ]);
    const parsed = parseTranscripts([file]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.map((r: any) => r.model).sort()).toEqual(["claude-fable-5", "claude-opus-5"]);
  });

  it("counts compactions, which carry no usage record of their own", () => {
    const file = transcript([
      assistant("msg_6", "claude-opus-5", { input_tokens: 1, output_tokens: 1 }),
      JSON.stringify({ type: "user", isCompactSummary: true, timestamp: "2026-08-29T00:00:01.000Z" }),
    ]);
    expect(parseTranscripts([file]).compactions).toBe(1);
  });

  it("encodes a cwd the way Claude Code names its project directory", () => {
    expect(encodeCwd("/home/ggomes/dev/garrison")).toBe("-home-ggomes-dev-garrison");
    expect(encodeCwd("/home/ggomes/.garrison")).toBe("-home-ggomes--garrison");
  });
});

describe("the codex rollout reader", () => {
  it("derives per-call rows from monotone total_token_usage deltas", () => {
    // The CLI re-emits identical token_count records; summing last_token_usage
    // over-counts by a measured 22%. Deltas of the cumulative total do not.
    const day = path.join(tmp, "sessions", "2026", "08", "29");
    mkdirSync(day, { recursive: true });
    const id = "01a00000-0000-7000-8000-000000000001";
    const file = path.join(day, `rollout-2026-08-29T00-00-00-${id}.jsonl`);
    const tc = (total: number) =>
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
        },
      });
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session_meta", payload: { id, session_id: id, thread_source: "user" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
        tc(100),
        tc(100), // a duplicate contributes nothing
        tc(250),
      ].join("\n") + "\n"
    );
    const rows = rolloutUsageRows(file, { own: true });
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.usage.input_tokens)).toEqual([100, 150]);
    expect(rows[0].model).toBe("gpt-5.6-sol");
  });

  it("groups a parent thread with its subagent threads, and keeps them distinguishable", () => {
    // stdout reports the parent only. On a measured delegation that was a 2.74x
    // undercount, because three spawn_agent children burned 7.15M tokens the
    // parent's counter never saw.
    const day = path.join(tmp, "sessions", "2026", "08", "29");
    mkdirSync(day, { recursive: true });
    const parent = "01a00000-0000-7000-8000-00000000aaaa";
    const child = "01a00000-0000-7000-8000-00000000bbbb";
    const tc = (total: number) =>
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, output_tokens: 0 } } },
      });
    writeFileSync(
      path.join(day, `rollout-2026-08-29T00-00-00-${parent}.jsonl`),
      [JSON.stringify({ type: "session_meta", payload: { id: parent, session_id: parent, thread_source: "user" } }), tc(10)].join("\n") + "\n"
    );
    writeFileSync(
      path.join(day, `rollout-2026-08-29T00-00-05-${child}.jsonl`),
      [
        // A forked child replays the parent's session_meta first in real files;
        // the reader must key on the FIRST record, which is the child's own.
        JSON.stringify({ type: "session_meta", payload: { id: child, session_id: parent, thread_source: "subagent" } }),
        JSON.stringify({ type: "session_meta", payload: { id: parent, session_id: parent, thread_source: "user" } }),
        tc(70),
      ].join("\n") + "\n"
    );
    const files = findRolloutFiles(parent, { home: tmp });
    expect(files).toHaveLength(2);
    const rows = files.flatMap((f: any) => rolloutUsageRows(f.file, { own: f.own }));
    expect(rows.reduce((n: number, r: any) => n + r.usage.input_tokens, 0)).toBe(80);
    expect(rows.map((r: any) => r.threadSource).sort()).toEqual(["subagent", "user"]);
  });
});

// ── the exporter's printed working ──────────────────────────────────────────
// The round-one report published a hand-check that did not reproduce its own
// total: it applied the 5-minute cache-write rate to writes that were 1-hour
// writes. The total was right and the printed arithmetic was wrong, which is
// the worst combination. The working is now printed from the same rates and
// rows the total comes from, so the two cannot drift apart again.
describe("worked arithmetic", () => {
  it("prices a 1h cache write at 2x base input, not the 5m 1.25x", () => {
    const rates = loadModelRates();
    const { rate } = resolveModelRate("claude-opus-5", rates);
    expect(rate.cacheWrite1h).toBe(rate.input * 2);
    expect(rate.cacheWrite5m).toBe(rate.input * 1.25);
  });

  it("reproduces the round-one baseline total from its own token classes", () => {
    // The exact rows from bench/cost-2026-08-28/export-claude-code-run1.json.
    const usage = {
      inputTokens: 38, outputTokens: 19373,
      cacheWrite5mTokens: 0, cacheWrite1hTokens: 47900, cacheReadTokens: 771504,
    };
    const priced = priceUsage(usage, { model: "claude-opus-5" });
    expect(priced.usd).toBeCloseTo(1.349267, 6);
    // ... and the published 5m-rate version does NOT reproduce it, which is
    // exactly the defect this pins.
    const wrong = (38 * 5 + 19373 * 25 + 47900 * 6.25 + 771504 * 0.5) / 1e6;
    expect(wrong).not.toBeCloseTo(1.349267, 4);
  });
});
