// Mutation-gate killers (GARRISON-UNIFY-V1 run-level gate). Stryker's first
// pass left survivors in the run-critical decision functions - each block
// below pins a boundary or branch a surviving mutant proved untested:
// autonomy classification (policy-core), D9 gate-evidence + rail fallbacks
// (kanban policy), and the power fitting's busy-signal boundaries.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore - pure .mjs (single line so the ignore anchors to the specifier)
import { classifyExecution, isSignificantAutonomous, biasTarget, resolvePhaseTarget } from "../fittings/seed/orchestrator/lib/policy-core.mjs";
// @ts-ignore - pure .mjs (single line so the ignore anchors to the specifier)
import { gateKeyForPhase, hasPhaseGateEvidence, classificationForPhase, skillForPhase, railForCard, phaseOnForCard } from "../fittings/seed/kanban-loop/lib/policy.mjs";
// @ts-ignore - pure .mjs
import {
  sessionsSignal,
  kanbanSignal,
  presenceSignal,
  sshSignal,
  loadSignal,
  keepAwakeSignal,
  aggregateSignals,
  tickCountdown
} from "../fittings/seed/power-default/lib/power-core.mjs";

const T0 = Date.parse("2026-07-10T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("classifyExecution boundaries (D8)", () => {
  it("each autonomous channel triggers, case-insensitively", () => {
    for (const ch of ["kanban", "scheduler", "board", "autothing", "KANBAN", "Board"]) {
      expect(classifyExecution({ channel: ch })).toBe("autonomous");
    }
    expect(classifyExecution({ channel: "web" })).toBe("interactive");
  });

  it("automation shape needs BOTH the phrase AND an ops/other classification", () => {
    const msg = "every day archive the inbox and then post a summary";
    expect(classifyExecution({ message: msg, classification: { taskType: "ops" } })).toBe("autonomous");
    expect(classifyExecution({ message: msg, classification: { taskType: "other" } })).toBe("autonomous");
    expect(classifyExecution({ message: msg, classification: { taskType: "code" } })).toBe("interactive");
    expect(classifyExecution({ message: "archive the inbox", classification: { taskType: "ops" } })).toBe("interactive");
  });

  it("gary floors to interactive BEFORE the classifier's own read", () => {
    expect(classifyExecution({ mode: "gary", classification: { execution: "autonomous" } })).toBe("interactive");
    expect(classifyExecution({ mode: "joe", classification: { execution: "autonomous" } })).toBe("autonomous");
    expect(classifyExecution({ classification: { execution: "AUTONOMOUS" } })).toBe("interactive"); // out-of-vocab
  });
});

describe("isSignificantAutonomous boundaries", () => {
  it("every pipeline verb is significant", () => {
    for (const v of [
      "plan", "implement", "test", "review", "adversarial-review", "adversarial-test",
      "design-audit", "walkthrough", "validate", "codex-checkpoint"
    ]) {
      expect(isSignificantAutonomous({ taskType: v, tier: "T0-trivial" })).toBe(true);
    }
  });

  it("code/ops significance is tiered; other kinds are not significant", () => {
    expect(isSignificantAutonomous({ taskType: "code", tier: "T0-trivial" })).toBe(false);
    expect(isSignificantAutonomous({ taskType: "code", tier: "T1-standard" })).toBe(true);
    expect(isSignificantAutonomous({ taskType: "ops", tier: "T2-deep" })).toBe(true);
    expect(isSignificantAutonomous({ taskType: "writing", tier: "T2-deep" })).toBe(false);
    expect(isSignificantAutonomous(null)).toBe(false);
  });
});

