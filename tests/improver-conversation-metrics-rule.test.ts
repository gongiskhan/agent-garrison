// The improver's Conversations diet: thresholds fire, below-threshold writes
// nothing, and the plan's sentence holds — raise what always escalates, lower
// what never does.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";
// @ts-ignore — pure .mjs
import { runConversationMetricsRule, ESCALATION_RATE_HIGH, NEVER_ESCALATES_MIN_STRETCHES } from "../fittings/seed/improver/lib/conversation-metrics-rule.mjs";

let tmp: string;
let env: Record<string, string>;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "convrule-"));
  env = { GARRISON_HOME: tmp };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function stretch(store: any, { duty, chosenBy = "default" }: any) {
  const id = `s-${Math.random().toString(36).slice(2, 8)}`;
  store.append({ kind: "stretch-started", duty, stretch: id, payload: { stretchId: id, duty, chosenBy, target: { model: "sonnet", runtime: "agent-sdk" } } });
  store.append({ kind: "stretch-ended", duty, stretch: id, payload: { stretchId: id, outcome: "handoff", usedTokens: 1000 } });
}

describe("conversation-metrics rule", () => {
  it("below every threshold, proposes nothing", () => {
    const store = openConversation("quiet", { role: "gateway", env });
    stretch(store, { duty: "implement" });
    stretch(store, { duty: "review" });
    const res = runConversationMetricsRule({ env });
    expect(res.proposals).toHaveLength(0);
    expect(res.inputs.stretches).toBe(2);
  });

  it("a duty escalating above the rate threshold proposes RAISING its default", () => {
    const store = openConversation("hot", { role: "gateway", env });
    for (let i = 0; i < 4; i++) stretch(store, { duty: "implement", chosenBy: "escalation-tripwire" });
    for (let i = 0; i < 4; i++) stretch(store, { duty: "implement" });
    const res = runConversationMetricsRule({ env });
    const raise = res.proposals.find((p: any) => p.title.includes("Raise the implement"));
    expect(raise).toBeTruthy();
    expect(raise.evidence.escalationRate).toBeGreaterThanOrEqual(ESCALATION_RATE_HIGH);
    expect(raise.area).toBe("routing");
  });

  it("a duty with many stretches and zero escalations proposes LOWERING", () => {
    const store = openConversation("calm", { role: "gateway", env });
    for (let i = 0; i < NEVER_ESCALATES_MIN_STRETCHES; i++) stretch(store, { duty: "triage" });
    const res = runConversationMetricsRule({ env });
    const lower = res.proposals.find((p: any) => p.title.includes("lowering the triage"));
    expect(lower).toBeTruthy();
    expect(lower.area).toBe("cost");
  });

  it("repeated consecutive failures surface as a reliability proposal", () => {
    const store = openConversation("failing", { role: "gateway", env });
    for (const id of ["f1", "f2"]) {
      store.append({ kind: "stretch-started", duty: "implement", stretch: id, payload: { stretchId: id, duty: "implement", chosenBy: "default", target: { model: "sonnet" } } });
      store.append({ kind: "handoff", duty: "implement", stretch: id, payload: { stretchId: id, status: "failed", failedApproaches: [{ approach: "x", why: "y" }] } });
      store.append({ kind: "stretch-ended", duty: "implement", stretch: id, payload: { stretchId: id, outcome: "error", usedTokens: 100 } });
    }
    const res = runConversationMetricsRule({ env });
    expect(res.proposals.some((p: any) => p.area === "reliability")).toBe(true);
  });
});
