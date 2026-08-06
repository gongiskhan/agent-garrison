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
import { mkdir, open, readdir, readFile } from "node:fs/promises";
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

export type DispatchState = "claimed" | "running" | "cancelling" | "done" | "failed";

export interface DispatchCancellation {
  state: "requested" | "timeout" | "acknowledged";
  requestedAt: string;
  deadlineAt: string;
  acknowledgedAt?: string;
  detail?: string;
}

export interface CardDispatch {
  machine: string;
  workerId: string;
  claimedAt: string;
  heartbeatAt: string;
  state: DispatchState;
  // Stable identity for this claim and the card log that Watch tails. A new
  // claim gets a new runId/logIndex; retries from the same worker are deduped by
  // event id under that run.
  runId?: string;
  routingToken?: string;
  phase?: string;
  logIndex?: number;
  // The only card revision this claim is allowed to settle. Heartbeats advance
  // it explicitly after a CAS; any unrelated edit creates a mismatch and stops
  // the worker rather than silently blessing revision drift.
  claimRevision?: number;
  // Set when a claim is taken over or abandoned, so a late worker can be told
  // to stop rather than racing the new owner.
  releasedAt?: string;
  detail?: string;
  requestedTransition?: string;
  // Runtime-native session identity reported by the remote adapter. The rich
  // Watch replay itself is backed by the host's immutable dispatch journal,
  // but retaining this pointer makes the run provenance complete.
  sessionId?: string;
  logCursor?: number;
  evidenceManifest?: Array<{ name: string; bytes: number; sha256: string }>;
  cancellation?: DispatchCancellation;
}

// The unit of work handed to a worker. v1 carries a literal command so the
// transport can be proven with zero model tokens (brief Phase 3's stub gate);
// a duty-driven run is the same envelope with a different `run`.
export type DispatchRun =
  | { kind: "command"; command: string }
  | { kind: "duty"; duty: string; prompt: string };

export interface DispatchRuntimeTarget {
  targetId: string;
  runtime: string;
  provider: string | null;
  model: string;
  effort: string | null;
  promptMode: string | null;
  maxTurns: number | null;
}

export interface DispatchJob {
  runId: string;
  routingToken: string;
  cardId: string;
  title: string;
  list: string;
  project: string | null;
  scope: "personal" | "project" | "unscoped";
  run: DispatchRun;
  runtimeTarget?: DispatchRuntimeTarget;
  phase: string;
  validTransitions: string[];
  logIndex: number;
  claimRevision: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  // The environment to materialize before running (brief D2/D3). Absent only
  // for a non-project personal card (the worker selects its confined managed
  // workspace) or a literal smoke command. Ordinary unscoped agent work and
  // project work without a verified Loadout are refused.
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
  outpost?: unknown;
  dispatch?: unknown;
  dispatchCommand?: unknown;
  description?: unknown;
  acceptance?: unknown;
  duty?: unknown;
  goalMode?: unknown;
  level?: unknown;
  sequence?: unknown;
  scope?: unknown;
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
  description: string | null;
  acceptance: string | null;
  duty: string | null;
  goalMode: boolean;
  level: number;
  sequence: string[] | null;
  scope: "personal" | "project" | "unscoped";
  // Card scheduling: hold the card (locally AND from remote claims) until this
  // instant. Optional — pre-scheduling cards read it as undefined.
  scheduledFor?: string | null;
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

export function claimRevisionMatches(cardRev: number, dispatch: CardDispatch | null): boolean {
  return Boolean(dispatch && Number.isInteger(dispatch.claimRevision) && dispatch.claimRevision === cardRev);
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
    ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
    ...(typeof d.runId === "string" ? { runId: d.runId } : {}),
    ...(typeof d.routingToken === "string" ? { routingToken: d.routingToken } : {}),
    ...(typeof d.phase === "string" ? { phase: d.phase } : {}),
    ...(Number.isInteger(d.logIndex) && Number(d.logIndex) > 0 ? { logIndex: Number(d.logIndex) } : {}),
    ...(Number.isInteger(d.claimRevision) && Number(d.claimRevision) >= 0 ? { claimRevision: Number(d.claimRevision) } : {}),
    ...(typeof d.requestedTransition === "string" ? { requestedTransition: d.requestedTransition } : {}),
    ...(typeof d.sessionId === "string" ? { sessionId: d.sessionId } : {}),
    ...(Number.isSafeInteger(d.logCursor) && Number(d.logCursor) >= 0 ? { logCursor: Number(d.logCursor) } : {}),
    ...(Array.isArray(d.evidenceManifest) ? { evidenceManifest: d.evidenceManifest as CardDispatch["evidenceManifest"] } : {}),
    ...(d.cancellation && typeof d.cancellation === "object"
      ? { cancellation: d.cancellation as DispatchCancellation }
      : {})
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
    placement: (() => {
      const parsed = parsePlacement(card.placement);
      const legacy = typeof card.outpost === "string" ? card.outpost.trim() : "";
      return parsed.target === HOST_TARGET && legacy ? { ...parsed, target: legacy } : parsed;
    })(),
    dispatch: parseDispatch(card.dispatch),
    command: typeof card.dispatchCommand === "string" ? card.dispatchCommand : null,
    description: typeof card.description === "string" ? card.description : null,
    acceptance: typeof card.acceptance === "string" ? card.acceptance : null,
    duty: typeof card.duty === "string" ? card.duty : null,
    goalMode: card.goalMode === true,
    level: Number.isInteger(card.level) && Number(card.level) > 0 ? Number(card.level) : 1,
    sequence: Array.isArray(card.sequence)
      ? card.sequence.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : null,
    scope: card.scope === "personal" || card.scope === "project" || card.scope === "unscoped"
      ? card.scope
      : typeof card.project === "string" && card.project.trim()
        ? "project"
        : "unscoped",
    scheduledFor: typeof (card as { scheduledFor?: unknown }).scheduledFor === "string" ? (card as { scheduledFor?: string }).scheduledFor : null
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
  // Card scheduling: the user-facing scheduledFor holds remote claims exactly
  // as it holds the local tick. Same fail-closed rule as not_before.
  if (card.scheduledFor) {
    const at = Date.parse(card.scheduledFor);
    if (!Number.isFinite(at)) {
      return { claimable: false, reason: "scheduledFor is unparseable" };
    }
    if (now < at) return { claimable: false, reason: `scheduled for ${card.scheduledFor}` };
  }
  if (card.dispatch && card.dispatch.state !== "failed" && card.dispatch.state !== "done") {
    if (card.dispatch.state === "cancelling" || card.dispatch.cancellation?.state === "requested" || card.dispatch.cancellation?.state === "timeout") {
      return { claimable: false, reason: `cancellation ${card.dispatch.cancellation?.state || "requested"}; waiting for worker acknowledgement` };
    }
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
    if (card.dispatch.state === "cancelling" || card.dispatch.cancellation?.state === "requested" || card.dispatch.cancellation?.state === "timeout") return false;
    return isLeaseExpired(card.dispatch, now, leaseSeconds);
  });
}