describe("biasTarget ladder arithmetic", () => {
  const ladder = ["cc-haiku-low", "cc-sonnet-med", "cc-opus-high"]; // fast, standard, expert

  it("prefer only demotes FROM standard; floor always raises", () => {
    expect(biasTarget("cc-sonnet-med", { prefer: "fast" }, ladder)).toBe("cc-haiku-low");
    expect(biasTarget("cc-opus-high", { prefer: "fast" }, ladder)).toBe("cc-opus-high"); // not standard - prefer ignored
    expect(biasTarget("cc-haiku-low", { floor: "expert" }, ladder)).toBe("cc-opus-high");
    expect(biasTarget("cc-opus-high", { floor: "fast" }, ladder)).toBe("cc-opus-high"); // floor never lowers
  });

  it("unknown target or missing bias is identity; rank clamps to the ladder end", () => {
    expect(biasTarget("not-in-ladder", { floor: "expert" }, ladder)).toBe("not-in-ladder");
    expect(biasTarget("cc-sonnet-med", null, ladder)).toBe("cc-sonnet-med");
    expect(biasTarget("cc-haiku-low", { floor: "expert" }, ladder.slice(0, 2))).toBe("cc-sonnet-med"); // clamp
  });
});

describe("resolvePhaseTarget", () => {
  it("throws the named-cell error on a missing cell and returns the cell verbatim otherwise", () => {
    const policy = { matrix: { implement: { "T2-deep": { targetId: "x", model: "opus" } } } };
    expect(resolvePhaseTarget(policy, "implement", "T2-deep").model).toBe("opus");
    expect(() => resolvePhaseTarget(policy, "review", "T2-deep")).toThrow("no matrix cell for review × T2-deep");
  });
});

describe("D9 gate-evidence reader (kanban policy)", () => {
  const mkRun = () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "d9-"));
    const runDir = "runs/r1";
    mkdirSync(path.join(cwd, runDir, "slices", "S1"), { recursive: true });
    return { cwd, runDir };
  };

  it("gate key mapping: hyphenated phases map to camelCase gate keys, others pass through", () => {
    expect(gateKeyForPhase("adversarial-review")).toBe("adversarialReview");
    expect(gateKeyForPhase("adversarial-test")).toBe("adversarialTest");
    expect(gateKeyForPhase("design-audit")).toBe("designAudit");
    expect(gateKeyForPhase("codex-checkpoint")).toBe("codexCheckpoint");
    expect(gateKeyForPhase("implement")).toBe("implement");
  });

  it("run-level gates{} entry counts - ANY status, including failed", () => {
    const { cwd, runDir } = mkRun();
    writeFileSync(path.join(cwd, runDir, "gate-status.json"), JSON.stringify({ gates: { test: { status: "failed" } } }));
    expect(hasPhaseGateEvidence(cwd, runDir, "test")).toBe(true);
    expect(hasPhaseGateEvidence(cwd, runDir, "review")).toBe(false);
  });

  it("per-slice gate-status counts; the phases{} alternative shape counts; hyphen phases use the mapped key", () => {
    const { cwd, runDir } = mkRun();
    writeFileSync(
      path.join(cwd, runDir, "slices", "S1", "gate-status.json"),
      JSON.stringify({ gates: { adversarialReview: { status: "passed" } } })
    );
    expect(hasPhaseGateEvidence(cwd, runDir, "adversarial-review")).toBe(true);
    writeFileSync(path.join(cwd, runDir, "gate-status.json"), JSON.stringify({ phases: { walkthrough: "done" } }));
    expect(hasPhaseGateEvidence(cwd, runDir, "walkthrough")).toBe(true);
  });

  it("no evidence on: missing runDir/phase, unreadable JSON, non-object gates", () => {
    const { cwd, runDir } = mkRun();
    expect(hasPhaseGateEvidence(cwd, null as unknown as string, "test")).toBe(false);
    expect(hasPhaseGateEvidence(cwd, runDir, "")).toBe(false);
    writeFileSync(path.join(cwd, runDir, "gate-status.json"), "not json");
    expect(hasPhaseGateEvidence(cwd, runDir, "test")).toBe(false);
    writeFileSync(path.join(cwd, runDir, "gate-status.json"), JSON.stringify({ gates: "test" }));
    expect(hasPhaseGateEvidence(cwd, runDir, "test")).toBe(false);
  });
});

