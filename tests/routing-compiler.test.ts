import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Pure .mjs core, typed by its hand-written routing-core.d.mts sibling.
// GARRISON-UNIFY-V1 S1: the seed is now the v2 policy schema (matrix cells
// resolve straight to TARGETS; the v1 role layer survives only as derived
// ladder labels). These tests assert the v2 contract; v1 migration coverage
// lives in tests/orchestrator-policy.test.ts.
import {
  compileRouting,
  resolveRoute,
  resolveDiscipline,
  validateRoutingConfig,
  routingMarkerV2
} from "../fittings/seed/orchestrator/lib/routing-core.mjs";
import type { TaskType, RuntimeTarget, Classification } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

const SEED = join(__dirname, "..", "fittings", "seed", "orchestrator", "config", "routing.seed.json");
const config = JSON.parse(readFileSync(SEED, "utf8"));

describe("routing compiler (MR1a)", () => {
  it("seed config validates (no errors)", () => {
    expect(validateRoutingConfig(config)).toEqual([]);
  });

  // routing-compile-ok + profiles-compile-ok
  it("compiles the active profile with its marker, byte-stably", () => {
    const a = compileRouting(config, "balanced");
    const b = compileRouting(config, "balanced");
    expect(a).toBe(b); // byte-stable
    expect(a).toContain(routingMarkerV2("balanced"));
    expect(a).toContain("<!-- garrison:routing v2 profile=balanced -->");
  });

  it("a different profile compiles to different, byte-stable bytes", () => {
    const balanced = compileRouting(config, "balanced");
    const economy = compileRouting(config, "economy");
    expect(economy).toBe(compileRouting(config, "economy")); // byte-stable
    expect(economy).not.toBe(balanced); // profiles differ
    expect(economy).toContain(routingMarkerV2("economy"));
    // economy routes code at cc-ollama-qwen; balanced at cc-opus-high for T2
    expect(economy).toContain("cc-ollama-qwen");
    expect(balanced).toContain("cc-opus-high");
  });

  // continuations-compile-ok
  it("renders both seeded continuation instructions", () => {
    const compiled = compileRouting(config, "balanced");
    expect(compiled).toContain("ex-secrets");
    expect(compiled).toContain("Work kinds → phase rails");
    expect(compiled).toContain("full-feature");
  });

  it("renders the reply-token duty + discipline + matrix", () => {
    const compiled = compileRouting(config, "balanced");
    expect(compiled).toContain("[route: <target-id> | rule: <rule-id> | profile: <name>]");
    expect(compiled).toMatch(/T2-deep.*full-gates/);
    expect(compiled).toContain("task-type ×"); // matrix header text
  });
});

