import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore — pure .mjs
import { createCard, saveCard, saveCardCASWithHooks } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import {
  acquireLeases,
  cleanupCardCoordination,
  registerTouchSetIntent,
  repairPendingCoordinationCleanups
  // @ts-ignore — pure .mjs
} from "../fittings/seed/kanban-loop/lib/coordination.mjs";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});


process.env.GARRISON_HOME = mkdtempSync(join(tmpdir(), "coord-cleanup-home-"));

describe("durable post-commit coordination cleanup", () => {
  it("surfaces cleanup failure after commit and repairs it from the durable queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-cleanup-retry-"));
    const repoPath = mkdtempSync(join(tmpdir(), "coord-cleanup-repo-"));
    const card = await createCard(root, { title: "terminal cleanup", project: "proj", list: "review" });
    const failedOperations = {
      removeCardIntents: () => { throw new Error("injected intent cleanup failure"); },
      releaseLeases: () => { throw new Error("injected lease cleanup failure"); }
    };

    const committed = await saveCardCASWithHooks(
      root,
      { ...card, list: "done" },
      card.rev ?? 0,
      "2026-08-03T12:00:00.000Z",
      {
        afterWrite: () => cleanupCardCoordination({
          root,
          cardId: card.id,
          repoPaths: [repoPath],
          removeIntents: true,
          ownerToken: null
        }, failedOperations)
      }
    );

    expect(committed.ok).toBe(true);
    expect(committed.card.list).toBe("done");
    expect(committed.postCommitError).toBeTruthy();
    const queueDir = join(root, ".coordination-cleanup");
    const [queued] = readdirSync(queueDir).filter((name) => name.endsWith(".json"));
    expect(queued).toBeTruthy();

    let intentRepairs = 0;
    let leaseRepairs = 0;
    const repaired = await repairPendingCoordinationCleanups({ root }, {
      removeCardIntents: () => { intentRepairs += 1; },
      releaseLeases: () => { leaseRepairs += 1; }
    });

    expect(repaired).toMatchObject({ repaired: [card.id], pending: [] });
    expect(intentRepairs).toBe(1);
    expect(leaseRepairs).toBe(1);
    expect(existsSync(join(queueDir, queued))).toBe(false);
  });

  it("supersedes a queued release-all when the same card has reopened", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-cleanup-reopen-"));
    const repoPath = mkdtempSync(join(tmpdir(), "coord-cleanup-reopen-repo-"));
    const base = await createCard(root, { title: "reopened generation", project: "proj", list: "review" });
    const closed = await saveCard(root, { ...base, list: "done" });
    const failedOperations = {
      removeCardIntents: () => { throw new Error("injected closure cleanup failure"); },
      releaseLeases: () => { throw new Error("injected closure lease failure"); }
    };

    expect(() => cleanupCardCoordination({
      root,
      cardId: closed.id,
      repoPaths: [repoPath],
      removeIntents: true,
      ownerToken: null
    }, failedOperations)).toThrow();

    const reopened = await saveCard(root, { ...closed, list: "implement", status: "ok" });
    expect(reopened.coordinationSeq).toBeGreaterThan(closed.coordinationSeq);
    const lease = acquireLeases({ repoPath, card: reopened, paths: ["package-lock.json"] });
    expect(lease.ok).toBe(true);
    registerTouchSetIntent({
      repoPath,
      card: reopened,
      touchSet: { files: ["package-lock.json"], dirs: [], exclusive: ["package-lock.json"] }
    });
    // Returning to the same closed list must not revive the old generation's
    // release-all. The durable coordination lifecycle, not only list state, wins.
    const reclosed = await saveCard(root, { ...reopened, list: "done", status: "ok" });
    expect(reclosed.coordinationSeq).toBeGreaterThan(reopened.coordinationSeq);

    const repair = await repairPendingCoordinationCleanups({ root });
    expect(repair).toMatchObject({ repaired: [], pending: [], superseded: [reopened.id] });

    // The stale Done-generation sidecar must not remove the successor generation.
    const contender = acquireLeases({
      repoPath,
      card: { id: "01CLEANUPCONTENDERAAAAAAA", runId: "01CLEANUPCONTENDERRUNAAAA" },
      paths: ["package-lock.json"]
    });
    expect(contender).toMatchObject({ ok: false, heldBy: reopened.id });
    const slug = createHash("sha1").update(repoPath).digest("hex").slice(0, 16);
    const ledger = join(process.env.GARRISON_HOME!, "coord", "intents", `${slug}.jsonl`);
    expect(readFileSync(ledger, "utf8")).toContain(`kanban:${reopened.id}`);
  });

  it("repairs a queued cleanup after a benign same-lifecycle card edit", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-cleanup-benign-edit-"));
    const repoPath = mkdtempSync(join(tmpdir(), "coord-cleanup-benign-repo-"));
    const base = await createCard(root, { title: "cleanup survives annotations", project: "proj", list: "review" });
    expect(acquireLeases({ repoPath, card: base, paths: ["package-lock.json"] }).ok).toBe(true);
    registerTouchSetIntent({
      repoPath,
      card: base,
      touchSet: { files: ["package-lock.json"], dirs: [], exclusive: ["package-lock.json"] }
    });
    const closed = await saveCard(root, { ...base, list: "done" });
    const failedOperations = {
      removeCardIntents: () => { throw new Error("injected closure cleanup failure"); },
      releaseLeases: () => { throw new Error("injected closure lease failure"); }
    };
    expect(() => cleanupCardCoordination({
      root,
      cardId: closed.id,
      repoPaths: [repoPath],
      removeIntents: true,
      ownerToken: null
    }, failedOperations)).toThrow();

    const edited = await saveCard(root, { ...closed, title: "cleanup survives a renamed card" });
    expect(edited.rev).toBeGreaterThan(closed.rev);
    expect(edited.coordinationSeq).toBe(closed.coordinationSeq);

    const repair = await repairPendingCoordinationCleanups({ root });
    expect(repair).toMatchObject({ repaired: [closed.id], pending: [], superseded: [] });

    const contender = acquireLeases({
      repoPath,
      card: { id: "01BENIGNEDITCONTENDERAAAAA", runId: "01BENIGNEDITCONTENDERRUNAA" },
      paths: ["package-lock.json"]
    });
    expect(contender.ok).toBe(true);
    const slug = createHash("sha1").update(repoPath).digest("hex").slice(0, 16);
    const ledger = join(process.env.GARRISON_HOME!, "coord", "intents", `${slug}.jsonl`);
    expect(readFileSync(ledger, "utf8")).not.toContain(`kanban:${closed.id}`);
  });
});
