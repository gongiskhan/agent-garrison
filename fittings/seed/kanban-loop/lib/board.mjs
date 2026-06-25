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

export async function loadBoard(root = kanbanRoot()) {
  return readJSON(path.join(root, "board.json"));
}

export async function saveBoard(board, root = kanbanRoot()) {
  await atomicWriteJSON(path.join(root, "board.json"), board);
}

const cardFile = (root, id) => path.join(root, "cards", id, "card.json");

export async function createCard(root, { title, description = "", project = null, list, goalMode = false, acceptance = null, at = new Date().toISOString() }) {
  const id = ulid();
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
    created: at,
    updated: at
  };
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
    return { ok: true, card: next };
  });
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
export async function appendCardLog(root, id, n, text) {
  const file = path.join(root, "cards", id, `log-${n}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text.endsWith("\n") ? text : text + "\n", "utf8");
  return file;
}
