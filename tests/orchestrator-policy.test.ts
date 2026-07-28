// S1 (GARRISON-UNIFY-V1) — the Orchestrator policy core.
// Covers: v2 schema validation, D1 seeded matrix cells, phase rails / work
// kinds (D2), the phase-skill registry (D3), compilePolicy byte-stability +
// atomic-write path (D4), v1→v2 migration, and the computeLadder bias that
// preserves modes routingBias behavior.
import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "..");
const CORE = pathToFileURL(path.join(ROOT, "fittings/seed/orchestrator/lib/routing-core.mjs")).href;
const SEED = path.join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json");

async function core() {
  return import(CORE);
}

function seedConfig() {
  return JSON.parse(fs.readFileSync(SEED, "utf8"));
}

describe("orchestrator policy core (S1)", () => {
  it("seed config is v2 and validates clean", async () => {
    const mod = await core();
    const cfg = seedConfig();
    expect(cfg.version).toBe(2);
    expect(mod.validateRoutingConfig(cfg)).toEqual([]);
  });

  it("every pipeline verb is a task type (D1)", async () => {
    const mod = await core();
    const cfg = seedConfig();
    for (const phase of mod.PHASES) expect(cfg.taskTypes).toContain(phase);
    // general kinds survive
    for (const g of ["code", "research", "writing", "image", "video", "ops", "other"]) {
      expect(cfg.taskTypes).toContain(g);
    }
  });

  it("seeded cells mirror the briefed behavior (D1)", async () => {
    const mod = await core();
    const policy = mod.compilePolicy(seedConfig());
    expect(policy.matrix["implement"]["T2-deep"].targetId).toBe("cc-opus-high");
    expect(policy.matrix["test"]["T1-standard"].model).toBe("sonnet");
    expect(policy.matrix["test"]["T1-standard"].effort).toBe("medium");
    expect(policy.matrix["walkthrough"]["T1-standard"].model).toBe("sonnet");
    // report is a latency-sensitive one-shot → the fast agent-sdk/Anthropic target (D29 / S9).
    expect(policy.matrix["report"]["T1-standard"].runtime).toBe("agent-sdk");
    expect(policy.matrix["report"]["T1-standard"].model).toBe("claude-haiku-4-5");
    expect(policy.matrix["report"]["T1-standard"].effort).toBe("low");
    const codex = policy.matrix["codex-checkpoint"]["T1-standard"];
    expect(codex.runtime).toBe("codex");
    expect(codex.model).toBe("gpt-5.5");
    expect(codex.effort).toBe("high");
    // adversarial gates on high-effort native targets
    expect(policy.matrix["adversarial-review"]["T1-standard"].effort).toBe("xhigh");
    expect(policy.matrix["adversarial-test"]["T1-standard"].effort).toBe("high");
  });

  it("compilePolicy is byte-stable (D4)", async () => {
    const mod = await core();
    const cfg = seedConfig();
    const a = mod.stableStringify(mod.compilePolicy(cfg));
    const b = mod.stableStringify(mod.compilePolicy(cfg));
    expect(a).toBe(b);
    // key order independent of input insertion order
    const reordered = JSON.parse(JSON.stringify(cfg));
    const { workKinds, ...rest } = reordered;
    const c = mod.stableStringify(mod.compilePolicy({ ...rest, workKinds }));
    expect(c).toBe(a);
  });

  it("work kinds resolve to rails with bound skills (D2/D3)", async () => {
    const mod = await core();
    const cfg = seedConfig();
    // A phase plan is an ordered SUBSET: phases outside the plan stay in the
    // rail rendered OFF (honesty, never hidden).
    const docs = mod.railFor(cfg, "docs-change");
    expect(docs.phases.length).toBe(12);
    expect(docs.phases.filter((p: { on: boolean }) => p.on).map((p: { id: string }) => p.id)).toEqual(["implement"]);
    expect(docs.phases.find((p: { id: string }) => p.id === "walkthrough").off_reason).toBe("phase-plan");
    expect(docs.evidence).toBe("text");
    const api = mod.railFor(cfg, "api-change");
    expect(api.phases.filter((p: { on: boolean }) => p.on).map((p: { id: string }) => p.id)).toEqual(["implement", "test"]);
    expect(api.evidence).toBe("logs");
    const full = mod.railFor(cfg, "full-feature");
    expect(full.phases.length).toBe(12);
    // every phase in the full plan is ON; the opt-in security-review phase is the one OFF chip.
    expect(full.phases.filter((p: { on: boolean }) => p.on).length).toBe(11);
    expect(full.phases.find((p: { id: string }) => p.id === "security-review").on).toBe(false);
    expect(full.evidence).toBe("video");
    expect(full.phases.find((p: { id: string }) => p.id === "review").skill).toBe("garrison-review");
    // default kind
    expect(mod.railFor(cfg, null).workKind).toBe("full-feature");
  });

  it("per-card phase toggles render off, never hidden (D17 honesty)", async () => {
    const mod = await core();
    const rail = mod.railFor(seedConfig(), "full-feature", { walkthrough: false });
    const wt = rail.phases.find((p: { id: string }) => p.id === "walkthrough");
    expect(wt.on).toBe(false);
    expect(wt.off_reason).toBe("card-toggle");
    expect(rail.phases.length).toBe(12); // still present
  });

  it("per-kind skill overrides win over global bindings (D3)", async () => {
    const mod = await core();
    const cfg = seedConfig();
    cfg.phaseSkills.overrides["docs-change"] = { implement: "my-docs-writer" };
    expect(mod.validateRoutingConfig(cfg)).toEqual([]);
    const rail = mod.railFor(cfg, "docs-change");
    expect(rail.phases[0].skill).toBe("my-docs-writer");
  });

  it("vocabulary is extensible without code change (D1/D2)", async () => {
    const mod = await core();
    const cfg = seedConfig();
    cfg.taskTypes.push("data-migration");
    cfg.profiles.balanced.matrix.rows["data-migration"] = { default: "cc-opus-high", cells: {} };
    cfg.phasePlans["migrate"] = { phases: ["plan", "implement", "test"], evidence: "logs" };
    cfg.workKinds["schema-migration"] = { phasePlan: "migrate" };
    expect(mod.validateRoutingConfig(cfg)).toEqual([]);
    const policy = mod.compilePolicy(cfg);
    expect(policy.matrix["data-migration"]["T1-standard"].targetId).toBe("cc-opus-high");
    const rail = mod.railFor(cfg, "schema-migration");
    expect(rail.phases.filter((p: { on: boolean }) => p.on).map((p: { id: string }) => p.id)).toEqual([
      "plan",
      "implement",
      "test"
    ]);
    expect(rail.phases.length).toBe(12); // off phases stay visible
  });

  it("validation catches unknown targets, phases and plans", async () => {
    const mod = await core();
    const bad = seedConfig();
    bad.profiles.balanced.matrix.rows["implement"].cells["T2-deep"] = "no-such-target";
    bad.phasePlans["broken"] = { phases: ["not-a-phase"], evidence: "logs" };
    bad.workKinds["orphan"] = { phasePlan: "missing-plan" };
    const errors = mod.validateRoutingConfig(bad);
    expect(errors.join("\n")).toMatch(/no-such-target/);
    expect(errors.join("\n")).toMatch(/not-a-phase/);
    expect(errors.join("\n")).toMatch(/missing-plan/);
  });

  it("resolveRoute on v2 configs resolves cell > row > column > default", async () => {
    const mod = await core();
    const cfg = seedConfig();
    const cell = mod.resolveRoute(cfg, null, { taskType: "implement", tier: "T0-trivial" });
    expect(cell.targetId).toBe("cc-sonnet-med");
    expect(cell.via).toBe("cell");
    const row = mod.resolveRoute(cfg, null, { taskType: "plan", tier: "T1-standard" });
    expect(row.targetId).toBe("cc-fable-xhigh");
    expect(row.via).toBe("row-default");
    const exception = mod.resolveRoute(cfg, null, {
      taskType: "code",
      tier: "T1-standard",
      matchedException: "ex-image"
    });
    expect(exception.targetId).toBe("sec-gemini");
    expect(exception.via).toBe("exception");
  });

  it("computeLadder bias preserves v1 routingBias behavior", async () => {
    const mod = await core();
    const ladder = ["cc-haiku-low", "cc-sonnet-med", "cc-opus-high"];
    // Joe: expert floor raises everything on the ladder
    expect(mod.biasTarget("cc-haiku-low", { floor: "expert", prefer: "expert" }, ladder)).toBe("cc-opus-high");
    // Gary: standard-toward-fast dials the standard resolution down
    expect(mod.biasTarget("cc-sonnet-med", { floor: "fast", prefer: "fast" }, ladder)).toBe("cc-haiku-low");
    // A genuinely hard task keeps its tier (never lowered by floor)
    expect(mod.biasTarget("cc-opus-high", { floor: "standard", prefer: "expert" }, ladder)).toBe("cc-opus-high");
    // Off-ladder targets are never biased
    expect(mod.biasTarget("sec-gemini", { floor: "expert", prefer: "expert" }, ladder)).toBe("sec-gemini");
  });

  it("v1 configs migrate to v2 preserving effective routes", async () => {
    const mod = await core();
    const v1 = {
      version: 1,
      activeProfile: "balanced",
      taskTypes: ["code", "review", "research", "image", "video", "writing", "ops", "other"],
      tiers: ["T0-trivial", "T1-standard", "T2-deep"],
      exceptions: [{ id: "ex-x", when: "x", role: "review" }],
      matrix: {
        defaults: { role: "standard" },
        columns: { "T2-deep": "expert" },
        rows: { code: { default: "standard", cells: { "T0-trivial": "fast" } } }
      },
      discipline: {
        "T0-trivial": { review: "none", testing: "none", evidence: "none", distribution: "none" },
        "T1-standard": { review: "self-review", testing: "tests", evidence: "text", distribution: "none" },
        "T2-deep": { review: "review-by:default", testing: "full-gates", evidence: "video", distribution: "link" }
      },
      continuations: [],
      targets: [
        { id: "a-low", type: "runtime-target", runtime: "claude-code", model: "haiku", effort: "low" },
        { id: "a-med", type: "runtime-target", runtime: "claude-code", model: "sonnet", effort: "medium" },
        { id: "a-high", type: "runtime-target", runtime: "claude-code", model: "opus", effort: "high" }
      ],
      profiles: {
        balanced: {
          preRoute: "on",
          roleMap: { expert: "a-high", standard: "a-med", fast: "a-low", image: "a-med", video: "a-med", review: "a-med" },
          disciplineOverrides: {}
        }
      }
    };
    const v2 = mod.migrateRoutingConfig(v1);
    expect(mod.validateRoutingConfig(v2)).toEqual([]);
    // same effective resolution as v1
    const before = mod.resolveRoute(v1, null, { taskType: "code", tier: "T0-trivial" });
    const after = mod.resolveRoute(v2, null, { taskType: "code", tier: "T0-trivial" });
    expect(after.targetId).toBe(before.targetId);
    const beforeDeep = mod.resolveRoute(v1, null, { taskType: "writing", tier: "T2-deep" });
    const afterDeep = mod.resolveRoute(v2, null, { taskType: "writing", tier: "T2-deep" });
    expect(afterDeep.targetId).toBe(beforeDeep.targetId);
    expect(v2.profiles.balanced.computeLadder).toEqual(["a-low", "a-med", "a-high"]);
  });

  it("compiled routing markdown carries the v2 marker and rails", async () => {
    const mod = await core();
    const md = mod.compileRouting(seedConfig(), "balanced");
    expect(md).toContain("garrison:routing v2 profile=balanced");
    expect(md).toContain("task-type × tier → target");
    expect(md).toContain("full-feature");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("resolvePhaseTarget answers straight off the compiled policy", async () => {
    const mod = await core();
    const policy = mod.compilePolicy(seedConfig());
    const t = mod.resolvePhaseTarget(policy, "implement", "T2-deep");
    expect(t.model).toBe("opus");
    expect(t.effort).toBe("high");
    expect(() => mod.resolvePhaseTarget(policy, "nope", "T2-deep")).toThrow();
  });

  it("inferPhasePlan derives a rail from tier discipline (D2 fallback)", async () => {
    const mod = await core();
    const cfg = seedConfig();
    const t2 = mod.inferPhasePlan(cfg, "balanced", "T2-deep");
    expect(t2.inferred).toBe(true);
    const t2ids = t2.phases.map((p: { id: string }) => p.id);
    expect(t2ids).toContain("implement");
    expect(t2ids).toContain("test");
    // full-gates testing pulls in the deep gates; video evidence pulls walkthrough.
    expect(t2ids).toContain("adversarial-test");
    expect(t2ids).toContain("walkthrough");
    expect(t2.evidence).toBe("video");
    // plan is ALWAYS on — a goal card enters through the Plan list; a rail
    // without it would fast-forward past the phase the run starts in.
    expect(t2ids[0]).toBe("plan");
    // order is pipeline order (PHASES), never insertion order.
    expect(t2ids).toEqual(mod.PHASES.filter((id: string) => t2ids.includes(id)));
    const t0 = mod.inferPhasePlan(cfg, "balanced", "T0-trivial");
    expect(t0.phases.map((p: { id: string }) => p.id)).toEqual(["plan", "implement"]);
    expect(t0.evidence).toBe("none");
    // T1-standard: plan/implement/review/test — the discipline table's own
    // promise (self-review + tests, no adversarial gates, no video).
    const t1 = mod.inferPhasePlan(cfg, "balanced", "T1-standard");
    expect(t1.phases.map((p: { id: string }) => p.id)).toEqual(["plan", "implement", "review", "test"]);
  });

  it("phaseTogglesFor turns an inferred plan into the card phases-toggle map", async () => {
    const mod = await core();
    const cfg = seedConfig();
    const t1 = mod.inferPhasePlan(cfg, "balanced", "T1-standard");
    const toggles = mod.phaseTogglesFor(t1);
    // Every pipeline phase the plan leaves off is explicitly false…
    expect(toggles["adversarial-review"]).toBe(false);
    expect(toggles["walkthrough"]).toBe(false);
    expect(toggles["codex-checkpoint"]).toBe(false);
    // …and phases IN the plan are absent (on by default in the rail merge).
    expect(toggles).not.toHaveProperty("plan");
    expect(toggles).not.toHaveProperty("implement");
    expect(toggles).not.toHaveProperty("review");
    expect(toggles).not.toHaveProperty("test");
    // An all-on plan needs no toggles at all.
    expect(mod.phaseTogglesFor({ phases: mod.PHASES.map((id: string) => ({ id, on: true })) })).toBeNull();
  });
});

// The duties repoint: composition duty ladders drive the matrix rows.
describe("applyDutyCells (duties drive the routed matrix)", () => {
  const dutyModel = {
    version: 2,
    compositionId: "default",
    kanbanLists: ["code", "plan"],
    sequences: {},
    cells: {
      code: {
        "1": { target: "sdk-haiku", effort: "low", runtime: "agent-sdk", model: "claude-haiku-4-5", provider: "anthropic", type: "runtime-target" },
        "2": { target: "cc-sonnet", effort: "medium", runtime: "agent-sdk", model: "sonnet", provider: "anthropic", type: "runtime-target", promptMode: "coding", maxTurns: 100 },
        "3": { target: "cc-opus", effort: "high", runtime: "agent-sdk", model: "opus", provider: "anthropic", type: "runtime-target", promptMode: "coding", maxTurns: 100 }
      },
      plan: {
        "1": { target: "fable", effort: "high", runtime: "claude-code", model: "claude-fable-5", provider: "anthropic-plan", type: "runtime-target" }
      },
      "not-a-task-type": {
        "1": { target: "cc-sonnet", effort: "low", runtime: "claude-code", model: "sonnet", provider: "anthropic-plan", type: "runtime-target" }
      }
    }
  };

  it("derives per-tier cells from the ladder (tier k -> rung min(k+1, n)) with cell-level effort", async () => {
    const mod = await core();
    const merged = mod.applyDutyCells(seedConfig(), dutyModel);
    expect(mod.validatePolicyConfig(merged)).toEqual([]);
    const t0 = mod.resolveRouteV2(merged, "balanced", { taskType: "code", tier: "T0-trivial" });
    const t1 = mod.resolveRouteV2(merged, "balanced", { taskType: "code", tier: "T1-standard" });
    const t2 = mod.resolveRouteV2(merged, "balanced", { taskType: "code", tier: "T2-deep" });
    expect([t0.targetId, t1.targetId, t2.targetId]).toEqual(["sdk-haiku", "cc-sonnet", "cc-opus"]);
    // The duty cell's effort OVERLAYS the target spec — the resolved target IS
    // the effective spec the switch planner and the decision log see.
    expect(t1.target?.effort).toBe("medium");
    expect(t1.effort).toBe("medium");
    expect(t1.ruleId).toBe("duty:code/L2");
    // A 1-rung ladder clamps every tier onto its only cell.
    const planT2 = mod.resolveRouteV2(merged, "balanced", { taskType: "plan", tier: "T2-deep" });
    expect(planT2.targetId).toBe("fable");
    expect(planT2.ruleId).toBe("duty:plan/L1");
  });

  it("compiles the duty-derived cells into policy.json's matrix", async () => {
    const mod = await core();
    const merged = mod.applyDutyCells(seedConfig(), dutyModel);
    const policy = mod.compilePolicy(merged);
    expect(policy.matrix.code["T1-standard"].targetId).toBe("cc-sonnet");
    expect(policy.matrix.code["T1-standard"].effort).toBe("medium");
    expect(policy.matrix.code["T1-standard"].model).toBe("sonnet");
    expect(policy.matrix.code["T1-standard"].rule).toBe("duty:code/L2");
  });

  it("ignores duties outside the task-type vocabulary and appends unknown targets", async () => {
    const mod = await core();
    const cfg = seedConfig();
    const merged = mod.applyDutyCells(cfg, dutyModel);
    for (const p of Object.values(merged.profiles) as Array<{ matrix: { rows: Record<string, unknown> } }>) {
      expect(p.matrix.rows).not.toHaveProperty("not-a-task-type");
    }
    // Targets referenced only by duty cells got appended from the cell spec…
    const ids = merged.targets.map((t: { id: string }) => t.id);
    expect(ids).toContain("cc-sonnet");
    expect(ids).toContain("fable");
    // …the agent-sdk harness knobs (promptMode/maxTurns) travel with the
    // injected target so a duty-repointed coding turn keeps its claude_code
    // profile + turn cap instead of falling back to full/12.
    const injectedSonnet = merged.targets.find((t: { id: string }) => t.id === "cc-sonnet") as
      | { promptMode?: string; maxTurns?: number }
      | undefined;
    expect(injectedSonnet?.promptMode).toBe("coding");
    expect(injectedSonnet?.maxTurns).toBe(100);
    // …and pre-existing target entries are never overwritten.
    expect(merged.targets.length).toBeGreaterThanOrEqual(cfg.targets.length);
  });

  it("is a no-op for an absent/empty cells model and never mutates its input", async () => {
    const mod = await core();
    const cfg = seedConfig();
    const before = JSON.stringify(cfg);
    expect(mod.applyDutyCells(cfg, null)).toBe(cfg);
    expect(mod.applyDutyCells(cfg, { cells: {} })).toBe(cfg);
    mod.applyDutyCells(cfg, dutyModel);
    expect(JSON.stringify(cfg)).toBe(before);
  });
});

// S3 (GARRISON-RUNTIMES-V1): primaryRuntime is policy data.
describe("primaryRuntime in the policy (P3/D4)", () => {
  it("the seed declares the default and it compiles into the policy", async () => {
    const mod = await core();
    const cfg = seedConfig();
    expect(cfg.primaryRuntime).toBe("claude-code-runtime");
    expect(mod.compilePolicy(cfg).primaryRuntime).toBe("claude-code-runtime");
    // Absent key → same default (primaryRuntimeOf applies it at compile).
    const { primaryRuntime: _drop, ...noKey } = cfg;
    expect(mod.compilePolicy(noKey).primaryRuntime).toBe("claude-code-runtime");
  });

  it("carries an explicit primaryRuntime through compile", async () => {
    const mod = await core();
    const pol = mod.compilePolicy({ ...seedConfig(), primaryRuntime: "codex-runtime" });
    expect(pol.primaryRuntime).toBe("codex-runtime");
  });

  it("rejects a non-string/empty primaryRuntime loudly", async () => {
    const mod = await core();
    expect(() => mod.compilePolicy({ ...seedConfig(), primaryRuntime: 42 })).toThrow(/primaryRuntime must be a non-empty string/);
    expect(() => mod.compilePolicy({ ...seedConfig(), primaryRuntime: "   " })).toThrow(/primaryRuntime must be a non-empty string/);
  });

  it("compiled policy carries the providers section alongside (P2+P3 coherence)", async () => {
    const mod = await core();
    const pol = mod.compilePolicy(seedConfig());
    expect(pol.providers.map((x: { id: string }) => x.id)).toEqual(["anthropic-plan", "anthropic", "ollama-local", "deepseek", "zai-glm"]);
  });
});
