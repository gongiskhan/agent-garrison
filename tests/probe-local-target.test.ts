import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The Improver Probe follows the active Anthropic-only Orchestrator seed. This
// compiles the config the same way the runner does and guards against a stale
// local-daemon target being reintroduced.
const REPO = path.resolve(__dirname, "..");
const ROUTING_CORE = path.join(REPO, "fittings/seed/orchestrator/lib/routing-core.mjs");
const PROBE_CORE = path.join(REPO, "fittings/seed/improver/lib/probe-core.mjs");
const COMP_ROUTING = path.join(REPO, "fittings/seed/orchestrator/config/routing.seed.json");

describe("probe-question routes to subscription Haiku", () => {
  it("the seed routing config seeds a probe-question row → an Anthropic agent-sdk target", async () => {
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
    expect(cell.provider).toBe("anthropic");
    expect(cell.model).toBe("claude-haiku-4-5");
    expect(cell.targetId).toBe("agent-sdk-haiku-fast");
  });

  it("resolveProbeTarget resolves the active target from the compiled policy (probe is not dead)", async () => {
    const core = await import(pathToFileURL(ROUTING_CORE).href);
    const pc = await import(pathToFileURL(PROBE_CORE).href);
    const cfg = JSON.parse(readFileSync(COMP_ROUTING, "utf8"));
    const policy = core.compilePolicy(cfg, cfg.activeProfile ?? null);
    const t = pc.resolveProbeTarget(policy);
    expect(t.provider).toBe("anthropic");
    expect(t.runtime).toBe("agent-sdk");
    expect(t.targetId).toBe("agent-sdk-haiku-fast");
  });

  it("the shipped policy retains no Ollama provider or Qwen target", () => {
    const raw = readFileSync(COMP_ROUTING, "utf8");
    expect(raw).not.toMatch(/ollama|qwen/i);
  });
});
