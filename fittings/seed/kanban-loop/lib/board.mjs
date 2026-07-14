// Kanban Loop storage (V1a): file-per-card under ~/.garrison/kanban-loop.
//   board.json            — list defs + order + per-list config (NEVER membership)
//   cards/<ulid>/card.json — title, project, list, status, iterations, goalMode, ts
//   cards/<ulid>/log-N.md  — per-session logs (written by the engine)
// List membership is DERIVED by scanning cards (brief §3) — never stored on disk.
// Every mutation is read-immediately-before-write + atomic (temp file then rename).
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ulid } from "./ulid.mjs";
import { routeTerminalTransition } from "./notify-origin.mjs";
import { generateHandoffIfDone } from "./handoff.mjs";
import { deriveOriginId } from "./origins.mjs";
import { markSteeringApplied } from "./steering.mjs";

export function kanbanRoot() {
  return process.env.GARRISON_KANBAN_DIR || path.join(os.homedir(), ".garrison", "kanban-loop");
}

// Atomic JSON write: write a unique temp file, then rename over the target so a
// reader never sees a partial file and two writers don't interleave.
export async function atomicWriteJSON(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${ulid()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

// One-shot board migration (D15): v2 boards carried per-list skill/taskType/
// tier/mode pins — the dead config GARRISON-UNIFY-V1 deletes. Strip them,
// stamp each agent list's phase (its id), bump to v3. Idempotent; unknown
// fields survive.
export function migrateBoard(board) {
  if (!board || typeof board !== "object") return board;
  if ((board.version || 0) >= 3) return board;
  const lists = (board.lists || []).map((l) => {
    const { skill, taskType, tier, mode, ...rest } = l;
    if (rest.kind === "agent" && !rest.phase) rest.phase = rest.id;
    return rest;
  });
  return { ...board, version: 3, lists };
}

export async function loadBoard(root = kanbanRoot()) {
  const board = await readJSON(path.join(root, "board.json"));
  // v2→v3 migration on read, persisted back so it runs once; a fresh board is
  // already v3.
  if (board && (board.version || 0) < 3) {
    const migrated = migrateBoard(board);
    await saveBoard(migrated, root);
    return migrated;
  }
  return board;
}

export async function saveBoard(board, root = kanbanRoot()) {
  await atomicWriteJSON(path.join(root, "board.json"), board);
}

const cardFile = (root, id) => path.join(root, "cards", id, "card.json");

// The card-owned Discuss brief: a markdown file next to the card's card.json. This is
// the DETERMINISTIC, card-scoped brief location — James writes it here (told the absolute
// path in the Discuss kickoff), the web-channel Brief editor reads/writes it, and the
// engine folds it into the build prompt. Decoupled from any project working dir, so the
// three never disagree on where the brief lives.
export const cardBriefFile = (root, id) => path.join(root, "cards", id, "brief.md");
export const cardBriefRel = (id) => `cards/${id}/brief.md`; // relative to kanbanRoot (card.briefPath marker)

export async function createCard(root, { title, description = "", project = null, list, goalMode = false, acceptance = null, workKind = null, phases = null, tier = null, origin = null, originChannel = null, outpost = null, duty = null, level = null, sequence = null, continues = null, clarity = null, origin_id: explicitOriginId = null, at = new Date().toISOString() }) {
  const id = ulid();
  // WS2 (D7): a continuation card references its predecessor by ULID. When set and
  // no explicit origin was given, the card's origin is "continuation".
  const validContinues = typeof continues === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(continues) ? continues : null;
  // A continuation INHERITS the predecessor's duty journey when the creator did
  // not pick one: a bare successor would fall back to the legacy board validNext
  // and wander lists the predecessor never meant to visit. Server-side so every
  // creation door (Continue button, create_continuation tool, gateway) gets it.
  if (validContinues && !duty && !sequence) {
    try {
      const prev = JSON.parse(await fs.readFile(cardFile(root, validContinues), "utf8"));
      duty = prev.duty ?? null;
      level = prev.level ?? null;
      sequence = Array.isArray(prev.sequence) && prev.sequence.length ? [...prev.sequence] : null;
    } catch {
      /* unknown predecessor - the successor stays bare */
    }
  }
  const card = {
    id,
    title: title ?? "(untitled)",
    description,
    project,
    list,
    status: "ok",
    iterations: 0,
    rev: 0, // optimistic-concurrency revision (compare-and-swap on write)
    cost: null,
    goalMode: Boolean(goalMode),
    acceptance,
    // ── run-policy fields (S4: D2/D8/D17) ─────────────────────────────────
    // workKind names the policy work kind whose phase plan is this card's
    // rail; phases is the per-card toggle map merged OVER the plan (an OFF
    // phase renders off, never hidden); tier rides classification (the phase
    // is the task type); origin records who registered the run.
    workKind: typeof workKind === "string" && workKind ? workKind : null,
    phases: phases && typeof phases === "object" ? phases : null,
    tier: typeof tier === "string" && tier ? tier : null,
    origin: typeof origin === "string" && origin ? origin : validContinues ? "continuation" : null,
    // WS2 (D7): predecessor card id for a continuation (null for a fresh card). The
    // engine reads the predecessor's handoff.json into the successor's prompt.
    continues: validContinues,
    // The originating channel thread ({channel, threadId}) — where the engine
    // posts this card's outcome (done / needs-attention) back to. Absent for
    // board-created cards.
    originChannel:
      originChannel && typeof originChannel === "object" && typeof originChannel.channel === "string" && typeof originChannel.threadId === "string"
        ? { channel: originChannel.channel, threadId: originChannel.threadId }
        : null,
    // ── resolved-model flow (D15, S4a) ────────────────────────────────────
    // The card's duty + level (its journey through the board): its resolved
    // sequence (resolver.resolveSequence) is the ordered leaf phase lists it
    // visits — a card visits EXACTLY its sequence and skips the rest. `sequence`
    // caches those leaf ids so the engine advances along it without re-resolving;
    // absent (a legacy card) → the engine uses the board's static validNext.
    duty: typeof duty === "string" && duty ? duty : null,
    level: Number.isInteger(level) ? level : null,
    sequence: Array.isArray(sequence) && sequence.every((s) => typeof s === "string") ? sequence : null,
    // S3d (D9b): the dispatcher's specification-clarity verdict. A "needs-discuss"
    // card is dispatched through the Discuss duty first (the engine's gated-discuss
    // exemption keys on this); anything else is null (a clear card runs straight).
    clarity: clarity === "needs-discuss" ? "needs-discuss" : null,
    // D27: single-outpost affinity — the run engine dispatches this card's
    // phase sessions to the named outpost; offline → needs-attention.
    outpost: typeof outpost === "string" && outpost ? outpost : null,
    // ── execution visibility ──────────────────────────────────────────────
    // The card's activity timeline (engine.withEvent appends to it on every
    // transition); the last operative reply snippet (shown on the card front);
    // and when the current run started (drives the live elapsed timer). All
    // start empty/null and are filled CAS-safely as the card moves.
    events: [{ at, kind: "created", message: project ? `Created in ${list} (project ${project})` : `Created in ${list} — no project yet` }],
    lastReply: null,
    runningSince: null,
    // V1b pointer fields (FINDING 10 — the card stores POINTERS, never inlined
    // document bodies). runId/runDir are minted lazily on the card's first
    // agent-list entry (FINDING 4); the rest are filled by the skills/surfaces as
    // they produce artifacts. No migration: storage is file-per-card JSON, so a
    // V1a card simply reads these as undefined and they default on next write.
    runId: null,        // minted once, on the first agent-list entry
    runDir: null,       // docs/autothing/runs/<runId>, project-relative
    sliceId: null,      // the FLOW_PLAN slice this card is building
    sessionIds: [],     // Claude Code transcript ids for each run (pointers)
    briefPath: null,    // James-mode brief produced in Discuss (under briefs_path)
    videoUrl: null,     // walkthrough gallery link (set by the Walkthrough list)
    // ── coordination fields (GARRISON-FLOW-V2 S1, Q4) ──────────────────────
    // Same-branch multi-run coordination. waitingOn holds the wait descriptor
    // when the engine defers a plan-completed card behind an overlapping run
    // (the card SITS in Plan, gate evidence already written, until the blocker
    // reaches its release point); stabilityAt marks the card's first-review
    // stability point (overlapping medium waiters may start); planCompletedAt
    // is the total-order key for ordering overlapping runs; blocking is the
    // best-effort list of cards waiting on THIS card (UI convenience). New
    // keys, so a pre-coordination card simply reads them as undefined.
    waitingOn: null,
    stabilityAt: null,
    planCompletedAt: null,
    blocking: [],
    // S2 (Q5/Q7): git fence anchors this run has committed ({phase, sha, at,
    // empty}) and a prepared-revert descriptor after abandonment. New keys; a
    // pre-S2 card reads them as undefined.
    fences: [],
    preparedRevert: null,
    created: at,
    updated: at
  };
  // S3a (D8): every card carries an origin_id — an explicit one wins, else derive
  // from originChannel/origin (web:<threadId> | skill:unknown | board). originChannel
  // is kept in sync for back-compat (notify-origin's web delivery reads it).
  card.origin_id =
    typeof explicitOriginId === "string" && explicitOriginId ? explicitOriginId : deriveOriginId(card);
  await atomicWriteJSON(cardFile(root, id), card);
  return card;
}

export async function loadCard(root, id) {
  return readJSON(cardFile(root, id));
}

// Read-immediately-before-write then atomic-write the mutated card. Bumps rev.
export async function saveCard(root, card, at = new Date().toISOString()) {
  const next = { ...card, rev: (card.rev ?? 0) + 1, updated: at };
  await atomicWriteJSON(cardFile(root, card.id), next);
  return next;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_TIMEOUT_MS = Number(process.env.GARRISON_KANBAN_LOCK_TIMEOUT_MS || 5000);
const LOCK_STALE_MS = Number(process.env.GARRISON_KANBAN_LOCK_STALE_MS || 30000);

// Is a pid alive on THIS host? kill(pid,0) probes without signalling: ESRCH = gone,
// EPERM = alive-but-not-ours. (Single-machine, solo-dev deployment, so a pid is a
// reliable liveness token; a cross-host lock falls back to the age heuristic.)
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

// Per-card EXCLUSIVE lock via O_EXCL create (`wx`) — atomic across PROCESSES, so two
// concurrent ticks (or a tick + the scheduler beat) cannot both enter a card's
// read-compare-write critical section. The lock file records the holder's pid so a
// lock is broken ONLY when its owner is provably gone (a crashed worker) — never
// because a live holder ran long. Age (LOCK_STALE_MS) is a last-resort fallback used
// only when the owner pid is unreadable (e.g. a cross-host or corrupt lock).
// Generic cross-process exclusive lock around a critical section, keyed by a lock
// file path. O_EXCL create + owner-pid + dead-owner/stale breaking — the substrate
// withCardLock and withBoardLock both build on so the check-and-set logic lives in
// exactly one place.
export async function withFileLock(lockPath, label, fn) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      // Create the lock AND write the owner pid in ONE atomic exclusive op (flag 'wx'
      // = O_CREAT|O_EXCL|O_WRONLY) — so the lock file is never observed pid-less by a
      // racing breaker (no post-create pre-pid window).
      await fs.writeFile(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let broke = false;
      // Break the lock only if its owner process is provably dead.
      try {
        const owner = parseInt(await fs.readFile(lockPath, "utf8"), 10);
        if (Number.isInteger(owner) && !isPidAlive(owner)) {
          await fs.rm(lockPath, { force: true });
          broke = true;
        }
      } catch { /* owner unreadable — fall through to the age fallback */ }
      // Fallback: an owner-less lock older than LOCK_STALE_MS is treated as abandoned.
      if (!broke) {
        try {
          const st = await fs.stat(lockPath);
          const owner = parseInt(await fs.readFile(lockPath, "utf8").catch(() => ""), 10);
          if (!Number.isInteger(owner) && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            await fs.rm(lockPath, { force: true }); broke = true;
          }
        } catch { broke = true; /* lock vanished between checks — retry the acquire */ }
      }
      if (broke) continue;
      if (Date.now() > deadline) throw new Error(`kanban: ${label} lock timeout after ${LOCK_TIMEOUT_MS}ms`);
      await sleep(10 + Math.floor(Math.random() * 15)); // jittered backoff
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

export async function withCardLock(root, id, fn) {
  const dir = path.join(root, "cards", id);
  await fs.mkdir(dir, { recursive: true });
  return withFileLock(path.join(dir, ".lock"), `card ${id}`, fn);
}

// Board-level exclusive lock (board.json is one shared file). Serializes the
// whole-board read→mutate→write so a board-rev CAS is a true critical section:
// two concurrent writers cannot both read the same rev and both save.
export async function withBoardLock(root, fn) {
  return withFileLock(path.join(root, ".board.lock"), "board", fn);
}

// Compare-and-swap whole-board save. Runs the read→check-rev→mutate→write inside
// withBoardLock, so simultaneous writers can't lost-update board.json. `mutate`
// receives the fresh board and returns { board } (or { error } to abort). On rev
// mismatch returns { ok:false, conflict:true, rev }. Bumps board.rev on success.
export async function saveBoardCAS(root, expectedRev, mutate) {
  return withBoardLock(root, async () => {
    const board = await loadBoard(root);
    const currentRev = Number.isInteger(board.rev) ? board.rev : 0;
    if (Number.isInteger(expectedRev) && expectedRev !== currentRev) {
      return { ok: false, conflict: true, rev: currentRev };
    }
    const result = mutate(board);
    if (result && result.error) return { ok: false, error: result.error };
    const nextBoard = result.board;
    nextBoard.rev = currentRev + 1;
    await saveBoard(nextBoard, root);
    return { ok: true, board: nextBoard, list: result.list, rev: nextBoard.rev };
  });
}

// Compare-and-swap save: only write when the on-disk rev still matches what the
// caller last read (`expectedRev`), so a concurrent tick or a manual edit cannot be
// silently overwritten (the lost-update class the temp+rename atomic write does NOT
// prevent). The read-compare-write runs inside a per-card O_EXCL lock, so the
// check-and-set is atomic across processes — two concurrent ticks cannot both observe
// the same rev and both succeed (no double-acquire, no double-mint of runId).
// Returns { ok, conflict?, card }.
export async function saveCardCAS(root, card, expectedRev, at = new Date().toISOString()) {
  return withCardLock(root, card.id, async () => {
    let disk = null;
    try {
      disk = await loadCard(root, card.id);
    } catch {
      disk = null; // first write of a brand-new card
    }
    if (disk && (disk.rev ?? 0) !== expectedRev) {
      return { ok: false, conflict: true, card: disk };
    }
    const next = { ...card, rev: expectedRev + 1, updated: at };
    await atomicWriteJSON(cardFile(root, card.id), next);
    // Feedback to the originating channel on a terminal transition (done /
    // needs-attention). saveCardCAS is the one write path every mover uses
    // (engine, server PATCH, batch), so the edge fires exactly once per
    // outcome. Fire-and-forget — never delays or fails the write.
    // S3a lifecycle router: on the terminal edge (into done / needs-attention) route
    // a finished | blocked | failed event — appends to the origin's durable event log
    // for ALL transports, and posts the (legacy) web text to the originating thread.
    routeTerminalTransition(root, disk, next);
    // WS2 handoff packet: on the done edge, compose + write cards/<id>/handoff.json
    // (deferred to the next tick, fully guarded — never blocks or fails this write).
    generateHandoffIfDone(root, disk, next);
    // S3c: a card reaching a terminal list strands any unapplied revisit directive
    // (the boundary guard early-returns before it) — clear it so the chip resolves and
    // it can never fire on a reopened card. No-op when there is no pending directive.
    if ((next.list === "done" || next.list === "needs-attention") && (disk?.list ?? null) !== next.list) {
      markSteeringApplied(root, next.id, "obsolete-terminal");
    }
    return { ok: true, card: next };
  });
}

// Read-immediately, mutate, CAS-write a card by id — retrying a few times when a
// concurrent write bumps the rev under us. `mutate(card)` returns the next card (or a
// falsy value to leave it unchanged). Used for CROSS-CARD event writes (a card writing
// a coordination/blocking event onto ANOTHER card it does not "own" the read of): the
// engine's per-card processing has the running card's rev, but a blocker card must be
// read-then-CAS-written independently. Returns the written card, the unchanged card, or
// null on repeated conflict / missing card. (This is the same shape as the board
// server's private updateCard helper; kept here so the engine + coordination lib can
// reuse it without depending on the server.)
export async function updateCardCAS(root, id, mutate, tries = 6) {
  for (let i = 0; i < tries; i++) {
    let card;
    try {
      card = await loadCard(root, id);
    } catch {
      return null; // no such card
    }
    card.id = id;
    const next = mutate(card);
    if (!next) return card; // mutate opted out — nothing to write
    const res = await saveCardCAS(root, next, card.rev ?? 0);
    if (res.ok) return res.card;
  }
  return null; // lost the CAS race `tries` times
}

export async function listCardIds(root = kanbanRoot()) {
  try {
    const entries = await fs.readdir(path.join(root, "cards"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function loadAllCards(root = kanbanRoot()) {
  const ids = await listCardIds(root);
  const cards = [];
  for (const id of ids) {
    try {
      cards.push(await loadCard(root, id));
    } catch {
      // skip an unreadable/partial card dir
    }
  }
  return cards;
}

// Derive list membership from the cards (pure) — never stored.
export function deriveMembership(cards) {
  const byList = {};
  for (const c of cards) {
    (byList[c.list] ??= []).push(c.id);
  }
  return byList;
}

// Append a per-session log line for a card (cards/<id>/log-N.md).
// Delete a card's OWN directory (cards/<id>/ — card.json + every log-<n>.md). This is
// the card itself + its iteration logs; it never touches the run dir, brief, or shared
// transcripts (the server's delete handler decides those). Idempotent: a missing dir is
// a no-op. Returns true if a directory was removed.
export async function deleteCard(root, id) {
  const dir = path.join(root, "cards", id);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function appendCardLog(root, id, n, text) {
  const file = path.join(root, "cards", id, `log-${n}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text.endsWith("\n") ? text : text + "\n", "utf8");
  return file;
}

// Overwrite a card's iteration log atomically (temp + rename). Used for the LIVE
// stream: the engine rewrites log-<n>.md with the operative's growing reply as
// chunks arrive (so Watch shows progress), then once more with the clean final
// reply. Atomic so a tailing Watch never reads a torn half-written file.
export async function writeCardLog(root, id, n, text) {
  const file = path.join(root, "cards", id, `log-${n}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text.endsWith("\n") ? text : text + "\n", "utf8");
  await fs.rename(tmp, file);
  return file;
}
