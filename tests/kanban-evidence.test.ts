// Always-on evidence bundle: when the heavy walkthrough VIDEO is skipped, the pipeline
// still leaves tangible proof under <runDir>/evidence/ (a screenshot and/or evidence.md),
// surfaced on the finished card. These tests pin (a) the path-confinement of the new
// served directory — the security-sensitive part — and (b) that resolveCardLinks
// enumerates + classifies the bundle from disk.
import { describe, it, expect } from "vitest";

// S4: the run engine reads the compiled Orchestrator policy for gate-evidence
// enforcement + phase classification. These tests exercise the PURE transition
// mechanics, so pin the policy path at a nonexistent file (policy-less mode);
// the policy-driven behavior is covered in tests/run-engine.test.ts.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
// S6 (D19): runDirs mint ABSOLUTE under the evidence home — sandbox it so
// tests never write the real ~/.garrison/runs.
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));

import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { isSafeEvidenceName, isEvidenceImage, resolveArtifactRef, resolveCardLinks } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — pure .mjs
import { advanceCardPhase, evidenceContractForTransition, evidenceRequiredForTransition, hasEvidence, processBatch, processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { seedBoard, phaseTemplatesFrom } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { buildBoard } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore — pure .mjs
import { resetPolicyCache } from "../fittings/seed/kanban-loop/lib/policy.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadAllCards, loadCard, saveCard } from "../fittings/seed/kanban-loop/lib/board.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "kanban-ev-"));

async function withTestGatePolicy(root: string, run: () => Promise<any>): Promise<any> {
  const previous = process.env.GARRISON_POLICY_PATH;
  const policyFile = join(root, "test-policy.json");
  writeFileSync(
    policyFile,
    JSON.stringify({
      version: 1,
      phases: ["test"],
      taskTypes: ["test"],
      tiers: ["T1-standard"],
      phaseSkills: { bindings: {}, overrides: {} },
      workKinds: {},
      phasePlans: {}
    }),
    "utf8"
  );
  process.env.GARRISON_POLICY_PATH = policyFile;
  resetPolicyCache();
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.GARRISON_POLICY_PATH;
    else process.env.GARRISON_POLICY_PATH = previous;
    resetPolicyCache();
  }
}

function writePassingTestGate(runDir: string, nextPhase = "done") {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "gate-status.test.json"),
    JSON.stringify({ status: "passed", next_phase: nextPhase, notes: "node --test: 14/14 passed" }),
    "utf8"
  );
}

// Simulates a board installed before Test gained requiresEvidenceOn and
// requiredEvidenceFile. The engine invariant must remain stronger than this
// mutable/stale list definition on every transition seam.
const legacyTerminalTestBoard = {
  version: 3,
  lists: [
    { id: "test", title: "Test", kind: "agent", phase: "test", trigger: "scheduler-beat", batched: true, validNext: ["done", "implement"] },
    { id: "done", title: "Done", kind: "manual", trigger: "manual", terminal: true, validNext: [] },
    { id: "needs-attention", title: "Needs attention", kind: "manual", trigger: "manual", validNext: ["test", "implement"] }
  ],
  projects: {}
};

function writeEvidenceReport(runDir: string) {
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  writeFileSync(
    join(runDir, "evidence", "evidence.md"),
    "# Test evidence\n\n- Command: `node --test`\n- Result: 14/14 passed\n",
    "utf8"
  );
}

describe("evidence filename safety (isSafeEvidenceName)", () => {
  it("accepts plain filenames", () => {
    for (const n of ["after.png", "evidence.md", "step-1.jpg", "a_b.webp", "X.png"]) {
      expect(isSafeEvidenceName(n)).toBe(true);
    }
  });
  it("rejects separators, traversal, leading dots and junk", () => {
    for (const n of ["../secret", "a/b.png", "a\\b.png", "..", ".", ".hidden", "..evil.png", "", null as any, "x".repeat(200)]) {
      expect(isSafeEvidenceName(n)).toBe(false);
    }
  });
});

