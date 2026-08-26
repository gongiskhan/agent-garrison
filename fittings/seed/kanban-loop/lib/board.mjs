// Kanban Loop storage: the GARRISON STATE SERVICE owns the cards and the board
// layout. This module keeps every name and signature its callers already use —
// engine.mjs, coordination.mjs and the board server are untouched — and only its
// bodies moved off the filesystem.
//
//   cards                  — `cards` rows in the state service. rev CAS via
//                            If-Match, coordination_seq as a monotonic floor,
//                            no resurrection, occurrence_key UNIQUE, and an
//                            unparseable schedule refused at the door.
//   board layout           — config doc `board.layout` / scope `global`.
//   cards/<id>/brief.md,
//   attachments/, log-N.md — still node-local files.
//
// The `root` argument every function still accepts selects where those
// node-local SIDE FILES live (kanbanRoot()); it no longer selects a card store.
//
// List membership is still DERIVED from the cards, never stored.
import { promises as fs, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ulid } from "./ulid.mjs";
import { routeTerminalTransition } from "./notify-origin.mjs";
import { generateHandoffIfDone } from "./handoff.mjs";
import { deriveOriginId } from "./origins.mjs";
import { markSteeringApplied } from "./steering.mjs";
import { adoptFlowKeys } from "./policy.mjs";
import { emitPersonalCompletionAfterDone, isPersonalDoneTransition } from "./personal-memory-outbox.mjs";
import { openConversation } from "@garrison/claude-pty";
import {
  SCHEDULE_ACTIONS,
  normaliseScheduleAction,
  normaliseScheduledFor,
  normaliseCardSchedule,
  scheduleNextAt
} from "./schedules.mjs";
import { createStateClient, StateApiError } from "./state-client.mjs";

export { SCHEDULE_ACTIONS, normaliseScheduleAction, normaliseScheduledFor, normaliseCardSchedule } from "./schedules.mjs";

export function kanbanRoot() {
  const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  return process.env.GARRISON_KANBAN_DIR || path.join(home, "kanban-loop");
}

// Atomic JSON write: write a unique temp file, then rename over the target so a
// reader never sees a partial file and two writers don't interleave.
export async function atomicWriteJSON(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${ulid()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, file);
}

// ── the state service seam ─────────────────────────────────────────
// ONE client per process, memoised on the discovery inputs so a token rotation
// — or a test pointing this process at its own ephemeral service — is picked up
// without a restart. The client throws loudly when the node is not enrolled;
// there is deliberately NO fallback to a local card store, no cache and no write
// queue. A stale read is worse than a clear stop.
let stateClientCache = null;
let stateClientKey = null;

function stateDiscoveryKey(env) {
  return [
    env.GARRISON_STATE_URL ?? "",
    env.GARRISON_STATE_TOKEN ?? "",
    env.GARRISON_HOME ?? "",
    env.GARRISON_NODE_NAME ?? ""
  ].join("|");
}

export function boardStateClient() {
  const key = stateDiscoveryKey(process.env);
  if (stateClientCache && stateClientKey === key) return stateClientCache;
  stateClientCache = createStateClient({ readFileSync });
  stateClientKey = key;
  return stateClientCache;
}

function isStatus(err, status) {
  return err instanceof StateApiError && err.status === status;
}

// How many times a lock-scoped (recovery) write re-reads and re-runs its mutator
// after losing the CAS. The lifecycle lock used to make that impossible; the
// service transaction plus a bounded retry is the same guarantee without a pid.
const LOCKED_WRITE_TRIES = 6;

// This node's name. `host` placement resolves through it (see below), so an
// unnamed node is a hard, loud error rather than a card that quietly lands
// nowhere.
function localNodeName() {
  const client = boardStateClient();
  const name = String(client.node || process.env.GARRISON_NODE_NAME || "").trim();
  if (!name) {
    throw new Error(
      "kanban: this node has no name — set GARRISON_NODE_NAME (or `node` in $GARRISON_HOME/state.json) so placement can resolve \"host\""
    );
  }
  return name;
}

// `host` means \"run where Garrison runs\" — a phrase with no referent once
// several machines all run Garrison, so the store never holds it (the service
// rejects it outright). It is WRITTEN as this node's name and READ BACK as
// `host` when the target IS this node, which is exactly what \"mine to run\"
// means locally. A target naming another node crosses both ways verbatim, so
// the engine's local/remote split and dispatch claimability are unchanged.
function placementToStore(placement) {
  if (!placement || typeof placement !== "object") return placement ?? null;
  if (placement.target !== HOST_PLACEMENT_TARGET) return placement;
  return { ...placement, target: localNodeName() };
}

function placementFromStore(placement) {
  if (!placement || typeof placement !== "object") return placement ?? null;
  let self = null;
  try { self = localNodeName(); } catch { self = null; }
  if (!self || placement.target !== self) return placement;
  return { ...placement, target: HOST_PLACEMENT_TARGET };
}

// A NULL promoted column comes back as an absent key; the board's card shape
// uses explicit nulls, and a reader that wrote `null` must read `null`.
const NULLABLE_PROMOTED = [
  "position", "project", "scheduledFor", "schedule", "occurrenceKey", "systemKey", "origin_id", "placement"
];

// `compat` mirrors exactly where the file store applied its read-time fixups:
// loadCard did, and a write's return value did NOT. Relocating a retired list on
// the way OUT of a write would rename the caller's own card under it.
function cardFromStore(row, { compat = false } = {}) {
  if (!row) return null;
  const card = { ...row };
  // The service's own bookkeeping; the card carries `created` / `updated`.
  delete card.created_at;
  delete card.updated_at;
  for (const field of NULLABLE_PROMOTED) {
    if (card[field] === undefined) card[field] = null;
  }
  card.placement = placementFromStore(card.placement);
  if (!compat) return card;
  // Compat on read, exactly as the file store did: adopt the pre-rename flow key
  // and relocate a card left in a list the v6 migration retired.
  return relocateRetiredListCards(adoptFlowKeys(card));
}

function cardToStore(card) {
  const out = { ...card };
  delete out.created_at;
  delete out.updated_at;
  if (out.placement) out.placement = placementToStore(out.placement);
  return out;
}

// Position allocation happens inside the write transaction now — that was the
// whole job of withCardOrderLock. An explicit finite number is honoured; anything
// else lands at the BOTTOM, which is the order a null `position` already had when
// it fell back to the creation instant.
function positionHint(card) {
  return typeof card?.position === "number" && Number.isFinite(card.position) ? card.position : "bottom";
}

// ── node-local card mirror (batch-one bridge) ─────────────────────────
// The service is the source of truth and nothing in this module ever READS the
// mirror. It exists because three callers have not been migrated yet and still
// open cards/<id>/card.json on the node that wrote it:
//   * src/lib/board-summary.ts               (the Next app's board summary)
//   * coordination.mjs readCardStateForCleanup (the durable cleanup guard)
//   * personal-memory-outbox.mjs reconcilePersonalCompletionOutbox
// It is write-only and best-effort, and it goes away with those three.
async function mirrorCard(root, card) {
  if (!card || !card.id) return card;
  try {
    await atomicWriteJSON(cardFile(root, card.id), card);
  } catch (err) {
    console.error(`[kanban] card mirror failed for ${card.id}: ${err?.message ?? err}`);
  }
  return card;
}

// The current on-disk board schema version. Bumped whenever a migration below
// must run once on load for EVERY existing board (not just model-driven ones).
export const BOARD_VERSION = 10;

// A duty-backed list's display title. The board is the thing Gonçalo looks at all
// day, so a list that runs a duty must SAY it runs a duty (brief §2.4) — otherwise
// the board shows a column called "Review" with no hint that it is a routed agent
// step rather than a place to park things.
//
// Only the ids that title-case badly are listed; everything else derives.
const DUTY_TITLE_OVERRIDES = {
  "ux-qa": "UX QA",
  "adversarial-review": "Adversarial Review",
  "adversarial-test": "Adversarial Test",
  "codex-checkpoint": "Codex Checkpoint",
  "security-review": "Security Review",
  "probe-question": "Probe Question"
};

export const DUTY_TITLE_PREFIX = "duty: ";

