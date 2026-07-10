import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — pure .mjs core typed by routing-core.d.mts
import {
  buildClassifierPrompt,
  parseClassification,
  resolveRoute
} from "../fittings/seed/orchestrator/lib/routing-core.mjs";

const config = JSON.parse(
  readFileSync(join(__dirname, "..", "fittings", "seed", "orchestrator", "config", "routing.seed.json"), "utf8")
);

describe("Stage A classifier prompt (MR1c)", () => {
  it("the classifier prompt lists every task type, tier (+definition), exception, and the user task", () => {
    const p = buildClassifierPrompt(config, "fix the failing login test");
    for (const tt of config.taskTypes) expect(p).toContain(tt);
    for (const tier of config.tiers) expect(p).toContain(tier);
    expect(p).toContain(config.tierDefinitions["T2-deep"].slice(0, 20));
    for (const ex of config.exceptions) expect(p).toContain(ex.id);
    expect(p).toContain("fix the failing login test");
    expect(p).toMatch(/JSON/i);
  });

  it("truncates a very long task to keep the classification turn cheap", () => {
    const p = buildClassifierPrompt(config, "x".repeat(10000));
    expect(p.length).toBeLessThan(6000);
  });
});

describe("Stage A response parser (MR1c)", () => {
  it("parses a clean single-line JSON reply", () => {
    const c = parseClassification('{"taskType":"code","tier":"T2-deep","matchedException":null}', config);
    expect(c).toEqual({ taskType: "code", tier: "T2-deep", matchedException: null, contextKind: undefined });
  });

  it("parses JSON embedded in prose", () => {
    const c = parseClassification('Sure! Here is the classification: {"taskType":"research","tier":"T1-standard"} — done.', config);
    expect(c?.taskType).toBe("research");
    expect(c?.tier).toBe("T1-standard");
  });

  it("parses a fenced ```json block", () => {
    const c = parseClassification('```json\n{"taskType":"review","tier":"T0-trivial"}\n```', config);
    expect(c?.taskType).toBe("review");
    expect(c?.tier).toBe("T0-trivial");
  });

  it("keeps a valid matchedException and drops an unknown one", () => {
    expect(parseClassification('{"taskType":"code","tier":"T1-standard","matchedException":"ex-secrets"}', config)?.matchedException).toBe("ex-secrets");
    expect(parseClassification('{"taskType":"code","tier":"T1-standard","matchedException":"ex-nope"}', config)?.matchedException).toBeNull();
  });

  it("clamps an out-of-vocabulary taskType→other and tier→T1-standard", () => {
    const c = parseClassification('{"taskType":"banana","tier":"T9"}', config);
    expect(c?.taskType).toBe("other");
    expect(c?.tier).toBe("T1-standard");
  });

  it("returns null when there is no JSON at all", () => {
    expect(parseClassification("I cannot classify this.", config)).toBeNull();
  });

  it("classify→resolve composes: a parsed classification resolves a real route", () => {
    const c = parseClassification('{"taskType":"code","tier":"T2-deep"}', config);
    expect(c).not.toBeNull();
    const route = resolveRoute(config, "balanced", c!);
    expect(route.role).toBe("expert");
    expect(route.targetId).toBe("cc-opus-high");
  });
});
