import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — pure .mjs core typed by routing-core.d.mts
import { compilePolicy } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

// GARRISON-FLOW-V2 S4 / D13: the `security-review` phase is a bindable,
// opt-in phase. It must exist as a phase + binding + matrix cell, be absent
// from every phase plan and work kind (off by default), and be gated by the
// per-project `projects.<label>.security_sensitive` flag.

const ROOT = join(__dirname, "..");
const SEED = JSON.parse(
  readFileSync(join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json"), "utf8")
);
const PROMPT = readFileSync(
  join(ROOT, "fittings/seed/orchestrator/.apm/prompts/orchestrator.prompt.md"),
  "utf8"
);

describe("security opt-in (S4 / D13)", () => {
  const policy = compilePolicy(SEED, "balanced");

  it("security-review is a bindable phase pointing at autothing-security-review", () => {
    expect(policy.phases).toContain("security-review");
    expect(policy.phaseSkills.bindings["security-review"]).toBe("autothing-security-review");
  });

  it("security-review has a matrix cell mirroring adversarial-review's target", () => {
    for (const tier of policy.tiers) {
      const sec = policy.matrix["security-review"][tier];
      const adv = policy.matrix["adversarial-review"][tier];
      expect(sec).toBeTruthy();
      expect(sec.targetId).toBe(adv.targetId);
      expect(sec.targetId).toBe("cc-fable-xhigh");
    }
  });

  it("security-review is OFF by default — in no phase plan and no work kind", () => {
    for (const [, plan] of Object.entries<any>(policy.phasePlans)) {
      const ids = (plan.phases || []).map((p: any) => (typeof p === "string" ? p : p.id));
      expect(ids).not.toContain("security-review");
    }
    // work kinds only name a phasePlan; none should resolve to a plan carrying it
    for (const [, wk] of Object.entries<any>(policy.workKinds)) {
      const ids = (policy.phasePlans[wk.phasePlan]?.phases || []).map((p: any) =>
        typeof p === "string" ? p : p.id
      );
      expect(ids).not.toContain("security-review");
    }
  });

  it("the projects section gates security by label; agent-garrison is NOT security-sensitive", () => {
    expect(policy.projects).toBeTruthy();
    expect(policy.projects["agent-garrison"]).toBeTruthy();
    expect(policy.projects["agent-garrison"].security_sensitive).toBe(false);
    // a non-security-sensitive project carries no forced security phase
    expect(policy.projects["agent-garrison"].profile).toBeTruthy();
  });

  it("the orchestrator prompt instructs never to auto-select security phases", () => {
    expect(PROMPT).toMatch(/security[- ]review is opt-in/i);
    expect(PROMPT).toContain("projects.<label>.security_sensitive");
  });

  it("compilePolicy is byte-stable across the projects/security additions", () => {
    const a = JSON.stringify(compilePolicy(SEED, "balanced"));
    const b = JSON.stringify(compilePolicy(SEED, "balanced"));
    expect(a).toBe(b);
  });
});
