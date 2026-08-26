// THE "card stuck running forever" regression (2026-07-29), re-aimed twice by
// the Conversations cut (2026-08-26).
//
// Observed originally: a card was dispatched, the operative did the whole job
// and replied "done", and the card nonetheless sat at status "running"
// indefinitely — a live elapsed timer that just counted up, and nothing ever
// cleared it. The dispatch engine's terminal-write machinery (commitRunResult
// and friends) fixed that era's wedge and died with the engine: the launcher's
// writeCardTransition + the tick's kick lane replaced it.
//
// What SURVIVES, and what this file drives, are the two sweeps that release a
// run whose driver went away — plus the second-generation bug the five-state
// board introduced: every release used to clear `status` to "ok" while leaving
// `list` alone, and board.mjs coherentCardState re-derives status FROM the list
// at the write choke point, so the release was a silent no-op and the card
// stayed wedged (worse: the same write nulled runOwner, so the next sweep no
// longer classified it as orphaned at all). A release now MOVES the card to
// To do — under the five-state board, `list` IS the state.
//
// The contract, unchanged since the first incident: NO path may leave a card
// showing "running" with nobody driving it — and, new with Conversations, no
// sweep may yank a card whose conversation the kick lane can resume.
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import path from "node:path";

// @ts-ignore pure mjs
import { sweepOrphanedRuns, orphanRunThresholdMs, recoverInterruptedRuns, isOrphanedRun } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore pure mjs
import { resetPolicyCache } from "../fittings/seed/kanban-loop/lib/policy.mjs";
// @ts-ignore pure mjs
import { loadCard, saveCardCAS, deleteCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore pure mjs
import { compilePolicy, stableStringify } from "../fittings/seed/orchestrator/lib/routing-core.mjs";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState, seedCard } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});
// Fixed-ULID fixtures are reused across tests in this file; a per-test wipe gives
// each one the fresh board its own tmp root used to give it.
beforeEach(async () => {
  await __kanbanState?.reset();
});

const ROOT = path.resolve(__dirname, "..");
const SEED_CONFIG = path.join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json");

let tmp: string;

function writePolicy(file: string) {
  const cfg = JSON.parse(readFileSync(SEED_CONFIG, "utf8"));
  writeFileSync(file, stableStringify(compilePolicy(cfg)), "utf8");
  resetPolicyCache();
}

// A card mid-run. Conversations: `list` IS the state, so a running card lives on
// the `running` list — the store's write choke point re-derives `status` from it,
// and a fixture on any other list would silently read back as "ok".
async function makeRunningCard(root: string, overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string) || "01WEDGECARD000000000000000";
  const card = {
    id,
    title: "on ekoa-code move the Pedidos into a tab in the settings area",
    description: "on ekoa-code move the Pedidos into a tab in the settings area",
    project: null,
    list: "running",
    status: "running",
    runningSince: "2026-01-01T00:00:01Z",
    runOwner: { pid: process.pid, host: hostname(), at: "2026-01-01T00:00:01Z" },
    runSeq: 1,
    iterations: 0,
    rev: 0,
    goalMode: true,
    acceptance: null,
    events: [],
    runId: "01WEDGERUN0000000000000000",
    runDir: path.join(root, "runs", id),
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    ...overrides
  };
  mkdirSync(path.join(root, "cards", card.id), { recursive: true });
  if (card.runDir) mkdirSync(card.runDir as string, { recursive: true });
  const stored = await seedCard(card);
  return { ...card, rev: stored.rev, position: stored.position } as any;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "kanban-wedge-"));
  // Sandbox the runs home so a freshly MINTED runDir lands under the tmpdir, never ~/.garrison.
  process.env.GARRISON_RUNS_DIR = path.join(tmp, "runs");
  process.env.GARRISON_POLICY_PATH = path.join(tmp, "policy.json");
  writePolicy(process.env.GARRISON_POLICY_PATH);
});

