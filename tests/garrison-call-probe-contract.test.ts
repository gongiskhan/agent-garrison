import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// S2b — the E11 correction: the Improver probe generator makes NO live model call
// (questions are deterministic templates; resolveProbeTarget only resolves + logs a
// target). So S2b changes ZERO probe behavior. This test pins that: the improver's
// resolveProbeTarget contract still resolves its compiled matrix cell UNCHANGED
// after garrison-call lands. No improver code is touched by this slice — a
// regression here would mean something moved the probe-question cell.
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

describe("S2b leaves the Improver probe resolution unchanged (E11 correction)", () => {
  it("resolveProbeTarget still resolves the seed matrix cell to the local ollama target", () => {
    const policy = compileSeedPolicy();
    const t = probe.resolveProbeTarget(policy);
    // The exact contract as it resolves today — a garrison-call-backed target may
    // later repoint this cell (RUN_SPEC assumption 1), but THIS slice must not.
    expect(t).toMatchObject({
      targetId: "sdk-ollama-probe",
      runtime: "agent-sdk",
      provider: "ollama-local",
      model: "qwen2.5:3b"
    });
    // The load-bearing invariant regardless of the exact target id: local, never Anthropic.
    expect(t.provider).not.toBe("anthropic");
    expect(t.runtime).toBe("agent-sdk");
    expect(t.targetId).toBeTruthy();
  });

  it("the compiled policy carries a probe-question row (the probe is not dead)", () => {
    const policy = compileSeedPolicy();
    const row = policy.matrix["probe-question"];
    expect(row, "compiled policy must carry a probe-question row").toBeTruthy();
    const cell = row[Object.keys(row)[0]];
    expect(cell.provider).toBe("ollama-local");
    expect(cell.provider).not.toBe("anthropic");
  });
});
