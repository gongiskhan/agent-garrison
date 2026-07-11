// GARRISON-FLOW-V2 S8 — the probe-question task type routes to the fast target
// (agent-sdk-haiku-fast) in EVERY profile at EVERY tier (D23/D29e), and the seed
// still compiles byte-stably. The generator resolves its model target from this
// compiled cell.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// @ts-ignore - pure .mjs
import { compilePolicy, validateRoutingConfig, stableStringify } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

const SEED = join(__dirname, "..", "fittings", "seed", "orchestrator", "config", "routing.seed.json");
const config = JSON.parse(readFileSync(SEED, "utf8"));

describe("probe-question policy cell", () => {
  it("the seed (with probe-question) still validates with no errors", () => {
    expect(validateRoutingConfig(config)).toEqual([]);
  });

  it("probe-question is a declared task type", () => {
    expect(config.taskTypes).toContain("probe-question");
  });

  it.each(["balanced", "economy", "premium"])("profile %s routes probe-question to agent-sdk-haiku-fast at every tier", (profile) => {
    const policy = compilePolicy(config, profile);
    const row = policy.matrix["probe-question"];
    expect(row).toBeTruthy();
    for (const tier of policy.tiers) {
      expect(row[tier].targetId).toBe("agent-sdk-haiku-fast");
      expect(row[tier].runtime).toBe("agent-sdk");
      expect(row[tier].model).toBe("claude-haiku-4-5");
    }
  });

  it("compiles byte-stably (two compiles produce identical policy bytes)", () => {
    const a = stableStringify(compilePolicy(config, "balanced"));
    const b = stableStringify(compilePolicy(config, "balanced"));
    expect(a).toBe(b);
  });
});
