// S4 (GARRISON-UNIFY-V1) — THE run engine: policy-driven resolution (D15),
// durable gate-evidence transitions (D9), rail fast-forward + per-card phase
// toggles (D17), engine-owned list locks (D16 API side), the in-process
// library entry (D13), and the board v2→v3 migration.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore pure mjs
import {
  processCard,
  advanceCardPhase,
  effectiveListForCard,
  buildCardPrompt,
  getList
  // @ts-ignore
} from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore pure mjs
import {
  loadPolicy,
  resetPolicyCache,
  railForCard,
  phaseOnForCard,
  skillForPhase,
  classificationForPhase,
  hasPhaseGateEvidence,
  gateKeyForPhase,
  policyLoadState
  // @ts-ignore
} from "../fittings/seed/kanban-loop/lib/policy.mjs";
// @ts-ignore pure mjs
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { seedBoard, migrateBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore pure mjs
import { atomicWriteJSON, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore pure mjs
import { compilePolicy, stableStringify } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

const ROOT = path.resolve(__dirname, "..");
const SEED_CONFIG = path.join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json");

let tmp: string;
let policyFile: string;

function writePolicy() {
  const cfg = JSON.parse(readFileSync(SEED_CONFIG, "utf8"));
  writeFileSync(policyFile, stableStringify(compilePolicy(cfg)), "utf8");
  resetPolicyCache();
}

async function makeCard(root: string, overrides: Record<string, unknown> = {}) {
  const card = {
    id: "01TESTCARD0000000000000000",
    title: "t",
    description: "d",
    project: null,
    list: "plan",
    status: "ok",
    iterations: 0,
    rev: 0,
    goalMode: false,
    acceptance: null,
    events: [],
    runId: "01TESTRUN00000000000000000",
    runDir: "docs/autothing/runs/01TESTRUN00000000000000000",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    ...overrides
  };
  mkdirSync(path.join(root, "cards", card.id), { recursive: true });
  await atomicWriteJSON(path.join(root, "cards", card.id, "card.json"), card);
  return card;
}

function writeGateEvidence(cwd: string, runDir: string, phase: string, status = "passed") {
  // resolve (not join): an S6 absolute runDir must not concatenate under cwd
  const sliceDir = path.join(path.resolve(cwd, runDir), "slices", "s1");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(
    path.join(sliceDir, "gate-status.json"),
    JSON.stringify({ slice: "s1", gates: { [gateKeyForPhase(phase)]: { status } } }),
    "utf8"
  );
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "run-engine-"));
  policyFile = path.join(tmp, "policy.json");
  process.env.GARRISON_POLICY_PATH = policyFile;
  writePolicy();
});

describe("policy resolution (D15)", () => {
  it("a list maps to a phase; skill/classification resolve from the compiled policy", () => {
    const board = seedBoard();
    const plan = getList(board, "plan");
    expect(plan.phase).toBe("plan");
    expect(plan.skill).toBeUndefined();
    expect(plan.taskType).toBeUndefined();
    expect(plan.tier).toBeUndefined();
    expect(plan.mode).toBeUndefined();
    const policy = loadPolicy();
    expect(skillForPhase(policy, "plan", "full-feature")).toBe("garrison-plan");
    expect(skillForPhase(policy, "review", "full-feature")).toBe("garrison-review");
    expect(classificationForPhase(policy, "implement", { tier: "T2-deep" })).toEqual({
      taskType: "implement",
      tier: "T2-deep"
    });
    // out-of-vocab tier falls back to T1-standard
    expect(classificationForPhase(policy, "implement", { tier: "bogus" })!.tier).toBe("T1-standard");
  });

  it("v2 boards migrate: dead per-list pins stripped, phase stamped, version 3", () => {
    const v2 = {
      version: 2,
      lists: [
        { id: "plan", kind: "agent", skill: "garrison-plan", taskType: "code", tier: "T2-deep", mode: "james", validNext: ["implement"] },
        { id: "todo", kind: "manual", validNext: ["plan"] }
      ]
    };
    const v3 = migrateBoard(v2);
    expect(v3.version).toBe(3);
    const plan = v3.lists[0];
    expect(plan.skill).toBeUndefined();
    expect(plan.taskType).toBeUndefined();
    expect(plan.tier).toBeUndefined();
    expect(plan.mode).toBeUndefined();
    expect(plan.phase).toBe("plan");
    // idempotent
    expect(migrateBoard(v3)).toBe(v3);
  });

  it("the dispatch prompt names the policy-bound skill and demands the gate-status entry", () => {
    const board = seedBoard();
    const list = getList(board, "review");
    const prompt = buildCardPrompt({
      list,
      card: { title: "x", runDir: "docs/autothing/runs/r1", goalMode: false },
      validNext: list.validNext,
      skill: "garrison-review",
      phase: "review"
    });
    expect(prompt).toContain("`garrison-review`");
    expect(prompt).toContain("gate-status entry");
    expect(prompt).not.toContain("james,"); // per-list mode line is dead
  });
});

