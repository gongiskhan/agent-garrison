import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — pure .mjs core typed by routing-core.d.mts
import { compilePolicy } from "../fittings/seed/orchestrator/lib/routing-core.mjs";
import { AUTHORED_SECTION_DEFAULTS } from "@/lib/orchestrator-authored-defaults";

// GARRISON-FLOW-V2 S4 / D13: the `security-review` phase is a bindable,
// opt-in phase. It must exist as a phase + binding + matrix cell, never run at
// a flow's default level (off by default), and be gated by the per-project
// `projects.<label>.security_sensitive` flag.

const ROOT = join(__dirname, "..");
const SEED = JSON.parse(
  readFileSync(join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json"), "utf8")
);
const PROMPT = AUTHORED_SECTION_DEFAULTS["execution-policy"].content;

describe("security opt-in (S4 / D13)", () => {
  const policy = compilePolicy(SEED, "balanced");

  it("security-review is a bindable phase pointing at garrison-security-review", () => {
    expect(policy.phases).toContain("security-review");
    expect(policy.phaseSkills.bindings["security-review"]).toBe("garrison-security-review");
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

  it("security-review is OFF by default — in no phase plan, and in no flow at its default level", () => {
    for (const [, plan] of Object.entries<any>(policy.phasePlans)) {
      const ids = (plan.phases || []).map((p: any) => (typeof p === "string" ? p : p.id));
      expect(ids).not.toContain("security-review");
    }
    // 2026-08-09: flows became levelled, so "in no flow" has to be asked per
    // level — the old form read `wk.phasePlan`, which no flow carries any more,
    // and would have passed vacuously against ANY library.
    const running: string[] = [];
    for (const [id, flow] of Object.entries<any>(policy.flows)) {
      for (const [lvl, def] of Object.entries<any>(flow.levels ?? {})) {
        if ((def.duties ?? []).includes("security-review")) running.push(`${id}:${lvl}`);
      }
    }
    // Exactly one place in the whole library schedules it: the deepest ops level
    // (deploys and infra are the one shape where a boundary review is the work).
    expect(running).toEqual(["ops:3"]);
    // …and that level sits ABOVE the flow's default, so no card reaches it
    // without an explicit escalation. Every other route in is the project flag.
    // (routing-core.d.mts still types a flow as the pre-levels `{phasePlan}`,
    // hence the read through `any` here and above.)
    expect(Number((policy.flows as Record<string, any>).ops.defaultLevel)).toBeLessThan(3);
    for (const [id, flow] of Object.entries<any>(policy.flows)) {
      const def = flow.levels?.[String(flow.defaultLevel ?? 1)];
      expect(def?.duties ?? [], `${id} runs security-review by default`).not.toContain("security-review");
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
