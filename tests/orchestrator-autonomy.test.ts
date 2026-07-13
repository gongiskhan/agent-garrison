// S2 (GARRISON-UNIFY-V1) — the autonomy axis (D8) + the brain-merge grep proofs
// (D6/D7, acceptance 10): no fitting named model-router remains, and
// orchestration doctrine exists in exactly one prompt body.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "..");
const CORE = pathToFileURL(path.join(ROOT, "fittings/seed/orchestrator/lib/routing-core.mjs")).href;

async function core() {
  return import(CORE);
}

describe("autonomy axis (D8)", () => {
  it("card- and scheduler-originated turns are autonomous (deterministic, no classifier)", async () => {
    const mod = await core();
    expect(mod.classifyExecution({ channel: "kanban" })).toBe("autonomous");
    expect(mod.classifyExecution({ channel: "scheduler" })).toBe("autonomous");
    expect(mod.classifyExecution({ channel: "board" })).toBe("autonomous");
  });

  it("an explicit autonomous marker wins (web-channel toggle / garrison doorway)", async () => {
    const mod = await core();
    expect(mod.classifyExecution({ channel: "web", explicitAutonomous: true })).toBe("autonomous");
    expect(
      mod.classifyExecution({ channel: "web", explicitAutonomous: true, mode: "gary" })
    ).toBe("autonomous"); // explicit marker outranks the Gary floor
  });

  it("a multi-step cross-app automation shape is autonomous", async () => {
    const mod = await core();
    expect(
      mod.classifyExecution({
        channel: "web",
        message: "every day at 9, pull the Trello board and then email me a summary",
        classification: { taskType: "ops", tier: "T1-standard" }
      })
    ).toBe("autonomous");
  });

  it("Gary-mode conversation floors to interactive", async () => {
    const mod = await core();
    expect(
      mod.classifyExecution({
        channel: "web",
        mode: "gary",
        message: "what should I cook this week?",
        classification: { taskType: "other", tier: "T0-trivial" }
      })
    ).toBe("interactive");
  });

  it("ordinary interactive work stays interactive; the CLASSIFIER's execution read decides (rev-s2 fix)", async () => {
    const mod = await core();
    // ordinary chat code work → interactive (no dead task-type fallback)
    expect(
      mod.classifyExecution({ channel: "web", classification: { taskType: "code", tier: "T1-standard" } })
    ).toBe("interactive");
    // "review this diff" must NOT card-ify (the old false-positive)
    expect(
      mod.classifyExecution({ channel: "web", classification: { taskType: "review", tier: "T2-deep" } })
    ).toBe("interactive");
    // the classifier's own autonomous read stands
    expect(
      mod.classifyExecution({ channel: "web", classification: { taskType: "code", tier: "T1-standard", execution: "autonomous" } })
    ).toBe("autonomous");
    // ...but Gary-mode conversation still floors interactive? No — explicit
    // classifier reads rank BELOW the Gary floor per D8 rule order.
    expect(
      mod.classifyExecution({ channel: "web", mode: "gary", classification: { taskType: "code", tier: "T1-standard", execution: "autonomous" } })
    ).toBe("interactive");
  });

  it("the classifier prompt asks for execution and the parser clamps it", async () => {
    const mod = await core();
    const cfg = JSON.parse(
      (await import("node:fs")).readFileSync(
        path.join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json"),
        "utf8"
      )
    );
    expect(mod.buildClassifierPrompt(cfg, "hello")).toContain("execution");
    const parsed = mod.parseClassification('{"taskType":"code","tier":"T1-standard","execution":"autonomous"}', cfg);
    expect(parsed.execution).toBe("autonomous");
    const clamped = mod.parseClassification('{"taskType":"code","tier":"T1-standard","execution":"bogus"}', cfg);
    expect(clamped.execution).toBe("interactive");
  });

  it("significance test: build verbs and non-trivial code are significant", async () => {
    const mod = await core();
    expect(mod.isSignificantAutonomous({ taskType: "implement", tier: "T1-standard" })).toBe(true);
    expect(mod.isSignificantAutonomous({ taskType: "code", tier: "T2-deep" })).toBe(true);
    expect(mod.isSignificantAutonomous({ taskType: "code", tier: "T0-trivial" })).toBe(false);
    expect(mod.isSignificantAutonomous({ taskType: "other", tier: "T1-standard" })).toBe(false);
  });

  it("buildAutonomousCardPayload carries brief, phases override, and classification", async () => {
    const mod = await core();
    const p = mod.buildAutonomousCardPayload({
      brief: "build X",
      project: "/home/u/dev/x",
      workKind: "full-feature",
      phases: { walkthrough: false },
      taskType: "implement",
      tier: "T2-deep"
    });
    expect(p.description).toBe("build X");
    expect(p.goalMode).toBe(true);
    expect(p.phases).toEqual({ walkthrough: false });
    expect(p.classification).toEqual({ taskType: "implement", tier: "T2-deep" });
    expect(p.origin).toBe("orchestrator");
  });

  it("carries the resolved (duty, level, sequence) when present (S4b door-1 persistence)", async () => {
    const mod = await core();
    const p = mod.buildAutonomousCardPayload({
      brief: "build X",
      duty: "develop",
      level: 2,
      sequence: ["plan", "implement", "review", "test"]
    });
    expect(p.duty).toBe("develop");
    expect(p.level).toBe(2);
    expect(p.sequence).toEqual(["plan", "implement", "review", "test"]);
    // Absent when not resolved (pre-S4b card shape preserved).
    const bare = mod.buildAutonomousCardPayload({ brief: "y" });
    expect(bare).not.toHaveProperty("duty");
    expect(bare).not.toHaveProperty("sequence");
  });
});

