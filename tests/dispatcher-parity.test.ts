// S3d (GARRISON-MARATHON-V3) — Dispatcher fixture parity (assumption 5 / D6).
//
// The 122-case classifier corpus pins the prompt builder, the parser, and the
// (task-type, tier) -> target resolver against fittings/seed/orchestrator/config/
// routing.seed.json. This proves the DUTIES-AND-LEVELS successor is
// golden-equivalent: for EVERY seed matrix cell, resolving the migrated model at
// (duty=taskType, level=tierIndex+1) yields the SAME (runtime, model, effort) the
// old (task-type, tier) matrix produced.
//
// Two independent anchors:
//   1. compilePolicy (policy-core, the exact golden the corpus asserts) fills all
//      60 cells with {runtime, model, effort} — compared cell-by-cell.
//   2. The old resolveRoute + shedTargets mapping (router-migrate) — the migration
//      the composition actually shipped.
// Both must agree with the (duty, level) resolution via the Resolver.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shedTargets, foldProfile } from "../src/lib/router-migrate";
import { resolveSequence } from "../src/lib/resolver";
import type { ResolvedDuty } from "../src/lib/resolver";
// @ts-ignore — pure .mjs routing core (the corpus' source of truth)
import { resolveRoute, compilePolicy } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

const SEED = join(__dirname, "..", "fittings", "seed", "orchestrator", "config", "routing.seed.json");
const seed = JSON.parse(readFileSync(SEED, "utf8"));
const ACTIVE: string = seed.activeProfile ?? "balanced";

// Fold the active profile into the duties-and-levels model exactly as the
// router->duties migrator does (S3c), then key it for the Resolver.
//
// The seed's SECONDARY targets (sec-gemini / sec-codex, which the image/video
// rows route to) carry no engine `model` — the compiled policy reports
// {runtime:"gemini", model:null, effort:null} for those cells. Effort-shedding
// builds engine identities and requires a model, so the live migration (S3c)
// folded the real composition where secondaries have a model. To fold the seed
// here we give a modelless target a placeholder model (its runtime name); the
// parity assertions below then compare runtime + effort for EVERY cell and
// compare model ONLY where the golden has a real one — so the placeholder is
// never asserted, and all 60 cells are still covered.
const foldableTargets = (seed.targets ?? []).map((t: { model?: unknown; runtime?: string }) =>
  typeof t.model === "string" && t.model.length > 0 ? t : { ...t, model: t.runtime }
);
const shed = shedTargets(foldableTargets);
const fold = foldProfile(seed, ACTIVE, shed);
const dutiesMap: Record<string, ResolvedDuty> = Object.fromEntries(
  fold.duties.map((d) => [d.id, d as ResolvedDuty])
);
const targetsById = new Map(fold.targets.map((t) => [t.id, t]));

// tier index -> level (T0->1, T1->2, T2->3), the migration's mapping.
const levelForTier = (tierIndex: number) => tierIndex + 1;

describe("Dispatcher fixture parity — full seed matrix (duty, level) == (task-type, tier)", () => {
  it("every migrated duty carries one leaf level per tier", () => {
    for (const taskType of seed.taskTypes) {
      const duty = dutiesMap[taskType];
      expect(duty, `missing duty ${taskType}`).toBeTruthy();
      expect(duty.levels.length).toBe(seed.tiers.length);
      for (const level of duty.levels) expect(level.cell).toBeTruthy();
    }
  });

  it("anchor 1 — resolves to the SAME (runtime, model, effort) the compiled policy pins (all 60 cells)", () => {
    const policy = compilePolicy(seed);
    let checked = 0;
    for (const taskType of seed.taskTypes) {
      for (let ti = 0; ti < seed.tiers.length; ti++) {
        const tier = seed.tiers[ti];
        const gold = policy.matrix?.[taskType]?.[tier];
        expect(gold, `compiled policy missing ${taskType}/${tier}`).toBeTruthy();

        const steps = resolveSequence(taskType, levelForTier(ti), dutiesMap);
        expect(steps.length).toBe(1); // a leaf duty resolves to exactly one step
        const cell = steps[0].cell;
        const target = targetsById.get(cell.target ?? "");
        expect(target, `cell target ${cell.target} not in migrated targets`).toBeTruthy();

        expect(target!.runtime).toBe(gold.runtime);
        // Model is compared only where the golden pins one; secondary cells
        // (image/video -> gemini) carry model:null on both sides (see the fold
        // note above), so runtime + effort is the parity for them.
        if (gold.model) expect(target!.model).toBe(gold.model);
        expect(cell.effort ?? null).toBe(gold.effort ?? null);
        checked++;
      }
    }
    expect(checked).toBe(seed.taskTypes.length * seed.tiers.length);
  });

  it("anchor 2 — matches the old resolveRoute + effort-shedding mapping (all 60 cells)", () => {
    for (const taskType of seed.taskTypes) {
      for (let ti = 0; ti < seed.tiers.length; ti++) {
        const tier = seed.tiers[ti];
        const old = resolveRoute(seed, ACTIVE, { taskType, tier });
        const expected = old.targetId ? shed.origIdToShed.get(old.targetId) : undefined;
        expect(expected, `no shed mapping for ${old.targetId}`).toBeTruthy();

        const cell = resolveSequence(taskType, levelForTier(ti), dutiesMap)[0].cell;
        expect(cell.target).toBe(expected!.id);
        expect(cell.effort ?? undefined).toBe(expected!.effort ?? undefined);
      }
    }
  });
});

