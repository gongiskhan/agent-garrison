import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// WS7 hard constraint: the Improver Probe's question-generation target must be
// the LOCAL non-Anthropic model. This test compiles the composition routing
// config the same way the runner does and asserts the probe-question cell
// resolves to a local (ollama) agent-sdk target — never an Anthropic endpoint.
const REPO = path.resolve(__dirname, "..");
const ROUTING_CORE = path.join(REPO, "fittings/seed/orchestrator/lib/routing-core.mjs");
const PROBE_CORE = path.join(REPO, "fittings/seed/improver/lib/probe-core.mjs");
const COMP_ROUTING = path.join(REPO, "fittings/seed/orchestrator/config/routing.seed.json");

describe("probe-question routes to the LOCAL model (never Anthropic) — WS7", () => {
  it("the seed routing config seeds a probe-question row → an ollama-local agent-sdk target", async () => {
    const core = await import(pathToFileURL(ROUTING_CORE).href);
    const cfg = JSON.parse(readFileSync(COMP_ROUTING, "utf8"));
    expect(cfg.taskTypes).toContain("probe-question");
    const errs = core.validateRoutingConfig(cfg);
    expect(errs).toEqual([]);

    const policy = core.compilePolicy(cfg, cfg.activeProfile ?? null) as {
      matrix: Record<string, Record<string, { targetId: string; provider: string; runtime: string; model: string }>>;
    };
    const row = policy.matrix["probe-question"];
    expect(row, "compiled policy must carry a probe-question row").toBeTruthy();
    const cell = row[Object.keys(row)[0]];
    expect(cell.runtime).toBe("agent-sdk");
    expect(cell.provider).toBe("ollama-local");
    // the constraint: never an Anthropic endpoint for probe questions
    expect(cell.provider).not.toBe("anthropic");
    expect(cell.targetId).toBeTruthy();
  });

  it("resolveProbeTarget resolves the local target from the compiled policy (probe is not dead)", async () => {
    const core = await import(pathToFileURL(ROUTING_CORE).href);
    const pc = await import(pathToFileURL(PROBE_CORE).href);
    const cfg = JSON.parse(readFileSync(COMP_ROUTING, "utf8"));
    const policy = core.compilePolicy(cfg, cfg.activeProfile ?? null);
    const t = pc.resolveProbeTarget(policy);
    expect(t.provider).toBe("ollama-local");
    expect(t.provider).not.toBe("anthropic");
    expect(t.runtime).toBe("agent-sdk");
  });

  it("ollama-local resolves to a localhost base URL (the default-deny fence keeps it off remote endpoints)", async () => {
    const providers = await import(pathToFileURL(path.join(REPO, "fittings/seed/agent-sdk-runtime/lib/providers.mjs")).href);
    const spec = providers.SDK_PROVIDERS["ollama-local"];
    expect(spec.baseUrl).toMatch(/localhost|127\.0\.0\.1/);
    expect(spec.baseUrl).not.toMatch(/anthropic\.com/);
  });
});