// ── the backstop: a run whose DRIVER died, while the board server lives on ────
//
// recoverInterruptedRuns only fires at board-SERVER boot — which never comes for
// an always-on prod server — so a card whose driver went away is only ever
// looked at again by sweepOrphanedRuns on the tick.
describe("sweepOrphanedRuns — a lost run is released instead of wedging the board", () => {
  it("releases a run whose owner pid is dead on this host — and the release MOVES the card", async () => {
    const card = await makeRunningCard(tmp, {
      id: "01ORPHANCARD00000000000001",
      runningSince: new Date().toISOString(),
      runOwner: { pid: 4194303, host: hostname(), at: new Date().toISOString() }
    });
    expect(await sweepOrphanedRuns(tmp)).toContain(card.id);
    const onDisk: any = await loadCard(tmp, card.id);
    // Off the running list, or coherentCardState stamps "running" right back.
    expect(onDisk.list).toBe("todo");
    expect(onDisk.status).not.toBe("running");
    expect(onDisk.runningSince ?? null).toBeNull();
    expect(onDisk.runOwner ?? null).toBeNull();
    expect(onDisk.lastDispatchError.reason).toBe("orphaned");
    expect(onDisk.events.some((e: any) => e.kind === "recovered")).toBe(true);
  });

  it("leaves a run with a LIVE owner alone, however long it has been going", async () => {
    const card = await makeRunningCard(tmp, {
      id: "01ORPHANCARD00000000000002",
      runningSince: new Date(Date.now() - 10 * orphanRunThresholdMs()).toISOString(),
      runOwner: { pid: process.ppid, host: hostname(), at: new Date().toISOString() }
    });
    expect(await sweepOrphanedRuns(tmp)).toEqual([]);
    expect(((await loadCard(tmp, card.id)) as any).status).toBe("running");
  });

  it("falls back to the age ceiling when there is no usable owner stamp (a pre-existing card)", async () => {
    const fresh = await makeRunningCard(tmp, {
      id: "01ORPHANCARD00000000000003",
      runningSince: new Date().toISOString(),
      runOwner: null
    });
    expect(await sweepOrphanedRuns(tmp)).toEqual([]);
    expect(((await loadCard(tmp, fresh.id)) as any).status).toBe("running");

    const stale = await makeRunningCard(tmp, {
      id: "01ORPHANCARD00000000000004",
      runningSince: new Date(Date.now() - orphanRunThresholdMs() - 60_000).toISOString(),
      runOwner: null
    });
    expect(await sweepOrphanedRuns(tmp)).toContain(stale.id);
    const onDisk: any = await loadCard(tmp, stale.id);
    expect(onDisk.list).toBe("todo");
    expect(onDisk.status).not.toBe("running");
  });

  it("NEVER touches a conversation-linked card — the kick lane owns that recovery", async () => {
    // A crashed gateway leaves the card on Running with a resumable conversation
    // behind it. The tick re-POSTs /conversation/kick (409-idempotent) and the
    // launcher resumes from the store — a sweep release here would strand work
    // the launcher can pick straight back up.
    const card = await makeRunningCard(tmp, {
      id: "01ORPHANCARD00000000000005",
      conversationId: "01ORPHANCARD00000000000005",
      runningSince: new Date(Date.now() - 10 * orphanRunThresholdMs()).toISOString(),
      runOwner: { pid: 4194303, host: hostname(), at: new Date().toISOString() }
    });
    expect(isOrphanedRun(card)).toBeNull();
    expect(await sweepOrphanedRuns(tmp)).toEqual([]);
    const onDisk: any = await loadCard(tmp, card.id);
    expect(onDisk.list).toBe("running");
    expect(onDisk.status).toBe("running");
  });

  it("the threshold is derived from the dispatcher's per-turn timeout, never a bare literal", () => {
    const turn = process.env.KANBAN_TURN_TIMEOUT_MS;
    const slack = process.env.KANBAN_ORPHAN_SLACK_MS;
    try {
      process.env.KANBAN_TURN_TIMEOUT_MS = "60000";
      process.env.KANBAN_ORPHAN_SLACK_MS = "1000";
      expect(orphanRunThresholdMs()).toBe(61_000);
    } finally {
      if (turn === undefined) delete process.env.KANBAN_TURN_TIMEOUT_MS; else process.env.KANBAN_TURN_TIMEOUT_MS = turn;
      if (slack === undefined) delete process.env.KANBAN_ORPHAN_SLACK_MS; else process.env.KANBAN_ORPHAN_SLACK_MS = slack;
    }
  });
});

