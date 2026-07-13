import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
// @ts-ignore - pure .mjs core (typed by routing-core.d.mts); the runtime resolver we assert parity against.
import { resolveRouteV2 as resolveRouteV2Raw } from "../fittings/seed/orchestrator/lib/routing-core.mjs";
// The parity assertions feed the loose migrator input shape (RoutingConfig, version?: number) to
// the runtime resolver, whose .d.mts types the arg as PolicyConfigV2 (version: 2 literal) and the
// resolved target as Target | null. The migrator reads the same bytes the runtime does, so we treat
// the resolver as a loose boundary for the parity test: it accepts RoutingConfig, and for every
// (taskType,tier) of a well-formed profile it resolves a non-null target that feeds straight into
// shedTargetEffort (typed here as exactly that function's parameter).
const resolveRouteV2 = resolveRouteV2Raw as unknown as (
  config: RoutingConfig,
  profile: string,
  classification: { taskType: string; tier: string }
) => { targetId: string | null; target: Parameters<typeof shedTargetEffort>[0] };
import { parseCompositionV4 } from "../src/lib/compositions";
import {
  shedTargetEffort,
  shedTargets,
  resolveMatrixTarget,
  validateCellCompatibility,
  buildDisciplineRefMap,
  foldProfile,
  migrateRouterConfig,
  type RoutingConfig
} from "../src/lib/router-migrate";

const LIVE_ROUTING = path.join(
  __dirname,
  "..",
  "compositions",
  "default",
  ".garrison",
  "routing.json"
);

function readLive(): RoutingConfig {
  return JSON.parse(fs.readFileSync(LIVE_ROUTING, "utf8")) as RoutingConfig;
}

// ── Effort shedding + dedupe ──────────────────────────────────────────────────
describe("shedTargetEffort", () => {
  it("drops effort from the id and moves the field effort into the shed value", () => {
    const { engineTarget, effort } = shedTargetEffort({
      id: "cc-opus-high",
      type: "runtime-target",
      runtime: "claude-code",
      provider: "anthropic-plan",
      model: "opus",
      effort: "high"
    });
    expect(engineTarget.id).toBe("cc-opus");
    expect(engineTarget.runtime).toBe("claude-code");
    expect(engineTarget.model).toBe("opus");
    expect(engineTarget.provider).toBe("anthropic-plan");
    expect(effort).toBe("high");
    // Targets are engine identity ONLY - no effort field survives.
    expect("effort" in engineTarget).toBe(false);
  });

  it("prefers the .effort field over the id suffix (the field is what the runtime resolves)", () => {
    // Live drift: id says `high`, field says `low` (with a _effortWas breadcrumb).
    const { engineTarget, effort } = shedTargetEffort({
      id: "cc-opus-high",
      runtime: "claude-code",
      provider: "anthropic-plan",
      model: "opus",
      effort: "low",
      _effortWas: "high"
    });
    expect(engineTarget.id).toBe("cc-opus");
    expect(effort).toBe("low");
    // The breadcrumb is dropped, not smuggled into params.
    expect(engineTarget.params).toBeUndefined();
  });

  it("normalizes the `med` short form to `medium`", () => {
    const { engineTarget, effort } = shedTargetEffort({
      id: "cc-sonnet-med",
      runtime: "claude-code",
      model: "sonnet",
      effort: "medium"
    });
    expect(engineTarget.id).toBe("cc-sonnet");
    expect(effort).toBe("medium");
  });

  it("keeps the id when there is no effort suffix, sheds effort from the field", () => {
    const { engineTarget, effort } = shedTargetEffort({
      id: "sdk-ollama-probe",
      runtime: "agent-sdk",
      provider: "ollama-local",
      model: "qwen2.5:3b",
      effort: "low"
    });
    expect(engineTarget.id).toBe("sdk-ollama-probe");
    expect(effort).toBe("low");
  });

  it("preserves non-identity scalar fields under params", () => {
    const { engineTarget, effort } = shedTargetEffort({
      id: "sdk-ollama-build",
      type: "runtime-target",
      runtime: "agent-sdk",
      provider: "ollama-local",
      model: "qwen2.5-coder:7b",
      promptMode: "lean",
      maxTurns: 2,
      leanPrompt: "output code only"
    });
    expect(engineTarget.id).toBe("sdk-ollama-build");
    expect(effort).toBeUndefined();
    expect(engineTarget.params).toEqual({
      type: "runtime-target",
      promptMode: "lean",
      maxTurns: 2,
      leanPrompt: "output code only"
    });
  });
});