// Named, legible goldens ported straight from the classifier fixtures
// (tests/orchestrator-policy.test.ts + tests/routing-classify.test.ts). These
// are independent of the exhaustive loop above — a documentation anchor showing
// the (task-type, tier) -> target golden maps to a concrete (duty, level).
describe("Dispatcher fixture parity — ported named goldens", () => {
  const GOLDENS: Array<{
    label: string;
    duty: string;
    level: number;
    runtime?: string;
    dutyModel?: string;
    effort: string | null;
  }> = [
    // implement x T2-deep -> cc-opus-high  (orchestrator-policy.test.ts:45)
    { label: "implement x T2-deep -> cc-opus/high", duty: "implement", level: 3, runtime: "claude-code", dutyModel: "opus", effort: "high" },
    // implement x T0-trivial -> cc-sonnet-med  (orchestrator-policy.test.ts:151)
    { label: "implement x T0-trivial -> cc-sonnet/medium", duty: "implement", level: 1, runtime: "claude-code", dutyModel: "sonnet", effort: "medium" },
    // test x T1-standard -> sonnet/medium  (orchestrator-policy.test.ts:47)
    { label: "test x T1-standard -> cc-sonnet/medium", duty: "test", level: 2, runtime: "claude-code", dutyModel: "sonnet", effort: "medium" },
    // plan x T1-standard -> cc-fable-xhigh (row-default)  (orchestrator-policy.test.ts:154)
    { label: "plan x T1-standard -> cc-fable/xhigh", duty: "plan", level: 2, runtime: "claude-code", dutyModel: "fable", effort: "xhigh" },
    // report x T1-standard -> agent-sdk/claude-haiku-4-5/low  (orchestrator-policy.test.ts:50)
    { label: "report x T1-standard -> agent-sdk/claude-haiku-4-5/low", duty: "report", level: 2, runtime: "agent-sdk", dutyModel: "claude-haiku-4-5", effort: "low" },
    // codex-checkpoint x T1-standard -> codex/gpt-5.5/high  (orchestrator-policy.test.ts:53)
    { label: "codex-checkpoint x T1-standard -> codex/gpt-5.5/high", duty: "codex-checkpoint", level: 2, runtime: "codex", dutyModel: "gpt-5.5", effort: "high" },
    // adversarial-review x T1-standard -> effort xhigh  (orchestrator-policy.test.ts:58)
    { label: "adversarial-review x T1-standard -> xhigh", duty: "adversarial-review", level: 2, effort: "xhigh" },
    // adversarial-test x T1-standard -> effort high  (orchestrator-policy.test.ts:59)
    { label: "adversarial-test x T1-standard -> high", duty: "adversarial-test", level: 2, effort: "high" },
    // code x T2-deep -> cc-opus-high  (routing-classify.test.ts:65)
    { label: "code x T2-deep -> cc-opus/high", duty: "code", level: 3, runtime: "claude-code", dutyModel: "opus", effort: "high" }
  ];

  for (const g of GOLDENS) {
    it(g.label, () => {
      const cell = resolveSequence(g.duty, g.level, dutiesMap)[0].cell;
      expect(cell.effort ?? null).toBe(g.effort);
      if (g.runtime || g.dutyModel) {
        const target = targetsById.get(cell.target ?? "");
        expect(target, `no target ${cell.target}`).toBeTruthy();
        if (g.runtime) expect(target!.runtime).toBe(g.runtime);
        if (g.dutyModel) expect(target!.model).toBe(g.dutyModel);
      }
    });
  }
});