describe("durable gate evidence (D9)", () => {
  it("hasPhaseGateEvidence finds slice-level entries by camelCase gate key", () => {
    writeGateEvidence(tmp, "run1", "adversarial-review");
    expect(hasPhaseGateEvidence(tmp, "run1", "adversarial-review")).toBe(true);
    expect(hasPhaseGateEvidence(tmp, "run1", "test")).toBe(false);
    expect(hasPhaseGateEvidence(tmp, "missing", "test")).toBe(false);
  });

  it("a verdict WITHOUT the phase's gate evidence parks the card in needs-attention", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { list: "review", tier: "T1-standard" });
    const runFn = async () => ({ reply: "looks clean.\nadversarial-review" });
    const { card: out, outcome } = await processCard({ root: tmp, board, card, runFn, cwd: tmp });
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("no-gate-evidence");
    expect(out.list).toBe("needs-attention");
    expect(out.attentionReason).toContain("durable gate evidence");
  });

  it("a verdict WITH gate evidence advances (a FAILED entry counts too)", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { list: "review" });
    writeGateEvidence(tmp, card.runDir, "review", "failed");
    const runFn = async () => ({ reply: "found real issues.\nimplement" });
    const { card: out, outcome } = await processCard({ root: tmp, board, card, runFn, cwd: tmp });
    expect(outcome.status).toBe("moved");
    expect(out.list).toBe("implement");
  });
});

describe("rails + per-card phase toggles (D17)", () => {
  it("railForCard merges card toggles over the work kind's plan; off phases stay visible", () => {
    const policy = loadPolicy();
    const rail = railForCard(policy, { workKind: "full-feature", phases: { walkthrough: false } });
    const wt = rail.phases.find((p: { id: string }) => p.id === "walkthrough");
    expect(wt.on).toBe(false);
    expect(wt.off_reason).toBe("card-toggle");
    expect(rail.phases.length).toBeGreaterThan(5);
    expect(phaseOnForCard(rail, "walkthrough")).toBe(false);
    expect(phaseOnForCard(rail, "implement")).toBe(true);
  });

  it("a docs-change card fast-forwards over OFF phases with explicit off events", async () => {
    const board = seedBoard();
    // docs-change rail = [implement] only; a card landing on review (all other
    // phases off) fast-forwards to done, recording each skipped phase.
    const policy = loadPolicy();
    const rail = railForCard(policy, { workKind: "docs-change" });
    const fwd = effectiveListForCard(board, rail, "review", {});
    expect(fwd.listId).toBe("done");
    expect(fwd.skipped).toContain("review");
    expect(fwd.skipped).toContain("test");
    expect(fwd.skipped).toContain("walkthrough");
  });

  it("processCard skips an OFF phase on entry without dispatching", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { list: "walkthrough", workKind: "api-change" });
    let dispatched = false;
    const runFn = async () => {
      dispatched = true;
      return { reply: "validate" };
    };
    const { card: out, outcome } = await processCard({ root: tmp, board, card, runFn, cwd: tmp });
    expect(dispatched).toBe(false);
    expect(outcome.status).toBe("moved");
    // api-change rail: implement + test only → walkthrough/validate off → done
    expect(out.list).toBe("done");
    const offEvents = out.events.filter((e: { kind: string }) => e.kind === "phase-off");
    expect(offEvents.length).toBeGreaterThan(0);
  });
});

