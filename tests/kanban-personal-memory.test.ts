import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOTS: string[] = [];
function temp(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  ROOTS.push(root);
  return root;
}

const PROJECT_ROOT = temp("garrison-personal-memory-project-");
const RUNS_ROOT = temp("garrison-personal-memory-runs-");
process.env.GARRISON_KANBAN_PROJECT_ROOT = PROJECT_ROOT;
process.env.GARRISON_RUNS_DIR = RUNS_ROOT;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore - pure ESM .mjs
import { createCard, saveCardCAS, saveCardCASWithHooks } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore - pure ESM .mjs
import { processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore - pure ESM .mjs
import { buildPersonalCompletionPacket, enqueuePersonalCompletion, personalCompletionPacketFile, personalCompletionPacketsDir, reconcilePersonalCompletionOutbox } from "../fittings/seed/kanban-loop/lib/personal-memory-outbox.mjs";

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

function packetFiles(root: string) {
  try { return readdirSync(personalCompletionPacketsDir(root)).filter((name) => name.endsWith(".json")).sort(); }
  catch { return []; }
}

async function waitForFile(file: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(existsSync(file)).toBe(true);
}

describe("personal Done-card neutral memory outbox", () => {
  it("captures the final engine duty summary in both the handoff and immutable packet", async () => {
    const root = temp("garrison-personal-memory-engine-order-");
    const card = await createCard(root, {
      title: "Final phase ordering",
      description: "Capture the final decision after the engine writes its duty summary.",
      scope: "personal",
      flow: "api-change",
      list: "implement"
    });
    const board = {
      version: 4,
      lists: [
        { id: "implement", title: "Implement", kind: "agent", phase: "implement", trigger: "immediate", validNext: ["done"] },
        { id: "done", title: "Done", kind: "manual", trigger: "manual", terminal: true, validNext: [] }
      ]
    };
    const runFn = async ({ card: running }: any) => {
      mkdirSync(running.runDir, { recursive: true });
      writeFileSync(join(running.runDir, "gate-status.implement.json"), JSON.stringify({
        summary: "Final implementation decision from the terminal duty"
      }));
      return { reply: "Implemented the final choice.\ndone" };
    };

    const completed = await processCard({
      root,
      board,
      card,
      runFn,
      cwd: PROJECT_ROOT,
      now: () => "2026-08-05T12:00:00.000Z"
    });
    expect(completed.outcome).toMatchObject({ status: "moved", to: "done" });

    const handoffFile = join(root, "cards", card.id, "handoff.json");
    const packetFile = personalCompletionPacketFile(root, completed.card);
    await waitForFile(handoffFile);
    await waitForFile(packetFile);

    const handoff = JSON.parse(readFileSync(handoffFile, "utf8"));
    const packet = JSON.parse(readFileSync(packetFile, "utf8"));
    expect(handoff.completionSummary).toContain("Implemented the final choice");
    expect(handoff.keyDecisions).toContain("implement: Final implementation decision from the terminal duty");
    expect(packet.agentCloseout.summary).toContain("Implemented the final choice");
    expect(packet.agentCloseout.decisions).toContain("implement: Final implementation decision from the terminal duty");
  });

  it("records the effective run-spec project rather than a stale display label", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const packet = buildPersonalCompletionPacket({
      id,
      title: "Private repository task",
      scope: "personal",
      list: "done",
      project: "old-label",
      routing: { project: "/home/ggomes/dev/ekoa-code" },
      coordinationSeq: 2
    });
    expect(packet.project).toBe("ekoa-code");
  });

  it("emits after the card lock with bounded provenance and no attachment/session/log payload", async () => {
    const root = temp("garrison-personal-memory-board-");
    const runDir = join(PROJECT_ROOT, "run-one");
    mkdirSync(join(runDir, "evidence"), { recursive: true });
    writeFileSync(join(runDir, "evidence", "screen.png"), "not-real-image");
    writeFileSync(join(runDir, "duty-summary.implement.json"), JSON.stringify({
      phase: "implement",
      at: "2026-08-05T10:00:00.000Z",
      summary: `Implemented safely with sk-${"a".repeat(24)}`,
      gateSummary: "Tests reported green"
    }));

    const card = await createCard(root, {
      title: "Renew passport",
      description: `${"Private context. ".repeat(400)}\n\nAttached files:\n- /home/ggomes/private/passport.png`,
      project: "/home/ggomes/dev/ekoa-code",
      scope: "personal",
      flow: "api-change",
      list: "todo",
      checklist: Array.from({ length: 55 }, (_, i) => ({ text: `item ${i}`, done: i < 2 }))
    });
    mkdirSync(join(root, "cards", card.id), { recursive: true });
    writeFileSync(join(root, "cards", card.id, "brief.md"), "- Keep the renewal receipt\n");

    let packetExistedWhileLocked = true;
    const result = await saveCardCASWithHooks(root, {
      ...card,
      list: "done",
      runDir,
      iterations: 1,
      sessionIds: ["session-private-id"],
      completionNote: `Submitted at the embassy; api_key=${"z".repeat(24)}`
    }, card.rev, "2026-08-05T10:10:00.000Z", {
      afterWrite: ({ next }: any) => {
        packetExistedWhileLocked = existsSync(personalCompletionPacketFile(root, next));
      }
    });

    expect(result.ok).toBe(true);
    expect(packetExistedWhileLocked).toBe(false);
    expect(result.memoryCapture).toMatchObject({ status: "scheduled", packetId: `${card.id}-g1` });
    // The successful board save returns before outbox I/O; commit recovery owns
    // the narrow gap if the process dies before the scheduled write.
    expect(packetFiles(root)).toHaveLength(0);
    const outboxFile = personalCompletionPacketFile(root, result.card);
    await waitForFile(outboxFile);

    const raw = readFileSync(outboxFile, "utf8");
    const packet = JSON.parse(raw);
    expect(packet.packetId).toBe(`${card.id}-g1`);
    expect(packet.coordinationSeq).toBe(1);
    expect(packet.scope).toBe("personal");
    expect(packet.project).toBe("ekoa-code"); // context label, never the machine path
    expect(packet.flow).toBe("api-change");
    expect(packet.description.length).toBeLessThanOrEqual(4_000);
    expect(packet.description).not.toContain("Attached files:");
    expect(packet.description).not.toContain("/home/ggomes/private/passport.png");
    expect(packet.checklist).toHaveLength(50);
    expect(packet.manualCompletionNote).toContain("[REDACTED]");
    expect(packet.verification.description).toBe("unverified-user-authored");
    expect(packet.provenance.semantics).toBe("completion-source-record-not-promoted-memory");
    expect(packet.agentCloseout.summary).toContain("[REDACTED]");
    expect(packet.agentCloseout.decisions).toContain("implement: Tests reported green");
    expect(packet.agentCloseout.evidence.some((item: any) => item.ref === "evidence:screen.png")).toBe(true);
    expect(packet.agentCloseout.evidence.every((item: any) => !/^(session:|log:|attachment:|plan$)/.test(item.ref))).toBe(true);
    expect(raw).not.toContain("session-private-id");
    expect(raw).not.toContain("filesTouched");
  });

  it("refuses a pre-existing packet whose filename does not match its full identity", async () => {
    const root = temp("garrison-personal-memory-collision-");
    const card = await createCard(root, { title: "Collision", scope: "personal", list: "done" });
    const file = personalCompletionPacketFile(root, card);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      kind: "garrison.personal-card-completion",
      packetId: `${card.id}-g0`,
      cardId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      coordinationSeq: 0,
      scope: "personal"
    }));

    await expect(enqueuePersonalCompletion(root, card)).rejects.toThrow(/outbox collision/);
  });

  it("emits when an already-Done manual card is explicitly labelled personal", async () => {
    const root = temp("garrison-personal-memory-label-");
    const card = await createCard(root, { title: "Call the dentist", scope: "unscoped", list: "done" });
    expect(packetFiles(root)).toEqual([]);

    const result = await saveCardCAS(root, { ...card, scope: "personal" }, card.rev);
    expect(result.ok).toBe(true);
    expect(result.memoryCapture).toMatchObject({ status: "scheduled", packetId: `${card.id}-g0` });
    await waitForFile(personalCompletionPacketFile(root, result.card));
    expect(packetFiles(root)).toEqual([`${card.id}-g0.json`]);
  });

  it("is idempotent within one Done generation and creates a new packet after reopen", async () => {
    const root = temp("garrison-personal-memory-generation-");
    const card = await createCard(root, { title: "Book a train", scope: "personal", list: "todo" });
    const first = await saveCardCAS(root, { ...card, list: "done" }, card.rev);
    expect(first.memoryCapture).toMatchObject({ status: "scheduled", packetId: `${card.id}-g1` });
    await waitForFile(personalCompletionPacketFile(root, first.card));
    const duplicate = await enqueuePersonalCompletion(root, first.card);
    expect(duplicate).toMatchObject({ created: false, packetId: `${card.id}-g1` });

    const reopened = await saveCardCAS(root, { ...first.card, list: "todo" }, first.card.rev);
    const second = await saveCardCAS(root, { ...reopened.card, list: "done" }, reopened.card.rev);
    expect(second.memoryCapture).toMatchObject({ status: "scheduled", packetId: `${card.id}-g3` });
    await waitForFile(personalCompletionPacketFile(root, second.card));
    expect(packetFiles(root)).toEqual([`${card.id}-g1.json`, `${card.id}-g3.json`]);
  });

  it("reconciles a personal Done card created without passing through the terminal CAS seam", async () => {
    const root = temp("garrison-personal-memory-reconcile-");
    const card = await createCard(root, { title: "Legacy completion", scope: "personal", list: "done" });
    expect(packetFiles(root)).toEqual([]);

    const repaired = await reconcilePersonalCompletionOutbox(root);
    expect(repaired).toMatchObject({ scanned: 1, emitted: 1, existing: 0, errors: [] });
    expect(packetFiles(root)).toEqual([`${card.id}-g0.json`]);
    const again = await reconcilePersonalCompletionOutbox(root);
    expect(again).toMatchObject({ scanned: 1, emitted: 0, existing: 1, errors: [] });
  });

  it("never emits for a Done card whose explicit scope is not personal", async () => {
    const root = temp("garrison-personal-memory-project-scope-");
    const card = await createCard(root, { title: "Project work", project: "garrison", scope: "project", list: "todo" });
    const result = await saveCardCAS(root, { ...card, list: "done" }, card.rev);
    expect(result.ok).toBe(true);
    expect(result.memoryCapture).toBeUndefined();
    expect(packetFiles(root)).toEqual([]);
  });
});
