// GARRISON-FLOW-V2 S1 (Q2 point 2 + Q4 + Q8) — plan-completion ordering. Two
// same-project runs whose touch-sets overlap: the LATER run (its plan completed
// second) is deferred behind the earlier one — medium overlap waits for the
// earlier run's stability point, heavy waits for it to reach terminal. The card
// SITS in Plan (not moved), tick skips it, and reevaluateWaiting releases it.
import { describe, it, expect, beforeEach } from "vitest";

import { mkdtempSync as __mkdtemp, writeFileSync as __write } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));
process.env.GARRISON_HOME = __mkdtemp(__join(__tmpdir(), "gh-ordering-"));
// Coordination activates only when the compiled policy carries a `coordination`
// section (a policy-less run and a policy without the section never coordinate).
// This minimal policy carries the section (defaults fill its sub-keys) and no
// `phases`, so coordination is ON without engaging the D9 gate-evidence / rail
// machinery — exactly the surface these tests exercise.
const __pol = __join(process.env.GARRISON_HOME, "policy.json");
__write(__pol, JSON.stringify({ coordination: { enabled: true } }));
process.env.GARRISON_POLICY_PATH = __pol;

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, saveCard, deleteCard, loadAllCards } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { reevaluateWaiting, serializeGate, coordinationAvailability, resetCoordinationCache } from "../fittings/seed/kanban-loop/lib/coordination.mjs";

const board = seedBoard();
const tmp = () => mkdtempSync(join(tmpdir(), "coord-order-"));

// Write a touch-set into a fresh run dir and return the dir.
function withTouchSet(root: string, tag: string, files: string[]) {
  const runDir = join(root, "runs", tag);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "touch-set.json"), JSON.stringify({ version: 1, files, dirs: [], surfaces: [], exclusive: [] }));
  return runDir;
}

// An EARLIER live peer already past Plan (on implement), carrying its touch-set +
// an earlier planCompletedAt.
async function makeEarlierPeer(root: string, runId: string, files: string[], at: string) {
  const c = await createCard(root, { title: "earlier " + runId, project: "proj", list: "plan" });
  const runDir = withTouchSet(root, runId, files);
  return saveCard(root, { ...c, runId, runDir, list: "implement", status: "ok", planCompletedAt: at });
}

// A LATER card sitting on Plan, its touch-set already written (as the plan skill
// would), ready for processCard to complete its plan.
async function makeLaterCard(root: string, runId: string, files: string[]) {
  const c = await createCard(root, { title: "later " + runId, project: "proj", list: "plan" });
  const runDir = withTouchSet(root, runId, files);
  return saveCard(root, { ...c, runId, runDir });
}

beforeEach(() => resetCoordinationCache());

describe("plan-completion coordination — the later run waits on the earlier", () => {
  it("MEDIUM overlap -> the later card waits until the earlier card's stability", async () => {
    const root = tmp();
    const earlier = await makeEarlierPeer(root, "01AAAAAAAAAAAAAAAAAAAAAAAA", ["src/a.ts", "src/x.ts", "src/y.ts"], "2026-07-10T11:00:00.000Z");
    const later = await makeLaterCard(root, "01BBBBBBBBBBBBBBBBBBBBBBBB", ["src/a.ts", "src/b.ts", "src/c.ts"]);
    let called = false;
    const runFn = async () => { called = true; return { reply: "implement" }; };
    const { outcome } = await processCard({ root, board, card: later, runFn, cap: 10, now: () => "2026-07-10T12:00:00.000Z" });

    expect(called).toBe(true); // the plan run DID dispatch
    expect(outcome.status).toBe("waiting");
    const disk = await loadCard(root, later.id);
    expect(disk.list).toBe("plan"); // sat in Plan, not moved to implement
    expect(disk.waitingOn).toBeTruthy();
    expect(disk.waitingOn.cardId).toBe(earlier.id);
    expect(disk.waitingOn.grade).toBe("medium");
    expect(disk.waitingOn.until).toBe("stability");
    expect(disk.waitingOn.thenTo).toBe("implement");
    expect(typeof disk.planCompletedAt).toBe("string");
    // a coordination event recorded on the waiting card
    expect(disk.events.some((e: any) => e.kind === "coordination")).toBe(true);
    // and the blocker learns it is blocking + gets its own event (both cards, honesty)
    const blk = await loadCard(root, earlier.id);
    expect(blk.blocking).toContain(later.id);
    expect(blk.events.some((e: any) => e.kind === "coordination")).toBe(true);
  });

  it("HEAVY overlap -> the later card waits until the earlier card is terminal", async () => {
    const root = tmp();
    const earlier = await makeEarlierPeer(root, "01AAAAAAAAAAAAAAAAAAAAAAAA", ["src/a.ts", "src/b.ts", "src/c.ts"], "2026-07-10T11:00:00.000Z");
    const later = await makeLaterCard(root, "01BBBBBBBBBBBBBBBBBBBBBBBB", ["src/a.ts", "src/b.ts", "src/c.ts"]);
    const runFn = async () => ({ reply: "implement" });
    const { outcome } = await processCard({ root, board, card: later, runFn, cap: 10, now: () => "2026-07-10T12:00:00.000Z" });
    expect(outcome.status).toBe("waiting");
    const disk = await loadCard(root, later.id);
    expect(disk.waitingOn.grade).toBe("heavy");
    expect(disk.waitingOn.until).toBe("terminal");
    void earlier;
  });

  it("NO overlap -> the later card advances to implement normally", async () => {
    const root = tmp();
    await makeEarlierPeer(root, "01AAAAAAAAAAAAAAAAAAAAAAAA", ["src/other.ts"], "2026-07-10T11:00:00.000Z");
    const later = await makeLaterCard(root, "01BBBBBBBBBBBBBBBBBBBBBBBB", ["src/mine.ts"]);
    const runFn = async () => ({ reply: "implement" });
    const { outcome } = await processCard({ root, board, card: later, runFn, cap: 10, now: () => "2026-07-10T12:00:00.000Z" });
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("implement");
    const disk = await loadCard(root, later.id);
    expect(disk.list).toBe("implement");
    expect(disk.waitingOn).toBeNull();
    expect(typeof disk.planCompletedAt).toBe("string");
  });

  it("PARKS when coordination is enabled but the plan wrote no touch-set", async () => {
    const root = tmp();
    // a card on Plan with a runDir but NO touch-set.json written
    let c = await createCard(root, { title: "no touchset", project: "proj", list: "plan" });
    const runDir = join(root, "runs", "noTS");
    mkdirSync(runDir, { recursive: true });
    c = await saveCard(root, { ...c, runId: "01CCCCCCCCCCCCCCCCCCCCCCCC", runDir });
    const runFn = async () => ({ reply: "implement" });
    const { outcome } = await processCard({ root, board, card: c, runFn, cap: 10, now: () => "2026-07-10T12:00:00.000Z" });
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("no-touch-set");
    const disk = await loadCard(root, c.id);
    expect(disk.list).toBe("needs-attention");
  });
});

