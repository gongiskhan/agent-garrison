// S1b (D19, RUN_SPEC assumption 2) — THE empty-output race regression.
//
// The owner's concrete failure was NOT a missing empty-check: card
// 01KXD5E1PA43ZSYWN50W8T5M75 ("build a task list app") was parked "produced no
// output" at 08:22:05, but its gate-status.implement.json (status passed,
// next_phase review, git committed) landed at 08:24:17 — ~2.5 min LATER. The
// empty `done` reply was PREMATURE: the operative was still writing its gate
// evidence. The engine parked a genuinely-succeeding run purely on timing.
//
// The fix: on an empty reply the engine no longer parks at once — it polls the
// phase's gate file over a bounded, configurable grace window. Gate lands within
// the window → advance per the gate. No gate after the window → park with the
// failure contract (never claims success; carries a log-tail excerpt; marks the
// card for a context-keeping retry). These tests reproduce BOTH outcomes with an
// injected sleep so the race is deterministic and the suite never actually waits.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore pure mjs
import {
  processCard,
  processBatch,
  buildEmptyFailureReason,
  resolveEmptyGrace,
  pollForGateEvidence
  // @ts-ignore
} from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore pure mjs
import { resetPolicyCache } from "../fittings/seed/kanban-loop/lib/policy.mjs";
// @ts-ignore pure mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore pure mjs
import { atomicWriteJSON, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore pure mjs
import { compilePolicy, stableStringify } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

const ROOT = path.resolve(__dirname, "..");
const SEED_CONFIG = path.join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json");

let tmp: string;

function writePolicy(file: string) {
  const cfg = JSON.parse(readFileSync(SEED_CONFIG, "utf8"));
  writeFileSync(file, stableStringify(compilePolicy(cfg)), "utf8");
  resetPolicyCache();
}

async function makeCard(root: string, overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string) || "01TESTCARD0000000000000000";
  const card = {
    id,
    title: "build a task list app",
    description: "d",
    project: null,
    list: "implement",
    status: "ok",
    iterations: 0,
    rev: 0,
    workKind: "full-feature",
    goalMode: false,
    acceptance: null,
    events: [],
    runId: "01TESTRUN00000000000000000",
    runDir: path.join(root, "runs", id),
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    ...overrides
  };
  mkdirSync(path.join(root, "cards", card.id), { recursive: true });
  mkdirSync(card.runDir as string, { recursive: true });
  await atomicWriteJSON(path.join(root, "cards", card.id, "card.json"), card);
  return card;
}

// A per-phase gate sidecar naming next_phase — the exact shape the operative wrote
// ~2.5 min after the empty done in the observed failure.
function landGate(runDir: string, phase: string, nextPhase: string) {
  writeFileSync(
    path.join(runDir, `gate-status.${phase}.json`),
    JSON.stringify({ phase, status: "passed", next_phase: nextPhase }),
    "utf8"
  );
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "empty-race-"));
  process.env.GARRISON_POLICY_PATH = path.join(tmp, "policy.json");
  writePolicy(process.env.GARRISON_POLICY_PATH);
});

describe("processCard — the empty-reply gate-evidence race (S1b/D19)", () => {
  it("(a) empty reply + gate file lands AFTER the empty done, within the grace window → card ADVANCES, not parked", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp);
    // The gate lands on the 2nd grace poll — i.e. strictly AFTER the empty done
    // event, mid-window (the observed race).
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 2) landGate(card.runDir as string, "implement", "review");
    };
    const { card: out, outcome } = await processCard({
      root: tmp,
      board,
      card,
      runFn: async () => ({ reply: "" }), // premature empty done — work still on disk-in-flight
      cwd: tmp,
      emptyGrace: { intervalMs: 1000, checks: 6, sleep }
    });
    expect(polls).toBeGreaterThanOrEqual(2); // it actually waited past the empty done
    expect(outcome.status).toBe("moved"); // advanced, NOT parked
    expect(out.status).not.toBe("needs-attention");
    expect(out.list).not.toBe("needs-attention");
    // and it advanced via the durable gate verdict (review), recorded as a routed event
    expect(out.events.some((e: any) => e.kind === "routed")).toBe(true);
  });

  it("(b) empty reply + NO gate after the grace window → PARKED with the failure contract + log-tail evidence + context-keeping mark", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp);
    let polls = 0;
    const sleep = async () => { polls += 1; }; // never lands a gate
    const { card: out, outcome } = await processCard({
      root: tmp,
      board,
      card,
      runFn: async () => ({ reply: "" }),
      cwd: tmp,
      emptyGrace: { intervalMs: 1000, checks: 6, sleep }
    });
    expect(polls).toBe(6); // the full grace window was exhausted before parking
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("empty-reply");
    expect(out.list).toBe("needs-attention");

    const reason: string = out.attentionReason;
    // keeps the legacy phrasing the visibility test pins
    expect(reason).toMatch(/no output|returned nothing/i);
    // NEVER claims success (the banned words)
    expect(reason.toLowerCase()).not.toMatch(/\bcompleted\b|\bsuccess\b|\bdone\b/);
    // states it is a failure, notes the grace window, and carries a log-tail excerpt
    expect(reason).toMatch(/FAILURE, not a pass/);
    expect(reason).toMatch(/6 checks/);
    expect(reason).toMatch(/Last lines of the iteration log/);
    // marks the card for a context-keeping retry (runDir + iteration history kept)
    expect(out.retryKeepsContext).toBe(true);
    expect(reason).toMatch(/prior work preserved|iteration history are kept/);

    // persisted to disk (not just the returned card)
    const disk = await loadCard(tmp, card.id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.retryKeepsContext).toBe(true);
  });

  it("a non-empty reply that never names a verdict still parks as no-exact-match (grace is scoped to EMPTY only)", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp);
    let polls = 0;
    const sleep = async () => { polls += 1; };
    const { outcome } = await processCard({
      root: tmp,
      board,
      card,
      runFn: async () => ({ reply: "I need more info before I can implement this." }),
      cwd: tmp,
      emptyGrace: { intervalMs: 1000, checks: 6, sleep }
    });
    expect(polls).toBe(0); // no grace window for a non-empty reply
    expect(outcome.reason).toBe("no-exact-match");
  });
});

