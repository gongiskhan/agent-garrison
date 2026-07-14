import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs
import { decideCompaction, initialCompactState, resolveCompactConfig, createCompactController, COOLDOWN_TURNS, DEFAULT_THRESHOLD_PCT } from "../fittings/seed/http-gateway/scripts/lib/compact-controller.mjs";
// @ts-ignore — pure .mjs
import { renderFocusTemplate, focusDigest, DEFAULT_FOCUS_TEMPLATE } from "../fittings/seed/http-gateway/scripts/lib/compact-focus-template.mjs";

// S1b — the Garrison compact controller: pure decision matrix, config resolution,
// focus-template render, and the effectful controller (injected deps).

describe("compact controller — resolveCompactConfig", () => {
  it("applies defaults when the env is empty", () => {
    const cfg = resolveCompactConfig({});
    expect(cfg["claude-code"]).toEqual({ enabled: true, thresholdPct: DEFAULT_THRESHOLD_PCT, focusTemplate: DEFAULT_FOCUS_TEMPLATE });
    // every runtime is fully defaulted
    for (const rt of ["claude-code", "agent-sdk", "openai-agents", "codex", "opencode"]) {
      expect(cfg[rt].enabled).toBe(true);
      expect(cfg[rt].thresholdPct).toBe(60);
    }
  });

  it("honors the global scalar overrides", () => {
    const cfg = resolveCompactConfig({
      GARRISON_COMPACT_ENABLED: "false",
      GARRISON_COMPACT_THRESHOLD_PCT: "75",
      GARRISON_COMPACT_FOCUS_TEMPLATE: "custom {{card_id}}",
    });
    expect(cfg["claude-code"]).toEqual({ enabled: false, thresholdPct: 75, focusTemplate: "custom {{card_id}}" });
  });

  it("lets a per-runtime override map win over the globals", () => {
    const cfg = resolveCompactConfig({
      GARRISON_COMPACT_ENABLED: "true",
      GARRISON_COMPACT_THRESHOLD_PCT: "60",
      GARRISON_COMPACT_CONFIG: JSON.stringify({ "agent-sdk": { enabled: false, threshold_pct: 80, focus_template: "x {{duty}}" } }),
    });
    expect(cfg["agent-sdk"]).toEqual({ enabled: false, thresholdPct: 80, focusTemplate: "x {{duty}}" });
    // untouched runtimes keep the globals
    expect(cfg["claude-code"].enabled).toBe(true);
    expect(cfg["claude-code"].thresholdPct).toBe(60);
  });

  it("ignores an out-of-range threshold and a malformed override map", () => {
    const cfg = resolveCompactConfig({ GARRISON_COMPACT_THRESHOLD_PCT: "999", GARRISON_COMPACT_CONFIG: "{not json" });
    expect(cfg["claude-code"].thresholdPct).toBe(60);
  });
});

describe("compact controller — renderFocusTemplate / focusDigest", () => {
  it("substitutes every line when the context is full", () => {
    const text = renderFocusTemplate(DEFAULT_FOCUS_TEMPLATE, {
      card_id: "C1",
      card_title: "Add login",
      duty: "implement",
      level: 2,
      decisions: "chose JWT",
      open_items: "wire logout",
      files_touched: "auth.ts",
      steering: "keep it small",
    });
    expect(text).toContain("Active card: C1 - Add login");
    expect(text).toContain("Current duty: implement (level 2)");
    expect(text).toContain("Decisions made so far: chose JWT");
    expect(text).toContain("keep it small");
    expect(text).not.toContain("{{");
  });

  it("drops the card/duty lines cleanly for an empty context (generic variant)", () => {
    const text = renderFocusTemplate(DEFAULT_FOCUS_TEMPLATE, {});
    expect(text).not.toContain("Active card:");
    expect(text).not.toContain("Current duty:");
    expect(text).not.toContain("{{");
    // the preamble + the final preserve instruction survive
    expect(text).toContain("Compaction focus");
    expect(text).toContain("Do NOT drop the card id/title");
  });

  it("focusDigest collapses to a single line and caps length", () => {
    const d = focusDigest("line one\n\nline two   with   spaces");
    expect(d).toBe("line one line two with spaces");
    expect(focusDigest("x".repeat(2000)).length).toBe(800);
  });
});

describe("compact controller — decideCompaction matrix", () => {
  const base = { thresholdPct: 60, enabled: true, hold: false, compactionCount: 0, turnCount: 5 };

  it("compacts when at/over threshold, enabled, armed, cooldown clear, no hold", () => {
    const r = decideCompaction({ ...initialCompactState(), turnCount: 5 }, { ...base, usagePct: 70 });
    expect(r.action).toBe("compact");
    expect(r.nextState.armed).toBe(false);
    expect(r.nextState.lastCompactTurn).toBe(5);
  });

  it("does nothing (and re-arms) below threshold", () => {
    const r = decideCompaction({ ...initialCompactState(), armed: false, turnCount: 5 }, { ...base, usagePct: 30 });
    expect(r.action).toBe("none");
    expect(r.nextState.armed).toBe(true);
  });

  it("defers when a hold is active", () => {
    const r = decideCompaction({ ...initialCompactState(), turnCount: 5 }, { ...base, usagePct: 90, hold: true });
    expect(r.action).toBe("deferred");
  });

  it("skips (cooldown) when not armed", () => {
    const r = decideCompaction({ ...initialCompactState(), armed: false, turnCount: 20 }, { ...base, usagePct: 90 });
    expect(r.action).toBe("skipped-cooldown");
  });

  it("skips (cooldown) within COOLDOWN_TURNS of the last compaction", () => {
    const r = decideCompaction({ ...initialCompactState(), armed: true, lastCompactTurn: 4, turnCount: 5 }, { ...base, usagePct: 90, turnCount: 5 });
    expect(5 - 4).toBeLessThan(COOLDOWN_TURNS);
    expect(r.action).toBe("skipped-cooldown");
  });

  it("treats a NEW transcript compaction as the compaction (skipped-native) and resets cooldown", () => {
    const r = decideCompaction({ ...initialCompactState(), lastCompactionCount: 0, turnCount: 5 }, { ...base, usagePct: 90, compactionCount: 1 });
    expect(r.action).toBe("skipped-native");
    expect(r.nextState.lastCompactionCount).toBe(1);
    expect(r.nextState.armed).toBe(false);
  });

  it("does nothing when disabled or when usage is unknown", () => {
    expect(decideCompaction(initialCompactState(), { ...base, usagePct: 90, enabled: false }).action).toBe("none");
    expect(decideCompaction(initialCompactState(), { ...base, usagePct: null }).action).toBe("none");
  });
});

