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
  it("the compiled discipline names the Garrison verb-skills at the right tiers", () => {
    const section = compileRouting(SEED, "balanced");
    // T1/T2 testing → garrison-testing; review → code-review (+design-audit at T2);
    // T2 evidence(video) → run-garrison; T2 distribution(link) → garrison-governance.
    expect(section).toContain("garrison-testing");
    expect(section).toContain("code-review");
    expect(section).toContain("garrison-design-audit");
    expect(section).toContain("run-garrison");
    expect(section).toContain("garrison-governance");
  });

  it("T0-trivial escalates no skills (everything 'none')", () => {
    const section = compileRouting(SEED, "balanced");
    // target the DISCIPLINE line specifically (tier-definitions + the matrix header
    // also mention T0-trivial) — it's the one carrying "review:".
    const t0 = section.split("\n").find((l) => l.includes("T0-trivial") && l.includes("review:"));
    expect(t0).toBeTruthy();
    expect(t0).toContain("testing: none");
    expect(t0).not.toContain("garrison-testing");
  });

  it("the orchestrator prompt explains how to satisfy discipline via the skills + /goal", () => {
    expect(PROMPT).toContain("Satisfying discipline");
    expect(PROMPT).toContain("garrison-planning");
    expect(PROMPT).toContain("garrison-testing");
    expect(PROMPT).toContain("garrison-governance");
    expect(PROMPT).toContain("/goal");
    expect(PROMPT).toContain("FLOW_PLAN.md");
  });
});