// The boot sweep must not clear a run driven by a LIVE process that is not us —
// a board restart (every prod:redeploy) must never reset a card another local
// process is still driving.
describe("recoverInterruptedRuns — a live foreign driver is left alone", () => {
  it("clears a run with a DEAD owner — released to To do, not flipped in place", async () => {
    const card = await makeRunningCard(tmp, {
      id: "01BOOTSWEEP000000000000001",
      runningSince: new Date().toISOString(),
      runOwner: { pid: 4194303, host: hostname(), at: new Date().toISOString() }
    });
    const recovered = await recoverInterruptedRuns(tmp);
    expect(recovered).toContain(card.id);
    const onDisk: any = await loadCard(tmp, card.id);
    expect(onDisk.list).toBe("todo");
    expect(onDisk.status).toBe("ok");
    expect(onDisk.runOwner ?? null).toBeNull(); // the stale stamp is cleared too
  });

  it("does NOT clear a run whose driver is another live process on this host", async () => {
    // A pid that is alive but is not us: our own parent.
    const card = await makeRunningCard(tmp, {
      id: "01BOOTSWEEP000000000000002",
      runningSince: new Date().toISOString(),
      runOwner: { pid: process.ppid, host: hostname(), at: new Date().toISOString() }
    });
    const recovered = await recoverInterruptedRuns(tmp);
    expect(recovered).not.toContain(card.id);
    expect(((await loadCard(tmp, card.id)) as any).status).toBe("running");
  });

  it("still clears a run stamped by THIS pid — that is our own previous life, not a live driver", async () => {
    const card = await makeRunningCard(tmp, {
      id: "01BOOTSWEEP000000000000003",
      runningSince: new Date().toISOString(),
      runOwner: { pid: process.pid, host: hostname(), at: new Date().toISOString() }
    });
    expect(await recoverInterruptedRuns(tmp)).toContain(card.id);
  });

  it("NEVER touches a conversation-linked card — a board restart does not interrupt the gateway", async () => {
    const card = await makeRunningCard(tmp, {
      id: "01BOOTSWEEP000000000000004",
      conversationId: "01BOOTSWEEP000000000000004",
      runOwner: { pid: 4194303, host: hostname(), at: new Date().toISOString() }
    });
    expect(await recoverInterruptedRuns(tmp)).toEqual([]);
    const onDisk: any = await loadCard(tmp, card.id);
    expect(onDisk.list).toBe("running");
    expect(onDisk.status).toBe("running");
  });
});

// A DELETED card must stay deleted.
//
// Observed live: a probe card was deleted while its turn was still in flight. A
// minute later the card was BACK on the board, parked in needs-attention, with only
// the artifacts of that final write in its directory. saveCardCAS skipped the rev
// check whenever the card was missing — commented "first write of a brand-new card"
// — and wrote anyway, so any writer holding a stale in-memory copy resurrected it.
describe("saveCardCAS — a deleted card is never resurrected", () => {
  it("refuses the write and reports `deleted` when the card is gone", async () => {
    const card = await makeRunningCard(tmp, { id: "01DELETEDCARD00000000000001" });
    // The store tombstones the card; a PATCH against it is structurally a 404,
    // which is the same refusal the missing file used to produce.
    expect(await deleteCard(tmp, card.id)).toBe(true);

    const res: any = await saveCardCAS(tmp, { ...card, list: "done" }, card.rev ?? 0);

    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(true);
    expect(existsSync(path.join(tmp, "cards", card.id, "card.json"))).toBe(false);
  });

  it("a normal update still works — the guard only fires on a missing file", async () => {
    const card = await makeRunningCard(tmp, { id: "01DELETEDCARD00000000000003" });
    const res: any = await saveCardCAS(tmp, { ...card, list: "done", status: "ok", runningSince: null }, card.rev ?? 0);
    expect(res.ok).toBe(true);
    expect(res.card.list).toBe("done");
  });
});
