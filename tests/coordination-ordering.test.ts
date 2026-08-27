// GARRISON-FLOW-V2 S1 — the coordination surface that SURVIVES the Conversations
// cut, exercised through its real drivers.
//
// What went, and why it is not here: the plan-completion ORDERING decision
// (applyPlanCompletionCoordination) and the whole waitingOn / reevaluateWaiting
// release machinery were driven by the engine's processCard/processBatch, which
// the cut deleted. Nothing writes `waitingOn` any more (the board's migration
// explicitly drops the field), and `isHumanHeld` — whose predicate is
// `list.kind !== "agent"` — is TRUE for every non-terminal column of the
// five-state board, so reevaluateWaiting filters out every possible waiter.
// Tests for that half would have passed vacuously (the "stays held" cases) or
// failed structurally (the "gets released" cases); both are dishonest, so they
// were removed and the finding reported rather than adapted.
//
// What remains has a live caller and is asserted here:
//   • the RECOVERY HOLD — prepareRecoveredCoordinationHold, run inside the PATCH
//     move door's CAS (server.mjs commitPatch beforeWrite): lease reacquisition,
//     outward-intent refresh, and its four fail-closed refusals.
//   • the SERIALIZE gate — serializeGate, consulted by POST /cards/:id/start when
//     coordination is enabled but degraded.
//   • LEASE GENERATIONS — acquire/renew/release owner-token discipline.
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";

import { mkdtempSync as __mkdtemp, writeFileSync as __write } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));
process.env.GARRISON_HOME = __mkdtemp(__join(__tmpdir(), "gh-ordering-"));
// Coordination activates only when the compiled policy carries a `coordination`
// section (a policy-less run and a policy without the section never coordinate).
const __pol = __join(process.env.GARRISON_HOME, "policy.json");
__write(__pol, JSON.stringify({ coordination: { enabled: true } }));
process.env.GARRISON_POLICY_PATH = __pol;

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { createCard, loadCard, saveCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { serializeGate, coordinationAvailability, resetCoordinationCache, acquireLeases, renewLeases, releaseLeases } from "../fittings/seed/kanban-loop/lib/coordination.mjs";

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
// The card store is shared by every test in this file now, where a fresh tmp root
// used to isolate them; wipe it between tests so one test's cards can never show
// up in another's sweep, batch, or board read.
beforeEach(async () => {
  await __kanbanState?.reset();
});

const board = seedBoard();
const tmp = () => mkdtempSync(join(tmpdir(), "coord-order-"));

// Write a touch-set into a fresh run dir and return the dir.
function withTouchSet(root: string, tag: string, files: string[]) {
  const runDir = join(root, "runs", tag);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "touch-set.json"), JSON.stringify({ version: 1, files, dirs: [], surfaces: [], exclusive: [] }));
  return runDir;
}

beforeEach(() => resetCoordinationCache());

describe("recovery hold — the resumed card's coordination position", () => {
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
      list: "running",
      status: "running"
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
    // No lease file exists — the parked card has been holding its exclusive path
    // by lifecycle alone. Recovery must durably restore that lease WHILE the card
    // is still parked and before the CAS exposes it as active, so there is never a
    // snapshot in which a second card could take the same path.
    // @ts-ignore — pure .mjs
    const { prepareRecoveredCoordinationHold } = await import("../fittings/seed/kanban-loop/scripts/server.mjs");
    // Real clock: the lease has to be LIVE for the refusal below to mean anything
    // (a lease stamped in the past is simply expired, which proves nothing).
    const hold = prepareRecoveredCoordinationHold(boardWithRepo, {
      ...parked,
      list: "todo",
      status: "ok"
    });
    expect(hold).toMatchObject({ ok: true, acquired: ["package-lock.json"] });

    // Durable, not in-memory: a different card is refused the path by the lease
    // file the hold just wrote, and it names the recovered card as the holder.
    expect(acquireLeases({
      repoPath: repoDir,
      card: { id: "01BBBBBBBBBBBBBBBBBBBBBBBB", runId: "01BBBBBBBBBBBBBBBBBBBBBBBB" },
      paths: ["package-lock.json"]
    })).toMatchObject({ ok: false, heldBy: parked.id, path: "package-lock.json" });
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

  // NOTE (Conversations): the PATCH door now derives targetPhase from the list
  // (`getList(board, next.list)?.phase ?? next.list`), and the five-state board
  // carries no `phase` on any column — so "plan" can no longer arrive from the
  // live caller and this escape hatch is reachable only from a direct lib call.
  // Kept as the lib contract; reported as dormant.
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
      const older = { id: "01A", project: "p", list: "running", runDir: "/x", status: "running" };
      const younger = { id: "01B", project: "p", list: "running", runDir: "/x", status: "running" };
      const cards = [older, younger];
      expect(serializeGate(cards, older, board).allowed).toBe(true);
      expect(serializeGate(cards, younger, board).allowed).toBe(false);
    } finally {
      process.env.GARRISON_POLICY_PATH = prev;
      resetCoordinationCache();
    }
  });
});

describe("lease generations", () => {
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
});
