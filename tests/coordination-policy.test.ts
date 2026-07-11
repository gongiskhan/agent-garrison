// GARRISON-FLOW-V2 S6 (D3/D6) — the composer's coordination section flows
// through the policy compiler: the seed carries it, compilePolicy passes it
// through ONLY when present (so a legacy config never coordinates), validation
// rejects mistyped knobs, and the compile stays byte-stable.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// @ts-ignore - pure .mjs core
import { compilePolicy, validatePolicyConfig, stableStringify } from "../fittings/seed/orchestrator/lib/policy-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(HERE, "..", "fittings", "seed", "orchestrator", "config", "routing.seed.json");
const seed = () => JSON.parse(readFileSync(SEED_PATH, "utf8"));

describe("coordination policy (S6 seed + compiler)", () => {
  it("the seed carries a coordination section with the four surfaced controls + seeded lease list", () => {
    const c = seed().coordination;
    expect(c).toBeTruthy();
    expect(c.enabled).toBe(true);
    expect(c.serializeWhenUnavailable).toBe(true);
    expect(c.thresholds).toEqual({ heavyFiles: 3, heavyRatio: 0.5 });
    // Seeded lockfile leases (D6) — two runs must never rewrite these at once.
    expect(c.exclusiveLeases).toEqual(
      expect.arrayContaining(["apm.lock.yaml", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"])
    );
  });

  it("compilePolicy carries coordination through verbatim (turns the engine gate ON)", () => {
    const policy = compilePolicy(seed(), "balanced");
    expect(policy.coordination).toBeTruthy();
    expect(policy.coordination.enabled).toBe(true);
    expect(policy.coordination.thresholds.heavyFiles).toBe(3);
    expect(policy.coordination.exclusiveLeases).toContain("package-lock.json");
    // fences + leaseTtlMinutes pass through even though the composer doesn't surface them.
    expect(policy.coordination.leaseTtlMinutes).toBe(60);
    expect(policy.coordination.fences.trailer).toBe("Garrison-Card");
  });

  it("a config WITHOUT a coordination section compiles WITHOUT one (legacy never coordinates)", () => {
    const cfg = seed();
    delete cfg.coordination;
    const policy = compilePolicy(cfg, "balanced");
    expect("coordination" in policy).toBe(false);
  });

  it("the policy compile is byte-stable with coordination present", () => {
    const a = stableStringify(compilePolicy(seed(), "balanced"));
    const b = stableStringify(compilePolicy(seed(), "balanced"));
    expect(a).toBe(b);
  });

  it("validation rejects mistyped coordination knobs", () => {
    const bad = (mut: (c: any) => void) => {
      const cfg = seed();
      cfg.coordination = { enabled: true, thresholds: { heavyFiles: 3, heavyRatio: 0.5 }, exclusiveLeases: [] };
      mut(cfg.coordination);
      return validatePolicyConfig(cfg);
    };
    expect(bad((c) => (c.enabled = "yes"))).toEqual(expect.arrayContaining([expect.stringContaining("coordination.enabled")]));
    expect(bad((c) => (c.thresholds.heavyFiles = 0))).toEqual(
      expect.arrayContaining([expect.stringContaining("heavyFiles")])
    );
    expect(bad((c) => (c.thresholds.heavyRatio = 2))).toEqual(
      expect.arrayContaining([expect.stringContaining("heavyRatio")])
    );
    expect(bad((c) => (c.exclusiveLeases = ["ok", 3]))).toEqual(
      expect.arrayContaining([expect.stringContaining("exclusiveLeases")])
    );
  });

  it("valid coordination edits pass validation (composer round-trip)", () => {
    const cfg = seed();
    cfg.coordination = {
      enabled: false,
      thresholds: { heavyFiles: 2, heavyRatio: 0.25 },
      exclusiveLeases: ["Cargo.lock"],
      serializeWhenUnavailable: false
    };
    expect(validatePolicyConfig(cfg)).toEqual([]);
  });
});