describe("dispatch skip + release", () => {
  it("processCard early-returns 'waiting' without dispatching a card that already has waitingOn", async () => {
    const root = tmp();
    let c = await createCard(root, { title: "waiting", project: "proj", list: "plan" });
    c = await saveCard(root, {
      ...c,
      runId: "01DDDDDDDDDDDDDDDDDDDDDDDD",
      runDir: join(root, "runs", "w"),
      waitingOn: { cardId: "01AAAAAAAAAAAAAAAAAAAAAAAA", cardTitle: "x", grade: "medium", reason: "r", until: "stability", thenTo: "implement", rerun: false, since: "t" }
    });
    let called = false;
    const runFn = async () => { called = true; return { reply: "implement" }; };
    const { outcome } = await processCard({ root, board, card: c, runFn, cap: 10 });
    expect(outcome.status).toBe("waiting");
    expect(called).toBe(false); // never dispatched
  });

  it("reevaluateWaiting releases a stability-waiter once the blocker records stabilityAt", async () => {
    const root = tmp();
    const blocker = await createCard(root, { title: "blocker", project: "proj", list: "review" });
    const blk = await saveCard(root, { ...blocker, runId: "01AAAAAAAAAAAAAAAAAAAAAAAA", runDir: join(root, "b"), stabilityAt: "2026-07-10T12:30:00.000Z", blocking: [] });
    const waiter = await createCard(root, { title: "waiter", project: "proj", list: "plan" });
    const w = await saveCard(root, {
      ...waiter,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: join(root, "w"),
      planCompletedAt: "2026-07-10T12:00:00.000Z",
      waitingOn: { cardId: blk.id, cardTitle: "blocker", grade: "medium", reason: "r", until: "stability", thenTo: "implement", rerun: false, since: "t" }
    });
    const cards = [await loadCard(root, blk.id), await loadCard(root, w.id)];
    const { released } = await reevaluateWaiting({ root, board, cards });
    expect(released.map((r: any) => r.id)).toContain(w.id);
    const disk = await loadCard(root, w.id);
    expect(disk.list).toBe("implement");
    expect(disk.waitingOn).toBeNull();
  });

  it("reevaluateWaiting does NOT release a stability-waiter while the blocker has no stabilityAt", async () => {
    const root = tmp();
    const blocker = await createCard(root, { title: "blocker", project: "proj", list: "implement" });
    const blk = await saveCard(root, { ...blocker, runId: "01AAAAAAAAAAAAAAAAAAAAAAAA", runDir: join(root, "b") });
    const waiter = await createCard(root, { title: "waiter", project: "proj", list: "plan" });
    const w = await saveCard(root, {
      ...waiter,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: join(root, "w"),
      waitingOn: { cardId: blk.id, cardTitle: "blocker", grade: "medium", reason: "r", until: "stability", thenTo: "implement", rerun: false, since: "t" }
    });
    const cards = [await loadCard(root, blk.id), await loadCard(root, w.id)];
    const { released } = await reevaluateWaiting({ root, board, cards });
    expect(released).toEqual([]);
    expect((await loadCard(root, w.id)).list).toBe("plan");
  });

  it("releases a STABILITY-waiter whose blocker was DELETED before ever passing review (no strand)", async () => {
    const root = tmp();
    const blocker = await createCard(root, { title: "blocker", project: "proj", list: "review" });
    const blk = await saveCard(root, { ...blocker, runId: "01AAAAAAAAAAAAAAAAAAAAAAAA", runDir: join(root, "b") });
    const waiter = await createCard(root, { title: "waiter", project: "proj", list: "plan" });
    await saveCard(root, {
      ...waiter,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: join(root, "w"),
      waitingOn: { cardId: blk.id, cardTitle: "blocker", grade: "medium", reason: "r", until: "stability", thenTo: "implement", rerun: false, since: "t" }
    });
    await deleteCard(root, blk.id); // blocker gone before it ever recorded stabilityAt
    const cards = await loadAllCards(root);
    const { released } = await reevaluateWaiting({ root, board, cards });
    expect(released.map((r: any) => r.id)).toContain(waiter.id);
    const disk = await loadCard(root, waiter.id);
    expect(disk.list).toBe("implement");
    expect(disk.waitingOn).toBeNull();
    expect(disk.events.some((e: any) => e.kind === "coordination" && /deleted/.test(e.message))).toBe(true);
  });

  it("releases a STABILITY-waiter whose blocker reached DONE without a stability point (terminal supersedes)", async () => {
    const root = tmp();
    const blocker = await createCard(root, { title: "blocker", project: "proj", list: "done" });
    const blk = await saveCard(root, { ...blocker, runId: "01AAAAAAAAAAAAAAAAAAAAAAAA", runDir: join(root, "b") }); // NO stabilityAt
    const waiter = await createCard(root, { title: "waiter", project: "proj", list: "plan" });
    const w = await saveCard(root, {
      ...waiter,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: join(root, "w"),
      waitingOn: { cardId: blk.id, cardTitle: "blocker", grade: "medium", reason: "r", until: "stability", thenTo: "implement", rerun: false, since: "t" }
    });
    const cards = [await loadCard(root, blk.id), await loadCard(root, w.id)];
    const { released } = await reevaluateWaiting({ root, board, cards });
    expect(released.map((r: any) => r.id)).toContain(w.id);
    const disk = await loadCard(root, w.id);
    expect(disk.list).toBe("implement");
    expect(disk.events.some((e: any) => e.kind === "coordination" && /terminal without a stability point/.test(e.message))).toBe(true);
  });

  it("reevaluateWaiting releases a terminal-waiter when the blocker reaches Done", async () => {
    const root = tmp();
    const blocker = await createCard(root, { title: "blocker", project: "proj", list: "done" });
    const blk = await saveCard(root, { ...blocker, runId: "01AAAAAAAAAAAAAAAAAAAAAAAA", runDir: join(root, "b") });
    const waiter = await createCard(root, { title: "waiter", project: "proj", list: "plan" });
    const w = await saveCard(root, {
      ...waiter,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: join(root, "w"),
      waitingOn: { cardId: blk.id, cardTitle: "blocker", grade: "heavy", reason: "r", until: "terminal", thenTo: "implement", rerun: false, since: "t" }
    });
    const cards = [await loadCard(root, blk.id), await loadCard(root, w.id)];
    const { released } = await reevaluateWaiting({ root, board, cards });
    expect(released.map((r: any) => r.id)).toContain(w.id);
    expect((await loadCard(root, w.id)).list).toBe("implement");
  });
});

describe("D9 degraded — serialize (broken substrate)", () => {
  it("a corrupt policy makes coordination unavailable and the serialize gate blocks the younger card", async () => {
    // point the policy at a corrupt file so policyLoadState() === 'corrupt'
    const badDir = mkdtempSync(join(tmpdir(), "coord-badpolicy-"));
    const badPolicy = join(badDir, "policy.json");
    writeFileSync(badPolicy, "{ not valid json ");
    const prev = process.env.GARRISON_POLICY_PATH;
    process.env.GARRISON_POLICY_PATH = badPolicy;
    resetCoordinationCache();
    try {
      expect(coordinationAvailability().ok).toBe(false);
      const older = { id: "01A", project: "p", list: "implement", runDir: "/x", status: "ok" };
      const younger = { id: "01B", project: "p", list: "implement", runDir: "/x", status: "ok" };
      const cards = [older, younger];
      expect(serializeGate(cards, older, board).allowed).toBe(true);
      expect(serializeGate(cards, younger, board).allowed).toBe(false);
    } finally {
      process.env.GARRISON_POLICY_PATH = prev;
      resetCoordinationCache();
    }
  });
});