// Every duty a flow level can name needs a list, or a card entering that level
// has nowhere to run and stalls. `feature` level 3 alone runs walkthrough,
// validate and report, none of which had a column before the 2026-08-09 library
// landed. Ordered as the pipeline runs, and inserted before the terminal manual
// columns so the board still reads left to right.
const REQUIRED_DUTY_LISTS = [
  "adversarial-test",
  "security-review",
  "walkthrough",
  "validate",
  "codex-checkpoint",
  "report"
];

// Discuss is deliberately NOT prefixed. It is a DESTINATION where a card sits
// across many turns of conversation, not a step a card passes through, so
// "duty: Discuss" would misdescribe it — and the brief lists it among the plain
// lists in §2.4 even while §2.1 calls it a duty (ORCHESTRATOR_COHERENCE.md A1).
const UNPREFIXED_AGENT_LISTS = new Set(["discuss"]);

/** A list's name for use INSIDE a sentence. The `duty:` prefix is a column-header
 *  device — it tells you at a glance which columns are routed agent steps. In prose
 *  it reads as noise ("advanced Needs attention → duty: Plan"), so strip it. */
export function listProseLabel(listOrTitle) {
  const title =
    typeof listOrTitle === "string" ? listOrTitle : listOrTitle?.title ?? listOrTitle?.id ?? "";
  return String(title).startsWith(DUTY_TITLE_PREFIX)
    ? String(title).slice(DUTY_TITLE_PREFIX.length)
    : String(title);
}

export function dutyListTitle(id) {
  const base =
    DUTY_TITLE_OVERRIDES[id] ??
    String(id)
      .split("-")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ");
  return `${DUTY_TITLE_PREFIX}${base}`;
}

// One-shot board migration. Idempotent; unknown fields survive.
//   v2→v3 (D15): strip dead per-list skill/taskType/tier/mode pins and stamp each
//     agent list's phase (its id).
//   v3→v4 (2026-08-04): ensure the fixed `archived` tail column exists. This runs
//     for boards that predate the resolved-model reconcile too (a composition with
//     no model.json is otherwise never rebuilt), so every live board picks up the
//     Archived column on the next load regardless of how it was seeded.
//   v4→v5 (2026-08-05): add the fixed Scheduled system column at the far left.
export function migrateBoard(board) {
  if (!board || typeof board !== "object") return board;
  if ((board.version || 0) >= BOARD_VERSION) return board;
  let lists = board.lists || [];
  if ((board.version || 0) < 3) {
    lists = lists.map((l) => {
      const { skill, taskType, tier, mode, ...rest } = l;
      if (rest.kind === "agent" && !rest.phase) rest.phase = rest.id;
      return rest;
    });
  }
  if (!lists.some((l) => l.id === "archived")) {
    const maxOrder = lists.reduce((m, l) => Math.max(m, Number.isFinite(l.order) ? l.order : 0), 0);
    lists = [
      ...lists,
      { id: "archived", title: "Archived", order: maxOrder + 1, kind: "manual", trigger: "manual", terminal: true, archived: true, validNext: [] }
    ];
  }
  if (!lists.some((l) => l.id === "scheduled")) {
    lists = [
      {
        id: "scheduled", title: "Scheduled", order: -1, userOrder: -1,
        kind: "scheduled", trigger: "scheduler-beat", system: true,
        validNext: []
      },
      ...lists
    ];
  } else {
    lists = lists.map((list) => list.id === "scheduled"
      ? { ...list, order: -1, userOrder: -1, kind: "scheduled", trigger: "scheduler-beat", system: true, validNext: [] }
      : list);
  }
  if ((board.version || 0) < 7) {
    // v5→v7 (2026-08-09, ORCHESTRATOR_COHERENCE.md §5.1):
    // (Numbered 7, not 6: a live kanban process re-read this module mid-edit — after
    // BOARD_VERSION became 6 but before this block existed — and stamped both live
    // boards v6 with nothing applied. Gating on <7 heals those boards; a board that
    // legitimately reached 6 is unchanged by re-running an idempotent migration.)
    //   (a) the `code` duty was retired into `implement` — they named the same
    //       work — so its list is dropped. Any card still sitting in it (there
    //       were none on the live boards) moves to `implement` rather than being
    //       stranded in a list that no longer routes.
    //   (b) every duty-backed list gets the `duty:` prefix so the board says which
    //       lists are routed agent steps. List IDS ARE NOT TOUCHED — cards
    //       reference them and persisted references must keep resolving.
    // (c) add a column for every duty a flow level can name.
    const terminalIds = new Set(["done", "needs-attention", "archived"]);
    const firstTerminal = lists.findIndex((l) => terminalIds.has(l.id));
    const missing = REQUIRED_DUTY_LISTS.filter((id) => !lists.some((l) => l.id === id)).map((id) => ({
      id,
      title: dutyListTitle(id),
      kind: "agent",
      phase: id,
      trigger: "manual",
      validNext: []
    }));
    if (missing.length) {
      const at = firstTerminal === -1 ? lists.length : firstTerminal;
      // Fractional orders between the last agent column and the first terminal
      // one. Renumbering every list instead would silently reshuffle a board the
      // user had reordered by hand — the new columns must slot in WITHOUT
      // touching the position of anything already there.
      const before = at === 0 ? 0 : Number(lists[at - 1]?.order ?? at - 1);
      const after = at < lists.length ? Number(lists[at]?.order ?? before + 1) : before + 1;
      const step = (after - before) / (missing.length + 1);
      const placed = missing.map((l, i) => ({ ...l, order: before + step * (i + 1) }));
      lists = [...lists.slice(0, at), ...placed, ...lists.slice(at)];
    }

    const hasImplement = lists.some((l) => l.id === "implement");
    lists = lists
      .filter((l) => !(l.id === "code" && hasImplement))
      .map((list) => {
        if (list.kind !== "agent" && list.kind !== "agent-interactive") return list;
        if (UNPREFIXED_AGENT_LISTS.has(list.id)) return list;
        // Idempotent: a title already prefixed is left exactly as the user left it.
        if (typeof list.title === "string" && list.title.startsWith(DUTY_TITLE_PREFIX)) return list;
        return { ...list, title: dutyListTitle(list.id) };
      })
      .map((list) => ({
        ...list,
        validNext: Array.isArray(list.validNext)
          ? list.validNext.map((n) => (n === "code" && hasImplement ? "implement" : n))
          : list.validNext
      }));
  }
  if ((board.version || 0) < 9) {
    // v7→v9 (2026-08-15): the Kanban "Add list" affordance used to create a
    // composition DUTY — an agent list carrying the `duty:` prefix that starts a
    // run when a card lands on it. It now creates a human-managed manual list.
    // The one list created under the old flow on the live boards is `ice-box`,
    // explicitly described "human managed"; convert it to what the user intended:
    // a manual, human-managed parking column, no `duty:` prefix, no agent
    // behaviour. Its ID is NOT touched — cards reference it. Marking it
    // `userCreated` makes the duty reconcile PRESERVE it (resolved-model.mjs) once
    // the composition drops the ice-box duty, instead of stranding its cards.
    //   (Numbered 9, not 8: a live process re-read this module mid-edit — after
    //   BOARD_VERSION became 8 but before this block existed — and stamped the prod
    //   board v8 with nothing applied, exactly the v6→v7 window above. Gating on <9
    //   heals it; the conversion is idempotent, and a board with no ice-box list is
    //   untouched.)
    lists = lists.map((list) => {
      if (list.id !== "ice-box") return list;
      const { phase, executePrompt, routerPrompt, beatCron, interactive, surface, ...rest } = list;
      return {
        ...rest,
        title: "Ice Box",
        kind: "manual",
        trigger: "manual",
        userCreated: true,
        validNext: []
      };
    });
  }
  // v9→v10 (2026-08-26, Conversations) is a GUARD, not a transform. The board
  // becomes five state columns and 200+ legacy cards freeze as history — a
  // CARD migration, not a layout migration, so it is NOT done on read:
  // scripts/migrate-conversations.mjs does the board and the cards in ONE
  // pass. Until it runs, a v9 board on v10 code is served exactly as it is
  // and stays stamped 9 — a half-migrated board (new columns, old cards)
  // would strand every card through relocateStrandedCards. Nothing here to
  // get wrong, which is the point: the two live boards recorded above (v6,
  // v8) were stamped by a migration that shipped a version bump ahead of its
  // transform.
  if ((board.version || 0) < 10) {
    console.warn("[kanban] board is pre-Conversations — run scripts/migrate-conversations.mjs; serving the legacy layout");
    // The pre-v9 blocks above still heal an old board; it is stamped AT MOST 9.
    return { ...board, version: 9, lists };
  }
  return { ...board, version: BOARD_VERSION, lists };
}

