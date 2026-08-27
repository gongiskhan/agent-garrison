// Per-stretch instrumentation: unknown model is UNPRICED never zero, the
// repeated-failure metric needs CONSECUTIVE failures, the cache keys on log
// mtime, and rollups group honestly.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";
// @ts-ignore — pure .mjs
import { MODEL_COSTS, loadModelCosts, priceStretch, computeConversationMetrics, conversationMetrics, rollupMetrics } from "../packages/claude-pty/src/conversation-metrics.mjs";

let tmp: string;
let env: Record<string, string>;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "convmetrics-"));
  env = { GARRISON_HOME: tmp };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function stretch(store: any, { id, duty, model, chosenBy = "default", outcome = "handoff", usedTokens = 1000, status = "complete", failedApproaches = [] as any[] }: any) {
  store.append({ kind: "stretch-started", duty, stretch: id, payload: { stretchId: id, duty, chosenBy, target: { model, provider: "anthropic", runtime: "agent-sdk", effort: "high" } } });
  store.append({ kind: "handoff", duty, stretch: id, payload: { stretchId: id, status, failedApproaches, nextSteps: { next: "done" } } });
  store.append({ kind: "stretch-ended", duty, stretch: id, payload: { stretchId: id, outcome, usedTokens, durationMs: 1000 } });
}

// @ts-ignore — pure .mjs
import { priceStretch as __priceStretch } from "../packages/claude-pty/src/conversation-metrics.mjs";

describe("priceStretch — dated provider ids match their family rate", () => {
  it("prices claude-haiku-4-5-20251001 at the haiku family rate", () => {
    const out: any = __priceStretch({ model: "claude-haiku-4-5-20251001", usedTokens: 1_000_000 });
    expect(out.unpriced).toBe(false);
    expect(out.usdLow).toBeCloseTo(1.0);
    expect(out.usdHigh).toBeCloseTo(5.0);
  });
  it("an unknown family stays unpriced - never borrows a neighbour's rate", () => {
    const out: any = __priceStretch({ model: "gpt-9-experimental", usedTokens: 1000 });
    expect(out.unpriced).toBe(true);
  });
});

describe("priceStretch", () => {
  it("prices known models as a low/high band at list rates", () => {
    const p = priceStretch({ model: "claude-haiku-4-5", usedTokens: 1_000_000 });
    expect(p.unpriced).toBe(false);
    expect(p.usdLow).toBe(1.0);
    expect(p.usdHigh).toBe(5.0);
  });

  it("an unknown model is UNPRICED, never zero", () => {
    const p = priceStretch({ model: "gpt-5.6-sol", usedTokens: 500_000 });
    expect(p.unpriced).toBe(true);
    expect(p.usd).toBeNull();
    expect((p as any).usdLow).toBeUndefined();
  });

  it("no usage reported is unpriced too", () => {
    expect(priceStretch({ model: "opus", usedTokens: null as any }).unpriced).toBe(true);
  });

  it("the override file merges OVER the static map", () => {
    mkdirSync(path.join(tmp, "conversations"), { recursive: true });
    writeFileSync(path.join(tmp, "conversations", "model-costs.json"), JSON.stringify({
      "gpt-5.6-sol": { input: 2.0, output: 8.0, cacheRead: 0.2, cacheWrite: 2.5 },
      opus: { input: 6.0, output: 30.0, cacheRead: 0.6, cacheWrite: 7.5 },
    }));
    const costs = loadModelCosts(env);
    expect(costs["gpt-5.6-sol"].input).toBe(2.0);
    expect(costs.opus.input).toBe(6.0);
    expect(costs.sonnet.input).toBe(MODEL_COSTS.sonnet.input); // untouched
  });
});