describe("routing resolver (MR1c core — pure code)", () => {
  // exception → target
  it("an ordered exception resolves first (image)", () => {
    const r = resolveRoute(config, "balanced", {
      taskType: "code",
      tier: "T1-standard",
      matchedException: "ex-image"
    } as Classification);
    expect(r.targetId).toBe("sec-gemini");
    expect(r.ruleId).toBe("exception:ex-image");
    expect(r.via).toBe("exception");
  });

  it("routes internal vision to tool-capable Claude targets, with a stronger adversarial pass", () => {
    const normal = resolveRoute(config, "balanced", {
      taskType: "image",
      tier: "T1-standard",
      matchedException: "ex-automation-vision"
    } as Classification);
    const adversarial = resolveRoute(config, "balanced", {
      taskType: "image",
      tier: "T2-deep",
      matchedException: "ex-automation-vision-adversarial"
    } as Classification);

    expect(normal.targetId).toBe("cc-sonnet-med");
    expect(normal.ruleId).toBe("exception:ex-automation-vision");
    expect(adversarial.targetId).toBe("cc-opus-high");
    expect(adversarial.ruleId).toBe("exception:ex-automation-vision-adversarial");
  });

  // cell → target
  it("a matrix cell resolves (code/T2 → cc-opus-high)", () => {
    const r = resolveRoute(config, "balanced", { taskType: "code", tier: "T2-deep" } as Classification);
    expect(r.targetId).toBe("cc-opus-high");
    expect(r.via).toBe("cell");
    expect(r.role).toBe("expert"); // derived ladder label survives for logging
  });

  // row default
  it("falls to the row default when the cell is empty (research/T1 → cc-sonnet-med)", () => {
    const r = resolveRoute(config, "balanced", { taskType: "research", tier: "T1-standard" } as Classification);
    expect(r.targetId).toBe("cc-sonnet-med");
    expect(r.via).toBe("row-default");
  });

  // column default — row default outranks column default (cell > row > col > global)
  it("row default outranks the column default; a missing row falls to the column default", () => {
    const r = resolveRoute(config, "balanced", { taskType: "writing", tier: "T2-deep" } as Classification);
    // writing row has no T2 cell but a default; row default wins before the column default.
    expect(r.via).toBe("row-default");
    const noRows = JSON.parse(JSON.stringify(config));
    noRows.profiles.balanced.matrix.rows = {};
    const r2 = resolveRoute(noRows, "balanced", { taskType: "zzz" as TaskType, tier: "T2-deep" } as Classification);
    expect(r2.targetId).toBe("cc-opus-high");
    expect(r2.via).toBe("column-default");
  });

  // global default
  it("falls to the global default for an unknown task type at T1", () => {
    const noRows = JSON.parse(JSON.stringify(config));
    noRows.profiles.balanced.matrix.rows = {};
    const r = resolveRoute(noRows, "balanced", { taskType: "zzz" as TaskType, tier: "T1-standard" } as Classification);
    expect(r.targetId).toBe("cc-sonnet-med");
    expect(r.via).toBe("global-default");
  });

  // per-profile matrices — same prompt, different profile, different target
  it("the same classification resolves to different targets under different profiles", () => {
    const cls: Classification = { taskType: "code", tier: "T2-deep" };
    const balanced = resolveRoute(config, "balanced", cls);
    const economy = resolveRoute(config, "economy", cls);
    expect(balanced.targetId).toBe("cc-opus-high");
    expect(economy.targetId).toBe("cc-ollama-qwen");
    expect((balanced.target as RuntimeTarget)?.provider).toBe("anthropic-plan");
    expect((economy.target as RuntimeTarget)?.provider).toBe("ollama-local");
  });

  it("resolves discipline with profile overrides", () => {
    const balancedT2 = resolveDiscipline(config, "balanced", "T2-deep");
    expect(balancedT2.evidence).toBe("video");
    const economyT2 = resolveDiscipline(config, "economy", "T2-deep");
    expect(economyT2.evidence).toBe("text"); // economy lightens T2 evidence
  });

  // Runtime freedom (D29 / S9)
  it("every seed target declares an authMode", () => {
    const modes = new Set(["subscription", "api-key", "local"]);
    for (const t of config.targets) {
      expect(t.authMode, `${t.id} has no authMode`).toBeTruthy();
      expect(modes.has(t.authMode), `${t.id} authMode ${t.authMode} not a known mode`).toBe(true);
    }
  });

  it("seeds the fast target agent-sdk-haiku-fast (agent-sdk / Anthropic / subscription)", () => {
    const fast = config.targets.find((t: RuntimeTarget) => t.id === "agent-sdk-haiku-fast");
    expect(fast).toBeTruthy();
    expect(fast.runtime).toBe("agent-sdk");
    expect(fast.provider).toBe("anthropic");
    expect(fast.model).toBe("claude-haiku-4-5");
    expect(fast.authMode).toBe("subscription");
  });

  it("points latency-sensitive balanced cells at the fast target", () => {
    // report row default and the trivial writing/ops one-shots resolve to the fast target.
    const report = resolveRoute(config, "balanced", { taskType: "report" as TaskType, tier: "T1-standard" } as Classification);
    expect(report.targetId).toBe("agent-sdk-haiku-fast");
    for (const tt of ["writing", "ops"]) {
      const r = resolveRoute(config, "balanced", { taskType: tt as TaskType, tier: "T0-trivial" } as Classification);
      expect(r.targetId, `${tt}/T0-trivial`).toBe("agent-sdk-haiku-fast");
      expect(r.via).toBe("cell");
    }
    // the conversational catch-all (other/T0) stays on the PTY operative path.
    const otherT0 = resolveRoute(config, "balanced", { taskType: "other", tier: "T0-trivial" } as Classification);
    expect(otherT0.targetId).toBe("cc-haiku-low");
    // it did not disturb the standard tiers (writing/T1 still the row default).
    const writingT1 = resolveRoute(config, "balanced", { taskType: "writing", tier: "T1-standard" } as Classification);
    expect(writingT1.targetId).toBe("cc-sonnet-med");
  });

  it("every seed profile carries a full compute ladder and a complete verb matrix", () => {
    for (const name of Object.keys(config.profiles)) {
      const p = config.profiles[name];
      expect(p.computeLadder.length).toBeGreaterThanOrEqual(3);
      for (const phase of [
        "plan",
        "implement",
        "review",
        "adversarial-review",
        "test",
        "adversarial-test",
        "ux-qa",
        "walkthrough",
        "validate",
        "codex-checkpoint",
        "report"
      ]) {
        expect(p.matrix.rows[phase]?.default, `${name}/${phase}`).toBeTruthy();
      }
    }
  });
});