describe("isEvidenceImage", () => {
  it("classifies image extensions", () => {
    expect(isEvidenceImage("after.png")).toBe(true);
    expect(isEvidenceImage("a.JPG")).toBe(true);
    expect(isEvidenceImage("evidence.md")).toBe(false);
    expect(isEvidenceImage("log.txt")).toBe(false);
  });
});

describe("resolveArtifactRef evidence:<file>", () => {
  const card = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ1", runDir: "docs/autothing/runs/RUN1" };
  it("resolves a safe name under <runDir>/evidence/", () => {
    const p = resolveArtifactRef(card, "evidence:after.png", { root: "/board", cwd: "/proj" });
    expect(p).toBe("/proj/docs/autothing/runs/RUN1/evidence/after.png");
  });
  it("refuses a traversing / separator-bearing name (null, never escapes)", () => {
    expect(resolveArtifactRef(card, "evidence:../../../../etc/passwd", { root: "/board", cwd: "/proj" })).toBe(null);
    expect(resolveArtifactRef(card, "evidence:a/b", { root: "/board", cwd: "/proj" })).toBe(null);
    expect(resolveArtifactRef({ id: card.id }, "evidence:after.png", { root: "/board", cwd: "/proj" })).toBe(null); // no runDir
  });
});

describe("resolveCardLinks enumerates the evidence bundle from disk", () => {
  it("lists screenshots (image:true) before the log, all confined under the run dir", () => {
    const cwd = tmp();
    const runDir = "docs/autothing/runs/RUNX";
    const evDir = join(cwd, runDir, "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, "evidence.md"), "# what changed\n- one line\n");
    writeFileSync(join(evDir, "after.png"), "PNGDATA");
    const card = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ2", runDir };
    const links = resolveCardLinks(card, { root: tmp(), cwd });
    expect(Array.isArray(links.evidence)).toBe(true);
    expect(links.evidence.length).toBe(2);
    // image leads
    expect(links.evidence[0].name).toBe("after.png");
    expect(links.evidence[0].image).toBe(true);
    expect(links.evidence[1].name).toBe("evidence.md");
    expect(links.evidence[1].image).toBe(false);
    // every entry is a confined serve ref with the opaque artifact url (no abs path)
    for (const e of links.evidence) {
      expect(e.kind).toBe("serve");
      expect(e.url).toContain("/artifact?ref=evidence");
    }
  });
  it("is empty (not erroring) when there is no evidence dir", () => {
    const cwd = tmp();
    const card = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ3", runDir: "docs/autothing/runs/NONE" };
    const links = resolveCardLinks(card, { root: tmp(), cwd });
    expect(links.evidence).toEqual([]);
  });

  it("does NOT enumerate a subdirectory as a serve link (only regular files)", () => {
    const cwd = tmp();
    const runDir = "docs/autothing/runs/RUNSUB";
    const evDir = join(cwd, runDir, "evidence");
    mkdirSync(join(evDir, "shots"), { recursive: true }); // a subdir
    writeFileSync(join(evDir, "evidence.md"), "# log\n");
    const card = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ4", runDir };
    const links = resolveCardLinks(card, { root: tmp(), cwd });
    expect(links.evidence.map((e: any) => e.name)).toEqual(["evidence.md"]); // no "shots"
  });
});

describe("evidence GATE — a requiresEvidence list cannot advance without producing evidence", () => {
  const board = seedBoard();

  it("hasEvidence is true only when <runDir>/evidence/ holds a regular file", () => {
    const cwd = tmp();
    const runDir = "docs/autothing/runs/HE";
    expect(hasEvidence(cwd, runDir)).toBe(false);
    mkdirSync(join(cwd, runDir, "evidence"), { recursive: true });
    expect(hasEvidence(cwd, runDir)).toBe(false); // empty dir
    writeFileSync(join(cwd, runDir, "evidence", "evidence.md"), "x");
    expect(hasEvidence(cwd, runDir)).toBe(true);
  });

  it("parks (no-evidence) when Walkthrough routes forward but left NO evidence", async () => {
    const root = tmp();
    const cwd = tmp();
    const card = await createCard(root, { title: "T", project: "p", list: "walkthrough" });
    // operative claims success (verdict `validate`) but writes nothing under evidence/.
    const runFn = async () => ({ reply: "all good\nvalidate" });
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10, cwd });
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("no-evidence");
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.attentionReason).toMatch(/no evidence/i);
  });

  it("ADVANCES when the evidence bundle actually exists on disk", async () => {
    const root = tmp();
    const cwd = tmp();
    const card = await createCard(root, { title: "T", project: "p", list: "walkthrough" });
    // mint the runDir the engine will look under, and write evidence there
    const runFn = async ({ card: c }: { card: any }) => {
      // S6: runDir is ABSOLUTE (evidence home) — use it directly.
      mkdirSync(join(c.runDir, "evidence"), { recursive: true });
      writeFileSync(join(c.runDir, "evidence", "after.png"), "PNG");
      return { reply: "captured screenshot\nvalidate" };
    };
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10, cwd });
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("validate");
  });
});