describe("brain merge grep proofs (D6/D7, acceptance 10)", () => {
  it("no fitting named model-router remains", () => {
    expect(existsSync(path.join(ROOT, "fittings/seed/model-router"))).toBe(false);
    expect(existsSync(path.join(ROOT, "fittings/seed/orchestrator"))).toBe(true);
    const seeds = readdirSync(path.join(ROOT, "fittings/seed"));
    expect(seeds).not.toContain("model-router");
    // the fitting's manifest names it orchestrator
    const apm = readFileSync(path.join(ROOT, "fittings/seed/orchestrator/apm.yml"), "utf8");
    expect(apm).toMatch(/^name: orchestrator$/m);
  });

  it("the old orchestrators are parked (de-listed from the library)", () => {
    const lib = JSON.parse(readFileSync(path.join(ROOT, "data/library.json"), "utf8"));
    const ids = lib.map((e: { id: string }) => e.id);
    expect(ids).not.toContain("model-router");
    expect(ids).not.toContain("garrison-orchestrator");
    expect(ids).toContain("orchestrator");
    for (const soul of ["soul-architect", "soul-engineer", "soul-assistant", "soul-researcher", "soul-companion"]) {
      expect(ids).not.toContain(soul);
    }
  });

  it("orchestration doctrine exists in exactly one prompt body (the merged orchestrator prompt)", () => {
    const merged = readFileSync(
      path.join(ROOT, "fittings/seed/orchestrator/.apm/prompts/orchestrator.prompt.md"),
      "utf8"
    );
    // the merged prompt carries all three bodies' load-bearing content
    expect(merged).toContain("{{routing}}"); // routing duties
    expect(merged).toContain("[route: <target-id> | rule: <rule-id> | profile: <name>]");
    expect(merged).toContain("[orchestrator-active]");
    expect(merged).toContain("current branch"); // garrison-orchestrator project-work flow (same-branch only, GARRISON-FLOW-V2 D10)
    expect(merged).toContain("origin: ui-tab"); // surface awareness
    expect(merged).toContain("Autonomous work"); // garrison disciplined-build doctrine section
    expect(merged).toContain("5-attempt ceiling");
    expect(merged).toContain("No voluntary deferral");
    expect(merged).toContain("Self-unblock before blocking");
    expect(merged).toContain("never a silent pass");
    expect(merged).toContain("detect once, degrade gracefully");
    // modes preserved as faces
    expect(merged).toContain("Gary");
    expect(merged).toContain("Joe");
    expect(merged).toContain("James");
    // no second prompt body carries the pipeline doctrine: the parked
    // garrison-orchestrator prompt must NOT contain the autonomous-build section
    const parked = readFileSync(
      path.join(ROOT, "fittings/seed/garrison-orchestrator/.apm/prompts/garrison-orchestrator.prompt.md"),
      "utf8"
    );
    expect(parked).not.toContain("5-attempt ceiling");
    expect(parked).not.toContain("Autonomous work (the disciplined build)");
  });
});