// A controller harness with injected effects; the test drives usage + compaction
// count and inspects the logged decision records.
function makeHarness(configOverride: any = {}) {
  const logs: any[] = [];
  let usage = { contextPct: 0, contextTokens: 0 };
  let compactions = { count: 0, last: null as any };
  let injected = 0;
  const ctrl = createCompactController({
    resolveConfig: () => ({ "claude-code": { enabled: true, thresholdPct: 60, focusTemplate: DEFAULT_FOCUS_TEMPLATE, ...configOverride } }),
    now: () => "2026-07-14T00:00:00Z",
    sampleUsage: async () => usage,
    readCompactions: async () => compactions,
    injectCompact: async () => {
      injected += 1;
      // A real /compact writes a new transcript compact_boundary.
      compactions = { count: compactions.count + 1, last: { preTokens: 900, postTokens: 20, trigger: "manual" } };
    },
    logDecision: async (r: any) => logs.push(r),
  });
  return {
    ctrl,
    logs,
    setUsage: (contextPct: number) => (usage = { contextPct, contextTokens: contextPct * 1000 }),
    setCompactions: (count: number) => (compactions = { count, last: null }),
    injectedCount: () => injected,
  };
}

describe("compact controller — createCompactController.check (effectful)", () => {
  it("compacts at a turn boundary when over threshold, logging before/after", async () => {
    const h = makeHarness();
    h.setUsage(72);
    const { action, record } = await h.ctrl.check({ boundary: "turn" });
    expect(action).toBe("compact");
    expect(h.injectedCount()).toBe(1);
    expect(record.kind).toBe("compacted");
    expect(record.beforePct).toBe(72);
    expect(h.logs).toHaveLength(1);
  });

  it("defers at a turn boundary when the duty holds, but compacts at the duty boundary (holds discharge)", async () => {
    const held = makeHarness();
    held.setUsage(80);
    const deferred = await held.ctrl.check({ boundary: "turn", hold: true });
    expect(deferred.action).toBe("deferred");
    expect(held.injectedCount()).toBe(0);

    const discharged = makeHarness();
    discharged.setUsage(80);
    const duty = await discharged.ctrl.check({ boundary: "duty", hold: true });
    expect(duty.action).toBe("compact"); // a duty boundary ignores the hold
    expect(discharged.injectedCount()).toBe(1);
  });

  it("holds a 3-turn cooldown after compacting", async () => {
    const h = makeHarness();
    h.setUsage(75);
    const first = await h.ctrl.check({ boundary: "turn" });
    expect(first.action).toBe("compact");
    // usage still high on the very next turn -> cooldown skip (not a second compaction)
    const second = await h.ctrl.check({ boundary: "turn" });
    expect(second.action).toBe("skipped-cooldown");
    expect(h.injectedCount()).toBe(1);
  });

  it("re-arms after usage drops below threshold and the cooldown clears", async () => {
    const h = makeHarness();
    h.setUsage(75);
    expect((await h.ctrl.check({ boundary: "turn" })).action).toBe("compact"); // turn 1
    h.setUsage(20);
    expect((await h.ctrl.check({ boundary: "turn" })).action).toBe("none"); // turn 2, re-arms
    h.setUsage(75);
    // turns 3 and 4: the 3-turn cooldown (since turn 1) clears on turn 4
    const t3 = await h.ctrl.check({ boundary: "turn" });
    const t4 = await h.ctrl.check({ boundary: "turn" });
    expect(t3.action).toBe("skipped-cooldown");
    expect(t4.action).toBe("compact");
    expect(h.injectedCount()).toBe(2);
  });

  it("skips its own cycle when a native compaction already landed", async () => {
    const h = makeHarness();
    h.setUsage(90);
    h.setCompactions(2); // a native auto-compact fired since the last check
    const { action, record } = await h.ctrl.check({ boundary: "turn" });
    expect(action).toBe("skipped-native");
    expect(record.kind).toBe("skipped-native");
    expect(h.injectedCount()).toBe(0);
  });

  it("no-ops below threshold and logs nothing", async () => {
    const h = makeHarness();
    h.setUsage(40);
    const { action, record } = await h.ctrl.check({ boundary: "turn" });
    expect(action).toBe("none");
    expect(record).toBeNull();
    expect(h.logs).toHaveLength(0);
  });

  it("does nothing when disabled", async () => {
    const h = makeHarness({ enabled: false });
    h.setUsage(90);
    expect((await h.ctrl.check({ boundary: "turn" })).action).toBe("none");
    expect(h.injectedCount()).toBe(0);
  });
});