describe("terminal Test evidence — a short develop workflow still leaves user-openable proof", () => {
  const model = {
    version: 1,
    compositionId: "test-terminal-evidence",
    kanbanLists: ["plan", "implement", "review", "test"],
    sequences: { develop: { "2": ["plan", "implement", "review", "test"] } }
  } as const;
  const board = buildBoard(model, { templates: phaseTemplatesFrom(seedBoard()) });
  const testList = board.lists.find((list: any) => list.id === "test");

  it("projects the Test -> Done report contract into a resolved board and names it in the operative prompt", () => {
    expect(testList.requiresEvidenceOn).toEqual(["done"]);
    expect(testList.requiredEvidenceFile).toBe("evidence.md");
    expect(testList.executePrompt).toContain("<runDir>/evidence/evidence.md");
    expect(testList.executePrompt).toMatch(/during THIS attempt/);
    expect(testList.executePrompt).toMatch(/create or overwrite `<runDir>\/gate-status\.test\.json`/);
    expect(testList.executePrompt).toMatch(/pre-existing gate record is stale input/i);
    expect(testList.executePrompt).toMatch(/replace any stale or invalid `next_phase`/i);
    expect(testList.executePrompt).toMatch(/Use `done` when `done` is that card's green terminal option/);
    expect(testList.executePrompt).toMatch(/exact verification commands/i);
    expect(testList.executePrompt).toMatch(/key results\/output/i);
    expect(testList.routerPrompt).toMatch(/THAT card's listed next-options/);
    expect(testList.routerPrompt).toContain("<runDir>/gate-status.test.json");
    expect(testList.routerPrompt).toMatch(/`next_phase` exactly equals the next-list you emit/);
    expect(testList.routerPrompt).toMatch(/especially `<cardId> done`/);
    expect(testList.routerPrompt).not.toContain("<cardId> adversarial-test");
    expect(evidenceRequiredForTransition(testList, "done")).toBe(true);
    expect(evidenceContractForTransition({}, "test", "done")).toEqual({
      required: true,
      requiredEvidenceFile: "evidence.md",
      invariant: "terminal-test-done"
    }); // engine-owned even when the installed list is stale
    // A longer pipeline may hand off from Test to its dedicated evidence phases.
    expect(evidenceRequiredForTransition(testList, "adversarial-test")).toBe(false);
  });

  it("requires the exact evidence.md report, not merely an arbitrary screenshot", () => {
    const cwd = tmp();
    const runDir = "runs/terminal-test";
    mkdirSync(join(cwd, runDir, "evidence"), { recursive: true });
    writeFileSync(join(cwd, runDir, "evidence", "after.png"), "PNG");
    expect(hasEvidence(cwd, runDir)).toBe(true); // historical any-artifact contract
    expect(hasEvidence(cwd, runDir, "evidence.md")).toBe(false);
    writeFileSync(join(cwd, runDir, "evidence", "evidence.md"), "  \n");
    expect(hasEvidence(cwd, runDir, "evidence.md")).toBe(false); // placeholder is not proof
    writeFileSync(join(cwd, runDir, "evidence", "evidence.md"), "# Tests\n- `npm test`: pass\n");
    expect(hasEvidence(cwd, runDir, "evidence.md")).toBe(true);
    expect(hasEvidence(cwd, runDir, "../evidence.md")).toBe(false); // filename-only confinement
  });

  it("processCard parks legacy Test -> Done without evidence.md even when the stale list has no evidence fields", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "legacy direct test", project: "demo", list: "test" });
    const { outcome } = await withTestGatePolicy(root, () => processCard({
      root,
      board: legacyTerminalTestBoard,
      card,
      runFn: async ({ card: running }: { card: any }) => {
        writePassingTestGate(running.runDir);
        return { reply: "tests pass\ndone" };
      }
    }));

    expect(outcome).toMatchObject({ status: "needs-attention", reason: "no-evidence" });
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.attentionReason).toMatch(/evidence\.md/);
  });

  it("processCard also enforces terminal proof when an OFF Test rail fast-forwards directly to Done", async () => {
    const root = tmp();
    const card = await createCard(root, {
      title: "rail-off terminal test",
      project: "demo",
      list: "test",
      phases: { test: false }
    });
    let dispatched = false;
    const { outcome } = await withTestGatePolicy(root, () => processCard({
      root,
      board: legacyTerminalTestBoard,
      card,
      runFn: async () => { dispatched = true; return { reply: "done" }; }
    }));

    expect(dispatched).toBe(false);
    expect(outcome).toMatchObject({ status: "needs-attention", reason: "no-evidence" });
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.attentionReason).toMatch(/rail-off/);
    expect(disk.attentionReason).toMatch(/evidence\.md/);
  });

  it("processBatch enforces the same invariant against a legacy Test list", async () => {
    const root = tmp();
    await createCard(root, { title: "legacy batch test", project: "demo", list: "test" });
    const cards = await loadAllCards(root);
    const { outcomes } = await withTestGatePolicy(root, () => processBatch({
      root,
      board: legacyTerminalTestBoard,
      listId: "test",
      cards,
      batchRunFn: async ({ cards: running }: { cards: any[] }) => {
        writePassingTestGate(running[0].runDir);
        return { reply: `${running[0].id} done` };
      }
    }));

    expect(outcomes[0]).toMatchObject({ status: "needs-attention", reason: "no-evidence" });
    const disk = await loadCard(root, cards[0].id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.attentionReason).toMatch(/evidence\.md/);
  });

  it("advanceCardPhase enforces the same invariant against a legacy Test list", async () => {
    const root = tmp();
    const created = await createCard(root, { title: "legacy in-session test", project: "demo", list: "test" });
    const runDir = join(root, "runs", created.id);
    const card = await saveCard(root, { ...created, runId: "legacy-in-session", runDir });
    writePassingTestGate(runDir);

    const { outcome } = await withTestGatePolicy(root, () => advanceCardPhase({
      root,
      board: legacyTerminalTestBoard,
      card,
      verdict: "done"
    }));

    expect(outcome).toMatchObject({ status: "needs-attention", reason: "no-evidence" });
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.attentionReason).toMatch(/evidence\.md/);
  });

  it("processCard parks when an explicit durable Test verdict disagrees with the actual Done edge", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "mismatched direct gate", project: "demo", list: "test" });
    const { outcome } = await withTestGatePolicy(root, () => processCard({
      root,
      board: legacyTerminalTestBoard,
      card,
      runFn: async ({ card: running }: { card: any }) => {
        writePassingTestGate(running.runDir, "adversarial-test");
        writeEvidenceReport(running.runDir);
        return { reply: "tests pass\ndone" };
      }
    }));

    expect(outcome).toMatchObject({ status: "needs-attention", reason: "gate-verdict-mismatch" });
    const disk = await loadCard(root, card.id);
    expect(disk.attentionReason).toMatch(/adversarial-test/);
    expect(disk.attentionReason).toMatch(/actual transition|chose done/i);
  });

  it("processBatch parks a Done verdict when gate-status.test.json still declares adversarial-test", async () => {
    const root = tmp();
    await createCard(root, { title: "mismatched batch gate", project: "demo", list: "test" });
    const cards = await loadAllCards(root);
    const { outcomes } = await withTestGatePolicy(root, () => processBatch({
      root,
      board: legacyTerminalTestBoard,
      listId: "test",
      cards,
      batchRunFn: async ({ cards: running }: { cards: any[] }) => {
        writePassingTestGate(running[0].runDir, "adversarial-test");
        writeEvidenceReport(running[0].runDir);
        return { reply: `${running[0].id} done` };
      }
    }));

    expect(outcomes[0]).toMatchObject({ status: "needs-attention", reason: "gate-verdict-mismatch" });
    const disk = await loadCard(root, cards[0].id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.attentionReason).toMatch(/adversarial-test/);
    expect(disk.attentionReason).toMatch(/actual transition/i);
  });

  it("advanceCardPhase also rejects an explicit durable verdict for a different edge", async () => {
    const root = tmp();
    const created = await createCard(root, { title: "mismatched in-session gate", project: "demo", list: "test" });
    const runDir = join(root, "runs", created.id);
    const card = await saveCard(root, { ...created, runId: "mismatch-in-session", runDir });
    writePassingTestGate(runDir, "adversarial-test");
    writeEvidenceReport(runDir);

    const { outcome } = await withTestGatePolicy(root, () => advanceCardPhase({
      root,
      board: legacyTerminalTestBoard,
      card,
      verdict: "done"
    }));

    expect(outcome).toMatchObject({ status: "needs-attention", reason: "gate-verdict-mismatch" });
    const disk = await loadCard(root, card.id);
    expect(disk.attentionReason).toMatch(/adversarial-test/);
    expect(disk.attentionReason).toMatch(/actual transition/i);
  });

  it("parks a batched Test -> Done verdict when evidence.md is absent", async () => {
    const root = tmp();
    await createCard(root, {
      title: "terminal test without proof",
      project: "demo",
      list: "test",
      duty: "develop",
      level: 2,
      sequence: ["plan", "implement", "review", "test"]
    });
    const cards = await loadAllCards(root);
    const { outcomes } = await withTestGatePolicy(root, () => processBatch({
      root,
      board,
      listId: "test",
      cards,
      model,
      batchRunFn: async ({ cards: running }: { cards: any[] }) => {
        writePassingTestGate(running[0].runDir);
        return { reply: `${running[0].id} done` };
      }
    }));
    expect(outcomes[0]).toMatchObject({ status: "needs-attention", reason: "no-evidence" });
    const disk = await loadCard(root, cards[0].id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.attentionReason).toMatch(/evidence\.md/);
    expect(existsSync(join(disk.runDir, "gate-status.test.json"))).toBe(true); // gate passed; proof alone was missing
  });

  it("moves the same batched Test -> Done edge after writing commands/results to evidence.md", async () => {
    const root = tmp();
    await createCard(root, {
      title: "terminal test with proof",
      project: "demo",
      list: "test",
      duty: "develop",
      level: 2,
      sequence: ["plan", "implement", "review", "test"]
    });
    const cards = await loadAllCards(root);
    const { outcomes } = await withTestGatePolicy(root, () => processBatch({
      root,
      board,
      listId: "test",
      cards,
      model,
      batchRunFn: async ({ cards: running }: { cards: any[] }) => {
        const card = running[0];
        writePassingTestGate(card.runDir);
        mkdirSync(join(card.runDir, "evidence"), { recursive: true });
        writeFileSync(
          join(card.runDir, "evidence", "evidence.md"),
          "# Test evidence\n\n- Command: `node --test`\n- Result: 14/14 passed\n"
        );
        return { reply: `${card.id} done` };
      }
    }));
    expect(outcomes[0]).toMatchObject({ status: "moved", to: "done" });
    const disk = await loadCard(root, cards[0].id);
    expect(disk.list).toBe("done");
    expect(existsSync(join(disk.runDir, "gate-status.test.json"))).toBe(true);
    expect(hasEvidence(root, disk.runDir, "evidence.md")).toBe(true);
  });
});
