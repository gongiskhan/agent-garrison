// The level resolution chain: inherit -> pin -> escalation.
//
// The whole point is that the router turns ONE dial. Every assertion here is
// really about that: whatever else happens, a duty's level is a function of the
// flow level plus declared pins plus a logged, raise-only escalation.

import { beforeAll, describe, expect, it } from "vitest";
import { loadLevelCore } from "@/lib/level-resolution";

type Core = Awaited<ReturnType<typeof loadLevelCore>>;
let core: Core;
beforeAll(async () => {
  core = await loadLevelCore();
});

// A flow shaped like the real ones Phase 2 authors: level 2 wants a harder
// review than the rest of the work.
const FLOW = {
  description: "small change or fix",
  defaultLevel: 1,
  levels: {
    "1": { duties: ["implement", "test"], definitionOfDone: "green tests", evidence: "logs" },
    "2": { duties: ["implement", "test", "review"], pins: { review: 3 }, definitionOfDone: "reviewed", evidence: "logs" },
    "3": {
      duties: ["plan", "implement", "test", "review", "adversarial-review", "walkthrough"],
      definitionOfDone: "adversarially reviewed with video",
      evidence: "video"
    }
  }
};

describe("clampLevel — the absent-value guard", () => {
  it("treats an ABSENT level as absent, not as zero", () => {
    // Number(null) === 0 and Number("") === 0, not NaN. Without an explicit guard
    // an absent pin coerces to 0, clamps to 1, and every duty in every flow reads
    // as "pinned to level 1" — a silent downgrade of the entire library. This is
    // the single most dangerous failure this module can have.
    for (const absent of [null, undefined, "", false, true, {}, [], "banana", NaN]) {
      expect(core.clampLevel(absent as never), String(absent)).toBeNull();
    }
  });

  it("clamps real numbers into range", () => {
    expect([core.clampLevel(0), core.clampLevel(1), core.clampLevel(2.7), core.clampLevel(99)]).toEqual([
      1, 1, 2, 3
    ]);
  });
});

describe("resolveFlowLevel — the one dial", () => {
  it("uses the requested level", () => {
    expect(core.resolveFlowLevel(FLOW, 3)).toBe(3);
  });

  it("falls back to the flow's defaultLevel, then to 1 — never upward", () => {
    // Silently spending MORE compute than asked must be someone's decision.
    expect(core.resolveFlowLevel(FLOW, null)).toBe(1);
    expect(core.resolveFlowLevel({ levels: {} }, null)).toBe(1);
    expect(core.resolveFlowLevel({ defaultLevel: 2, levels: {} }, undefined)).toBe(2);
  });

  it("clamps nonsense into range instead of propagating it", () => {
    expect(core.resolveFlowLevel(FLOW, 99)).toBe(3);
    expect(core.resolveFlowLevel(FLOW, 0)).toBe(1);
    expect(core.resolveFlowLevel(FLOW, "banana")).toBe(1);
  });
});

describe("step 1 — inherit", () => {
  it("runs every duty at the flow level by default", () => {
    const plan = core.resolveFlowPlan(FLOW, 1);
    expect(plan.duties.map((d) => [d.duty, d.level, d.source])).toEqual([
      ["implement", 1, "inherit"],
      ["test", 1, "inherit"]
    ]);
  });

  it("carries the level's definition of done and evidence", () => {
    expect(core.resolveFlowPlan(FLOW, 3).definitionOfDone).toBe("adversarially reviewed with video");
    expect(core.resolveFlowPlan(FLOW, 3).evidence).toBe("video");
  });
});

describe("step 2 — pins declared in the flow definition", () => {
  it("applies a pin at the flow level that declares it", () => {
    const plan = core.resolveFlowPlan(FLOW, 2);
    expect(plan.duties.map((d) => [d.duty, d.level, d.source])).toEqual([
      ["implement", 2, "inherit"],
      ["test", 2, "inherit"],
      ["review", 3, "pin"]
    ]);
  });

  it("does not leak a pin to another flow level", () => {
    // The pin is declared under level 2 only; level 3 has none.
    const l3 = core.resolveFlowPlan(FLOW, 3).duties.find((d) => d.duty === "review");
    expect(l3).toMatchObject({ level: 3, source: "inherit", pinned: null });
  });

  it("reports a pin equal to the flow level as plain inheritance", () => {
    const flow = { levels: { "2": { duties: ["test"], pins: { test: 2 } } } };
    expect(core.resolveDutyLevel(flow, 2, "test")).toMatchObject({ level: 2, source: "inherit" });
  });
});

