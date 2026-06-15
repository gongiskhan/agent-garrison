import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Pure .mjs core, typed by its hand-written routing-core.d.mts sibling.
import {
  compileRouting,
  resolveRole,
  resolveRoute,
  resolveDiscipline,
  validateRoutingConfig,
  routingMarker,
  ROLES
} from "../fittings/seed/model-router/lib/routing-core.mjs";
import type { TaskType, RuntimeTarget, Classification } from "../fittings/seed/model-router/lib/routing-core.mjs";

const SEED = join(__dirname, "..", "fittings", "seed", "model-router", "config", "routing.seed.json");
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
    expect(a).toContain(routingMarker("balanced"));
    expect(a).toContain("<!-- garrison:routing v1 profile=balanced -->");
  });

  it("a different profile compiles to different, byte-stable bytes", () => {
    const balanced = compileRouting(config, "balanced");
    const economy = compileRouting(config, "economy");
    expect(economy).toBe(compileRouting(config, "economy")); // byte-stable
    expect(economy).not.toBe(balanced); // profiles differ
    expect(economy).toContain(routingMarker("economy"));
    // economy maps expert→ollama-local; balanced→opus
    expect(economy).toContain("ollama-local");
    expect(balanced).toContain("opus");
  });

  // continuations-compile-ok
  it("renders both seeded continuation instructions", () => {
    const compiled = compileRouting(config, "balanced");
    expect(compiled).toContain("Implement this plan?");
    expect(compiled).toContain("Act on this report?");
    expect(compiled).toContain("write the output to the Artifact Store");
  });

  it("renders the reply-token duty + discipline + matrix", () => {
    const compiled = compileRouting(config, "balanced");
    expect(compiled).toContain("[route: <target-id> | rule: <rule-id> | profile: <name>]");
    expect(compiled).toMatch(/T2-deep.*full-gates/);
    expect(compiled).toContain("task-type ×"); // matrix header text
  });
});

describe("routing resolver (MR1c core — pure code)", () => {
  // exception → role
  it("an ordered exception resolves first (image)", () => {
    const r = resolveRole(config, { taskType: "code", tier: "T1-standard", matchedException: "ex-image" });
    expect(r.role).toBe("image");
    expect(r.ruleId).toBe("exception:ex-image");
    expect(r.via).toBe("exception");
  });

  // cell → role
  it("a matrix cell resolves (code/T2 → expert)", () => {
    const r = resolveRole(config, { taskType: "code", tier: "T2-deep" });
    expect(r.role).toBe("expert");
    expect(r.via).toBe("cell");
  });

  // row default
  it("falls to the row default when the cell is empty (research/T1 → standard)", () => {
    const r = resolveRole(config, { taskType: "research", tier: "T1-standard" });
    expect(r.role).toBe("standard");
    expect(r.via).toBe("row-default");
  });

  // column default — row default outranks column default (cell > row > col > global)
  it("row default outranks the column default; a missing row falls to the column default", () => {
    const r = resolveRole(config, { taskType: "writing", tier: "T2-deep" });
    // writing row has no T2 cell but default 'standard'; row default wins before the column default.
    expect(r.via).toBe("row-default");
    const r2 = resolveRole({ ...config, matrix: { ...config.matrix, rows: {} } }, { taskType: "zzz" as TaskType, tier: "T2-deep" });
    expect(r2.role).toBe("expert");
    expect(r2.via).toBe("column-default");
  });

  // global default
  it("falls to the global default for an unknown task type at T1", () => {
    const r = resolveRole({ ...config, matrix: { ...config.matrix, rows: {} } }, { taskType: "zzz" as TaskType, tier: "T1-standard" });
    expect(r.role).toBe("standard");
    expect(r.via).toBe("global-default");
  });

  // rolemap-ok — same prompt, different profile, different target, same matrix
  it("the same classification resolves to different targets under different profiles", () => {
    const cls: Classification = { taskType: "code", tier: "T2-deep" }; // → role expert
    const balanced = resolveRoute(config, "balanced", cls);
    const economy = resolveRoute(config, "economy", cls);
    expect(balanced.role).toBe("expert");
    expect(economy.role).toBe("expert"); // matrix unchanged → same role
    expect(balanced.targetId).toBe("cc-opus-high");
    expect(economy.targetId).toBe("cc-ollama-qwen"); // roleMap differs → different target
    expect((balanced.target as RuntimeTarget)?.provider).toBe("anthropic-plan");
    expect((economy.target as RuntimeTarget)?.provider).toBe("ollama-local");
  });

  it("resolves discipline with profile overrides", () => {
    const balancedT2 = resolveDiscipline(config, "balanced", "T2-deep");
    expect(balancedT2.evidence).toBe("video");
    const economyT2 = resolveDiscipline(config, "economy", "T2-deep");
    expect(economyT2.evidence).toBe("text"); // economy lightens T2 evidence
  });

  it("every role in the fixed vocabulary is mapped by every seed profile", () => {
    for (const name of Object.keys(config.profiles)) {
      for (const role of ROLES) {
        expect(config.profiles[name].roleMap[role]).toBeTruthy();
      }
    }
  });
});
