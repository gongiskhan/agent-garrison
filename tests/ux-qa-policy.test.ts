import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — pure .mjs core typed by routing-core.d.mts
import { compilePolicy, railFor } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

// GARRISON-FLOW-V2 S5 / D14 + D15: the `design-audit` phase is retired and
// replaced by `ux-qa` (skill garrison-ux-qa). ux-qa must be a bindable phase +
// matrix cell mirroring the old design-audit target, live in the `full` plan and
// the new `ui-change` work kind, ABSENT from docs/api/video plans, and the
// policy must carry a top-level `uxQa.severityThreshold` (default `major`).

const ROOT = join(__dirname, "..");
const SEED = JSON.parse(
  readFileSync(join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json"), "utf8")
);

function planPhaseIds(policy: any, planName: string): string[] {
  return (policy.phasePlans[planName]?.phases || []).map((p: any) => (typeof p === "string" ? p : p.id));
}

describe("ux-qa phase (S5 / D14+D15)", () => {
  const policy = compilePolicy(SEED, "balanced");

  it("ux-qa is a bindable phase pointing at garrison-ux-qa; design-audit is gone", () => {
    expect(policy.phases).toContain("ux-qa");
    expect(policy.phases).not.toContain("design-audit");
    expect(policy.phaseSkills.bindings["ux-qa"]).toBe("garrison-ux-qa");
    expect(policy.phaseSkills.bindings["design-audit"]).toBeUndefined();
    expect(policy.taskTypes).toContain("ux-qa");
    expect(policy.taskTypes).not.toContain("design-audit");
    // no dangling matrix cell for the retired phase
    expect(policy.matrix["design-audit"]).toBeUndefined();
  });

  it("ux-qa's matrix cell mirrors the old design-audit target (cc-fable-xhigh) at every tier", () => {
    for (const tier of policy.tiers) {
      const cell = policy.matrix["ux-qa"][tier];
      expect(cell).toBeTruthy();
      expect(cell.targetId).toBe("cc-fable-xhigh");
      expect(cell.model).toBe("fable");
      expect(cell.effort).toBe("xhigh");
      // same target the review-family gates resolve to
      expect(cell.targetId).toBe(policy.matrix["adversarial-review"][tier].targetId);
    }
  });

  it("the ui-change work kind resolves to its 4-phase plan (implement, review, ux-qa, walkthrough)", () => {
    expect(policy.workKinds["ui-change"]).toBeTruthy();
    expect(policy.workKinds["ui-change"].phasePlan).toBe("ui-change");
    expect(planPhaseIds(policy, "ui-change")).toEqual(["implement", "review", "ux-qa", "walkthrough"]);
    // the rail's ON phases are exactly that plan (off phases stay visible)
    const rail = railFor(SEED, "ui-change");
    expect(rail.evidence).toBe("video");
    expect(rail.phases.filter((p: { on: boolean }) => p.on).map((p: { id: string }) => p.id)).toEqual([
      "implement",
      "review",
      "ux-qa",
      "walkthrough"
    ]);
    // ux-qa in this plan is bound to its skill
    expect(rail.phases.find((p: { id: string }) => p.id === "ux-qa")?.skill).toBe("garrison-ux-qa");
  });

  it("the full plan carries ux-qa; docs/api/video plans do NOT", () => {
    expect(planPhaseIds(policy, "full")).toContain("ux-qa");
    // full-feature keeps ux-qa via the full plan
    expect(planPhaseIds(policy, policy.workKinds["full-feature"].phasePlan)).toContain("ux-qa");
    for (const kind of ["docs-change", "api-change", "video-edit"]) {
      const plan = policy.workKinds[kind].phasePlan;
      expect(planPhaseIds(policy, plan), `${kind} → ${plan}`).not.toContain("ux-qa");
    }
  });

  it("the policy carries uxQa.severityThreshold defaulting to major", () => {
    expect(policy.uxQa).toBeTruthy();
    expect(policy.uxQa.severityThreshold).toBe("major");
    // a config that omits uxQa still compiles the default (robustness)
    const { uxQa, ...withoutUxQa } = SEED;
    const fallback = compilePolicy(withoutUxQa, "balanced");
    expect(fallback.uxQa.severityThreshold).toBe("major");
  });

  it("compilePolicy stays byte-stable across the ux-qa additions", () => {
    const a = JSON.stringify(compilePolicy(SEED, "balanced"));
    const b = JSON.stringify(compilePolicy(SEED, "balanced"));
    expect(a).toBe(b);
  });
});
