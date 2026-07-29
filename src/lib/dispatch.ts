// Outpost Dispatch — the host half of pull-based claiming (brief D1).
//
// A worker on a remote machine polls this host, claims a card targeted at it,
// heartbeats while working, and reports a terminal status. The host never dials
// the worker; that is the whole point. The existing WebSocket bridge (host
// pushes RPC to a Mac) stays for ad-hoc ops and is untouched here.
//
// SPLIT OF RESPONSIBILITY
//   reads  — straight off disk (cards/<id>/card.json), the same convention
//            board-summary.ts uses, so listing claimable work does not depend
//            on the board's server process being up.
//   writes — through the board's own HTTP API with `x-garrison-engine`, so every
//            mutation goes through saveCardCAS. That is the single write choke
//            point: terminal-edge side effects (handoff generation, routing,
//            steering) fire there. A second writer poking card.json directly
//            would silently skip all of it and race the engine's own CAS.
//
// WHY rev-CAS AND NOT THE CARD LOCK
// The board's per-card `.lock` carries a pid and checks liveness with a local
// `kill(pid, 0)` — meaningless for a pid on another machine, where it may well
// collide with an unrelated local process. Cross-host mutual exclusion rides
// the card's `rev` compare-and-swap instead, which is machine-agnostic.

import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { garrisonDir } from "./claude-home";
import { HOST_TARGET } from "./dispatch-machines";

// How long a claim survives without a heartbeat before the card is reclaimed.
// Generous relative to the worker's own beat (see DISPATCH_HEARTBEAT_SECONDS):
// a reclaim mid-run means two machines could touch one card, so the cost of
// being late is far lower than the cost of being early.
export const DISPATCH_LEASE_SECONDS = 180;
export const DISPATCH_HEARTBEAT_SECONDS = 30;

export interface CardPlacement {
  // "host" (run locally, the default) or a paired machine name.
  target: string;
  // Do not dispatch before this instant. Absent = eligible immediately.
  not_before?: string;
}

export type DispatchState = "claimed" | "running" | "done" | "failed";

export interface CardDispatch {
  machine: string;
  workerId: string;
  claimedAt: string;
  heartbeatAt: string;
  state: DispatchState;
  // Set when a claim is taken over or abandoned, so a late worker can be told
  // to stop rather than racing the new owner.
  releasedAt?: string;
  detail?: string;
}

// The unit of work handed to a worker. v1 carries a literal command so the
// transport can be proven with zero model tokens (brief Phase 3's stub gate);
// a duty-driven run is the same envelope with a different `run`.
export type DispatchRun =
  | { kind: "command"; command: string }
  | { kind: "duty"; duty: string; prompt: string };

export interface DispatchJob {
  cardId: string;
  title: string;
  list: string;
  project: string | null;
  run: DispatchRun;
  leaseSeconds: number;
  heartbeatSeconds: number;
  // The environment to materialize before running (brief D2/D3). Absent when
  // the card's project has no Loadout — the run then happens wherever the
  // worker's workdir is, which is fine for a stub but not for real work.
  loadout?: unknown;
  // The ALREADY-RENDERED .env body, resolved from the vault ON THE HOST. This
  // is the only form in which a secret travels: the vault file and its master
  // key never leave this machine, and the worker never learns a vault key name
  // it was not given a value for. Never log a job payload.
  envContent?: string;
  // Which vault entry supplied each name (the PROJECT__VAR override, or the
  // bare name). Names only, never values — enough to debug a wrong-value
  // report without printing the value.
  envSources?: Record<string, string>;
}

interface RawCard {
  id?: unknown;
  title?: unknown;
  list?: unknown;
  project?: unknown;
  rev?: unknown;
  placement?: unknown;
  dispatch?: unknown;
  dispatchCommand?: unknown;
}

export interface ClaimableCard {
  id: string;
  title: string;
  list: string;
  project: string | null;
  rev: number;
  placement: CardPlacement;
  dispatch: CardDispatch | null;
  command: string | null;
}

export function kanbanBoardDir(): string {
  const dir = process.env.GARRISON_KANBAN_DIR?.trim();
  return dir && dir.length > 0 ? dir : path.join(garrisonDir(), "kanban-loop");
}

