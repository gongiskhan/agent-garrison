// Current-attempt durable gate contract. A retry deliberately keeps its runDir
// for context/audit, so the engine must distinguish a gate rewritten by THIS
// attempt from an inherited file whose matching verdict belongs to an older run.
import { beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore — pure .mjs
import { advanceCardPhase, processBatch, processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, saveCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { resetPolicyCache } from "../fittings/seed/kanban-loop/lib/policy.mjs";

let root: string;

const board = {
  version: 3,
  lists: [
    { id: "review", title: "Review", kind: "agent", phase: "review", trigger: "immediate", validNext: ["implement"] },
    { id: "test", title: "Test", kind: "agent", phase: "test", trigger: "scheduler-beat", batched: true, validNext: ["adversarial-test"] },
    { id: "implement", title: "Implement", kind: "manual", trigger: "manual", validNext: [] },
    { id: "adversarial-test", title: "Adversarial Test", kind: "manual", trigger: "manual", validNext: [] },
    { id: "needs-attention", title: "Needs attention", kind: "manual", trigger: "manual", validNext: ["review", "test"] }
  ],
  projects: {}
};

function writePolicy() {
  const file = join(root, "policy.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    phases: ["review", "test"],
    taskTypes: ["review", "test"],
    tiers: ["T1-standard"],
    phaseSkills: { bindings: {}, overrides: {} },
    workKinds: {},
    phasePlans: {}
  }));
  process.env.GARRISON_POLICY_PATH = file;
  resetPolicyCache();
}

async function makeCard(list: "review" | "test", options: { updated?: string; iterations?: number } = {}) {
  const created = await createCard(root, {
    title: `${list} freshness`,
    project: "demo",
    list,
    at: options.updated || new Date().toISOString()
  });
  const runDir = join(root, "runs", created.id);
  mkdirSync(runDir, { recursive: true });
  return saveCard(
    root,
    {
      ...created,
      runId: `run-${created.id}`,
      runDir,
      iterations: options.iterations ?? 1
    },
    options.updated || new Date().toISOString()
  );
}

function gateFile(card: any) {
  return join(card.runDir, `gate-status.${card.list}.json`);
}

function writeGate(card: any, body: Record<string, unknown>) {
  const file = gateFile(card);
  writeFileSync(file, JSON.stringify(body), "utf8");
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kanban-gate-fresh-"));
  writePolicy();
});

describe("dispatched current-attempt gate freshness", () => {
  it("processCard rejects an untouched matching gate inherited from the prior attempt", async () => {
    const card = await makeCard("review");
    writeGate(card, { phase: "review", status: "passed", next_phase: "implement" });

    const { outcome } = await processCard({
      root,
      board,
      card,
      cwd: root,
      runFn: async () => ({ reply: "review is clean\nimplement" })
    });

    expect(outcome).toMatchObject({ status: "needs-attention", reason: "stale-gate-evidence" });
    const disk = await loadCard(root, card.id);
    expect(disk.attentionReason).toMatch(/predates this dispatch|inherited gate/i);
  });

  it("accepts an identical atomic rewrite even when content and mtime are unchanged", async () => {
    const card = await makeCard("review");
    const body = JSON.stringify({ phase: "review", status: "passed", next_phase: "implement" });
    const file = gateFile(card);
    const fixedTime = new Date("2025-01-02T03:04:05.000Z");
    writeFileSync(file, body, "utf8");
    utimesSync(file, fixedTime, fixedTime);
    const before = statSync(file);

    const { outcome } = await processCard({
      root,
      board,
      card,
      cwd: root,
      runFn: async () => {
        // Atomic writers replace the inode. Preserve the exact bytes and mtime
        // to prove freshness does not depend on either changing.
        const replacement = `${file}.replacement`;
        writeFileSync(replacement, body, "utf8");
        utimesSync(replacement, fixedTime, fixedTime);
        renameSync(replacement, file);
        return { reply: "implement" };
      }
    });

    const after = statSync(file);
    expect(readFileSync(file, "utf8")).toBe(body);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).not.toBe(before.ino);
    expect(outcome).toMatchObject({ status: "moved", to: "implement" });
  });

  it("preserves compatibility with a freshly-written legacy status-only gate", async () => {
    const card = await makeCard("review");
    const { outcome } = await processCard({
      root,
      board,
      card,
      cwd: root,
      runFn: async ({ card: running }: { card: any }) => {
        writeGate(running, { phase: "review", status: "passed" });
        return { reply: "implement" };
      }
    });

    expect(outcome).toMatchObject({ status: "moved", to: "implement" });
  });

  it("does not let a stale matching gate rescue a max-turn stop", async () => {
    const card = await makeCard("review");
    writeGate(card, { phase: "review", status: "passed", next_phase: "implement" });
    let calls = 0;

    const { outcome } = await processCard({
      root,
      board,
      card,
      cwd: root,
      runFn: async () => {
        calls += 1;
        return { reply: "", stoppedReason: "max_turns" };
      }
    });

    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ status: "needs-attention", reason: "stale-gate-evidence" });
  });

  it("processBatch applies the same per-card baseline and rejects inherited matching evidence", async () => {
    const card = await makeCard("test");
    writeGate(card, { phase: "test", status: "passed", next_phase: "adversarial-test" });

    const { outcomes } = await processBatch({
      root,
      board,
      listId: "test",
      cards: [card],
      cwd: root,
      batchRunFn: async ({ cards }: { cards: any[] }) => ({ reply: `${cards[0].id} adversarial-test` })
    });

    expect(outcomes[0]).toMatchObject({ status: "needs-attention", reason: "stale-gate-evidence" });
    expect((await loadCard(root, card.id)).attentionReason).toMatch(/predates this batch dispatch/i);
  });
});

describe("advanceCardPhase phase-entry freshness", () => {
  it("rejects a gate older than the card's persisted phase-entry/recovery boundary", async () => {
    const card = await makeCard("review", { updated: "2099-01-01T00:00:00.000Z" });
    writeGate(card, { phase: "review", status: "passed", next_phase: "implement" });

    const { outcome } = await advanceCardPhase({ root, board, card, verdict: "implement", cwd: root });

    expect(outcome).toMatchObject({ status: "needs-attention", reason: "stale-gate-evidence" });
  });

  it("accepts a gate written after phase entry and keeps status-only compatibility", async () => {
    const card = await makeCard("review", { updated: "2020-01-01T00:00:00.000Z" });
    writeGate(card, { phase: "review", status: "passed" });

    const { outcome } = await advanceCardPhase({ root, board, card, verdict: "implement", cwd: root });

    expect(outcome).toMatchObject({ status: "moved", to: "implement" });
  });
});