// The brief for a duty run. Deliberately NOT kanban-loop's buildCardPrompt:
// that one lives in the fitting and needs the board's list definitions, the
// valid-next set, discussion/continuation/steering context and the resolved
// skill — none of which the host dispatch layer has, and importing across that
// boundary would drag the whole board model into src/lib. This is the smaller,
// self-contained contract: WHAT the work is, and what "done" means. The remote
// agent has the same skills (config-sync mirrors ~/.claude) and the same repo
// (the Loadout materialized it), so the work item plus acceptance is enough.
export function buildDutyPrompt(card: ClaimableCard, validTransitions = validTransitionsFromSequence(card)): string {
  const parts: string[] = [`# Work item: ${card.title || "(untitled)"}`];
  parts.push(
    card.project
      ? `Project: ${card.project}`
      : card.scope === "personal"
        ? "Scope: personal (work in the managed private, non-repository personal workspace this session starts in)"
        : "Project: (none assigned — work in the repository this session starts in)"
  );
  parts.push(`Card: ${card.id}`, `List: ${card.list}`);
  if (card.description && card.description.trim()) parts.push("", card.description.trim());
  const acceptance = (card.acceptance || "").trim();
  if (acceptance) parts.push("", "# Acceptance", acceptance);
  else if (card.goalMode) {
    // goalMode with no acceptance is the one case the local engine tolerates by
    // falling back to the description; say so rather than shipping a run with no
    // definition of done.
    parts.push("", "# Acceptance", "(none recorded — treat the description above as the acceptance criteria)");
  }
  parts.push(
    "",
    "You are running on a Garrison OUTPOST, dispatched from the host board. The",
    "repository has already been checked out and its environment materialized, so",
    "work in the current directory. Finish exactly this phase, then stop.",
    "",
    `End your final response with exactly one transition token on its own final line: ${validTransitions.join(" | ") || "needs-attention"}.`,
    "The host validates that token and advances only this one phase; do not claim the whole card is Done unless `done` is listed."
  );
  return parts.join("\n");
}

export function buildJob(card: ClaimableCard, extra: Partial<DispatchJob> = {}): DispatchJob | null {
  const validTransitions = Array.isArray(extra.validTransitions) && extra.validTransitions.length
    ? extra.validTransitions
    : validTransitionsFromSequence(card);
  // A literal command still wins when one is set: that is the zero-token stub
  // lane the transport was proven with, and it stays the cheapest way to smoke
  // test a machine.
  //
  // Everything else becomes a DUTY run. Returning null here (the old v1
  // behaviour) meant an agentic card placed on a machine was skipped forever —
  // the worker polled, saw nothing claimable, and the card sat on the board
  // looking dispatched while nothing anywhere intended to run it.
  const run: DispatchRun = card.command
    ? { kind: "command", command: card.command }
    : { kind: "duty", duty: card.duty || card.list, prompt: buildDutyPrompt(card, validTransitions) };
  return {
    runId: typeof extra.runId === "string" ? extra.runId : "unclaimed",
    routingToken: typeof extra.routingToken === "string" ? extra.routingToken : "unclaimed",
    cardId: card.id,
    title: card.title,
    list: card.list,
    project: card.project,
    scope: card.scope,
    run,
    phase: card.list,
    validTransitions,
    logIndex: Number.isInteger(extra.logIndex) ? Number(extra.logIndex) : 1,
    claimRevision: Number.isInteger(extra.claimRevision) ? Number(extra.claimRevision) : card.rev,
    leaseSeconds: DISPATCH_LEASE_SECONDS,
    heartbeatSeconds: DISPATCH_HEARTBEAT_SECONDS,
    ...extra
  };
}