describe("rail fallbacks (kanban policy)", () => {
  const policy = {
    phases: ["plan", "implement", "walkthrough"],
    taskTypes: ["plan", "implement", "walkthrough"],
    tiers: ["T0-trivial", "T1-standard", "T2-deep"],
    defaultWorkKind: "full-feature",
    workKinds: { "full-feature": { phasePlan: "full" }, "docs-change": { phasePlan: "implement-only" } },
    phasePlans: {
      full: { evidence: "video", phases: ["plan", "implement", "walkthrough"] },
      "implement-only": { evidence: "none", phases: ["implement"] }
    },
    phaseSkills: { bindings: { implement: "autothing-implement" }, overrides: { "docs-change": { implement: "docs-writer" } } }
  };

  it("a card without a workKind falls back to the policy default", () => {
    const rail = railForCard(policy, {});
    expect(rail.workKind).toBe("full-feature");
    expect(rail.phases.filter((p: { on: boolean }) => p.on).map((p: { id: string }) => p.id)).toEqual(["plan", "implement", "walkthrough"]);
  });

  it("an unknown workKind (no plan) renders EVERY pipeline phase on", () => {
    const rail = railForCard(policy, { workKind: "mystery" });
    expect(rail.evidence).toBe("none");
    expect(rail.phases.every((p: { on: boolean }) => p.on)).toBe(true);
  });

  it("non-object card toggles are ignored; off reasons are exact", () => {
    const rail = railForCard(policy, { workKind: "docs-change", phases: "walkthrough" });
    const off = rail.phases.find((p: { id: string }) => p.id === "walkthrough");
    expect(off.on).toBe(false);
    expect(off.off_reason).toBe("phase-plan");
    const rail2 = railForCard(policy, { workKind: "full-feature", phases: { walkthrough: false } });
    expect(rail2.phases.find((p: { id: string }) => p.id === "walkthrough").off_reason).toBe("card-toggle");
  });

  it("phaseOnForCard: rail governs pipeline phases; non-pipeline columns default ON", () => {
    const rail = railForCard(policy, { workKind: "docs-change" });
    expect(phaseOnForCard(rail, "implement")).toBe(true);
    expect(phaseOnForCard(rail, "walkthrough")).toBe(false);
    expect(phaseOnForCard(rail, "custom-column")).toBe(true);
  });

  it("classificationForPhase: bad tier falls back to T1-standard; non-taskType phase is null", () => {
    expect(classificationForPhase(policy, "implement", { tier: "T9-nope" })).toEqual({ taskType: "implement", tier: "T1-standard" });
    expect(classificationForPhase(policy, "not-a-phase", { tier: "T2-deep" })).toBeNull();
  });

  it("skillForPhase: per-kind override beats the binding; neither means null", () => {
    expect(skillForPhase(policy, "implement", "docs-change")).toBe("docs-writer");
    expect(skillForPhase(policy, "implement", "full-feature")).toBe("autothing-implement");
    expect(skillForPhase(policy, "plan", "full-feature")).toBeNull();
  });
});