// list ⟷ status coherence (Conversations): lists ARE the states, `card.list`
// is authoritative and `status` mirrors it. Applied at the ONE write choke
// point below, on the BODY, before the store serialises it — so the store's
// re-derivation of promoted columns from body_json agrees by construction.
export function coherentCardState(card) {
  if (!card || typeof card !== "object") return card;
  if (card.list === "running") return card.status === "running" ? card : { ...card, status: "running" };
  if (card.list === "needs-attention") {
    return card.status === "needs-attention" ? card : { ...card, status: "needs-attention" };
  }
  if (card.status === "running" || card.status === "needs-attention") return { ...card, status: "ok" };
  return card;
}

/** Cards stranded in a list this migration removed. The board file only holds the
 *  list definitions; membership lives on each card, so the caller relocates them. */
export function relocateRetiredListCards(card) {
  if (card && card.list === "code") return { ...card, list: "implement" };
  return card;
}

// The board layout is ONE shared document, not a per-root file: config doc
// `board.layout` at scope `global`.
export const BOARD_NAMESPACE = "board.layout";
export const BOARD_SCOPE = "global";

// An absent layout stays an ENOENT-shaped throw — the seeding paths
// (kanban.mjs --setup) catch exactly that and seed, and a silent default here
// would clobber the seed-or-migrate-never-clobber rule.
function missingBoardError() {
  const err = new Error("kanban: no board layout — the board has not been seeded");
  err.code = "ENOENT";
  return err;
}

export async function loadBoard(root = kanbanRoot()) {
  const doc = await boardStateClient().getConfig(BOARD_NAMESPACE, BOARD_SCOPE);
  const board = doc?.body ?? null;
  if (!board || typeof board !== "object") throw missingBoardError();
  // Migration on read, persisted back so it runs once; a fresh board is already at
  // BOARD_VERSION. The v10 Conversations bump is a guard, not a transform: a v9
  // board comes back still stamped 9, and persisting THAT every read would churn
  // a config-doc rev per load — persist only when the version actually advanced.
  if (board && (board.version || 0) < BOARD_VERSION) {
    const migrated = migrateBoard(board);
    if ((migrated?.version || 0) > (board.version || 0)) {
      await saveBoard(migrated, root);
    }
    return migrated;
  }
  return board;
}

export async function saveBoard(board, root = kanbanRoot()) {
  const client = boardStateClient();
  // saveBoard carries no precondition of its own (that is saveBoardCAS's job), so
  // a concurrent writer just means re-reading the document rev and writing again.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const doc = await client.getConfig(BOARD_NAMESPACE, BOARD_SCOPE);
    try {
      await client.putConfig(BOARD_NAMESPACE, BOARD_SCOPE, board, { ifMatchRev: doc?.rev ?? 0 });
      return;
    } catch (err) {
      if (!isStatus(err, 409)) throw err;
    }
  }
  throw new Error("kanban: the board layout write lost the race 5 times");
}

const cardFile = (root, id) => path.join(root, "cards", id, "card.json");

// The card-owned Discuss brief: a markdown file next to the card's card.json. This is
// the DETERMINISTIC, card-scoped brief location — the Discuss duty writes it here (told the absolute
// path in the Discuss kickoff), the web-channel Brief editor reads/writes it, and the
// engine folds it into the build prompt. Decoupled from any project working dir, so the
// three never disagree on where the brief lives.
export const cardBriefFile = (root, id) => path.join(root, "cards", id, "brief.md");
export const cardBriefRel = (id) => `cards/${id}/brief.md`; // relative to kanbanRoot (card.briefPath marker)

// Card-owned attachments: uploaded files under cards/<id>/attachments/. The
// LISTING is derived by readdir (like list membership — never stored on the
// card, so a stray file delete can't desync a manifest). The engine folds the
// absolute paths into the dispatch prompt; the operative Reads them itself.
export const cardAttachmentsDir = (root, id) => path.join(root, "cards", id, "attachments");
export function listCardAttachments(root, id) {
  const dir = cardAttachmentsDir(root, id);
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Outpost Dispatch placement — WHERE a card runs.
//
// `host` (the default) means the local operative runs it, exactly as every card
// did before dispatch existed. Any other value names a paired machine that must
// PULL the card via the host's dispatch API.
//
// A malformed or absent placement normalises to `host`, never to "any machine":
// the failure mode of a typo must be "runs here as usual", not "scattered across
// the fleet". `not_before` is carried verbatim so the claim path can decide (and
// refuse an unparseable value) rather than this silently dropping a schedule.
export const HOST_PLACEMENT_TARGET = "host";
export function normalisePlacement(raw, legacyOutpost = null) {
  const legacy = typeof legacyOutpost === "string" ? legacyOutpost.trim() : "";
  if (!raw || typeof raw !== "object") return { target: legacy || HOST_PLACEMENT_TARGET };
  const target = typeof raw.target === "string" ? raw.target.trim() : "";
  const notBefore = typeof raw.not_before === "string" ? raw.not_before.trim() : "";
  return {
    target: target && target !== HOST_PLACEMENT_TARGET ? target : legacy || target || HOST_PLACEMENT_TARGET,
    ...(notBefore ? { not_before: notBefore } : {})
  };
}

// ── Card scheduling ────────────────────────────────────────────────────────
// `scheduledFor` (ISO instant) holds the card OUT of every dispatch path until
// the instant passes; the tick's due-sweep then either notifies ("notify", the
// default — the reminder carries the tell-Zeca phrases) or auto-starts ("run").
// An unparseable value HOLDS the card (same fail-closed rule as placement
// not_before in claimability): a scheduled card that runs early is worse than
// one that waits for a human.
// True when the card is held by a future (or unparseable — fail closed)
// schedule. Every dispatch seam funnels through this one predicate.
export function scheduleHolds(card, now = Date.now()) {
  const at = scheduleNextAt(card);
  if (!at) return false;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return true; // unparseable holds, never releases early
  return t > now;
}

// ── Checklist ──────────────────────────────────────────────────────────────
// Human-first task list inside a card ({id, text, done, doneAt}); the engine
// folds open items into the dispatch prompt so the operative sees them too.
// Whole-array replace on PATCH — items are tiny and human-edited.
export function normaliseChecklist(raw) {
  if (!Array.isArray(raw)) return null;
  const items = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const text = typeof it.text === "string" ? it.text.trim() : "";
    if (!text) continue;
    const done = it.done === true;
    items.push({
      id: typeof it.id === "string" && /^[0-9A-Za-z_-]{1,32}$/.test(it.id) ? it.id : ulid().slice(-10),
      // Preserve the authored body verbatim (after surrounding whitespace). A
      // checklist item is allowed to be a small multi-paragraph task brief; the
      // former silent 500-character slice lost later paragraphs on every save.
      text,
      done,
      doneAt: done && typeof it.doneAt === "string" ? it.doneAt : done ? new Date().toISOString() : null
    });
    if (items.length >= 100) break;
  }
  return items.length ? items : [];
}

// Within-list ordering: a card's effective position is its explicit `position`
// (set by drag-reorder) or its creation instant in ms — so legacy cards keep
// their historical created order and a drag only has to write ONE card.
export function cardPosition(card) {
  const p = card?.position;
  if (typeof p === "number" && Number.isFinite(p)) return p;
  const t = Date.parse(card?.created ?? "");
  return Number.isFinite(t) ? t : 0;
}

