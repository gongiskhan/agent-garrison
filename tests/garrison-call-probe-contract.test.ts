import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The Improver probe generator makes no live model call (questions are
// deterministic templates); resolveProbeTarget only resolves + logs a target.
// The shipped probe cell must therefore resolve to the same fast Anthropic SDK
// target as the rest of the no-Ollama default policy.
const REPO = path.resolve(__dirname, "..");
const ROUTING_CORE = path.join(REPO, "fittings/seed/orchestrator/lib/routing-core.mjs");
const PROBE_CORE = path.join(REPO, "fittings/seed/improver/lib/probe-core.mjs");
const SEED_ROUTING = path.join(REPO, "fittings/seed/orchestrator/config/routing.seed.json");

const routing = await import(pathToFileURL(ROUTING_CORE).href);
const probe = await import(pathToFileURL(PROBE_CORE).href);

function compileSeedPolicy() {
  const cfg = JSON.parse(readFileSync(SEED_ROUTING, "utf8"));
  expect(routing.validateRoutingConfig(cfg)).toEqual([]);
  return routing.compilePolicy(cfg, cfg.activeProfile ?? null);
}

describe("Improver probe resolution follows the active Orchestrator policy", () => {
  it("resolveProbeTarget resolves the seed matrix cell to subscription Haiku", () => {
    const policy = compileSeedPolicy();
    const t = probe.resolveProbeTarget(policy);
    expect(t).toMatchObject({
      targetId: "agent-sdk-haiku-fast",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-haiku-4-5"
    });
    expect(t.provider).toBe("anthropic");
    expect(t.runtime).toBe("agent-sdk");
    expect(t.targetId).toBeTruthy();
  });

  it("the compiled policy carries a probe-question row (the probe is not dead)", () => {
    const policy = compileSeedPolicy();
    const row = policy.matrix["probe-question"];
    expect(row, "compiled policy must carry a probe-question row").toBeTruthy();
    const cell = row[Object.keys(row)[0]];
    expect(cell.provider).toBe("anthropic");
    expect(JSON.stringify(policy)).not.toMatch(/ollama|qwen/i);
  });
});