describe("evidence home (S6/D19)", () => {
  it("mintRunFields mints an ABSOLUTE runDir under ~/.garrison/runs/<project>/<runId>", async () => {
    // @ts-ignore pure mjs
    const { mintRunFields, runProjectLabel } = await import("../fittings/seed/kanban-loop/lib/engine.mjs");
    process.env.GARRISON_RUNS_DIR = path.join(tmp, "runs-home");
    const minted = mintRunFields({ project: "/home/u/dev/garrison" });
    expect(path.isAbsolute(minted.runDir)).toBe(true);
    expect(minted.runDir).toContain(path.join(tmp, "runs-home", "garrison"));
    expect(minted.runDir.endsWith(minted.runId)).toBe(true);
    // label safety
    expect(runProjectLabel("/x/../..")).toBe("no-project");
    expect(runProjectLabel(null)).toBe("no-project");
    expect(runProjectLabel("~/dev/my repo!")).toBe("my-repo-");
    delete process.env.GARRISON_RUNS_DIR;
  });
});

describe("review fixes (rev-s4 findings)", () => {
  it("the BATCH path enforces D9 gate evidence (finding #1)", async () => {
    // @ts-ignore pure mjs
    const { processBatch } = await import("../fittings/seed/kanban-loop/lib/engine.mjs");
    const board = seedBoard();
    const card = await makeCard(tmp, { list: "test", project: "p1", tier: "T1-standard", runDir: path.join(tmp, "run-b1") });
    const batchRunFn = async () => ({ reply: `${card.id} adversarial-test` });
    const { outcomes } = await processBatch({ root: tmp, board, listId: "test", cards: [card], batchRunFn, cwd: tmp });
    expect(outcomes[0].status).toBe("needs-attention");
    expect(outcomes[0].reason).toBe("no-gate-evidence");
    // with evidence → moves
    const card2 = await makeCard(tmp, { id: "01TESTCARD0000000000000003", list: "test", project: "p1", runDir: path.join(tmp, "run-b2") });
    writeGateEvidence(tmp, card2.runDir as string, "test");
    const r2 = await processBatch({ root: tmp, board, listId: "test", cards: [card2], batchRunFn: async () => ({ reply: `${card2.id} adversarial-test` }) , cwd: tmp });
    expect(r2.outcomes[0].status).toBe("moved");
  });

  it("advanceCardPhase enforces requiresEvidence like the dispatched path (finding #2)", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01TESTCARD0000000000000004", list: "walkthrough", runDir: path.join(tmp, "run-w1") });
    writeGateEvidence(tmp, card.runDir as string, "walkthrough"); // gate entry exists...
    // ...but NO evidence/ bundle → refused
    const refused = await advanceCardPhase({ root: tmp, board, card, verdict: "validate", cwd: tmp });
    expect(refused.outcome.status).toBe("needs-attention");
    expect(refused.outcome.reason).toBe("no-evidence");
    // with the bundle → moves
    const card2 = await makeCard(tmp, { id: "01TESTCARD0000000000000005", list: "walkthrough", runDir: path.join(tmp, "run-w2") });
    writeGateEvidence(tmp, card2.runDir as string, "walkthrough");
    mkdirSync(path.join(card2.runDir as string, "evidence"), { recursive: true });
    writeFileSync(path.join(card2.runDir as string, "evidence", "evidence.md"), "# proof");
    const ok = await advanceCardPhase({ root: tmp, board, card: card2, verdict: "validate", cwd: tmp });
    expect(ok.outcome.status).toBe("moved");
  });
});