/**
 * The card's explicit run spec (RUN-SPEC-V1) — the `TurnRouting` pin, stored whole.
 *
 * STRUCTURAL sanitising only: the exact field list, and scalars-or-nothing. The
 * SEMANTIC check (is this tier/flow/phase in the compiled policy's
 * vocabulary?) belongs to the gateway's sanitizeRouting and is deliberately not
 * mirrored here — the board is a different process with no policy of its own, and a
 * second copy of that vocabulary is exactly the drift this whole change is removing.
 * A value the gateway refuses comes back as a rejection on the badge, which is the
 * designed way for a bad pin to surface.
 *
 * Returns null for "nothing pinned" so a fully-automatic card stores `routing: null`
 * rather than an empty object — the two read identically, and null is what every
 * pre-existing card already has.
 */
export const CARD_ROUTING_FIELDS = ["target", "model", "effort", "duty", "level", "project", "account", "tier", "flow", "phasesOff", "phasesOn"];
export function sanitiseCardRouting(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const field of CARD_ROUTING_FIELDS) {
    const value = raw[field];
    if (value === null || value === undefined) continue;
    if (field === "level") {
      const n = typeof value === "number" ? value : /^[0-9]+$/.test(String(value)) ? Number(value) : NaN;
      if (Number.isInteger(n) && n >= 1 && n <= 9) out.level = n;
      continue;
    }
    if (typeof value !== "string") continue;
    const s = value.trim();
    if (s) out[field] = s;
  }
  return Object.keys(out).length ? out : null;
}

// What kind of ownership/context a card has. This is deliberately independent of
// `flow`: personal is a task classification, while flow chooses an execution
// rail. A personal card can therefore still be moved onto an agent list and run.
export const CARD_SCOPES = ["personal", "project", "unscoped"];
export function cardScope(card) {
  if (card?.scope === "personal") return "personal";
  const project = typeof card?.project === "string" ? card.project.trim() : "";
  if (project) return "project";
  return "unscoped";
}

