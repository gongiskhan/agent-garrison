import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — pure .mjs core typed by routing-core.d.mts
import { compileRouting } from "../fittings/seed/model-router/lib/routing-core.mjs";

const ROOT = join(__dirname, "..");
const SEED = JSON.parse(
  readFileSync(join(ROOT, "fittings/seed/model-router/config/routing.seed.json"), "utf8")
);
const PROMPT = readFileSync(
  join(ROOT, "fittings/seed/model-router/.apm/prompts/model-router.prompt.md"),
  "utf8"
);

describe("discipline → verb-skill mapping (s4 / deliverable #1)", () => {
  it("the compiled discipline names the Garrison verb-skills at the right tiers (per-tier, not just present)", () => {
    const section = compileRouting(SEED, "balanced");
    const line = (tier: string) =>
      section.split("\n").find((l) => l.includes(tier) && l.includes("review:")) ?? "";
    const t1 = line("T1-standard");
    const t2 = line("T2-deep");
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
    // GARRISON-UNIFY-V1 S1: the annotation derives from the phase-skill REGISTRY
    // (policy phaseSkills.bindings, D3), not hardcoded names — swapping a binding
    // in the composer changes these lines with zero code changes.
    // T1-standard: self-review → the bound review skill, tests → the bound test
    // skill. NO UI design audit at standard tier (deep UI review only).
    expect(t1).toContain(SEED.phaseSkills.bindings.review);
    expect(t1).toContain(SEED.phaseSkills.bindings.test);
    expect(t1).not.toContain(SEED.phaseSkills.bindings["design-audit"]);
    // T2-deep: review-by → bound review (design-audit CONDITIONAL on UI),
    // full-gates → bound test, video → bound walkthrough, link → bound validate.
    expect(t2).toContain(SEED.phaseSkills.bindings.review);
    expect(t2).toContain(SEED.phaseSkills.bindings["design-audit"]);
    expect(t2).toContain("for UI changes"); // conditional, not a blanket second gate
    expect(t2).toContain(SEED.phaseSkills.bindings.test);
    expect(t2).toContain(SEED.phaseSkills.bindings.walkthrough);
    expect(t2).toContain(SEED.phaseSkills.bindings.validate);
  });

  it("T0-trivial escalates no skills (everything 'none')", () => {
    const section = compileRouting(SEED, "balanced");
    // target the DISCIPLINE line specifically (tier-definitions + the matrix header
    // also mention T0-trivial) — it's the one carrying "review:".
    const t0 = section.split("\n").find((l) => l.includes("T0-trivial") && l.includes("review:"));
    expect(t0).toBeTruthy();
    expect(t0).toContain("testing: none");
    expect(t0).not.toContain("autothing-test");
  });

  it("the orchestrator prompt explains how to satisfy discipline via the skills + /goal", () => {
    expect(PROMPT).toContain("Satisfying discipline");
    expect(PROMPT).toContain("autothing-plan");
    expect(PROMPT).toContain("autothing-test");
    expect(PROMPT).toContain("autothing-validate");
    expect(PROMPT).toContain("/goal");
    expect(PROMPT).toContain("FLOW_PLAN.md");
  });
});