describe("in-process advance (D13)", () => {
  it("advanceCardPhase enforces verdict validity + gate evidence, then moves", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { list: "plan", tier: "T2-deep" });
    // invalid verdict rejected
    const bad = await advanceCardPhase({ root: tmp, board, card, verdict: "done", cwd: tmp });
    expect(bad.outcome.status).toBe("rejected");
    // no gate evidence → parks
    const parked = await advanceCardPhase({ root: tmp, board, card, verdict: "implement", cwd: tmp });
    expect(parked.outcome.status).toBe("needs-attention");
    // with evidence → moves. Coordination is ON in the seed policy (S6), so the
    // plan advance also requires the plan's published touch-set (Q1 enforcement).
    // Coordination reads card.runDir AS-IS (production runDirs are absolute,
    // D19), so this card gets an absolute runDir under the sandbox.
    const card2 = await makeCard(tmp, {
      id: "01TESTCARD0000000000000002",
      list: "plan",
      runDir: path.join(tmp, "runs", "01TESTCARD0000000000000002")
    });
    writeGateEvidence(tmp, card2.runDir, "plan");
    writeFileSync(
      path.join(card2.runDir, "touch-set.json"),
      JSON.stringify({ version: 1, cardId: card2.id, files: ["src/x.ts"], dirs: [], surfaces: [], exclusive: [] }),
      "utf8"
    );
    const ok = await advanceCardPhase({ root: tmp, board, card: card2, verdict: "implement", cwd: tmp });
    expect(ok.outcome.status).toBe("moved");
    expect(ok.card.list).toBe("implement");
  });
});

// rev2-s567 S5#1 regression: a CORRUPT compiled policy (file present but
// unparseable) must FAIL SAFE — a real run must park, not fast-forward ungated
// (a null policy would make pipelinePhase falsy and skip the D9 check). An
// ABSENT policy stays the deliberate policy-less mode.
describe("corrupt-policy fail-safe (S5#1 / D9)", () => {
  it("policyLoadState distinguishes ok / absent / corrupt", () => {
    resetPolicyCache();
    expect(policyLoadState()).toBe("ok"); // beforeEach wrote a valid policy
    process.env.GARRISON_POLICY_PATH = path.join(tmp, "does-not-exist.json");
    resetPolicyCache();
    expect(policyLoadState()).toBe("absent");
    const corrupt = path.join(tmp, "corrupt-policy.json");
    writeFileSync(corrupt, "{ this is : not json ]");
    process.env.GARRISON_POLICY_PATH = corrupt;
    resetPolicyCache();
    expect(policyLoadState()).toBe("corrupt");
    expect(loadPolicy()).toBeNull();
  });

  it("advanceCardPhase PARKS a run whose policy is corrupt (never advances ungated)", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { list: "plan", tier: "T2-deep" });
    // Even WITH gate evidence written, a corrupt policy must refuse to advance.
    writeGateEvidence(tmp, card.runDir, "plan");
    const corrupt = path.join(tmp, "corrupt2.json");
    writeFileSync(corrupt, "}{ broken");
    process.env.GARRISON_POLICY_PATH = corrupt;
    resetPolicyCache();
    const parked = await advanceCardPhase({ root: tmp, board, card, verdict: "implement", cwd: tmp });
    expect(parked.outcome.status).toBe("needs-attention");
    expect(parked.outcome.reason).toBe("policy-corrupt");
  });

  it("advanceCardPhase still advances in ABSENT policy-less mode (mechanics unchanged)", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01TESTCARD0000000000000009", list: "plan" });
    writeGateEvidence(tmp, card.runDir, "plan");
    process.env.GARRISON_POLICY_PATH = path.join(tmp, "absent.json");
    resetPolicyCache();
    const ok = await advanceCardPhase({ root: tmp, board, card, verdict: "implement", cwd: tmp });
    expect(ok.outcome.status).toBe("moved");
  });
});