describe("shedTargets (dedupe)", () => {
  it("collapses two effort-only variants into one engine target and maps both originals", () => {
    const { targets, origIdToShed } = shedTargets([
      { id: "cc-opus-high", runtime: "claude-code", provider: "anthropic-plan", model: "opus", effort: "high" },
      { id: "cc-opus-low", runtime: "claude-code", provider: "anthropic-plan", model: "opus", effort: "low" }
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe("cc-opus");
    expect(origIdToShed.get("cc-opus-high")).toEqual({ id: "cc-opus", effort: "high" });
    expect(origIdToShed.get("cc-opus-low")).toEqual({ id: "cc-opus", effort: "low" });
  });

  it("throws when two targets collapse to the same id but differ in engine identity", () => {
    expect(() =>
      shedTargets([
        { id: "cc-opus-high", runtime: "claude-code", model: "opus", effort: "high" },
        { id: "cc-opus-low", runtime: "claude-code", model: "sonnet", effort: "low" }
      ])
    ).toThrow(/collision/);
  });

  it("sheds every live target without a collision", () => {
    const config = readLive();
    const { targets, origIdToShed } = shedTargets(config.targets ?? []);
    // Every original id maps to a shed id; no engine target carries effort.
    for (const raw of config.targets ?? []) {
      expect(origIdToShed.has(raw.id)).toBe(true);
    }
    for (const t of targets) expect("effort" in t).toBe(false);
    // The known effort-in-id targets shed their suffix.
    const ids = new Set(targets.map((t) => t.id));
    expect(ids.has("cc-opus")).toBe(true);
    expect(ids.has("cc-haiku")).toBe(true);
    expect(ids.has("cc-sonnet")).toBe(true);
  });
});

// ── Matrix precedence + parity with the runtime resolver ──────────────────────
describe("resolveMatrixTarget precedence", () => {
  const matrix = {
    defaults: { target: "D" },
    columns: { "T2-deep": "COL" },
    rows: {
      code: { default: "ROW", cells: { "T0-trivial": "CELL" } }
    }
  };
  it("cell > row-default > column > matrix-default", () => {
    expect(resolveMatrixTarget(matrix, "code", "T0-trivial")).toBe("CELL"); // cell
    expect(resolveMatrixTarget(matrix, "code", "T1-standard")).toBe("ROW"); // row default
    expect(resolveMatrixTarget(matrix, "other", "T2-deep")).toBe("COL"); // column
    expect(resolveMatrixTarget(matrix, "other", "T1-standard")).toBe("D"); // matrix default
  });
});

describe("(taskType,tier) -> (duty,level) parity with routing-core resolveRouteV2", () => {
  const config = readLive();
  const profile = config.activeProfile ?? "balanced";
  const tiers = config.tiers ?? [];
  const shed = shedTargets(config.targets ?? []);
  const fold = foldProfile(config, profile, shed);

  it("resolves every cell to the same target id the runtime resolver does", () => {
    for (const tt of config.taskTypes ?? []) {
      for (const tier of tiers) {
        const mine = resolveMatrixTarget((config.profiles ?? {})[profile]?.matrix, tt, tier);
        const rc = resolveRouteV2(config, profile, { taskType: tt, tier });
        expect(mine, `${tt}/${tier}`).toBe(rc.targetId);
      }
    }
  });

  it("every folded leaf cell reconstructs the runtime resolver's target + effort", () => {
    for (const tt of config.taskTypes ?? []) {
      const duty = fold.duties.find((d) => d.id === tt)!;
      expect(duty, tt).toBeTruthy();
      tiers.forEach((tier, index) => {
        const rc = resolveRouteV2(config, profile, { taskType: tt, tier });
        const shedRc = shedTargetEffort(rc.target);
        const cell = duty.levels[index].cell!;
        expect(cell.target, `${tt}/${tier} target`).toBe(shedRc.engineTarget.id);
        expect(cell.effort, `${tt}/${tier} effort`).toBe(shedRc.effort);
      });
    }
  });
});

// ── By-name discipline refs ───────────────────────────────────────────────────
describe("buildDisciplineRefMap", () => {
  it("rewrites review-by:default to a review duty-level lookup at the tier's level", () => {
    const config = readLive();
    const refs = buildDisciplineRefMap(config, config.activeProfile ?? "balanced");
    const t2 = refs.find((r) => r.tier === "T2-deep" && r.field === "review");
    expect(t2).toBeTruthy();
    expect(t2!.value).toBe("review-by:default");
    expect(t2!.resolved).toEqual({ duty: "review", level: 3 });
  });

  it("respects a profile override that removes the by-name ref (economy self-review)", () => {
    const config = readLive();
    const refs = buildDisciplineRefMap(config, "economy");
    // economy overrides T2-deep review -> self-review, so no by-name ref remains.
    expect(refs.find((r) => r.tier === "T2-deep" && r.field === "review")).toBeUndefined();
  });
});

// ── Cell compatibility ────────────────────────────────────────────────────────
describe("validateCellCompatibility", () => {
  const targets = [
    { id: "cc-opus", runtime: "claude-code", model: "opus" },
    { id: "gcall", runtime: "garrison-call", model: "qwen2.5:3b" }
  ];
  it("a skill cell on garrison-call is a violation", () => {
    const errs = validateCellCompatibility({ skill: "garrison-plan", target: "gcall", effort: "low" }, targets);
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("skill-needs-agentic-target");
  });
  it("a skill cell on an agentic runtime (claude-code) is fine", () => {
    expect(validateCellCompatibility({ skill: "garrison-plan", target: "cc-opus" }, targets)).toEqual([]);
  });
  it("a skill cell with no target is a violation", () => {
    const errs = validateCellCompatibility({ skill: "garrison-plan" }, targets);
    expect(errs[0].code).toBe("skill-without-target");
  });
  it("a non-skill cell imposes no runtime constraint", () => {
    expect(validateCellCompatibility({ target: "gcall", effort: "low" }, targets)).toEqual([]);
  });
});

// ── Full migration on a fixture dir (fold + siblings + retained + idempotence) ─
const FIXTURE_ROUTING: RoutingConfig = {
  version: 2,
  activeProfile: "main",
  taskTypes: ["plan", "code", "review", "report"],
  tiers: ["T0-trivial", "T1-standard", "T2-deep"],
  tierDefinitions: {
    "T0-trivial": "A one-shot answer. No design.",
    "T1-standard": "Ordinary bounded work.",
    "T2-deep": "High stakes, wide blast radius."
  },
  targets: [
    { id: "cc-opus-high", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "opus", effort: "high" },
    { id: "cc-haiku-low", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "haiku", effort: "low" },
    { id: "gcall-low", type: "runtime-target", runtime: "garrison-call", provider: "ollama-local", model: "qwen2.5:3b", effort: "low" }
  ],
  profiles: {
    main: {
      matrix: {
        defaults: { target: "cc-haiku-low" },
        columns: { "T2-deep": "cc-opus-high" },
        rows: {
          plan: { default: "cc-opus-high", cells: { "T0-trivial": "cc-haiku-low" } },
          code: { cells: { "T0-trivial": "cc-haiku-low", "T2-deep": "cc-opus-high" } },
          review: { default: "cc-opus-high", cells: {} }
        }
      },
      disciplineOverrides: {}
    },
    econ: {
      matrix: {
        defaults: { target: "gcall-low" },
        columns: {},
        rows: { plan: { default: "gcall-low", cells: {} } }
      },
      disciplineOverrides: { "T2-deep": { review: "self-review" } }
    }
  },
  discipline: {
    "T0-trivial": { review: "none", testing: "none" },
    "T1-standard": { review: "self-review", testing: "tests" },
    "T2-deep": { review: "review-by:default", testing: "full-gates" }
  },
  phaseSkills: { bindings: { plan: "garrison-plan" }, overrides: {} }
};

const FIXTURE_APM = [
  "name: fixture-op",
  "version: 0.1.0",
  "target: claude",
  "dependencies:",
  "  apm: []",
  "x-garrison:",
  "  composition:",
  "    id: comp",
  "    name: Fixture Op",
  "    global_config:",
  "      projects_root: ~/dev",
  "      vault: default",
  "      platform: claude-code",
  "      permissions_mode: auto",
  "      observability_config:",
  "        log_sink: runner",
  "    selections: {}",
  "    prompt_sources:",
  "      orchestrator: .garrison/prompts/orchestrator.md",
  "      soul: .garrison/prompts/soul.md",
  ""
].join("\n");

describe("migrateRouterConfig (fixture)", () => {
  let tmp: string;
  let compDir: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "router-migrate-"));
    compDir = path.join(tmp, "comp");
    await fsp.mkdir(path.join(compDir, ".garrison"), { recursive: true });
    await fsp.writeFile(path.join(compDir, ".garrison", "routing.json"), JSON.stringify(FIXTURE_ROUTING, null, 2));
    await fsp.writeFile(path.join(compDir, "apm.yml"), FIXTURE_APM);
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  function loadComposition(apmPath: string) {
    const manifest = yaml.load(fs.readFileSync(apmPath, "utf8")) as {
      "x-garrison": { composition: Record<string, unknown> };
    };
    return manifest["x-garrison"].composition;
  }

  type Block = Parameters<typeof parseCompositionV4>[0];

  it("folds the active profile into apm.yml as valid composition v4", async () => {
    const result = await migrateRouterConfig(compDir);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.activeProfile).toBe("main");

    const block = loadComposition(path.join(compDir, "apm.yml"));
    expect(block.schema).toBe(4);
    // Parses under the canonical v4 schema (proves the fold is well-formed).
    const parsed = parseCompositionV4(block as Block);
    expect(parsed.schema).toBe(4);
    expect(parsed.duties.map((d) => d.id).sort()).toEqual(["code", "plan", "report", "review"]);
    // Targets shed effort + dedupe: cc-opus, cc-haiku, gcall.
    expect(parsed.targets.map((t) => t.id).sort()).toEqual(["cc-haiku", "cc-opus", "gcall"]);
    for (const t of parsed.targets) expect("effort" in t).toBe(false);
  });

  it("backs up routing.json to routing.json.v3.bak with the original bytes", async () => {
    const original = fs.readFileSync(path.join(compDir, ".garrison", "routing.json"), "utf8");
    await migrateRouterConfig(compDir);
    const bak = fs.readFileSync(path.join(compDir, ".garrison", "routing.json.v3.bak"), "utf8");
    expect(bak).toBe(original);
  });

  it("wires only explicit-row task types; retains unselected duties with resolved cells", async () => {
    const result = await migrateRouterConfig(compDir);
    const fold = result.activeFold!;
    // main has explicit rows for plan/code/review; report has none -> retained-only.
    expect(fold.selectedDuties.sort()).toEqual(["code", "plan", "review"]);
    const report = fold.duties.find((d) => d.id === "report")!;
    expect(fold.selectedDuties).not.toContain("report");
    // Retained: report's cells still resolve (defaults cc-haiku, T2-deep column cc-opus).
    expect(report.levels[0].cell!.target).toBe("cc-haiku"); // T0 -> defaults
    expect(report.levels[2].cell!.target).toBe("cc-opus"); // T2 -> column
  });

  it("attaches skills from phaseSkills.bindings and the effort onto leaf cells", async () => {
    const result = await migrateRouterConfig(compDir);
    const plan = result.activeFold!.duties.find((d) => d.id === "plan")!;
    // plan is bound to garrison-plan; T0 cell -> cc-haiku (from row cell), effort low.
    expect(plan.levels[0].cell).toEqual({ skill: "garrison-plan", target: "cc-haiku", effort: "low" });
    // review is unbound -> no skill on its cells.
    const review = result.activeFold!.duties.find((d) => d.id === "review")!;
    expect(review.levels[0].cell!.skill).toBeUndefined();
  });

  it("emits a sibling composition per non-active profile, swapping the fold", async () => {
    const result = await migrateRouterConfig(compDir);
    expect(result.siblings.map((s) => s.profile)).toEqual(["econ"]);
    const sibling = result.siblings[0];
    expect(sibling.id).toBe("comp-econ");
    expect(fs.existsSync(sibling.apmPath)).toBe(true);
    const block = loadComposition(sibling.apmPath);
    expect(block.id).toBe("comp-econ");
    const parsed = parseCompositionV4(block as Block);
    expect(parsed.schema).toBe(4);
    // econ only wires `plan` (its one explicit row).
    expect(parsed.selectedDuties).toEqual(["plan"]);
    // Same shared targets.
    expect(parsed.targets.map((t) => t.id).sort()).toEqual(["cc-haiku", "cc-opus", "gcall"]);
  });

  it("reports cell-compatibility violations without aborting (sibling skill-on-garrison-call)", async () => {
    const result = await migrateRouterConfig(compDir);
    // main (active) is clean; econ routes plan (skill garrison-plan) to gcall (garrison-call).
    expect(result.violations.length).toBeGreaterThan(0);
    const econ = result.violations.filter((v) => v.profile === "econ");
    expect(econ.some((v) => v.error.code === "skill-needs-agentic-target")).toBe(true);
  });

  it("rewrites the by-name discipline ref and reports it in the active fold", async () => {
    const result = await migrateRouterConfig(compDir);
    const ref = result.activeFold!.disciplineRefs.find((r) => r.field === "review" && r.tier === "T2-deep");
    expect(ref).toBeTruthy();
    expect(ref!.resolved).toEqual({ duty: "review", level: 3 });
  });

  it("produces a non-empty apm.yml diff showing the added v4 blocks", async () => {
    const result = await migrateRouterConfig(compDir);
    expect(result.diff).toMatch(/\+.*schema: 4/);
    expect(result.diff).toMatch(/\+\s*duties:/);
    expect(result.diff).toMatch(/\+\s*targets:/);
  });

  it("refuses to run twice (idempotent - the .v3.bak marker)", async () => {
    const first = await migrateRouterConfig(compDir);
    expect(first.ok).toBe(true);
    const second = await migrateRouterConfig(compDir);
    expect(second.ok).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.reason).toMatch(/already exists/);
  });

  it("writes the backup marker BEFORE mutating apm.yml (backup-before-write, codex S3c)", async () => {
    // Order proof: at the moment apm.yml gains schema:4, the .v3.bak marker must
    // already exist — so a crash between them cannot leave a migrated apm.yml
    // with no idempotence marker (which a re-run would re-fold + corrupt).
    const bakPath = path.join(compDir, ".garrison", "routing.json.v3.bak");
    const apmPath = path.join(compDir, "apm.yml");
    let bakExistedWhenApmWritten: boolean | null = null;
    const realWriteFile = fsp.writeFile.bind(fsp);
    const spy = vi.spyOn(fsp, "writeFile").mockImplementation(async (p: any, data: any, enc?: any) => {
      if (typeof p === "string" && p === apmPath && bakExistedWhenApmWritten === null) {
        bakExistedWhenApmWritten = fs.existsSync(bakPath);
      }
      return realWriteFile(p, data, enc);
    });
    try {
      const res = await migrateRouterConfig(compDir);
      expect(res.ok).toBe(true);
      expect(bakExistedWhenApmWritten).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("aborts before writing when the ACTIVE profile has a skill/target incompatibility", async () => {
    // Make main route a bound task type to garrison-call -> active violation.
    const broken: RoutingConfig = JSON.parse(JSON.stringify(FIXTURE_ROUTING));
    broken.profiles!.main.matrix!.rows!.plan = { default: "gcall-low", cells: {} };
    await fsp.writeFile(path.join(compDir, ".garrison", "routing.json"), JSON.stringify(broken, null, 2));
    await expect(migrateRouterConfig(compDir)).rejects.toThrow(/violation/i);
    // Nothing written: no marker, apm.yml unchanged (still v3, no duties).
    expect(fs.existsSync(path.join(compDir, ".garrison", "routing.json.v3.bak"))).toBe(false);
    const block = loadComposition(path.join(compDir, "apm.yml"));
    expect(block.schema).toBeUndefined();
    expect(block.duties).toBeUndefined();
  });
});