// Normalise whatever is on the card into a placement. An absent or malformed
// placement is `host` — the default must be "run where Garrison runs", never
// "eligible for any machine", or a typo would scatter work across the fleet.
export function parsePlacement(raw: unknown): CardPlacement {
  if (!raw || typeof raw !== "object") return { target: HOST_TARGET };
  const target = (raw as { target?: unknown }).target;
  const notBefore = (raw as { not_before?: unknown }).not_before;
  if (typeof target !== "string" || target.trim().length === 0) {
    return { target: HOST_TARGET };
  }
  return {
    target: target.trim(),
    ...(typeof notBefore === "string" && notBefore.trim().length > 0
      ? { not_before: notBefore.trim() }
      : {})
  };
}

function parseDispatch(raw: unknown): CardDispatch | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.machine !== "string" || typeof d.state !== "string") return null;
  return {
    machine: d.machine,
    workerId: typeof d.workerId === "string" ? d.workerId : "",
    claimedAt: typeof d.claimedAt === "string" ? d.claimedAt : "",
    heartbeatAt: typeof d.heartbeatAt === "string" ? d.heartbeatAt : "",
    state: d.state as DispatchState,
    ...(typeof d.releasedAt === "string" ? { releasedAt: d.releasedAt } : {}),
    ...(typeof d.detail === "string" ? { detail: d.detail } : {})
  };
}

function parseCard(raw: unknown): ClaimableCard | null {
  if (!raw || typeof raw !== "object") return null;
  const card = raw as RawCard;
  if (typeof card.id !== "string" || typeof card.list !== "string") return null;
  return {
    id: card.id,
    title: typeof card.title === "string" ? card.title : "(untitled)",
    list: card.list,
    project: typeof card.project === "string" ? card.project : null,
    rev: typeof card.rev === "number" ? card.rev : 0,
    placement: parsePlacement(card.placement),
    dispatch: parseDispatch(card.dispatch),
    command: typeof card.dispatchCommand === "string" ? card.dispatchCommand : null
  };
}

export async function readAllCards(): Promise<ClaimableCard[]> {
  const cardsDir = path.join(kanbanBoardDir(), "cards");
  let ids: string[];
  try {
    ids = await readdir(cardsDir);
  } catch {
    return [];
  }
  const reads = await Promise.all(
    ids.map(async (id) => {
      try {
        return parseCard(JSON.parse(await readFile(path.join(cardsDir, id, "card.json"), "utf8")));
      } catch {
        // One unreadable card never takes dispatch down.
        return null;
      }
    })
  );
  return reads.filter((card): card is ClaimableCard => card !== null);
}

// Has this claim gone quiet past its lease?
export function isLeaseExpired(dispatch: CardDispatch, now: number, leaseSeconds: number): boolean {
  const beat = Date.parse(dispatch.heartbeatAt || dispatch.claimedAt);
  if (!Number.isFinite(beat)) return true;
  return now - beat > leaseSeconds * 1000;
}

// Terminal lists a dispatched card must never be pulled out of.
const TERMINAL_LISTS = new Set(["done", "needs-attention"]);
// Manual lists: a card sitting here has not been started by a human yet, so a
// worker must not grab it. Dispatch picks up work that is READY to run.
const MANUAL_LISTS = new Set(["backlog", "discuss"]);

export interface ClaimabilityVerdict {
  claimable: boolean;
  reason: string;
}

// Is this card claimable by `machine` right now? Pure — no I/O — so the rules
// are testable without a board on disk.
export function claimability(
  card: ClaimableCard,
  machine: string,
  now: number,
  leaseSeconds = DISPATCH_LEASE_SECONDS
): ClaimabilityVerdict {
  if (card.placement.target === HOST_TARGET) {
    return { claimable: false, reason: "targeted at the host" };
  }
  if (card.placement.target !== machine) {
    return { claimable: false, reason: `targeted at ${card.placement.target}` };
  }
  if (TERMINAL_LISTS.has(card.list)) {
    return { claimable: false, reason: `terminal list ${card.list}` };
  }
  if (MANUAL_LISTS.has(card.list)) {
    return { claimable: false, reason: `manual list ${card.list} — not started` };
  }
  if (card.placement.not_before) {
    const at = Date.parse(card.placement.not_before);
    // An UNPARSEABLE not_before holds the card rather than releasing it. A
    // scheduled card that runs early is worse than one that waits for a human.
    if (!Number.isFinite(at)) {
      return { claimable: false, reason: "not_before is unparseable" };
    }
    if (now < at) return { claimable: false, reason: `not before ${card.placement.not_before}` };
  }
  if (card.dispatch && card.dispatch.state !== "failed" && card.dispatch.state !== "done") {
    if (!isLeaseExpired(card.dispatch, now, leaseSeconds)) {
      return { claimable: false, reason: `held by ${card.dispatch.machine}` };
    }
    return { claimable: true, reason: `lease expired (was ${card.dispatch.machine})` };
  }
  return { claimable: true, reason: "ready" };
}