describe("power-core signal boundaries (D33)", () => {
  it("sessionsSignal: the staleness window is inclusive; non-working never counts", () => {
    const STALE = 10 * 60 * 1000;
    const mk = (agoMs: number, status = "working") => ({
      projects: { p: { sessions: { s: { lastStatus: status, lastStatusAt: iso(T0 - agoMs) } } } }
    });
    expect(sessionsSignal(mk(STALE), { now: T0 }).blocking).toBe(true); // exactly at the edge
    expect(sessionsSignal(mk(STALE + 1), { now: T0 }).blocking).toBe(false); // 1ms past
    expect(sessionsSignal(mk(0, "idle"), { now: T0 }).blocking).toBe(false);
    expect(sessionsSignal({ projects: { p: { sessions: { s: { lastStatus: "working" } } } } }, { now: T0 }).blocking).toBe(false); // no timestamp
  });

  it("kanbanSignal: running always counts; agent-list needs-attention is parked, not in-flight", () => {
    const board = { lists: [{ id: "agent-implement", kind: "agent" }, { id: "todo", kind: "manual" }] };
    expect(kanbanSignal([{ list: "todo", status: "running" }], board).blocking).toBe(true);
    expect(kanbanSignal([{ list: "agent-implement", status: "ok" }], board).blocking).toBe(true);
    expect(kanbanSignal([{ list: "agent-implement", status: "needs-attention" }], board).blocking).toBe(false);
    expect(kanbanSignal([{ list: "todo", status: "ok" }], board).blocking).toBe(false);
  });

  it("presenceSignal: window edge inclusive; sources keep the LATEST per source; value is the max", () => {
    const win = 30 * 60 * 1000;
    const edge = presenceSignal([{ source: "shell", at: iso(T0 - win) }], { now: T0, idleMinutes: 30 });
    expect(edge.blocking).toBe(true);
    const out = presenceSignal([{ source: "shell", at: iso(T0 - win - 1) }], { now: T0, idleMinutes: 30 });
    expect(out.blocking).toBe(false);
    const multi = presenceSignal(
      [
        { source: "shell", at: iso(T0 - 60_000) },
        { source: "shell", at: iso(T0 - 10_000) },
        { source: "phone", at: iso(T0 - 5_000) }
      ],
      { now: T0, idleMinutes: 30 }
    );
    expect(multi.value).toBe(iso(T0 - 5_000));
    const shell = multi.detail.sources.find((s: { source: string }) => s.source === "shell");
    expect(shell.at).toBe(iso(T0 - 10_000));
  });

  it("sshSignal: idle EXACTLY at the window does not block (only strictly-fresher activity)", () => {
    const winSec = 30 * 60;
    expect(sshSignal([{ remote: true, idleSeconds: winSec }], { idleMinutes: 30 }).blocking).toBe(false);
    expect(sshSignal([{ remote: true, idleSeconds: winSec - 1 }], { idleMinutes: 30 }).blocking).toBe(true);
    expect(sshSignal([{ remote: false, idleSeconds: 0 }], { idleMinutes: 30 }).blocking).toBe(false);
    expect(sshSignal([{ remote: true, idleSeconds: winSec - 1 }], { idleMinutes: 30 }).detail.attached).toBe(1);
  });

  it("loadSignal: threshold is exclusive; non-finite load reports null and never blocks", () => {
    expect(loadSignal(1.0, 1.0).blocking).toBe(false);
    expect(loadSignal(1.01, 1.0).blocking).toBe(true);
    const bad = loadSignal("nope" as unknown as number, 1.0); // deliberate bad input
    expect(bad.blocking).toBe(false);
    expect(bad.value).toBeNull();
    expect(loadSignal(2, undefined as unknown as number).detail.threshold).toBe(1.0);
  });

  it("keepAwakeSignal: active strictly before until; value is the ISO deadline only while active", () => {
    expect(keepAwakeSignal({ until: iso(T0) }, { now: T0 }).blocking).toBe(false); // expired at the instant
    const active = keepAwakeSignal({ until: iso(T0 + 1) }, { now: T0 });
    expect(active.blocking).toBe(true);
    expect(active.value).toBe(iso(T0 + 1));
    expect(keepAwakeSignal(null, { now: T0 }).value).toBeNull();
  });

  it("aggregateSignals: an errored signal is busy (fail-safe); empty list is clear", () => {
    expect(aggregateSignals([]).busy).toBe(false);
    expect(aggregateSignals([{ id: "x", blocking: false }]).busy).toBe(false);
    expect(aggregateSignals([{ id: "x", blocking: false }, { id: "y", error: "probe died" }]).busy).toBe(true);
  });

  it("tickCountdown: suspend fires exactly AT the idle window; a busy tick fully resets", () => {
    const idleMs = 30 * 60_000;
    const mid = tickCountdown({ clearSince: T0 - idleMs + 1 }, { busy: false, now: T0, idleMinutes: 30 });
    expect(mid.suspend).toBe(false);
    expect(mid.remainingMs).toBe(1);
    const at = tickCountdown({ clearSince: T0 - idleMs }, { busy: false, now: T0, idleMinutes: 30 });
    expect(at.suspend).toBe(true);
    const reset = tickCountdown({ clearSince: T0 - idleMs }, { busy: true, now: T0, idleMinutes: 30 });
    expect(reset).toEqual({ clearSince: null, remainingMs: idleMs, suspend: false });
  });
});
