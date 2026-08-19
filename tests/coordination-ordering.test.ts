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

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, saveCard, deleteCard, loadAllCards, updateCardCAS, withCardLock } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { reevaluateWaiting, serializeGate, coordinationAvailability, resetCoordinationCache, acquireLeases, renewLeases, releaseLeases, registerTouchSetIntent } from "../fittings/seed/kanban-loop/lib/coordination.mjs";

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

async function makeMixedPredicateCohort(root: string) {
  const blockerBase = await createCard(root, { title: "stable blocker", project: "proj", list: "review" });
  const blocker = await saveCard(root, {
    ...blockerBase,
    runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
    runDir: withTouchSet(root, "mixed-predicate-blocker", ["src/shared.ts"]),
    stabilityAt: "2026-08-03T10:05:00.000Z"
  });
  const makeWaiter = async (title: string, runId: string, planCompletedAt: string, until: "stability" | "terminal") => {
    const base = await createCard(root, { title, project: "proj", list: "plan" });
    return saveCard(root, {
      ...base,
      runId,
      runDir: withTouchSet(root, runId, ["src/shared.ts"]),
      planCompletedAt,
      waitingOn: {
        cardId: blocker.id,
        cardTitle: blocker.title,
        grade: until === "stability" ? "medium" : "heavy",
        reason: "same file",
        until,
        thenTo: "implement",
        rerun: false,
        since: planCompletedAt
      }
    });
  };
  const stabilityWaiter = await makeWaiter(
    "stability successor",
    "01BBBBBBBBBBBBBBBBBBBBBBBB",
    "2026-08-03T10:00:00.000Z",
    "stability"
  );
  const terminalWaiter = await makeWaiter(
    "terminal follower",
    "01CCCCCCCCCCCCCCCCCCCCCCCC",
    "2026-08-03T10:01:00.000Z",
    "terminal"
  );
  return { blocker, stabilityWaiter, terminalWaiter };
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

  it("a needs-attention peer keeps blocking a new overlapping plan until human resolution", async () => {
    const root = tmp();
    const earlier = await makeEarlierPeer(
      root,
      "01AAAAAAAAAAAAAAAAAAAAAAAA",
      ["src/a.ts", "src/x.ts", "src/y.ts"],
      "2026-07-10T11:00:00.000Z"
    );
    await saveCard(root, {
      ...earlier,
      list: "needs-attention",
      status: "needs-attention",
      stabilityAt: null
    });
    const later = await makeLaterCard(
      root,
      "01BBBBBBBBBBBBBBBBBBBBBBBB",
      ["src/a.ts", "src/b.ts", "src/c.ts"]
    );

    const { outcome } = await processCard({
      root,
      board,
      card: later,
      runFn: async () => ({ reply: "implement" }),
      cap: 10,
      now: () => "2026-07-10T12:00:00.000Z"
    });

    expect(outcome).toMatchObject({ status: "waiting" });
    expect((await loadCard(root, later.id)).waitingOn).toMatchObject({
      cardId: earlier.id,
      grade: "medium",
      until: "stability"
    });
  });

  it("a prior run moved to a human-held backlog keeps its shared-checkout claim", async () => {
    const root = tmp();
    const held = await makeEarlierPeer(
      root,
      "01AAAAAAAAAAAAAAAAAAAAAAAA",
      ["src/a.ts", "src/x.ts", "src/y.ts"],
      "2026-07-10T11:00:00.000Z"
    );
    await saveCard(root, { ...held, list: "backlog", status: "ok" });
    const later = await makeLaterCard(
      root,
      "01BBBBBBBBBBBBBBBBBBBBBBBB",
      ["src/a.ts", "src/b.ts", "src/c.ts"]
    );

    const { outcome } = await processCard({
      root,
      board,
      card: later,
      runFn: async () => ({ reply: "implement" }),
      now: () => "2026-07-10T12:00:00.000Z"
    });

    expect(outcome).toMatchObject({ status: "waiting" });
    expect((await loadCard(root, later.id)).waitingOn).toMatchObject({ cardId: held.id });
  });

  it("refreshes a resumed card's outward intent after a long human-held pause", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "coord-resume-intent-"));
    const boardWithRepo = { ...board, projects: { proj: { path: repoDir } } };
    const base = await createCard(root, { title: "resumed", project: "proj", list: "needs-attention" });
    const runDir = withTouchSet(root, "resumed-intent", ["src/a.ts"]);
    const resumed = await saveCard(root, {
      ...base,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir,
      list: "implement",
      status: "ok"
    });
    // @ts-ignore — pure .mjs
    const { prepareRecoveredCoordinationHold } = await import("../fittings/seed/kanban-loop/scripts/server.mjs");
    const refreshedAt = "2026-07-10T12:00:00.000Z";
    prepareRecoveredCoordinationHold(boardWithRepo, resumed, () => "2026-06-01T09:00:00.000Z");
    const hold = prepareRecoveredCoordinationHold(boardWithRepo, resumed, () => refreshedAt);
    const row = hold.intent;

    expect(hold.ok).toBe(true);
    expect(row).toMatchObject({
      session: `kanban:${resumed.id}`,
      cardId: resumed.id,
      ts: refreshedAt,
      files: ["src/a.ts"]
    });
    const slug = createHash("sha1").update(repoDir).digest("hex").slice(0, 16);
    const ledger = join(process.env.GARRISON_HOME!, "coord", "intents", `${slug}.jsonl`);
    const rows = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const claims = rows.filter((entry) => entry.session === `kanban:${resumed.id}` && entry.kind === "touch-set");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ ts: refreshedAt });
  });

  it("restores an expired exclusive lease before the resume CAS can expose the card as active", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "coord-resume-lease-"));
    const boardWithRepo = { ...board, projects: { proj: { path: repoDir } } };
    const base = await createCard(root, { title: "parked holder", project: "proj", list: "needs-attention" });
    const runDir = join(root, "runs", "resume-lease");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "touch-set.json"), JSON.stringify({
      version: 1,
      files: ["package-lock.json"],
      dirs: [],
      surfaces: [],
      exclusive: ["package-lock.json"]
    }));
    const parked = await saveCard(root, {
      ...base,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir,
      status: "needs-attention",
      parkedFrom: "implement"
    });
    const waiterBase = await createCard(root, { title: "lease waiter", project: "proj", list: "implement" });
    const waiterDir = join(root, "runs", "resume-waiter");
    mkdirSync(waiterDir, { recursive: true });
    writeFileSync(join(waiterDir, "touch-set.json"), JSON.stringify({
      version: 1,
      files: ["package-lock.json"],
      dirs: [],
      surfaces: [],
      exclusive: ["package-lock.json"]
    }));
    const waiter = await saveCard(root, {
      ...waiterBase,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: waiterDir,
      waitingOn: {
        cardId: parked.id,
        cardTitle: parked.title,
        grade: "lease",
        reason: "exclusive lease",
        until: "lease",
        thenTo: "implement",
        rerun: true,
        since: "t"
      }
    });
    // No lease file exists: the parked-card rule alone has kept the waiter held.
    // Recovery must durably restore that lease while the card is still parked,
    // then CAS it active; there is never a snapshot where both may run.
    // @ts-ignore — pure .mjs
    const { prepareRecoveredCoordinationHold } = await import("../fittings/seed/kanban-loop/scripts/server.mjs");
    const hold = prepareRecoveredCoordinationHold(boardWithRepo, {
      ...parked,
      list: "implement",
      status: "ok"
    }, () => "2026-07-10T12:00:00.000Z");
    expect(hold).toMatchObject({ ok: true, acquired: ["package-lock.json"] });
    const resumed = await saveCard(root, { ...parked, list: "implement", status: "ok", parkedFrom: null });

    const review = await reevaluateWaiting({
      root,
      board: boardWithRepo,
      cards: [await loadCard(root, resumed.id), await loadCard(root, waiter.id)]
    });
    expect(review.released).toEqual([]);
    expect((await loadCard(root, waiter.id)).waitingOn).toMatchObject({ cardId: resumed.id, until: "lease" });
  });

  it("does not let an explicitly abandoned card regain a released coordination position", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "coord-abandoned-resume-"));
    const boardWithRepo = { ...board, projects: { proj: { path: repoDir } } };
    const base = await createCard(root, { title: "abandoned", project: "proj", list: "needs-attention" });
    const runDir = withTouchSet(root, "abandoned-resume", ["src/a.ts"]);
    const card = await saveCard(root, {
      ...base,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir,
      status: "needs-attention",
      abandoned: true
    });
    // @ts-ignore — pure .mjs
    const { prepareRecoveredCoordinationHold } = await import("../fittings/seed/kanban-loop/scripts/server.mjs");
    expect(prepareRecoveredCoordinationHold(boardWithRepo, card)).toMatchObject({
      ok: false,
      code: "abandoned-card"
    });
  });

  it("fails recovery closed when a previously-started card lost or corrupted its touch-set", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "coord-missing-resume-touchset-"));
    const boardWithRepo = { ...board, projects: { proj: { path: repoDir } } };
    const base = await createCard(root, { title: "lost evidence", project: "proj", list: "needs-attention" });
    const runDir = join(root, "runs", "missing-resume-touchset");
    mkdirSync(runDir, { recursive: true }); // run minted, but touch-set is missing
    const card = await saveCard(root, {
      ...base,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir,
      status: "needs-attention",
      parkedFrom: "implement"
    });
    // @ts-ignore — pure .mjs
    const { prepareRecoveredCoordinationHold } = await import("../fittings/seed/kanban-loop/scripts/server.mjs");

    expect(prepareRecoveredCoordinationHold(boardWithRepo, card)).toMatchObject({
      ok: false,
      code: "touch-set-unavailable"
    });

    writeFileSync(join(runDir, "touch-set.json"), "{not-json");
    expect(prepareRecoveredCoordinationHold(boardWithRepo, card)).toMatchObject({
      ok: false,
      code: "touch-set-unavailable"
    });
  });

  it("lets a card with no touch-set move to PLAN, which is where one comes from", async () => {
    // The refusal names "re-run Plan" as the remedy, and Plan is a move - so
    // refusing every move left Abandon as the only real exit. It is reachable on
    // this board: a straight Discuss -> Implement move mints a runDir and skips
    // the only phase that writes a touch-set.
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "coord-replan-"));
    const boardWithRepo = { ...board, projects: { proj: { path: repoDir } } };
    const base = await createCard(root, { title: "skipped plan", project: "proj", list: "needs-attention" });
    const runDir = join(root, "runs", "replan-no-touchset");
    mkdirSync(runDir, { recursive: true });
    const card = await saveCard(root, {
      ...base,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir,
      status: "needs-attention",
      parkedFrom: "implement"
    });
    // @ts-ignore — pure .mjs
    const { prepareRecoveredCoordinationHold } = await import("../fittings/seed/kanban-loop/scripts/server.mjs");

    expect(prepareRecoveredCoordinationHold(boardWithRepo, card, undefined, "plan")).toMatchObject({
      ok: true,
      skipped: "replanning"
    });
    // Every OTHER direction still fails closed: only planning re-derives the
    // overlap, so only planning may proceed without it.
    for (const phase of ["implement", "review", "test", null]) {
      expect(prepareRecoveredCoordinationHold(boardWithRepo, card, undefined, phase)).toMatchObject({
        ok: false,
        code: "touch-set-unavailable"
      });
    }
  });

  it("fails recovery closed when another card now owns an exclusive path", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "coord-resume-conflict-"));
    const boardWithRepo = { ...board, projects: { proj: { path: repoDir } } };
    const base = await createCard(root, { title: "parked contender", project: "proj", list: "needs-attention" });
    const runDir = join(root, "runs", "resume-conflict");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "touch-set.json"), JSON.stringify({
      version: 1,
      files: ["package-lock.json"],
      dirs: [],
      surfaces: [],
      exclusive: ["package-lock.json"]
    }));
    const card = await saveCard(root, {
      ...base,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir,
      status: "needs-attention"
    });
    acquireLeases({
      repoPath: repoDir,
      card: { id: "01BBBBBBBBBBBBBBBBBBBBBBBB", runId: "01BBBBBBBBBBBBBBBBBBBBBBBB" },
      paths: ["package-lock.json"]
    });
    // @ts-ignore — pure .mjs
    const { prepareRecoveredCoordinationHold } = await import("../fittings/seed/kanban-loop/scripts/server.mjs");
    expect(prepareRecoveredCoordinationHold(boardWithRepo, card)).toMatchObject({
      ok: false,
      code: "lease-held",
      path: "package-lock.json",
      heldBy: "01BBBBBBBBBBBBBBBBBBBBBBBB"
    });
  });

  it("an out-of-repo filesystem surface is valid coordination evidence", async () => {
    const root = tmp();
    const c = await createCard(root, { title: "external", project: "proj", list: "plan" });
    const runDir = join(root, "runs", "external");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "touch-set.json"), JSON.stringify({
      version: 1,
      files: [],
      dirs: [],
      exclusive: [],
      surfaces: ["filesystem:/tmp/external-package"]
    }));
    const card = await saveCard(root, { ...c, runId: "01EEEEEEEEEEEEEEEEEEEEEEEE", runDir });
    const { outcome } = await processCard({
      root,
      board,
      card,
      runFn: async () => ({ reply: "implement" }),
      now: () => "2026-07-10T12:00:00.000Z"
    });
    expect(outcome).toMatchObject({ status: "moved", to: "implement" });
  });

  it("PARKS when coordination is enabled but the plan wrote no touch-set", async () => {
    const root = tmp();
    // a card on Plan with a runDir but NO touch-set.json written
    let c = await createCard(root, { title: "no touchset", project: "proj", list: "plan" });
    const runDir = join(root, "runs", "noTS");
    mkdirSync(runDir, { recursive: true });
    c = await saveCard(root, { ...c, runId: "01CCCCCCCCCCCCCCCCCCCCCCCC", runDir });
    const runFn = async () => ({
      reply: "implement",
      route: {
        targetId: "sdk-sonnet-full",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "medium",
        effortApplied: true
      }
    });
    const { outcome } = await processCard({ root, board, card: c, runFn, cap: 10, now: () => "2026-07-10T12:00:00.000Z" });
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("no-touch-set");
    const disk = await loadCard(root, c.id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "runtime",
        route: expect.objectContaining({
          targetId: "sdk-sonnet-full",
          runtime: "agent-sdk",
          model: "claude-sonnet-4-6",
          effort: "medium",
          effortApplied: true,
          phase: "plan"
        })
      })
    ]));
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

  it("releases only one waiter per overlapping successor chain when a blocker closes", async () => {
    const root = tmp();
    const blockerBase = await createCard(root, { title: "closed blocker", project: "proj", list: "done" });
    const blocker = await saveCard(root, {
      ...blockerBase,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir: withTouchSet(root, "closed-fanout-blocker", ["src/shared.ts"]),
      blocking: []
    });

    const makeWaiter = async (title: string, runId: string, planCompletedAt: string) => {
      const base = await createCard(root, { title, project: "proj", list: "plan" });
      return saveCard(root, {
        ...base,
        runId,
        runDir: withTouchSet(root, runId, ["src/shared.ts"]),
        planCompletedAt,
        waitingOn: {
          cardId: blocker.id,
          cardTitle: blocker.title,
          grade: "heavy",
          reason: "same file",
          until: "terminal",
          thenTo: "implement",
          rerun: false,
          since: planCompletedAt
        }
      });
    };
    const first = await makeWaiter("first", "01BBBBBBBBBBBBBBBBBBBBBBBB", "2026-08-03T10:00:00.000Z");
    const second = await makeWaiter("second", "01CCCCCCCCCCCCCCCCCCCCCCCC", "2026-08-03T10:01:00.000Z");
    const third = await makeWaiter("third", "01DDDDDDDDDDDDDDDDDDDDDDDD", "2026-08-03T10:02:00.000Z");

    // Deliberately omit the earliest waiter from the caller snapshot. The
    // reevaluator must build its cohort from fresh disk state or this stale
    // caller would release `second` while another tick releases `first`.
    const result = await reevaluateWaiting({ root, board, cards: [blocker, second, third] });

    expect(result.released).toEqual([{ id: first.id, to: "implement" }]);
    expect((await loadCard(root, first.id)).waitingOn).toBeNull();
    expect(await loadCard(root, second.id)).toMatchObject({
      list: "plan",
      waitingOn: { cardId: first.id, until: "terminal", grade: "heavy" }
    });
    expect(await loadCard(root, third.id)).toMatchObject({
      list: "plan",
      waitingOn: { cardId: first.id, until: "terminal", grade: "heavy" }
    });
  });

  it("re-chains a terminal waiter when an overlapping stability waiter becomes the successor", async () => {
    const root = tmp();
    const { blocker, stabilityWaiter, terminalWaiter } = await makeMixedPredicateCohort(root);

    const result = await reevaluateWaiting({ root, board, cards: [blocker, stabilityWaiter, terminalWaiter] });

    expect(result.released).toEqual([{ id: stabilityWaiter.id, to: "implement" }]);
    expect(await loadCard(root, stabilityWaiter.id)).toMatchObject({ list: "implement", waitingOn: null });
    expect(await loadCard(root, terminalWaiter.id)).toMatchObject({
      list: "plan",
      waitingOn: { cardId: stabilityWaiter.id, until: "terminal", grade: "heavy" }
    });

    const secondPass = await reevaluateWaiting({
      root,
      board,
      cards: await loadAllCards(root)
    });
    expect(secondPass.released).toEqual([]);
    expect((await loadCard(root, terminalWaiter.id)).waitingOn.cardId).toBe(stabilityWaiter.id);
  });

  it("durably re-chains the follower before the successor can be released", async () => {
    const root = tmp();
    const { blocker, stabilityWaiter, terminalWaiter } = await makeMixedPredicateCohort(root);
    let review!: ReturnType<typeof reevaluateWaiting>;

    // Hold the would-be leader's lifecycle lock. The reevaluator must still be
    // able to commit the follower edge, then block before releasing the leader.
    await withCardLock(root, stabilityWaiter.id, async () => {
      review = reevaluateWaiting({ root, board, cards: [blocker, stabilityWaiter, terminalWaiter] });
      const deadline = Date.now() + 2_000;
      for (;;) {
        const follower = await loadCard(root, terminalWaiter.id);
        if (follower.waitingOn?.cardId === stabilityWaiter.id) break;
        if (Date.now() > deadline) throw new Error("follower was not durably re-chained before leader release");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await loadCard(root, stabilityWaiter.id)).toMatchObject({
        list: "plan",
        waitingOn: { cardId: blocker.id, until: "stability" }
      });
    });

    await expect(review).resolves.toMatchObject({ released: [{ id: stabilityWaiter.id, to: "implement" }] });
  });

  it("does not release the successor when the follower re-chain loses its CAS", async () => {
    const root = tmp();
    const { blocker, stabilityWaiter, terminalWaiter } = await makeMixedPredicateCohort(root);
    let review!: ReturnType<typeof reevaluateWaiting>;

    // Force the follower snapshot stale while reevaluation owns the original
    // blocker and waits for this lock. A failed follower CAS must hold the leader.
    await withCardLock(root, terminalWaiter.id, async () => {
      review = reevaluateWaiting({ root, board, cards: [blocker, stabilityWaiter, terminalWaiter] });
      const blockerBridge = join(root, ".card-locks", `${blocker.id}.lock`);
      const deadline = Date.now() + 2_000;
      while (!existsSync(blockerBridge)) {
        if (Date.now() > deadline) throw new Error("reevaluator did not reach the blocker critical section");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const fresh = await loadCard(root, terminalWaiter.id);
      await saveCard(root, { ...fresh, title: "concurrent follower update" });
    });

    await expect(review).resolves.toEqual({ released: [] });
    expect(await loadCard(root, stabilityWaiter.id)).toMatchObject({
      list: "plan",
      waitingOn: { cardId: blocker.id, until: "stability" }
    });
    expect(await loadCard(root, terminalWaiter.id)).toMatchObject({
      title: "concurrent follower update",
      waitingOn: { cardId: blocker.id, until: "terminal" }
    });
  });

  it("terminal closure removes the blocker's stale intent and lease before releasing its waiter", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "coord-terminal-cleanup-"));
    const boardWithRepo = { ...board, projects: { proj: { path: repoDir } } };
    const blockerBase = await createCard(root, { title: "finished holder", project: "proj", list: "done" });
    const blocker = await saveCard(root, {
      ...blockerBase,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir: join(root, "finished-holder")
    });
    registerTouchSetIntent({
      repoPath: repoDir,
      card: blocker,
      touchSet: { files: ["package-lock.json"], dirs: [], exclusive: ["package-lock.json"] }
    });
    expect(acquireLeases({ repoPath: repoDir, card: blocker, paths: ["package-lock.json"] }).ok).toBe(true);
    const waiterBase = await createCard(root, { title: "lease waiter", project: "proj", list: "implement" });
    const waiterDir = join(root, "terminal-waiter");
    mkdirSync(waiterDir, { recursive: true });
    writeFileSync(join(waiterDir, "touch-set.json"), JSON.stringify({
      version: 1,
      files: ["package-lock.json"],
      dirs: [],
      surfaces: [],
      exclusive: ["package-lock.json"]
    }));
    const waiter = await saveCard(root, {
      ...waiterBase,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: waiterDir,
      waitingOn: {
        cardId: blocker.id,
        cardTitle: blocker.title,
        grade: "lease",
        reason: "exclusive lease",
        until: "lease",
        thenTo: "implement",
        rerun: true,
        since: "t"
      }
    });

    const review = await reevaluateWaiting({
      root,
      board: boardWithRepo,
      cards: [await loadCard(root, blocker.id), await loadCard(root, waiter.id)]
    });
    expect(review.released).toEqual([{ id: waiter.id, to: "implement" }]);
    const slug = createHash("sha1").update(repoDir).digest("hex").slice(0, 16);
    const ledger = join(process.env.GARRISON_HOME!, "coord", "intents", `${slug}.jsonl`);
    expect(readFileSync(ledger, "utf8")).not.toContain(`kanban:${blocker.id}`);
    expect(acquireLeases({
      repoPath: repoDir,
      card: { id: "01CCCCCCCCCCCCCCCCCCCCCCCC", runId: "01CCCCCCCCCCCCCCCCCCCCCCCC" },
      paths: ["package-lock.json"]
    }).ok).toBe(true);
  });

  it("keeps every overlapping waiter held when their blocker parks", async () => {
    const root = tmp();
    const blocker = await createCard(root, { title: "blocker", project: "proj", list: "review" });
    const waiterA = await createCard(root, { title: "waiter A", project: "proj", list: "plan" });
    const waiterB = await createCard(root, { title: "waiter B", project: "proj", list: "plan" });
    const blk = await saveCard(root, {
      ...blocker,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir: join(root, "b"),
      list: "needs-attention",
      status: "needs-attention",
      stabilityAt: null,
      blocking: [waiterA.id, waiterB.id]
    });
    const wait = (title: string) => ({
      cardId: blk.id,
      cardTitle: "blocker",
      grade: "heavy",
      reason: `${title} overlaps blocker`,
      until: "terminal",
      thenTo: "implement",
      rerun: false,
      since: "t"
    });
    const a = await saveCard(root, {
      ...waiterA,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: join(root, "wa"),
      waitingOn: wait(waiterA.title)
    });
    const b = await saveCard(root, {
      ...waiterB,
      runId: "01CCCCCCCCCCCCCCCCCCCCCCCC",
      runDir: join(root, "wb"),
      waitingOn: wait(waiterB.title)
    });

    const cards = [await loadCard(root, blk.id), await loadCard(root, a.id), await loadCard(root, b.id)];
    const { released } = await reevaluateWaiting({ root, board, cards });

    expect(released).toEqual([]);
    expect((await loadCard(root, a.id)).waitingOn).toMatchObject({ cardId: blk.id });
    expect((await loadCard(root, b.id)).waitingOn).toMatchObject({ cardId: blk.id });
    expect((await loadCard(root, blk.id)).blocking).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it("a stale parked snapshot cannot release a waiter while the blocker is being resumed", async () => {
    const root = tmp();
    const blockerBase = await createCard(root, { title: "blocker", project: "proj", list: "review" });
    const blocker = await saveCard(root, {
      ...blockerBase,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir: join(root, "blocker"),
      list: "needs-attention",
      status: "needs-attention",
      parkedFrom: "review",
      stabilityAt: null
    });
    const waiterBase = await createCard(root, { title: "waiter", project: "proj", list: "plan" });
    const waiter = await saveCard(root, {
      ...waiterBase,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: join(root, "waiter"),
      waitingOn: {
        cardId: blocker.id,
        cardTitle: blocker.title,
        grade: "medium",
        reason: "overlap",
        until: "stability",
        thenTo: "implement",
        rerun: false,
        since: "t"
      }
    });
    const staleParkedSnapshot = [
      await loadCard(root, blocker.id),
      await loadCard(root, waiter.id)
    ];

    // The human resumes the blocker after reevaluation took its snapshot. The old
    // snapshot must remain fail-closed; otherwise it can release the waiter after
    // the resumed blocker has already started against the same checkout.
    await saveCard(root, {
      ...blocker,
      list: "review",
      status: "ok",
      parkedFrom: null,
      attentionReason: null
    });
    const stale = await reevaluateWaiting({ root, board, cards: staleParkedSnapshot });
    expect(stale.released).toEqual([]);
    expect((await loadCard(root, waiter.id)).waitingOn).toMatchObject({ cardId: blocker.id });

    // A fresh snapshot also keeps waiting because Review has not reached stability.
    const fresh = await reevaluateWaiting({ root, board, cards: await loadAllCards(root) });
    expect(fresh.released).toEqual([]);
  });

  it("a parked lease holder remains fail-closed even when its lease file is absent", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "coord-parked-lease-"));
    const boardWithRepo = { ...board, projects: { proj: { path: repoDir } } };
    const blockerBase = await createCard(root, { title: "lease holder", project: "proj", list: "implement" });
    const blocker = await saveCard(root, {
      ...blockerBase,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir: join(root, "holder"),
      list: "needs-attention",
      status: "needs-attention",
      parkedFrom: "implement"
    });
    const waiterBase = await createCard(root, { title: "lease waiter", project: "proj", list: "implement" });
    const waiterDir = join(root, "lease-waiter");
    mkdirSync(waiterDir, { recursive: true });
    writeFileSync(join(waiterDir, "touch-set.json"), JSON.stringify({
      version: 1,
      files: ["package-lock.json"],
      dirs: [],
      surfaces: [],
      exclusive: ["package-lock.json"]
    }));
    const waiter = await saveCard(root, {
      ...waiterBase,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: waiterDir,
      waitingOn: {
        cardId: blocker.id,
        cardTitle: blocker.title,
        grade: "lease",
        reason: "exclusive lease",
        until: "lease",
        thenTo: "implement",
        rerun: true,
        since: "t"
      }
    });

    const held = await reevaluateWaiting({
      root,
      board: boardWithRepo,
      cards: [await loadCard(root, blocker.id), await loadCard(root, waiter.id)]
    });
    expect(held.released).toEqual([]);

    // Explicit Abandon is the human-controlled release override. Normal parking
    // never infers checkout cleanliness or releases the holder automatically.
    await saveCard(root, { ...blocker, abandoned: true });
    const released = await reevaluateWaiting({
      root,
      board: boardWithRepo,
      cards: await loadAllCards(root)
    });
    expect(released.released).toEqual([{ id: waiter.id, to: "implement" }]);
    expect((await loadCard(root, waiter.id)).waitingOn).toBeNull();
  });

  it("does not release a lease waiter from a live Implement owner just because the lease file is absent", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "coord-live-missing-lease-"));
    const boardWithRepo = { ...board, projects: { proj: { path: repoDir } } };
    const blockerBase = await createCard(root, { title: "live implement owner", project: "proj", list: "implement" });
    const blocker = await saveCard(root, {
      ...blockerBase,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir: withTouchSet(root, "live-implement-owner", ["package-lock.json"]),
      status: "running"
    });
    const waiterBase = await createCard(root, { title: "lease waiter", project: "proj", list: "implement" });
    const waiterDir = join(root, "runs", "live-lease-waiter");
    mkdirSync(waiterDir, { recursive: true });
    writeFileSync(join(waiterDir, "touch-set.json"), JSON.stringify({
      version: 1,
      files: ["package-lock.json"],
      dirs: [],
      surfaces: [],
      exclusive: ["package-lock.json"]
    }));
    const waiter = await saveCard(root, {
      ...waiterBase,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: waiterDir,
      waitingOn: {
        cardId: blocker.id,
        cardTitle: blocker.title,
        grade: "lease",
        reason: "exclusive lease",
        until: "lease",
        thenTo: "implement",
        rerun: true,
        since: "t"
      }
    });

    const result = await reevaluateWaiting({
      root,
      board: boardWithRepo,
      cards: [await loadCard(root, blocker.id), await loadCard(root, waiter.id)]
    });

    expect(result.released).toEqual([]);
    expect((await loadCard(root, waiter.id)).waitingOn).toMatchObject({ cardId: blocker.id, until: "lease" });
  });

  it("never releases a waiter that is itself on a human-held list", async () => {
    const root = tmp();
    const blocker = await createCard(root, { title: "finished blocker", project: "proj", list: "done" });
    const blk = await saveCard(root, {
      ...blocker,
      runId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      runDir: join(root, "b")
    });
    const waiter = await createCard(root, { title: "parked waiter", project: "proj", list: "plan" });
    const parked = await saveCard(root, {
      ...waiter,
      runId: "01BBBBBBBBBBBBBBBBBBBBBBBB",
      runDir: join(root, "w"),
      list: "needs-attention",
      status: "needs-attention",
      parkedFrom: "plan",
      waitingOn: {
        cardId: blk.id,
        cardTitle: blk.title,
        grade: "heavy",
        reason: "r",
        until: "terminal",
        thenTo: "implement",
        rerun: false,
        since: "t"
      }
    });
    const backlogBase = await createCard(root, { title: "backlog waiter", project: "proj", list: "backlog" });
    const backlogWaiter = await saveCard(root, {
      ...backlogBase,
      runId: "01CCCCCCCCCCCCCCCCCCCCCCCC",
      runDir: join(root, "manual-w"),
      list: "backlog",
      status: "ok",
      waitingOn: {
        cardId: blk.id,
        cardTitle: blk.title,
        grade: "heavy",
        reason: "r",
        until: "terminal",
        thenTo: "implement",
        rerun: false,
        since: "t"
      }
    });

    const { released } = await reevaluateWaiting({
      root,
      board,
      cards: [
        await loadCard(root, blk.id),
        await loadCard(root, parked.id),
        await loadCard(root, backlogWaiter.id)
      ]
    });

    expect(released).toEqual([]);
    const disk = await loadCard(root, parked.id);
    expect(disk).toMatchObject({
      list: "needs-attention",
      status: "needs-attention",
      parkedFrom: "plan"
    });
    expect(disk.waitingOn).toMatchObject({ cardId: blk.id, until: "terminal" });
    expect(await loadCard(root, backlogWaiter.id)).toMatchObject({
      list: "backlog",
      waitingOn: { cardId: blk.id, until: "terminal" }
    });
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

describe("D6 exclusive-lease union from policy", () => {
  it("uses the project settled by inference when checking Implement lease contention", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "lease-inferred-project-"));
    const inferredBoard = { ...seedBoard(), projects: { inferred: { path: repoDir } } };
    const path = "package-lock.json";
    const holder = { id: "01INFERLEASEHOLDERAAAAAAAA", runId: "01INFERLEASEHOLDERRUNAAA" };
    expect(acquireLeases({ repoPath: repoDir, card: holder, paths: [path] }).ok).toBe(true);

    const base = await createCard(root, { title: "infer before lease", project: null, list: "implement" });
    const runDir = withTouchSet(root, "inferred-project-waiter", [path]);
    writeFileSync(join(runDir, "touch-set.json"), JSON.stringify({
      version: 1,
      files: [path],
      dirs: [],
      surfaces: [],
      exclusive: [path]
    }));
    const card = await saveCard(root, {
      ...base,
      project: null,
      inferState: "running",
      runId: "01INFERLEASEWAITERBBBBBBB",
      runDir
    });
    let called = false;
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 1) {
        await updateCardCAS(root, card.id, (fresh: any) => ({ ...fresh, project: "inferred", inferState: "done" }));
      }
    };

    const { outcome } = await processCard({
      root,
      board: inferredBoard,
      card,
      runFn: async () => { called = true; return { reply: "review" }; },
      settle: { intervalMs: 1, checks: 3, sleep }
    });

    expect(polls).toBe(1);
    expect(called).toBe(false);
    expect(outcome).toMatchObject({ status: "waiting", reason: "lease" });
    expect(await loadCard(root, card.id)).toMatchObject({
      project: "inferred",
      list: "implement",
      waitingOn: { cardId: holder.id, until: "lease" }
    });
  });

  it("does not let a stale owner generation renew or release a successor lease", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "lease-owner-token-"));
    const path = "package-lock.json";
    const cardA = { id: "01LEASEOWNERAAAAAAAAAAAAA", runId: "01LEASEOWNERRUNA" };
    const cardB = { id: "01LEASEOWNERBBBBBBBBBBBBB", runId: "01LEASEOWNERRUNB" };
    const cardC = { id: "01LEASEOWNERCCCCCCCCCCCCC", runId: "01LEASEOWNERRUNC" };
    const first = acquireLeases({
      repoPath: repoDir,
      card: cardA,
      paths: [path],
      ttlMinutes: 1,
      now: "2026-08-03T10:00:00.000Z"
    });
    const successor = acquireLeases({
      repoPath: repoDir,
      card: cardA,
      paths: [path],
      ttlMinutes: 1,
      now: "2026-08-03T10:00:10.000Z"
    });
    expect(first.ok).toBe(true);
    expect(successor.ok).toBe(true);
    expect(successor.ownerToken).not.toBe(first.ownerToken);

    // Release while the SAME card owns a newer generation. This reaches the
    // owner-token comparison (a card-id mismatch would not test the invariant).
    releaseLeases({ repoPath: repoDir, cardId: cardA.id, ownerToken: first.ownerToken });
    const blockedBySuccessor = acquireLeases({
      repoPath: repoDir,
      card: cardB,
      paths: [path],
      now: "2026-08-03T10:00:20.000Z"
    });
    expect(blockedBySuccessor).toMatchObject({ ok: false, heldBy: cardA.id, path });

    renewLeases({
      repoPath: repoDir,
      card: cardA,
      paths: [path],
      ownerToken: first.ownerToken,
      ttlMinutes: 60,
      now: "2026-08-03T10:00:20.000Z"
    });
    const nextOwner = acquireLeases({
      repoPath: repoDir,
      card: cardB,
      paths: [path],
      now: "2026-08-03T10:02:00.000Z"
    });
    expect(nextOwner.ok).toBe(true);

    releaseLeases({ repoPath: repoDir, cardId: cardA.id, ownerToken: first.ownerToken });
    const contender = acquireLeases({
      repoPath: repoDir,
      card: cardC,
      paths: [path],
      now: "2026-08-03T10:02:10.000Z"
    });
    expect(contender).toMatchObject({ ok: false, heldBy: cardB.id, path });
  });

  it("fails closed when an existing exclusive lease cannot be parsed", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "lease-corrupt-evidence-"));
    const leaseBoard = { ...seedBoard(), projects: { proj: { path: repoDir } } };
    const path = "package-lock.json";
    const holder = { id: "01CORRUPTLEASEHOLDERAAAAAA", runId: "01CORRUPTLEASEHOLDERRUNAA" };
    expect(acquireLeases({ repoPath: repoDir, card: holder, paths: [path] }).ok).toBe(true);

    const slug = createHash("sha1").update(repoDir).digest("hex").slice(0, 16);
    const leaseDir = join(process.env.GARRISON_HOME!, "coord", "leases", slug);
    const [leaseFile] = readdirSync(leaseDir).filter((name) => name.endsWith(".json"));
    writeFileSync(join(leaseDir, leaseFile), "{corrupt-lease");

    let card = await createCard(root, { title: "must not run without lease evidence", project: "proj", list: "implement" });
    const runDir = withTouchSet(root, "corrupt-lease-waiter", [path]);
    writeFileSync(join(runDir, "touch-set.json"), JSON.stringify({
      version: 1,
      files: [path],
      dirs: [],
      surfaces: [],
      exclusive: [path]
    }));
    card = await saveCard(root, { ...card, runId: "01CORRUPTLEASEWAITERBBBBB", runDir });
    let called = false;

    const result = await processCard({
      root,
      board: leaseBoard,
      card,
      runFn: async () => { called = true; return { reply: "review" }; }
    });

    expect(called).toBe(false);
    expect(result.outcome).toMatchObject({ status: "skipped", reason: "lease-unavailable", retryable: true });
    expect((await loadCard(root, card.id)).status).not.toBe("running");
  });

  it("a card whose claims COVER a policy exclusiveLease WAITS when it is held (empty exclusive[])", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "lease-repo-"));
    const board = { ...seedBoard(), projects: { proj: { path: repoDir } } };
    const polDir = mkdtempSync(join(tmpdir(), "lease-pol-"));
    const pol = join(polDir, "policy.json");
    writeFileSync(pol, JSON.stringify({ coordination: { enabled: true, exclusiveLeases: ["package-lock.json"] } }));
    const prev = process.env.GARRISON_POLICY_PATH;
    process.env.GARRISON_POLICY_PATH = pol;
    resetCoordinationCache();
    try {
      // Card A already holds the lockfile lease (established directly).
      const holder = { id: "01LEASEHOLDERAAAAAAAAAAAA", runId: "01RLEASEA" };
      expect(acquireLeases({ repoPath: repoDir, card: holder, paths: ["package-lock.json"] }).ok).toBe(true);

      // Card B: on Implement, claims the lockfile via files[] but with exclusive[] EMPTY.
      let b = await createCard(root, { title: "B", project: "proj", list: "implement" });
      const bDir = join(root, "runs", "leaseB");
      mkdirSync(bDir, { recursive: true });
      writeFileSync(join(bDir, "touch-set.json"), JSON.stringify({ version: 1, files: ["package-lock.json"], dirs: [], surfaces: [], exclusive: [] }));
      b = await saveCard(root, { ...b, runId: "01LEASEBBBBBBBBBBBBBBBBBB", runDir: bDir });

      let called = false;
      const runFn = async () => { called = true; return { reply: "review" }; };
      const { outcome } = await processCard({ root, board, card: b, runFn, cap: 10 });
      expect(outcome.status).toBe("waiting");
      expect(outcome.reason).toBe("lease"); // the POLICY list forced the lease, not the prediction
      expect(called).toBe(false); // never dispatched
      expect((await loadCard(root, b.id)).waitingOn.until).toBe("lease");
    } finally {
      if (prev === undefined) delete process.env.GARRISON_POLICY_PATH;
      else process.env.GARRISON_POLICY_PATH = prev;
      resetCoordinationCache();
    }
  });

  it("a card whose claims do NOT cover the policy lease dispatches freely", async () => {
    const root = tmp();
    const repoDir = mkdtempSync(join(tmpdir(), "lease-repo2-"));
    const board = { ...seedBoard(), projects: { proj: { path: repoDir } } };
    const polDir = mkdtempSync(join(tmpdir(), "lease-pol2-"));
    const pol = join(polDir, "policy.json");
    writeFileSync(pol, JSON.stringify({ coordination: { enabled: true, exclusiveLeases: ["package-lock.json"] } }));
    const prev = process.env.GARRISON_POLICY_PATH;
    process.env.GARRISON_POLICY_PATH = pol;
    resetCoordinationCache();
    try {
      // Even with the lockfile leased by someone else, a card that does not claim
      // it is unaffected.
      acquireLeases({ repoPath: repoDir, card: { id: "01OTHERHOLDER0000000000AA", runId: "01RH" }, paths: ["package-lock.json"] });
      let c = await createCard(root, { title: "C", project: "proj", list: "implement" });
      const cDir = join(root, "runs", "leaseC");
      mkdirSync(cDir, { recursive: true });
      writeFileSync(join(cDir, "touch-set.json"), JSON.stringify({ version: 1, files: ["src/other.ts"], dirs: [], surfaces: [], exclusive: [] }));
      c = await saveCard(root, { ...c, runId: "01LEASECCCCCCCCCCCCCCCCCC", runDir: cDir });
      const runFn = async () => ({ reply: "review" });
      const { outcome } = await processCard({ root, board, card: c, runFn, cap: 10 });
      expect(outcome.status).toBe("moved");
      expect(outcome.to).toBe("review");
    } finally {
      if (prev === undefined) delete process.env.GARRISON_POLICY_PATH;
      else process.env.GARRISON_POLICY_PATH = prev;
      resetCoordinationCache();
    }
  });
});
