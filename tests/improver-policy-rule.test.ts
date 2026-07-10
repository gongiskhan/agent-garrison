// S15 (GARRISON-UNIFY-V1, D38) — the Improver's orchestrator-policy rule:
// friction log + run outcomes → reviewable policy proposals, never
// auto-applied.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "..");
const RULE = pathToFileURL(path.join(ROOT, "fittings/seed/improver/lib/orchestrator-policy-rule.mjs")).href;

function outcome(kind: string, gates: Record<string, { status: string }>) {
  return {
    project: "p",
    runId: "r",
    index: { workKind: kind, slices: [{ slice: "s1", gates }] }
  };
}

describe("orchestrator-policy rule (S15/D38)", () => {
  it("a phase failing in >=50% of runs proposes an effort step UP", async () => {
    const mod = await import(RULE);
    const outcomes = [
      outcome("full-feature", { test: { status: "failed" } }),
      outcome("full-feature", { test: { status: "failed" } }),
      outcome("full-feature", { test: { status: "passed" } })
    ];
    const props = mod.analyzeForPolicyProposals({ outcomes, at: "2026-01-01T00:00:00Z" });
    const up = props.find((p: { id: string }) => p.id.startsWith("orchestrator-policy-fail-"));
    expect(up).toBeTruthy();
    expect(up.rule).toBe("orchestrator-policy");
    expect(up.claim).toContain("test");
    expect(up.claim).toContain("2/3");
    expect(up.applyVia).toContain("PUT /routing");
  });

  it("a phase skipped in ALL runs of a kind proposes turning it off in the plan", async () => {
    const mod = await import(RULE);
    const outcomes = [
      outcome("api-change", { designAudit: { status: "skipped" } }),
      outcome("api-change", { designAudit: { status: "skipped" } }),
      outcome("api-change", { designAudit: { status: "skipped" } })
    ];
    const props = mod.analyzeForPolicyProposals({ outcomes, at: "2026-01-01T00:00:00Z" });
    const off = props.find((p: { id: string }) => p.id.startsWith("orchestrator-policy-off-"));
    expect(off).toBeTruthy();
    expect(off.diff).toContain("turn designAudit OFF");
  });

  it("a consistently-clean gate across >=5 runs proposes a step DOWN", async () => {
    const mod = await import(RULE);
    const outcomes = Array.from({ length: 5 }, () => outcome("full-feature", { walkthrough: { status: "passed" } }));
    const props = mod.analyzeForPolicyProposals({ outcomes, at: "2026-01-01T00:00:00Z" });
    const down = props.find((p: { id: string }) => p.id.startsWith("orchestrator-policy-calm-"));
    expect(down).toBeTruthy();
    expect(down.diff).toContain("step DOWN");
  });

  it("repeated friction mentions of a skill propose a binding review", async () => {
    const mod = await import(RULE);
    const frictionLines = [
      { project: "p", line: "- 2026-01-01T00:00:00Z [autothing-walkthrough] flaky capture → tighten retry" },
      { project: "p", line: "- 2026-01-02T00:00:00Z [autothing-walkthrough] missed caption → fix prompt" },
      { project: "p", line: "- 2026-01-03T00:00:00Z [autothing-walkthrough] gallery down → restart serve" }
    ];
    const props = mod.analyzeForPolicyProposals({ frictionLines, at: "2026-01-01T00:00:00Z" });
    const binding = props.find((p: { id: string }) => p.id.startsWith("orchestrator-policy-binding-"));
    expect(binding).toBeTruthy();
    expect(binding.claim).toContain("autothing-walkthrough");
    expect(binding.decision).toContain("Review/swap");
  });

  it("small samples propose NOTHING (conservative thresholds)", async () => {
    const mod = await import(RULE);
    const props = mod.analyzeForPolicyProposals({
      outcomes: [outcome("full-feature", { test: { status: "failed" } })],
      frictionLines: [{ project: "p", line: "- ts [autothing-test] one-off → n/a" }],
      at: "2026-01-01T00:00:00Z"
    });
    expect(props).toEqual([]);
  });

  it("collectors read the evidence home + friction logs from sandboxes", async () => {
    const mod = await import(RULE);
    const runs = mkdtempSync(path.join(tmpdir(), "runs-"));
    mkdirSync(path.join(runs, "proj", "r1"), { recursive: true });
    writeFileSync(
      path.join(runs, "proj", "r1", "evidence-index.json"),
      JSON.stringify({ workKind: "full-feature", slices: [] })
    );
    expect(mod.collectRunOutcomes(runs)).toHaveLength(1);

    const dev = mkdtempSync(path.join(tmpdir(), "dev-"));
    mkdirSync(path.join(dev, "repo", "docs", "autothing"), { recursive: true });
    writeFileSync(path.join(dev, "repo", "docs", "autothing", "friction-log.md"), "# log\n- ts [x] y → z\n");
    const lines = mod.collectFrictionLines(dev);
    expect(lines).toHaveLength(1);
    expect(lines[0].project).toBe("repo");
  });
});