// The next card this machine should take. Oldest-claimable-first by card id —
// ULIDs sort lexicographically by mint time, so this is FIFO without needing a
// timestamp compare, and it is deterministic when two workers race (they pick
// the same card, and rev-CAS decides the winner).
export function selectClaimable(
  cards: readonly ClaimableCard[],
  machine: string,
  now: number,
  leaseSeconds = DISPATCH_LEASE_SECONDS
): ClaimableCard | null {
  const eligible = cards
    .filter((card) => claimability(card, machine, now, leaseSeconds).claimable)
    .sort((left, right) => left.id.localeCompare(right.id));
  return eligible[0] ?? null;
}

// Cards whose worker has gone silent. The caller moves these to needs-attention
// with the machine named — per the product decision, placement is CLEARED so the
// card can be re-dispatched anywhere rather than stranded on a dead machine.
export function findExpiredClaims(
  cards: readonly ClaimableCard[],
  now: number,
  leaseSeconds = DISPATCH_LEASE_SECONDS
): ClaimableCard[] {
  return cards.filter((card) => {
    if (!card.dispatch) return false;
    if (card.dispatch.state === "done" || card.dispatch.state === "failed") return false;
    return isLeaseExpired(card.dispatch, now, leaseSeconds);
  });
}

export function buildJob(card: ClaimableCard, extra: Partial<DispatchJob> = {}): DispatchJob | null {
  // v1 dispatches only stub commands — enough to prove claim → heartbeat →
  // status → evidence with zero model tokens. A card with no command is not
  // yet runnable remotely; returning null keeps it visible as unclaimable
  // rather than handing a worker a job it cannot execute.
  if (!card.command) return null;
  return {
    cardId: card.id,
    title: card.title,
    list: card.list,
    project: card.project,
    run: { kind: "command", command: card.command },
    leaseSeconds: DISPATCH_LEASE_SECONDS,
    heartbeatSeconds: DISPATCH_HEARTBEAT_SECONDS,
    ...extra
  };
}

// ── board writes ─────────────────────────────────────────────────────────────

// The board's own-port address, from the status file that is the single source
// of truth for a running own-port fitting (never `lsof`, never a literal port).
export async function boardBaseUrl(): Promise<string | null> {
  try {
    const raw = await readFile(
      path.join(garrisonDir(), "ui-fittings", "kanban-loop.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === "string" && parsed.url.length > 0 ? parsed.url : null;
  } catch {
    return null;
  }
}

export class BoardUnavailableError extends Error {
  constructor() {
    super("the kanban board is not running — dispatch writes go through it");
    this.name = "BoardUnavailableError";
  }
}

// PATCH a card through the board. `x-garrison-engine` marks this a privileged
// engine-context mutation so the D16 lock (autonomous lists are engine-owned)
// does not reject it — dispatch IS engine context.
//
// The compare-and-swap field on the wire is `rev` (handlePatchCard reads
// `body.rev`, NOT `expectedRev`). Getting that name wrong does not fail loudly:
// the handler falls back to the card's CURRENT rev, so every write "succeeds"
// and the cross-host mutual exclusion silently evaporates.
export async function patchCard(
  cardId: string,
  patch: Record<string, unknown>
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = await boardBaseUrl();
  if (!base) throw new BoardUnavailableError();
  const res = await fetch(`${base}/cards/${encodeURIComponent(cardId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-garrison-engine": "outpost-dispatch"
    },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(10_000)
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}