export async function createCard(root, { id: explicitId = null, conversationId = null, title, description = "", project = null, scope = null, list, goalMode = false, acceptance = null, flow = null, phases = null, tier = null, routing = null, origin = null, originChannel = null, outpost = null, duty = null, level = null, sequence = null, continues = null, clarity = null, placement = null, dispatchCommand = null, schedule = null, scheduledFor = null, scheduleAction = null, scheduleTemplateId = null, scheduleSystemKey = null, occurrenceKey = null, occurrenceAt = null, systemKey = null, checklist = null, position = null, origin_id: explicitOriginId = null, at = new Date().toISOString() }) {
  // Conversations: a card materializing from a conversation TAKES the
  // conversation's ULID as its id — one identity, one directory name.
  const id = typeof explicitId === "string" && /^[0-9A-Za-z_-]{8,64}$/.test(explicitId) ? explicitId : ulid();
  // Personal is an independent label and may coexist with a project (for example,
  // a private task whose implementation still belongs to a real repository).
  // Every non-personal legacy/new shape derives project vs unscoped from the
  // actual project field.
  // The HTTP boundary rejects malformed scope values; this lower-level constructor
  // remains tolerant for imports/tests and old callers.
  scope = cardScope({ scope, project });
  // WS2 (D7): a continuation card references its predecessor by ULID. When set and
  // no explicit origin was given, the card's origin is "continuation".
  const validContinues = typeof continues === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(continues) ? continues : null;
  // A continuation INHERITS the predecessor's duty journey when the creator did
  // not pick one: a bare successor would fall back to the legacy board validNext
  // and wander lists the predecessor never meant to visit. Server-side so every
  // creation door (Continue button, create_continuation tool, gateway) gets it.
  if (validContinues && !duty && !sequence) {
    try {
      const prev = await loadCard(root, validContinues);
      duty = prev.duty ?? null;
      level = prev.level ?? null;
      sequence = Array.isArray(prev.sequence) && prev.sequence.length ? [...prev.sequence] : null;
    } catch {
      /* unknown predecessor - the successor stays bare */
    }
  }
  const cardSchedule = normaliseCardSchedule(schedule, {
    scheduledFor: normaliseScheduledFor(scheduledFor),
    scheduleAction,
    targetList: list,
    now: at
  });
  const card = {
    id,
    conversationId: typeof conversationId === "string" && conversationId ? conversationId : null,
    title: title ?? "(untitled)",
    description,
    project,
    scope,
    list,
    // list ⟷ status coherence holds from birth: a launcher-created Running
    // card is status running, everything else starts ok.
    status: list === "running" ? "running" : "ok",
    iterations: 0,
    rev: 0, // optimistic-concurrency revision (compare-and-swap on write)
    cost: null,
    goalMode: Boolean(goalMode),
    acceptance,
    // ── run-policy fields (S4: D2/D8/D17) ─────────────────────────────────
    // flow names the policy flow whose phase plan is this card's
    // rail; phases is the per-card toggle map merged OVER the plan (an OFF
    // phase renders off, never hidden); tier rides classification (the phase
    // is the task type); origin records who registered the run.
    flow: typeof flow === "string" && flow ? flow : null,
    phases: phases && typeof phases === "object" ? phases : null,
    tier: typeof tier === "string" && tier ? tier : null,
    // ── the card's explicit run spec (RUN-SPEC-V1) ────────────────────────
    // ONE object, not six fields: it is the same `TurnRouting` pin the Web
    // Channel's rail produces, and gatewayRunFn forwards it verbatim as the
    // request's `routing`. Storing it whole means the gateway stays the single
    // validator (it re-validates every turn against the live policy) and adding a
    // dimension later touches the vocabulary, not the card schema.
    //
    // Absent/empty = every dimension is automatic, which is the default for every
    // card. Sanitised to a plain object of scalars here; semantic validation is
    // deliberately NOT duplicated on the board.
    routing: sanitiseCardRouting(routing),
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
    // S3d (D9b): routing inference's specification-clarity verdict. A "needs-discuss"
    // card is dispatched through the Discuss duty first (the engine's gated-discuss
    // exemption keys on this); anything else is null (a clear card runs straight).
    clarity: clarity === "needs-discuss" ? "needs-discuss" : null,
    // Legacy `outpost` is migrated into the worker-owned placement below. New
    // cards never retain two contradictory remote-routing fields.
    outpost: null,
    // ── Outpost Dispatch (pull-based) ─────────────────────────────────────
    // WHERE this card runs. The older `outpost` create input is accepted only
    // as a compatibility alias and immediately materialized here.
    placement: normalisePlacement(placement, outpost),
    dispatch: null,
    // ── scheduling (see scheduleHolds above) ──────────────────────────────
    // scheduledFor holds dispatch until the instant passes; scheduleAction
    // decides what the due-sweep does (notify = reminder with tell-Zeca
    // phrases, run = auto-start); scheduleNotifiedAt makes the reminder
    // fire once (cleared by snooze/reschedule). position orders the card
    // within its list (null = created order); checklist is the in-card
    // task list. All new keys — pre-existing cards read them as undefined.
    schedule: cardSchedule,
    // Compatibility aliases for existing clients and Omi/MCP commands. The
    // schedule object is authoritative; aliases always mirror its next action.
    scheduledFor: cardSchedule?.nextAt ?? null,
    scheduleAction: cardSchedule?.action ?? null,
    scheduleNotifiedAt: null,
    scheduleTemplateId: typeof scheduleTemplateId === "string" && scheduleTemplateId ? scheduleTemplateId : null,
    scheduleSystemKey: typeof scheduleSystemKey === "string" && scheduleSystemKey ? scheduleSystemKey : null,
    occurrenceKey: typeof occurrenceKey === "string" && occurrenceKey ? occurrenceKey : null,
    occurrenceAt: typeof occurrenceAt === "string" && Number.isFinite(Date.parse(occurrenceAt))
      ? new Date(occurrenceAt).toISOString()
      : null,
    systemKey: typeof systemKey === "string" && systemKey ? systemKey : null,
    // Within-list float order. A finite `position` (from drag-reorder, or a
    // creation asking to land at the top of a list) wins; null = created order.
    // Threaded through createCard so the single creation door can stamp a
    // top-of-list position atomically at create time (no rev-churning
    // stamp-after-create write).
    position: typeof position === "number" && Number.isFinite(position) ? position : null,
    checklist: normaliseChecklist(checklist),
    // A literal command for a stub/no-model dispatched run. Present so the
    // transport can be proven end-to-end without spending model tokens; a
    // duty-driven remote run replaces it rather than extending it.
    dispatchCommand: typeof dispatchCommand === "string" && dispatchCommand ? dispatchCommand : null,
    // ── execution visibility ──────────────────────────────────────────────
    // The card's activity timeline (engine.withEvent appends to it on every
    // transition); the last operative reply snippet (shown on the card front);
    // and when the current run started (drives the live elapsed timer). All
    // start empty/null and are filled CAS-safely as the card moves.
    events: [{ at, kind: "created", message: project ? `Created in ${list} (project ${project})` : `Created in ${list} — no project yet` }],
    lastReply: null,
    runningSince: null,
    // Monotonic high-water mark for cards/<id>/log-N.md. Unlike `iterations`
    // (the convergence-cap counter), this never resets when a human retries a
    // needs-attention card, so a fresh attempt cannot overwrite an older log.
    logIndex: 0,
    // V1b pointer fields (FINDING 10 — the card stores POINTERS, never inlined
    // document bodies). runId/runDir are minted lazily on the card's first
    // agent-list entry (FINDING 4); the rest are filled by the skills/surfaces as
    // they produce artifacts. No migration: storage is file-per-card JSON, so a
    // V1a card simply reads these as undefined and they default on next write.
    runId: null,        // minted once, on the first agent-list entry
    runDir: null,       // docs/autothing/runs/<runId>, project-relative
    sliceId: null,      // the FLOW_PLAN slice this card is building
    sessionIds: [],     // Claude Code transcript ids for each run (pointers)
    briefPath: null,    // brief produced by the interactive Discuss duty
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
    // Monotonic coordination-lifecycle generation. This advances only when the
    // card changes coordination ownership state (list, run generation, or
    // abandonment), not for benign annotation edits. Durable cleanup sidecars
    // use it to distinguish a harmless later revision from a reopened successor.
    coordinationSeq: 0,
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
  const row = await boardStateClient().createCard(cardToStore({ ...card, position: positionHint(card) }));
  return mirrorCard(root, cardFromStore(row));
}

// Missing card throws (ENOENT-shaped), as reading a missing file did — every
// caller already funnels that through a try/catch.
export async function loadCard(root, id) {
  const row = await boardStateClient().getCard(id);
  if (!row) {
    const err = new Error(`kanban: no such card ${id}`);
    err.code = "ENOENT";
    throw err;
  }
  return cardFromStore(row, { compat: true });
}

function coordinationSeqForWrite(disk, candidate) {
  const current = Number.isSafeInteger(disk?.coordinationSeq) && disk.coordinationSeq >= 0
    ? disk.coordinationSeq
    : 0;
  if (!disk) return current;
  const changed =
    (disk.list || null) !== (candidate?.list || null) ||
    (disk.runId || null) !== (candidate?.runId || null) ||
    (Number.isInteger(disk.runSeq) ? disk.runSeq : null) !==
      (Number.isInteger(candidate?.runSeq) ? candidate.runSeq : null) ||
    (disk.leaseOwnerToken || null) !== (candidate?.leaseOwnerToken || null) ||
    (disk.abandoned === true) !== (candidate?.abandoned === true);
  return changed ? current + 1 : current;
}

// Read-immediately-before-write, then write the mutated card. Bumps rev.
export async function saveCard(root, card, at = new Date().toISOString()) {
  // saveCard is primarily a setup/test helper, but it must preserve the same
  // lifecycle-generation semantics as the production CAS path below. It carries
  // no precondition of its own and, exactly as the write-through file store did,
  // it CREATES the card when it does not exist yet.
  const client = boardStateClient();
  const disk = cardFromStore(await client.getCard(card.id), { compat: true });
  const next = {
    ...card,
    coordinationSeq: coordinationSeqForWrite(disk, card),
    rev: (card.rev ?? 0) + 1,
    updated: at
  };
  const row = disk
    ? await client.patchCard(card.id, cardToStore(next), { ifMatchRev: disk.rev ?? 0 })
    : await client.createCard(cardToStore({ ...next, position: positionHint(next) }));
  return mirrorCard(root, cardFromStore(row));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_TIMEOUT_MS = Number(process.env.GARRISON_KANBAN_LOCK_TIMEOUT_MS || 5000);
const LOCK_STALE_MS = Number(process.env.GARRISON_KANBAN_LOCK_STALE_MS || 30000);

// Is a pid alive on THIS host? kill(pid,0) probes without signalling: ESRCH = gone,
// EPERM = alive-but-not-ours. (Single-machine, solo-dev deployment, so a pid is a
// reliable liveness token; a cross-host lock falls back to the age heuristic.)
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

// Generic cross-process exclusive lock around a critical section, keyed by a lock
// path. Each contender owns TWO unique files in `<lockPath>.tickets`: a short-lived
// bakery "choosing" ticket, then its numbered ownership ticket. Lamport's bakery
// ordering means simultaneous contenders deterministically choose one winner; the
// filename's unguessable generation means stale cleanup and finally-release remove
// ONLY the generation they observed. The elected ticket owner also holds a
// PID-prefixed legacy bridge at `lockPath` so an already-running pre-ticket writer
// participates during a rolling upgrade; new code removes that bridge only when
// its full PID+token record still matches.
//
// A pre-ticket implementation used `lockPath` itself. The elected ticket owner
// therefore reuses it only as the compatibility bridge described above.
const LOCK_CHOOSING_PREFIX = "choosing-";
const LOCK_TICKET_PREFIX = "ticket-";
const LOCK_RECORD_SUFFIX = ".json";

function lockTicketDir(lockPath) {
  return `${lockPath}.tickets`;
}

function lockToken() {
  return `${process.pid}-${ulid()}`;
}

function lockRecordName(prefix, token) {
  return `${prefix}${token}${LOCK_RECORD_SUFFIX}`;
}

function lockTokenFromName(name, prefix) {
  if (!name.startsWith(prefix) || !name.endsWith(LOCK_RECORD_SUFFIX)) return null;
  const token = name.slice(prefix.length, -LOCK_RECORD_SUFFIX.length);
  return /^[0-9]+-[0-9A-HJKMNP-TV-Z]{26}$/.test(token) ? token : null;
}

async function activeLockRecords(dir, prefix) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const active = [];
  for (const name of names) {
    const token = lockTokenFromName(name, prefix);
    if (!token) continue;
    const file = path.join(dir, name);
    let row = null;
    let stat = null;
    try {
      const [raw, currentStat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
      row = JSON.parse(raw);
      stat = currentStat;
    } catch {
      try { stat = await fs.stat(file); } catch { continue; }
    }
    const valid =
      row &&
      row.token === token &&
      Number.isInteger(row.pid) &&
      row.pid > 0 &&
      (prefix !== LOCK_TICKET_PREFIX || Number.isSafeInteger(row.number) && row.number > 0);
    if (valid && isPidAlive(row.pid)) {
      active.push(row);
      continue;
    }
    // A valid record whose owner is provably dead is abandoned immediately. A
    // torn/corrupt record gets the age fallback. `file` includes the unique token,
    // so even two delayed breakers can never target a successor generation.
    if (valid || stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      try {
        await fs.rm(file, { force: true });
        continue;
      } catch {
        active.push({ token, invalid: true });
        continue;
      }
    }
    // A fresh partially-written record is a blocker until it becomes readable or
    // stale. This closes the O_EXCL-create -> write visibility window fail-closed.
    active.push({ token, invalid: true });
  }
  return active;
}

async function legacyLockBlocks(lockPath) {
  let raw;
  let stat;
  try {
    [raw, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
  } catch {
    return false;
  }
  const owner = Number.parseInt(raw, 10);
  if (Number.isInteger(owner) && isPidAlive(owner)) return true;
  if (Number.isInteger(owner) || Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
    // The elected ticket owner may reuse this pathname only after this observed
    // legacy owner is provably dead/stale. Ticket generations remain separate.
    try {
      await fs.rm(lockPath, { force: true });
      return false;
    } catch {
      return true;
    }
  }
  return true;
}

function legacyBridgeRecord(token) {
  // The PID prefix keeps this readable by the pre-ticket implementation's
  // `parseInt(raw, 10)` owner probe; the token lets new code avoid removing a
  // legacy-path generation it no longer owns.
  return `${process.pid}:${token}`;
}

async function tryAcquireLegacyBridge(lockPath, token) {
  const record = legacyBridgeRecord(token);
  try {
    await fs.writeFile(lockPath, record, { flag: "wx" });
    return record;
  } catch (err) {
    if (err?.code === "EEXIST") return null;
    throw err;
  }
}

async function releaseLegacyBridge(lockPath, record) {
  if (!record) return;
  try {
    if ((await fs.readFile(lockPath, "utf8")) !== record) return;
    await fs.rm(lockPath, { force: true });
  } catch {
    // Missing/replaced bridge: this generation no longer owns the shared path.
  }
}

export async function withFileLock(lockPath, label, fn) {
  const dir = lockTicketDir(lockPath);
  await fs.mkdir(dir, { recursive: true });
  const token = lockToken();
  const choosingFile = path.join(dir, lockRecordName(LOCK_CHOOSING_PREFIX, token));
  const ticketFile = path.join(dir, lockRecordName(LOCK_TICKET_PREFIX, token));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let ticketCreated = false;
  let legacyBridge = null;
  try {
    await fs.writeFile(choosingFile, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
    const existing = await activeLockRecords(dir, LOCK_TICKET_PREFIX);
    const number = existing.reduce((max, row) => Number.isSafeInteger(row.number) ? Math.max(max, row.number) : max, 0) + 1;
    await fs.writeFile(ticketFile, JSON.stringify({ pid: process.pid, token, number }), { flag: "wx" });
    ticketCreated = true;
    await fs.rm(choosingFile, { force: true });

    for (;;) {
      const choosing = await activeLockRecords(dir, LOCK_CHOOSING_PREFIX);
      const tickets = await activeLockRecords(dir, LOCK_TICKET_PREFIX);
      const owner = tickets
        .filter((row) => Number.isSafeInteger(row.number))
        .sort((a, b) => a.number - b.number || a.token.localeCompare(b.token))[0];
      const ownTicketPresent = tickets.some((row) => row.token === token);
      const everyTicketReadable = tickets.every((row) => Number.isSafeInteger(row.number));
      if (choosing.length === 0 && everyTicketReadable && ownTicketPresent && owner?.token === token && !(await legacyLockBlocks(lockPath))) {
        // Hold the pre-ticket pathname too. An already-running old process only
        // understands this O_EXCL PID file; without the bridge it could enter
        // while this ticket owner was already inside the critical section.
        legacyBridge = await tryAcquireLegacyBridge(lockPath, token);
        if (legacyBridge) return await fn();
      }
      if (Date.now() > deadline) throw new Error(`kanban: ${label} lock timeout after ${LOCK_TIMEOUT_MS}ms`);
      await sleep(10 + Math.floor(Math.random() * 15)); // jittered backoff
    }
  } finally {
    await releaseLegacyBridge(lockPath, legacyBridge);
    // These paths include this acquisition's unique generation. If a stale breaker
    // already removed either one, force is a no-op; it can never name a successor.
    await fs.rm(choosingFile, { force: true }).catch(() => {});
    if (ticketCreated) await fs.rm(ticketFile, { force: true }).catch(() => {});
  }
}

// ── what the store's CAS replaced, and what it did not ───────────────
// The store's rev CAS is now the cross-node guarantee for a single card's
// read→mutate→write, and no-resurrection is structural (a PATCH never upserts).
// That is strictly stronger than a file lock, which cannot mean anything on
// another machine.
//
// It is NOT, however, a substitute for every one of these locks, because a
// service transaction is per REQUEST and two of them span more than one card:
//
//   * withCardLock still serialises NODE-LOCAL lifecycle edges. coordination.mjs
//     reads the BLOCKER and writes the WAITER inside one section, and the board
//     server orders a save against a delete; neither is one request, so the CAS
//     cannot cover it. The lock is only ever taken by processes on this box, so
//     its pid-liveness probe is sound where it is used.
//   * withCardOrderLock still serialises the position ALLOCATOR (below): the
//     caller picks the float, and the store honours the number it is handed.
//
// withBoardLock is the one whose job did move: the board layout is a single
// document with its own rev, so saveBoardCAS's precondition is the critical
// section and re-reads on conflict.
export async function withCardLock(root, id, fn) {
  // The lock MUST live outside cards/<id>. Delete removes that whole directory;
  // when the lock lived inside it, a delete could unlink an acquired lock and a
  // late CAS writer could then recreate the card from its stale in-memory copy.
  // A stable external lock serializes every lifecycle edge (save/delete/reopen)
  // without creating the card directory as a side effect of merely locking it.
  return withFileLock(path.join(root, ".card-locks", `${id}.lock`), `card ${id}`, fn);
}

export async function withBoardLock(root, fn) {
  return fn();
}

// The ORDER lock is NOT a pass-through, because its job did not move. Choosing a
// new top position still happens in the CALLER: it reads every card in the
// destination list and picks a float below the current top, then hands the store
// an explicit number the store must honour verbatim. Two concurrent allocators
// would otherwise read the same top and pick the same position. (Node-local
// only; the cross-node form of this is a lease, which is not batch-one work.)
export async function withCardOrderLock(root, fn) {
  return withFileLock(path.join(root, ".card-order.lock"), "card order", fn);
}

// Compare-and-swap whole-board save. `mutate` receives the fresh board and
// returns { board } (or { error } to abort). On rev mismatch returns
// { ok:false, conflict:true, rev }. Bumps board.rev on success.
//
// TWO revs are in play and they are not the same thing: `board.rev` is the
// caller-visible CAS this contract has always exposed, and the config document's
// own rev is the service-side precondition. Losing the document race means
// another writer landed between the read and the write, so re-read and redo —
// which is what the board lock used to make impossible.
export async function saveBoardCAS(root, expectedRev, mutate) {
  const client = boardStateClient();
  let lastRev = 0;
  for (let attempt = 0; attempt < LOCKED_WRITE_TRIES; attempt += 1) {
    const doc = await client.getConfig(BOARD_NAMESPACE, BOARD_SCOPE);
    const stored = doc?.body ?? null;
    if (!stored || typeof stored !== "object") throw missingBoardError();
    // Migrate in memory; this very write persists it. Calling loadBoard here
    // would persist the migration separately and invalidate the doc rev we just
    // read, turning every migrating board write into a self-inflicted conflict.
    const board = (stored.version || 0) < BOARD_VERSION ? migrateBoard(stored) : stored;
    const currentRev = Number.isInteger(board.rev) ? board.rev : 0;
    lastRev = currentRev;
    if (Number.isInteger(expectedRev) && expectedRev !== currentRev) {
      return { ok: false, conflict: true, rev: currentRev };
    }
    const result = mutate(board);
    if (result && result.error) return { ok: false, error: result.error };
    const nextBoard = result.board;
    nextBoard.rev = currentRev + 1;
    try {
      await client.putConfig(BOARD_NAMESPACE, BOARD_SCOPE, nextBoard, { ifMatchRev: doc?.rev ?? 0 });
    } catch (err) {
      if (isStatus(err, 409)) continue;
      throw err;
    }
    return { ok: true, board: nextBoard, list: result.list, rev: nextBoard.rev };
  }
  return { ok: false, conflict: true, rev: lastRev };
}

// Compare-and-swap save: only write when the on-disk rev still matches what the
// caller last read (`expectedRev`), so a concurrent tick or a manual edit cannot be
// silently overwritten (the lost-update class the temp+rename atomic write does NOT
// prevent). The read-compare-write runs inside a per-card O_EXCL lock, so the
// check-and-set is atomic across processes — two concurrent ticks cannot both observe
// the same rev and both succeed (no double-acquire, no double-mint of runId).
// Returns { ok, conflict?, deleted?, precondition?, card }. `hooks` provides the
// narrow transaction seam used by lifecycle-sensitive callers:
//   beforeWrite({disk,next}) — runs only AFTER existence + rev validation while
//     the card lock is held; returning {ok:false,...} aborts without a card write.
//   afterWrite({disk,next,prepared}) — runs after the atomic card write, still
//     under the same lock (closure cleanup cannot race a reopen/delete).
// A post-commit hook failure is reported as `postCommitError` but never turns a
// committed card write into a false CAS failure.
// The Done-invariant verdict for a card entering `done`. Scoped to
// CONVERSATION-linked cards on purpose: their terminal handoff is the durable
// gate record (validator rule 10 + the launcher's flow policy are the other
// two layers). A card with no conversation — hand-managed, personal, or a
// pre-Conversations legacy card — owes nothing at this door; its gates lived
// in the retired engine transitions and freezing history is the migration's
// job, not this write's.
function doneEvidenceVerdict(card) {
  try {
    if (!card.conversationId) return { ok: true };
    const store = openConversation(card.conversationId, { role: "board" });
    const last = store.lastHandoffs(1)[0]?.handoff ?? null;
    if (!last) return { ok: false, reason: "conversation has no handoff" };
    if (last.status !== "complete") return { ok: false, reason: `terminal handoff status is ${last.status}` };
    const resolvable = (last.evidenceRefs ?? []).some((ev) => {
      if (ev?.kind !== "gate" && ev?.kind !== "run" && ev?.kind !== "file") return false;
      try {
        return readFileSync(ev.ref).length > 0;
      } catch {
        return false;
      }
    });
    return resolvable ? { ok: true } : { ok: false, reason: "no resolvable gate/run/file evidence in the terminal handoff" };
  } catch (err) {
    return { ok: false, reason: `evidence check failed: ${err?.message}` };
  }
}

// Best-effort conversation-ledger append from the board process. The ledger
// must never fail a card write. Exported: the server's materialization door
// writes card-materialized through the same seam.
export function appendConversationEvent(card, evt) {
  try {
    if (!card?.conversationId) return;
    openConversation(card.conversationId, { role: "board" }).append(evt);
  } catch {
    /* fail-open */
  }
}

async function writeCardWithHooks(root, { id, card = null, expectedRev = null, mutate = null, at, hooks = {} }) {
  // Snapshot the terminal edge while the CAS owns the authoritative before/after
  // pair, then perform the neutral outbox I/O only after the write commits.
  // Vault/provider work is never done by this module at all.
  let personalCompletionEdge = null;
  let doneHandoffEdge = null;
  const client = boardStateClient();
  // A `mutate` caller is a recovery path: it must see the authoritative card and
  // its write must land, which is what holding the lifecycle lock across the
  // read→mutate→write used to guarantee. Losing the service CAS therefore means
  // re-read and re-run the mutator. A `card` + `expectedRev` caller owns its own
  // precondition, so a conflict is REPORTED, never retried.
  const attempts = typeof mutate === "function" ? LOCKED_WRITE_TRIES : 1;
  const result = await withCardLock(root, id, async () => {
    let outcome = { ok: false, conflict: true, card: null };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      personalCompletionEdge = null;
      doneHandoffEdge = null;
      let disk = null;
      try {
        disk = await loadCard(root, id);
      } catch {
        disk = null;
      }
      // The card is GONE — it was deleted while this writer held its in-memory
      // copy. Writing would RESURRECT it, and the old code did exactly that: the
      // missing-disk case skipped the rev check ("first write of a brand-new card")
      // and wrote anyway. Observed live — a deleted card reappeared, parked, a minute
      // later when the run that was still in flight committed its result. The store
      // now refuses structurally too (a PATCH never upserts), so this is belt and
      // braces rather than the only guard.
      //
      // saveCardCAS never legitimately CREATES: createCard writes the first version,
      // and every other caller is updating a card it just read. So a missing card is
      // always a delete, and always a refusal.
      if (!disk) {
        return { ok: false, deleted: true, card: null };
      }
      if (typeof mutate !== "function" && (disk.rev ?? 0) !== expectedRev) {
        return { ok: false, conflict: true, card: disk };
      }
      const candidate = typeof mutate === "function" ? await mutate(disk) : card;
      if (!candidate) return { ok: false, skipped: true, card: disk };
      // list ⟷ status coherence runs on the BODY at the one choke point, so
      // promoted columns re-derived from body_json agree by construction.
      const next = {
        ...coherentCardState(candidate),
        coordinationSeq: coordinationSeqForWrite(disk, candidate),
        rev: (disk.rev ?? 0) + 1,
        updated: at
      };
      // The Done invariant (Conversations): a card that RAN owes evidence.
      // A conversation card owes a terminal handoff whose gate/run evidence
      // still resolves; a legacy run card owes <runDir>/evidence/evidence.md.
      // A human override passes but is RECORDED as unproven — never as a pass.
      if (next.list === "done" && (disk?.list ?? null) !== "done") {
        const verdict = doneEvidenceVerdict(next);
        if (!verdict.ok) {
          const override = next.completionOverride && typeof next.completionOverride.reason === "string" && next.completionOverride.reason.trim();
          if (!override) {
            return { ok: false, precondition: true, detail: { ok: false, code: "evidence-required", reason: verdict.reason }, card: disk };
          }
          appendConversationEvent(next, {
            kind: "card-completed-unproven",
            payload: { cardId: next.id, reason: next.completionOverride.reason, missing: verdict.reason }
          });
        }
      }
      let prepared = null;
      if (typeof hooks.beforeWrite === "function") {
        prepared = await hooks.beforeWrite({ disk, next });
        if (prepared && prepared.ok === false) {
          return { ok: false, precondition: true, detail: prepared, card: disk };
        }
      }
      // A beforeWrite hook may enrich the candidate. Recompute from the final
      // candidate so a future hook that changes a coordination identity field
      // cannot accidentally preserve the old epoch. (The store applies the same
      // value as a monotonic FLOOR, so a stale client can never rewind it.)
      next.coordinationSeq = coordinationSeqForWrite(disk, next);
      // A card claimed under a lease records the FENCE it was claimed with. Every
      // write from that claim carries it, so a holder that stalled past its lease
      // and woke up still holding the old card is refused — which a TTL alone
      // cannot do. A card with no claim carries no fence and no precondition.
      const fence = Number.isFinite(Number(next.leaseFence)) ? Number(next.leaseFence) : undefined;
      let written;
      try {
        written = cardFromStore(await client.patchCard(id, cardToStore(next), {
          ifMatchRev: disk.rev ?? 0,
          ...(fence !== undefined ? { fence } : {})
        }));
      } catch (err) {
        if (isStatus(err, 404)) return { ok: false, deleted: true, card: null };
        if (isStatus(err, 409) && err.body?.error === "fenced") {
          // Reported as a conflict so every existing caller's !ok branch still
          // does the right thing, and flagged so a caller that cares can say why.
          return { ok: false, conflict: true, fenced: true, card: disk };
        }
        if (isStatus(err, 409) && err.body?.error === "conflict") {
          // The 409 carries the CURRENT card, so the caller can merge without a
          // second round trip — and a retrying mutator re-reads it next pass.
          outcome = { ok: false, conflict: true, card: cardFromStore(err.body?.card, { compat: true }) ?? disk };
          continue;
        }
        throw err;
      }
      await mirrorCard(root, written);
      if (isPersonalDoneTransition(disk, written)) personalCompletionEdge = { prev: disk, next: written };
      if (written.list === "done" && (disk?.list ?? null) !== "done") {
        doneHandoffEdge = { prev: disk, next: written, summary: hooks.terminalSummary ?? null };
      }
      // Feedback to the originating channel on a terminal transition (done /
      // needs-attention). saveCardCAS is the one write path every mover uses
      // (engine, server PATCH, batch), so the edge fires exactly once per
      // outcome. Fire-and-forget — never delays or fails the write.
      // S3a lifecycle router: on the terminal edge (into done / needs-attention) route
      // a finished | blocked | failed event — appends to the origin's durable event log
      // for ALL transports, and posts the (legacy) web text to the originating thread.
      routeTerminalTransition(root, disk, written, { summary: hooks.terminalSummary });
      // Conversations: a state change on a conversation-linked card is a ledger
      // event, written by the SERVER at the one choke point — actor attribution
      // comes from the door (launcher | human | schedule-sweep | steering), and
      // an "unknown" in the metrics is a real finding, never defaulted to human.
      if (written.conversationId && ((disk?.list ?? null) !== written.list || (disk?.status ?? null) !== written.status)) {
        appendConversationEvent(written, {
          kind: "card-state-changed",
          payload: {
            cardId: written.id,
            from: { list: disk?.list ?? null, status: disk?.status ?? null },
            to: { list: written.list, status: written.status },
            by: typeof hooks.actor === "string" && hooks.actor ? hooks.actor : "unknown"
          }
        });
      }
      // The Done handoff is scheduled only after this loop returns. If it were
      // queued here, its callback could run before processCard writes its final
      // duty-summary.
      // S3c: a card reaching a terminal list strands any unapplied revisit directive
      // (the boundary guard early-returns before it) — clear it so the chip resolves and
      // it can never fire on a reopened card. No-op when there is no pending directive.
      if ((written.list === "done" || written.list === "needs-attention") && (disk?.list ?? null) !== written.list) {
        markSteeringApplied(root, written.id, "obsolete-terminal");
      }
      let postCommitError = null;
      if (typeof hooks.afterWrite === "function") {
        try {
          await hooks.afterWrite({ disk, next: written, prepared });
        } catch (err) {
          postCommitError = err;
        }
      }
      outcome = { ok: true, card: written, ...(postCommitError ? { postCommitError } : {}) };
      break;
    }
    return outcome;
  });

  if (!result?.ok) return result;
  // Register the handoff first and personal packet second. Both are deferred,
  // fail-open side effects outside the lifecycle lock; the engine continuation
  // therefore writes its final duty summary before either callback runs, and
  // FIFO immediate ordering lets the packet snapshot the finished handoff.
  if (doneHandoffEdge) {
    generateHandoffIfDone(root, doneHandoffEdge.prev, doneHandoffEdge.next);
    // Morning occurrences have an explicit dual-channel completion contract.
    // Load it lazily to keep the neutral board store independent of channel
    // implementations and outside the card lifecycle lock.
    void import("./morning-briefing.mjs")
      .then(({ scheduleMorningBriefDelivery }) => scheduleMorningBriefDelivery(
        root,
        doneHandoffEdge.next,
        { summary: doneHandoffEdge.summary }
      ))
      .catch((err) => console.error(`[kanban] Morning briefing delivery bootstrap failed: ${err?.message ?? err}`));
  }
  if (!personalCompletionEdge) return result;
  try {
    const memoryCapture = emitPersonalCompletionAfterDone(
      root,
      personalCompletionEdge.prev,
      personalCompletionEdge.next
    );
    return { ...result, ...(memoryCapture ? { memoryCapture } : {}) };
  } catch (err) {
    // Only synchronous scheduling/identity failures reach here; asynchronous
    // outbox I/O is fail-open inside the scheduler. The card is already
    // committed and startup reconciliation repairs either window.
    const message = String(err?.message || err).slice(0, 300);
    console.error(`[kanban] personal completion outbox enqueue failed for ${id}: ${message}`);
    return {
      ...result,
      memoryCapture: { status: "pending-reconciliation", error: message }
    };
  }
}

export async function saveCardCASWithHooks(root, card, expectedRev, at = new Date().toISOString(), hooks = {}) {
  return writeCardWithHooks(root, { id: card.id, card, expectedRev, at, hooks });
}

// Lock-scoped read -> mutate -> write for the rare recovery paths where a
// bounded optimistic CAS would defeat the recovery guarantee itself. The
// mutator sees the authoritative card while its lifecycle lock is held; the
// resulting write still goes through every normal revision, coordination,
// terminal-routing, handoff, and personal-memory hook above.
export async function updateCardLockedWithHooks(root, id, mutate, at = new Date().toISOString(), hooks = {}) {
  return writeCardWithHooks(root, { id, mutate, at, hooks });
}

export async function saveCardCAS(root, card, expectedRev, at = new Date().toISOString()) {
  return saveCardCASWithHooks(root, card, expectedRev, at);
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

// An unreachable store is a LOUD failure, not an empty board: swallowing it into
// "no cards" is precisely the stale read the mesh design refuses. An empty list
// from a reachable service is a real empty board.
export async function listCardIds(root = kanbanRoot()) {
  return (await boardStateClient().listCards()).map((row) => row.id);
}

export async function loadAllCards(root = kanbanRoot()) {
  // frozen:"0" unconditionally: done/needs-attention are REUSED list ids and
  // the frozen history (Conversations migration) must never reach the board,
  // its ticks, coordination scans or the weekly review. History readers ask
  // the state service for frozen:"1" explicitly.
  return (await boardStateClient().listCards({ frozen: "0" })).map((row) => cardFromStore(row, { compat: true }));
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
export async function deleteCard(root, id, expectedRev = null, hooks = {}) {
  return withCardLock(root, id, async () => {
    const dir = path.join(root, "cards", id);
    let disk;
    try {
      disk = await loadCard(root, id);
    } catch {
      return false; // idempotent missing-card no-op
    }
    if (Number.isInteger(expectedRev) && (disk.rev ?? 0) !== expectedRev) {
      return false; // caller must re-authorize against the fresh lifecycle state
    }
    try {
      // The store's delete is the commit: it tombstones the row under an If-Match,
      // so even a writer on another node either lost the CAS or is refused as a
      // resurrection.
      await boardStateClient().deleteCard(id, { ifMatchRev: disk.rev ?? 0 });
    } catch (err) {
      if (isStatus(err, 404) || isStatus(err, 409)) return false;
      throw err;
    }
    // The card's own node-local directory goes with it — the mirror, every
    // log-<n>.md, the brief and the attachments. Never the run dir or the shared
    // transcripts; the server's delete handler decides those.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (typeof hooks.afterDelete === "function") {
      try { await hooks.afterDelete({ disk }); }
      catch (err) {
        // Deletion is committed, but post-commit cleanup failures must remain
        // observable. Coordination cleanup journals its retry before throwing.
        console.error(`[kanban] post-delete cleanup failed for ${id}:`, err?.message || err);
      }
    }
    return true;
  });
}

export async function appendCardLog(root, id, n, text) {
  const file = path.join(root, "cards", id, `log-${n}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text.endsWith("\n") ? text : text + "\n", "utf8");
  // The LIVE stream stays node-local — writeCardLog rewrites the whole file on
  // every chunk, which is a write storm over HTTP. The DURABLE per-turn text is
  // mirrored into the card's docs so a peer can read the record. Best effort by
  // construction: a failed mirror is logged and NEVER fails the append.
  try {
    await boardStateClient().putCardDoc(id, `log-${n}.md`, await fs.readFile(file, "utf8"));
  } catch (err) {
    console.error(`[kanban] log mirror failed for ${id} log-${n}: ${err?.message ?? err}`);
  }
  return file;
}

// Latest durable per-card log ordinal. The on-card high-water mark closes the
// small acquire→first-write window for live Watch, while the disk scan keeps
// pre-logIndex cards (including already-reset cards with iterations:0) readable
// and ensures their next run appends after every existing log.
export function latestCardLogNumber(root, card) {
  const number = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0;
  let latest = Math.max(number(card?.logIndex), number(card?.iterations));
  try {
    for (const entry of readdirSync(path.join(root, "cards", card.id), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(/^log-(\d+)\.md$/);
      if (match) latest = Math.max(latest, number(Number(match[1])));
    }
  } catch {
    // A brand-new/legacy card directory may not exist yet; card fields suffice.
  }
  return latest;
}

// Overwrite a card's iteration log atomically (temp + rename). Used for the LIVE
// stream: the engine rewrites log-<n>.md with the operative's growing reply as
// chunks arrive (so Watch shows progress), then once more with the clean final
// reply. Atomic so a tailing Watch never reads a torn half-written file.
export async function writeCardLog(root, id, n, text) {
  const file = path.join(root, "cards", id, `log-${n}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // A PID-only temp name aliases every live-stream rewrite from this process.
  // When an onChunk write overlaps the authoritative final write, the first
  // rename consumes that shared temp path and the other writer fails ENOENT.
  // Give every attempt its own path; ordering is handled by the engine's
  // per-turn write queue, while this also makes direct concurrent callers safe.
  const tmp = `${file}.${process.pid}.${ulid()}.tmp`;
  try {
    await fs.writeFile(tmp, text.endsWith("\n") ? text : text + "\n", "utf8");
    await fs.rename(tmp, file);
  } finally {
    // rename removes the temp on success; force cleanup covers a failed write
    // or rename without obscuring the original error.
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  return file;
}