export function validTransitionsFromSequence(card: ClaimableCard): string[] {
  const sequence = card.sequence ?? [];
  const index = sequence.indexOf(card.list);
  if (index >= 0) return [sequence[index + 1] ?? "done"];
  return [];
}

// Legacy cards may not carry the resolved duty sequence. In that case the
// board's current list definition is authoritative; never guess `done`.
export async function validTransitionsForCard(card: ClaimableCard): Promise<string[]> {
  const resolved = validTransitionsFromSequence(card);
  if (resolved.length) return resolved;
  try {
    const board = JSON.parse(await readFile(path.join(kanbanBoardDir(), "board.json"), "utf8")) as {
      lists?: Array<{ id?: unknown; validNext?: unknown }>;
    };
    const list = (board.lists ?? []).find((item) => item.id === card.list);
    return Array.isArray(list?.validNext)
      ? list!.validNext.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

// Resolve the exact phase cell projected by the composition runner. Remote work
// must not invent a runtime from the duty name or silently fall back to a local
// CLI; if the phase has no projected cell, claim refuses it.
export async function readDispatchRuntimeTarget(card: ClaimableCard): Promise<DispatchRuntimeTarget | null> {
  try {
    const model = JSON.parse(await readFile(path.join(kanbanBoardDir(), "model.json"), "utf8")) as {
      steps?: Record<string, Record<string, Array<Record<string, unknown>>>>;
    };
    if (!card.duty) return null;
    const steps = model.steps?.[card.duty]?.[String(card.level)];
    if (!Array.isArray(steps)) return null;
    const index = card.sequence?.indexOf(card.list) ?? -1;
    const raw = (index >= 0 ? steps[index] : undefined)
      ?? steps.find((step) => step.duty === card.list);
    if (!raw) return null;
    const targetId = typeof raw.targetId === "string" ? raw.targetId : "";
    const runtime = typeof raw.runtime === "string" ? raw.runtime : "";
    const modelName = typeof raw.model === "string" ? raw.model : "";
    if (!targetId || !runtime || !modelName) return null;
    const params = raw.params && typeof raw.params === "object" ? raw.params as Record<string, unknown> : {};
    return {
      targetId,
      runtime,
      provider: typeof raw.provider === "string" ? raw.provider : null,
      model: modelName,
      effort: typeof raw.effort === "string" ? raw.effort : null,
      promptMode: typeof params.promptMode === "string" ? params.promptMode : null,
      maxTurns: Number.isInteger(params.maxTurns) && Number(params.maxTurns) > 0 ? Number(params.maxTurns) : null
    };
  } catch {
    return null;
  }
}

// Reserve a monotonic card log before the claim CAS. `wx` makes concurrent
// workers pick distinct files; the loser leaves an empty historical slot, which
// is harmless and preferable to two live streams overwriting one another.
export async function reserveDispatchLog(cardId: string): Promise<number> {
  const dir = path.join(kanbanBoardDir(), "cards", cardId);
  await mkdir(dir, { recursive: true });
  let highest = 0;
  try {
    for (const name of await readdir(dir)) {
      const match = /^log-(\d+)\.md$/.exec(name);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
  } catch {}
  for (let n = highest + 1; n < highest + 100; n += 1) {
    try {
      const handle = await open(path.join(dir, `log-${n}.md`), "wx", 0o600);
      await handle.writeFile(`# outpost dispatch\n`);
      await handle.close();
      return n;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not reserve a dispatch log for ${cardId}`);
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

// Commit one remote phase through Kanban's authoritative phase-transition
// routine. The worker never writes `list` directly; the board revalidates the
// claim/routing token and runs the same gate/evidence/coordination hooks as an
// in-process phase before it advances.
export async function completeDispatchPhase(
  cardId: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = await boardBaseUrl();
  if (!base) throw new BoardUnavailableError();
  const res = await fetch(`${base}/cards/${encodeURIComponent(cardId)}/dispatch-complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-garrison-engine": "outpost-dispatch"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const responseBody = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: responseBody };
}

// Record a worker's positive cancellation acknowledgement through Kanban's
// claim-owning seam. Until this call succeeds the card remains running and its
// lease/placement stay locked, preventing a second machine from overlapping the
// process group that may still be alive.
export async function acknowledgeDispatchCancellation(
  cardId: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const base = await boardBaseUrl();
  if (!base) throw new BoardUnavailableError();
  const res = await fetch(`${base}/cards/${encodeURIComponent(cardId)}/dispatch-cancel`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-garrison-engine": "outpost-dispatch"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  const responseBody = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: responseBody };
}