describe("computeConversationMetrics", () => {
  it("joins started/ended/handoff by stretch and aggregates", () => {
    const store = openConversation("m1", { role: "gateway", env });
    stretch(store, { id: "s1", duty: "triage", model: "claude-haiku-4-5", chosenBy: "floor", usedTokens: 10_000 });
    stretch(store, { id: "s2", duty: "implement", model: "sonnet", usedTokens: 200_000 });
    stretch(store, { id: "s3", duty: "review", model: "gpt-5.6-sol", usedTokens: 50_000 });
    store.append({ kind: "dig", payload: { target: "payload", by: "human" } });
    store.append({ kind: "escalation", duty: "implement", payload: { from: "middle", to: "top", reason: "no-progress" } });
    const m = computeConversationMetrics(store.tail(100));
    expect(m.stretches).toBe(3);
    expect(m.totalUsedTokens).toBe(260_000);
    expect(m.unpricedStretches).toBe(1); // sol is unpriced
    expect(m.usdLow).toBeGreaterThan(0);
    expect(m.digs).toBe(1);
    expect(m.escalations).toHaveLength(1);
    expect(m.chosenByMix).toMatchObject({ floor: 1, default: 2 });
    expect(m.byDuty.implement.usedTokens).toBe(200_000);
  });

  it("repeatedFailure requires >=2 CONSECUTIVE failed stretches", () => {
    const store = openConversation("m2", { role: "gateway", env });
    stretch(store, { id: "a", duty: "implement", model: "sonnet", status: "partial", failedApproaches: [{ approach: "x", why: "y" }] });
    stretch(store, { id: "b", duty: "test", model: "sonnet" }); // clean between
    stretch(store, { id: "c", duty: "implement", model: "sonnet", status: "partial", failedApproaches: [{ approach: "x", why: "y" }] });
    expect(computeConversationMetrics(store.tail(100)).repeatedFailure).toBe(false);
    stretch(store, { id: "d", duty: "implement", model: "sonnet", status: "failed", failedApproaches: [{ approach: "x", why: "y" }] });
    const m = computeConversationMetrics(store.tail(100));
    expect(m.repeatedFailure).toBe(true);
    expect(m.maxConsecutiveFailed).toBe(2);
  });

  it("delegation yield counts dispatched/returned/failed", () => {
    const store = openConversation("m3", { role: "bridge", env });
    store.append({ kind: "delegation-dispatched", payload: { delegationId: "d1" } });
    store.append({ kind: "delegation-returned", payload: { delegationId: "d1", usedTokens: 9000 } });
    store.append({ kind: "delegation-dispatched", payload: { delegationId: "d2" } });
    store.append({ kind: "delegation-failed", payload: { delegationId: "d2", code: "empty-output" } });
    const m = computeConversationMetrics(store.tail(100));
    expect(m.delegations).toMatchObject({ dispatched: 2, returned: 1, failed: 1, usedTokens: 9000 });
  });
});

describe("conversationMetrics cache + rollup", () => {
  it("caches on log mtime and recomputes only when the log grows", () => {
    const store = openConversation("m4", { role: "gateway", env });
    stretch(store, { id: "s1", duty: "triage", model: "haiku" });
    const first = conversationMetrics("m4", { env });
    expect(first.stretches).toBe(1);
    // cached read
    const again = conversationMetrics("m4", { env });
    expect(again.stretches).toBe(1);
    // grow the log — recomputes
    stretch(store, { id: "s2", duty: "implement", model: "sonnet" });
    const grown = conversationMetrics("m4", { env });
    expect(grown.stretches).toBe(2);
  });

  it("rollup groups by duty and by model with honest unpriced counts", () => {
    const a = openConversation("r1", { role: "gateway", env });
    stretch(a, { id: "s1", duty: "implement", model: "sonnet", usedTokens: 100_000 });
    stretch(a, { id: "s2", duty: "review", model: "gpt-5.6-sol", usedTokens: 40_000, chosenBy: "escalation-forced" });
    const b = openConversation("r2", { role: "gateway", env });
    stretch(b, { id: "s3", duty: "implement", model: "opus", usedTokens: 300_000 });
    const byDuty = rollupMetrics({ env, groupBy: "duty" });
    expect(byDuty.totals.conversations).toBe(2);
    expect(byDuty.totals.stretches).toBe(3);
    expect(byDuty.groups.implement.stretches).toBe(2);
    expect(byDuty.groups.review.unpriced).toBe(1);
    expect(byDuty.groups.review.escalationRate).toBe(1);
    const byModel = rollupMetrics({ env, groupBy: "model" });
    expect(byModel.groups["gpt-5.6-sol"].unpriced).toBe(1);
    expect(byModel.groups.sonnet.usdLow).toBeGreaterThan(0);
  });
});
