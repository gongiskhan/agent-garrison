import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — pure .mjs core typed by routing-core.d.mts
import { compilePolicy, railFor } from "../fittings/seed/orchestrator/lib/routing-core.mjs";
// @ts-ignore — pure .mjs (policy heart): the alias table is not re-exported through routing-core
import { FLOW_ALIASES, adoptFlow } from "../fittings/seed/orchestrator/lib/policy-core.mjs";

// GARRISON-FLOW-V2 S5 / D14 + D15: the `design-audit` phase is retired and
// replaced by `ux-qa` (skill garrison-ux-qa). ux-qa must be a bindable phase +
// matrix cell mirroring the old design-audit target, and the policy must carry a
// top-level `uxQa.severityThreshold` (default `major`).
//
// 2026-08-09: the flow library was replaced. The old `ui-change` flow this file
// was written against is gone, and the flows that carry ux-qa are LEVELLED — a
// flow no longer names one phase plan, it names a duty list per level. So the
// question "does the UI-shaped flow run ux-qa" becomes "at WHICH LEVEL does a
// flow run ux-qa", which is the sharper question anyway: it is what decides
// whether a real card pays for a UX judgement.

const ROOT = join(__dirname, "..");
const SEED = JSON.parse(
  readFileSync(join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json"), "utf8")
);

function planPhaseIds(policy: any, planName: string): string[] {
  return (policy.phasePlans[planName]?.phases || []).map((p: any) => (typeof p === "string" ? p : p.id));
}

// routing-core.d.mts still types a flow as the pre-levels `{phasePlan}`, so the
// levelled shape is read through this view until the declaration catches up.
type LevelledFlow = { defaultLevel?: number; levels: Record<string, { duties: string[] }> };
const levelledFlows = (policy: unknown): Record<string, LevelledFlow> =>
  (policy as { flows: unknown }).flows as Record<string, LevelledFlow>;

// Every (flow, level) pair whose duty list runs `phase`, read off the library.
function levelsRunning(policy: unknown, phase: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [id, flow] of Object.entries(levelledFlows(policy))) {
    for (const [lvl, def] of Object.entries(flow.levels ?? {})) {
      if ((def.duties ?? []).includes(phase)) out.push([id, lvl]);
    }
  }
  return out;
}

const onPhases = (rail: { phases: { id: string; on: boolean }[] }) =>
  rail.phases.filter((p) => p.on).map((p) => p.id);

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

  it("the retired ui-change name adopts to `feature`, whose level-3 rail runs ux-qa under its skill", () => {
    // The name a live card may still carry resolves, and it resolves to the flow
    // that inherited the UI work — not to some default.
    expect(policy.flows["ui-change"]).toBeUndefined();
    expect(FLOW_ALIASES["ui-change"]).toBe("feature");
    expect(adoptFlow("ui-change")).toBe("feature");

    // The old `ui-change` plan promised implement → review → ux-qa → walkthrough
    // with video evidence. Level 3 of `feature` is that promise plus the
    // adversarial passes: every phase the old plan ran, it still runs.
    const rail = railFor(SEED, adoptFlow("ui-change"), null, 3);
    expect(rail.evidence).toBe("video");
    expect(onPhases(rail)).toEqual([
      "plan",
      "implement",
      "test",
      "review",
      "adversarial-review",
      "adversarial-test",
      "ux-qa",
      "walkthrough",
      "validate",
      "report"
    ]);
    for (const id of ["implement", "review", "ux-qa", "walkthrough"]) {
      expect(onPhases(rail), `level 3 dropped ${id}`).toContain(id);
    }
    // ux-qa in this rail is bound to its skill
    expect(rail.phases.find((p: { id: string }) => p.id === "ux-qa")?.skill).toBe("garrison-ux-qa");
  });

  it("ux-qa is never a default: it costs a level-3 escalation, in the three flows that render a surface", () => {
    // The old library answered this per-flow; the levelled one answers it per
    // (flow, level), and that is what a card actually resolves through. ux-qa
    // belongs where something is LOOKED AT — a feature, an image, a video — and
    // nowhere else. It also sits above every one of those flows' default level,
    // so no card pays for a UX judgement it did not ask for.
    expect(levelsRunning(policy, "ux-qa").sort()).toEqual([
      ["feature", "3"],
      ["image", "3"],
      ["video", "3"]
    ]);
    for (const [id, lvl] of levelsRunning(policy, "ux-qa")) {
      expect(Number(lvl), `${id} runs ux-qa at or below its default level`).toBeGreaterThan(
        Number(levelledFlows(policy)[id].defaultLevel)
      );
      expect(onPhases(railFor(SEED, id, null, lvl))).toContain("ux-qa");
    }
    // Prose, code-only and ops work never reach it at ANY level.
    for (const id of ["docs", "fix", "research", "chore", "task", "automation", "ops", "discussion", "qa-sweep"]) {
      for (const lvl of Object.keys(levelledFlows(policy)[id].levels)) {
        expect(onPhases(railFor(SEED, id, null, lvl)), `${id} L${lvl} runs ux-qa`).not.toContain("ux-qa");
      }
    }
    // The legacy `full` plan still carries it: a pre-levels composition that
    // never migrated resolves through phasePlans, and must not lose the phase.
    expect(planPhaseIds(policy, "full")).toContain("ux-qa");
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