describe("step 3 — runtime escalation", () => {
  it("raises one duty and records where it came from", () => {
    const r = core.resolveDutyLevel(FLOW, 1, "test", { level: 3, reason: "touches auth" });
    expect(r).toMatchObject({
      level: 3,
      source: "escalation",
      inherited: 1,
      escalated: 3,
      reason: "touches auth"
    });
  });

  it("NEVER lowers a level, and says so rather than silently ignoring it", () => {
    // Escalation is fail-safe; de-escalation is not. A caller that believed it had
    // de-escalated and had not would ship unreviewed work thinking it chose to.
    const r = core.resolveDutyLevel(FLOW, 3, "implement", { level: 1, reason: "seems easy" });
    expect(r.level).toBe(3);
    expect(r.escalated).toBeNull();
    expect(r.rejected).toMatchObject({ requested: 1, keptAt: 3 });
  });

  it("cannot lower a level that a PIN raised either", () => {
    const r = core.resolveDutyLevel(FLOW, 2, "review", { level: 2, reason: "nah" });
    expect(r.level).toBe(3);
    expect(r.rejected).toMatchObject({ requested: 2, keptAt: 3 });
  });

  it("is per duty — it never moves the flow level or its siblings", () => {
    const plan = core.resolveFlowPlan(FLOW, 1, { test: { level: 3, reason: "flaky area" } });
    expect(plan.flowLevel).toBe(1);
    expect(plan.duties.map((d) => [d.duty, d.level])).toEqual([
      ["implement", 1],
      ["test", 3]
    ]);
  });
});

describe("escalateDuty — an unlogged escalation is a bug", () => {
  it("returns the decision-log record alongside the resolution", () => {
    const out = core.escalateDuty({
      flow: FLOW,
      flowLevel: 1,
      duty: "test",
      toLevel: 2,
      reason: "payment path",
      cardId: "card-1",
      at: "2026-08-09T12:00:00.000Z"
    });
    expect(out.applied).toBe(true);
    expect(out.record).toMatchObject({
      kind: "escalation",
      cardId: "card-1",
      duty: "test",
      flowLevel: 1,
      from: 1,
      to: 2,
      reason: "payment path",
      applied: true
    });
  });

  it("records a refused de-escalation instead of pretending it happened", () => {
    const out = core.escalateDuty({ flow: FLOW, flowLevel: 3, duty: "test", toLevel: 1, reason: "x" });
    expect(out.applied).toBe(false);
    expect(out.record).toMatchObject({ applied: false, from: 3, to: 3 });
    expect(out.record.rejected).toBeTruthy();
  });

  it("keeps a null reason visible rather than inventing one", () => {
    const out = core.escalateDuty({ flow: FLOW, flowLevel: 1, duty: "test", toLevel: 3 });
    expect(out.record.reason).toBeNull();
  });
});

describe("summariseEscalations — the loop that closes", () => {
  const rec = (duty: string, to: number, cardId: string, reason: string) => ({
    kind: "escalation", applied: true, flow: "small-fix", flowLevel: 1, duty, to, cardId, reason
  });

  it("groups by shape and flags a recurring one", () => {
    // A repeating escalation on the same shape is evidence the FLOW DEFINITION is
    // wrong, not evidence about any one card — that is what makes it worth a
    // proposal to promote it into a pin.
    const out = core.summariseEscalations(
      [
        rec("review", 3, "c1", "security surface"),
        rec("review", 3, "c2", "security surface"),
        rec("review", 3, "c3", "auth change"),
        rec("test", 2, "c4", "flaky")
      ],
      { threshold: 3 }
    );
    expect(out[0]).toMatchObject({ duty: "review", to: 3, count: 3, recurring: true });
    expect(out[0].reasons).toEqual(["security surface", "auth change"]);
    expect(out[1]).toMatchObject({ duty: "test", count: 1, recurring: false });
  });

  it("ignores refused escalations — a rejection is not a signal about the flow", () => {
    const out = core.summariseEscalations([{ ...rec("review", 3, "c1", "x"), applied: false }]);
    expect(out).toEqual([]);
  });

  it("survives junk records", () => {
    expect(core.summariseEscalations([null, undefined, {}, { kind: "route" }])).toEqual([]);
    expect(core.summariseEscalations(null as never)).toEqual([]);
  });
});

describe("dutiesForLevel", () => {
  it("returns the ordered duty list, and empty for an undefined level", () => {
    expect(core.dutiesForLevel(FLOW, 2)).toEqual(["implement", "test", "review"]);
    expect(core.dutiesForLevel(FLOW, 9)).toEqual([]);
    expect(core.dutiesForLevel(null, 1)).toEqual([]);
  });

  it("drops non-string entries rather than passing them to the router", () => {
    const junk = { levels: { "1": { duties: ["implement", null, 3, ""] as never } } };
    expect(core.dutiesForLevel(junk, 1)).toEqual([
      "implement"
    ]);
  });
});