describe("processBatch — the same race, mirrored (S1b/D19)", () => {
  it("empty batch reply + gate lands within the window → ADVANCES", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01TESTCARD0000000000000010", list: "test", project: "p1" });
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 2) landGate(card.runDir as string, "test", "adversarial-test");
    };
    const { outcomes } = await processBatch({
      root: tmp,
      board,
      listId: "test",
      cards: [card],
      batchRunFn: async () => ({ reply: "" }),
      cwd: tmp,
      emptyGrace: { intervalMs: 1000, checks: 6, sleep }
    });
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(outcomes[0].status).toBe("moved");
  });

  it("empty batch reply + no gate → PARKED as empty-reply with the failure contract", async () => {
    const board = seedBoard();
    const card = await makeCard(tmp, { id: "01TESTCARD0000000000000011", list: "test", project: "p1" });
    const sleep = async () => {};
    const { outcomes } = await processBatch({
      root: tmp,
      board,
      listId: "test",
      cards: [card],
      batchRunFn: async () => ({ reply: "" }),
      cwd: tmp,
      emptyGrace: { intervalMs: 1000, checks: 6, sleep }
    });
    expect(outcomes[0].status).toBe("needs-attention");
    expect(outcomes[0].reason).toBe("empty-reply");
    const disk = await loadCard(tmp, card.id);
    expect(disk.retryKeepsContext).toBe(true);
    expect(disk.attentionReason).toMatch(/FAILURE, not a pass/);
    expect(disk.attentionReason.toLowerCase()).not.toMatch(/\bcompleted\b|\bsuccess\b|\bdone\b/);
  });
});

describe("grace-window primitives (S1b/D19)", () => {
  it("resolveEmptyGrace applies overrides over the env defaults", () => {
    const g = resolveEmptyGrace({ checks: 3, intervalMs: 5 });
    expect(g.checks).toBe(3);
    expect(g.intervalMs).toBe(5);
    expect(typeof g.sleep).toBe("function");
    const dflt = resolveEmptyGrace();
    expect(dflt.checks).toBeGreaterThan(0);
    expect(dflt.intervalMs).toBeGreaterThan(0);
  });

  it("pollForGateEvidence returns the gate-named next once it lands, and null when the window exhausts", async () => {
    const runDir = path.join(tmp, "poll-run");
    mkdirSync(runDir, { recursive: true });
    let n = 0;
    const sleep = async () => { n += 1; if (n === 3) landGate(runDir, "implement", "review"); };
    const got = await pollForGateEvidence({ cwd: tmp, runDir, phase: "implement", validNext: ["review"], checks: 6, intervalMs: 0, sleep });
    expect(got.next).toBe("review");
    expect(got.waited).toBe(3);

    const miss = await pollForGateEvidence({ cwd: tmp, runDir: path.join(tmp, "empty-run"), phase: "implement", validNext: ["review"], checks: 4, intervalMs: 0, sleep: async () => {} });
    expect(miss.next).toBeNull();
    expect(miss.waited).toBe(4);
  });

  it("buildEmptyFailureReason honors the contract: no success words, has a failure statement, log tail, and the context-keeping retry line", () => {
    const reason = buildEmptyFailureReason({
      listTitle: "Implement",
      phase: "implement",
      grace: { waited: 6, intervalMs: 30000 },
      logTail: "# iteration 2\n(no reply body)"
    });
    expect(reason.toLowerCase()).not.toMatch(/\bcompleted\b|\bsuccess\b|\bdone\b/);
    expect(reason).toMatch(/returned no output/);
    expect(reason).toMatch(/FAILURE, not a pass/);
    expect(reason).toMatch(/waited 180s \(6 checks\)/);
    expect(reason).toMatch(/Last lines of the iteration log/);
    expect(reason).toMatch(/# iteration 2/);
    expect(reason).toMatch(/re-enters the implement phase/);
    expect(reason).toMatch(/kept, not reset/);
    // grace clause omitted when no window was run (policy-less / non-empty path)
    expect(buildEmptyFailureReason({ listTitle: "Plan" })).not.toMatch(/waited/);
  });
});
