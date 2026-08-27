// The board, DRIVEN BY the resolved model (GARRISON-UNIFY-V1 D15, slice S4a).
//
// D15 — "Kanban is the duty surface": the fixed system/head columns are Scheduled,
// Backlog and To-do, followed by one column per resolved leaf duty. Every LEAF DUTY that appears in a selected
// composite's resolved sequence (or stands alone) becomes a PHASE LIST. A card
// carries a (duty, level); its resolved sequence (resolver.resolveSequence)
// decides which phase lists it visits and in what order — it SKIPS every list
// not on its own sequence. Adding a duty adds its list; removing it removes the
// list. None of that order is hardcoded here: it is read from the resolved model
// the Resolver (src/lib/resolver.ts) computes and the runner projects to disk.
//
// The Resolver is TypeScript compose-time code; the board runs as its own Node
// process and cannot import it. So the runner writes the resolved model to
// ~/.garrison/kanban-loop/model.json at up() (kanban-model.ts), and this module
// reads it. The model file carries:
//   { version, kanbanLists: string[],                    // the ordered phase-list set (the union)
//     sequences: { [dutyId]: { [level]: string[] } } }   // each duty/level → its ordered leaf ids
// A card's flow is `sequences[card.duty][card.level]` (also cached on the card as
// `card.sequence`). When the file is ABSENT the board falls back to its built-in
// default pipeline (kanban.mjs defaultSeedBoard) so existing behaviour, and the
// whole existing test suite, are untouched — the resolved-model path is opt-in
// via the presence of model.json + a card carrying a duty/level.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";

// The SIX fixed board lists (Conversations, 2026-08-26; Backlog restored
// 2026-08-27 as a human shelf). Lists ARE the card states — Backlog, To do,
// Running, Needs input, Scheduled, Done — and nothing else.
// Duty lists, Discuss, Archived and the phase spine are gone: a card's
// current duty is a FIELD rendered as a chip, sequencing is the stretch
// handoff's job, and history is frozen cards behind the History view.
export const BOARD_LISTS = ["backlog", "todo", "running", "needs-attention", "scheduled", "done"];

export function kanbanModelFile(root) {
  const garrisonHome = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  return path.join(
    root || process.env.GARRISON_KANBAN_DIR || path.join(garrisonHome, "kanban-loop"),
    "model.json"
  );
}

// Read the runner-projected resolved model, or null when absent/unreadable/empty.
// A model with no kanbanLists is treated as absent (nothing to derive from), so
// the caller falls back to the default pipeline.
export function loadResolvedModel(root, expectedCompositionId = null) {
  try {
    const file = kanbanModelFile(root);
    if (!existsSync(file)) return null;
    const model = JSON.parse(readFileSync(file, "utf8"));
    // v1 is the original flow-only projection; v2 adds the Dispatcher vocabulary
    // and exact execution steps; v3 adds the model ladders (a v2 file simply has
    // no dutyLadder, and every ladder consumer falls back to the synthetic
    // one-rung form). Unknown future/invalid versions fail closed so a stale board
    // never guesses at a target shape it does not understand.
    if (model?.version !== 1 && model?.version !== 2 && model?.version !== 3) return null;
    if (!model || !Array.isArray(model.kanbanLists) || model.kanbanLists.length === 0) return null;
    // model.json is machine-global. A gateway must name its active composition
    // and reject a projection left by a previous one; board-only callers omit
    // the guard and rely on runner cleanup when falling back to the default flow.
    if (
      typeof expectedCompositionId === "string" &&
      expectedCompositionId.length > 0 &&
      model.compositionId !== expectedCompositionId
    ) {
      return null;
    }
    return model;
  } catch {
    return null;
  }
}

// True for the v2 execution manifest and its v3 superset (v3 only ADDS ladders).
// A v1 model still drives board flow, but it deliberately cannot claim exact
// runtime/model/effort routing.
export function hasExecutionModel(model) {
  return !!(
    model &&
    (model.version === 2 || model.version === 3) &&
    model.duties && typeof model.duties === "object" &&
    Array.isArray(model.selectedDuties) &&
    model.steps && typeof model.steps === "object"
  );
}

// The narrow shape dispatch-core consumes. Keep the projection object immutable:
// callers may cache the loaded manifest across turns.
export function dispatcherModelFrom(model) {
  if (!hasExecutionModel(model)) return null;
  return { duties: model.duties, selectedDuties: model.selectedDuties.slice() };
}

// Resolve the exact leaf execution step for a top-level (duty, level) and current
// phase. `stepIndex` is preferred when supplied (future-proofs repeated phase ids);
// otherwise the first matching phase is used, matching the board's current
// indexOf-based sequence semantics. Null means the manifest cannot honor the
// request and the gateway must fail loud rather than silently use a legacy cell.
export function resolveExecutionStep({ duty, level = 1, phase = null, stepIndex = null } = {}, model = null) {
  if (!hasExecutionModel(model) || typeof duty !== "string" || !duty) return null;
  const perDuty = model.steps[duty];
  const steps = perDuty && perDuty[String(level)];
  if (!Array.isArray(steps) || steps.length === 0) return null;
  if (Number.isInteger(stepIndex) && stepIndex >= 0 && stepIndex < steps.length) {
    const indexed = steps[stepIndex];
    if (!phase || indexed?.duty === phase) return indexed ?? null;
  }
  if (!phase) return steps[0] ?? null;
  return steps.find((step) => step?.duty === phase) ?? null;
}

// Convert a projected step into the route.target shape the gateway's existing
// runtime executors consume. Params are target-owned execution knobs; identity
// and per-cell effort are overwritten from the authoritative flattened fields.
export function executionRouteFor(input, model = null) {
  const step = resolveExecutionStep(input, model);
  if (!step || !step.targetId || !step.runtime || !step.model) return null;
  const params = step.params && typeof step.params === "object" ? step.params : {};
  const inferredType = ["codex", "gemini", "opencode"].includes(step.runtime)
    ? "secondary"
    : "runtime-target";
  const target = {
    ...params,
    id: step.targetId,
    type: typeof params.type === "string" ? params.type : inferredType,
    runtime: step.runtime,
    provider: step.provider ?? undefined,
    model: step.model,
    effort: step.effort ?? null
  };
  return {
    targetId: step.targetId,
    target,
    duty: input.duty,
    level: input.level ?? 1,
    phase: input.phase ?? step.duty,
    step,
    skill: step.skill ?? null
  };
}

// ── model ladders (Conversations A2) ───────────────────────────────────────
// A LADDER is the ordered set of model tiers a duty may climb (floor -> top); a
// LEVEL is depth of work. They are independent: the rung picks the target, the
// level's cell still owns effort. The runner projects `dutyLadder[dutyId]` for
// every selected duty (v3); these two helpers are the only readers a stretch
// launcher needs, and both are pure.

// The duty's ladder, or a SYNTHETIC one-rung ladder built from its level-1 cell.
// The synthetic form is what makes a v2 projection (no dutyLadder at all) and a
// duty that declares no ladder lines behave identically to today: one rung, no
// escalation room. Null only when the duty has no resolvable target anywhere.
export function ladderFor(model, dutyId) {
  if (!model || typeof dutyId !== "string" || !dutyId) return null;
  const projected = model.dutyLadder && typeof model.dutyLadder === "object" ? model.dutyLadder[dutyId] : null;
  if (projected && Array.isArray(projected.rungs) && projected.rungs.length > 0) return projected;

  const cell = model.cells && typeof model.cells === "object" ? model.cells[dutyId]?.["1"] : null;
  const target = cell && typeof cell.target === "string" ? cell.target : null;
  if (!target) return null;
  const spec = Array.isArray(model.targets) ? model.targets.find((t) => t && t.id === target) : null;
  return {
    ladder: null,
    rungs: [
      {
        id: target,
        target,
        runtime: spec?.runtime ?? cell.runtime ?? null,
        provider: spec?.provider ?? cell.provider ?? null,
        model: spec?.model ?? cell.model ?? null,
        params: { ...(spec?.params ?? {}) }
      }
    ],
    defaultIndex: 0,
    ceilingIndex: 0
  };
}

// The resolved rung at `index` on a duty's ladder — {id, target, runtime,
// provider, model, params}. The index is CLAMPED into the ladder rather than
// returning null: an escalation that walks off the top must land on the top
// rung, never on nothing. A non-integer index falls back to the duty's default
// rung. Null only when the duty has no ladder at all.
export function rungTarget(model, dutyId, index) {
  const ladder = ladderFor(model, dutyId);
  if (!ladder) return null;
  const wanted = Number.isInteger(index) ? index : ladder.defaultIndex;
  const clamped = Math.min(Math.max(wanted, 0), ladder.rungs.length - 1);
  return ladder.rungs[clamped] ?? null;
}

// Fields that define how the engine interprets a list. These are projected from
// the resolved model / canonical phase template on every reconcile; retaining a
// stale value here can silently weaken a gate (for example an old Test list that
// predates requiresEvidenceOn). Everything else is treated as operator config
// and kept when the list already exists. In particular, title, trigger,
// beatCron, executePrompt and routerPrompt are editable in the board UI.
const ENGINE_OWNED_LIST_FIELDS = new Set([
  "id",
  "order",
  "kind",
  "phase",
  "validNext",
  "interactive",
  "surface",
  "terminal",
  "onEnter",
  "notifyOnEntry",
  "system",
  "batched",
  "requiresEvidence",
  "requiresEvidenceOn",
  "requiredEvidenceFile"
]);

function isLegacyDefaultPrompt(migrations, listId, field, value) {
  const candidates = migrations?.[listId]?.[field];
  return Array.isArray(candidates) && candidates.includes(value);
}

// Merge a rebuilt engine list with an existing on-disk list. Structural and
// enforcement fields always come from the rebuilt definition (and are removed
// when the new definition omits them); operator-owned fields survive. Prompt
// defaults are intentionally NOT refreshed wholesale: an exact, explicitly
// enumerated historical default may migrate, while any genuine edit is kept.
function reconcileList(existing, rebuilt, legacyDefaultPrompts) {
  if (!existing) return rebuilt;

  const merged = { ...existing };
  for (const field of ENGINE_OWNED_LIST_FIELDS) delete merged[field];

  for (const [field, value] of Object.entries(rebuilt)) {
    if (ENGINE_OWNED_LIST_FIELDS.has(field) || !Object.hasOwn(existing, field)) {
      merged[field] = value;
    }
  }

  for (const field of ["executePrompt", "routerPrompt"]) {
    if (
      Object.hasOwn(existing, field) &&
      Object.hasOwn(rebuilt, field) &&
      isLegacyDefaultPrompt(legacyDefaultPrompts, rebuilt.id, field, existing[field])
    ) {
      merged[field] = rebuilt[field];
    }
  }

  return merged;
}

// The card's resolved sequence — the ordered leaf-duty ids it visits. Prefer the
// value cached on the card (`card.sequence`, written when the duty was assigned);
// otherwise look it up from the model's precomputed `sequences[duty][level]`.
// Returns null when the card carries no resolvable sequence (a legacy card with
// no duty/level) — the caller then uses the board's static validNext.
export function resolveCardSequence(card, model = null) {
  if (Array.isArray(card?.sequence) && card.sequence.length) return card.sequence;
  const duty = card?.duty;
  if (!duty || !model || !model.sequences) return null;
  const level = card.level ?? 1;
  const perLevel = model.sequences[duty];
  const seq = perLevel && perLevel[String(level)];
  return Array.isArray(seq) && seq.length ? seq : null;
}

// Whether a phase/duty holds off the compact controller (S1b). The projected
// model carries holds[dutyId] === true for each duty declaring context_hold; a
// card's CURRENT phase (card.list) IS a leaf-duty id (D15), so the engine passes
// contextHoldFor(model, card.list) as the dispatch hint. Absent/false -> no hold.
export function contextHoldFor(model, dutyId) {
  if (!model || !model.holds || typeof model.holds !== "object") return false;
  return model.holds[dutyId] === true;
}

// Whether a duty carries the `explicit` gate (S3d D9b): the projected model carries
// gates[dutyId] === "explicit" for each duty declaring gate: explicit. The engine
// reads dutyGateExplicit(model, card.list) on the discuss duty to decide whether to
// HOLD the card (explicit) or PASS THROUGH to plan (default). Absent map / value -> false.
export function dutyGateExplicit(model, dutyId) {
  if (!model || !model.gates || typeof model.gates !== "object") return false;
  return model.gates[dutyId] === "explicit";
}

// nextListForCard / validNextForCard / the GATE_PHASES fail-edge machinery are
// GONE (Conversations): sequencing lives in the stretch handoff, and a list's
// validNext is a human move-affordance only. resolveCardSequence survives above
// because the gateway's inbound dispatch consult and garrison-control still
// read a card's duty sequence.

// Build the board: the SIX fixed state columns, in order. The resolved model
// no longer shapes the list set at all (duty lists are gone — the launcher
// reads duties/ladders from the model directly); the `model` parameter stays
// for caller compatibility and future per-list config. Pure: no fs, no I/O.
//
// validNext is the HUMAN MOVE-AFFORDANCE ONLY (the Move menu / drag targets).
// It is NOT a routing edge and never dispatches anything — sequencing lives in
// the stretch handoff's nextSteps.next. Do not re-derive a pipeline from it.
export function buildBoard(_model = null, _opts = {}) {
  const lists = [];
  let order = 0;
  const push = (list) => lists.push({ ...list, order: order++ });

  // Backlog is purely human-managed shelf space — work parked for later. The
  // engine never picks from it, no trigger fires on entry, and nothing counts
  // it as in-flight; To do is the "immediate work" list it feeds.
  push({
    id: "backlog",
    title: "Backlog",
    kind: "manual",
    trigger: "manual",
    validNext: ["todo", "done"]
  });
  push({
    id: "todo",
    title: "To do",
    kind: "manual",
    trigger: "manual",
    onEnter: "infer-title-and-project",
    validNext: ["backlog", "done"]
  });
  // `kind: "system"` is NEW and ON PURPOSE: every legacy `kind === "agent"`
  // branch anywhere is FALSE for it, so a stray dispatch path cannot fire on
  // Running by accident, and card creation here stays launcher-only. A human
  // cannot MOVE a card into Running (you cannot start a stretch by dragging);
  // the edges below are the rescue exits for a wedged card.
  push({
    id: "running",
    title: "Running",
    kind: "system",
    trigger: "launcher",
    system: true,
    validNext: ["needs-attention", "todo"]
  });
  push({
    id: "needs-attention",
    title: "Needs input",
    kind: "manual",
    trigger: "manual",
    notifyOnEntry: true,
    validNext: ["todo", "backlog", "done"]
  });
  push({
    id: "scheduled",
    title: "Scheduled",
    kind: "scheduled",
    trigger: "scheduler-beat",
    system: true,
    validNext: ["todo"]
  });
  push({ id: "done", title: "Done", kind: "manual", trigger: "manual", terminal: true, validNext: ["todo", "backlog"] });

  return { version: 11, lists, projects: {} };
}

// Reconcile an EXISTING board's phase-list SET to the current resolved model
// (D15, S4a finding): rebuild the list STRUCTURE from the model — add lists for
// newly-selected duties, drop lists for deselected ones — while preserving the
// board's non-structural state (the `projects` map + `rev`). List MEMBERSHIP is
// derived by scanning card files (never stored on the board), so rebuilding
// board.json touches no card state; the caller separately relocates any card
// stranded on a removed list so nothing is lost. Returns
// { board, removed, added, updated } where removed/added are the list ids that
// left/joined the board and updated names same-id definitions whose engine-owned
// projection or recognized default prompt changed (used by setup to persist even
// when the list set itself stayed constant).
// Pure: no fs, no I/O.
export function reconcileBoardLists(existingBoard, model = null, opts = {}) {
  const rebuilt = buildBoard(model, opts);
  const existingLists = Array.isArray(existingBoard?.lists) ? existingBoard.lists : [];
  const existingById = new Map(existingLists.map((list) => [list.id, list]));
  const oldIds = new Set(existingLists.map((l) => l.id));
  const newIds = new Set(rebuilt.lists.map((l) => l.id));
  // No user-created lists under the five-state board (the Add-list affordance
  // is gone): everything outside the five is `removed`, and the caller
  // relocates any live card off a removed list so nothing is lost.
  const removed = [...oldIds].filter((id) => !newIds.has(id));
  const added = [...newIds].filter((id) => !oldIds.has(id));
  const reconciled = rebuilt.lists.map((list) =>
    reconcileList(existingById.get(list.id), list, opts.legacyDefaultPrompts)
  );
  const updated = reconciled
    .filter((list) => oldIds.has(list.id) && !isDeepStrictEqual(existingById.get(list.id), list))
    .map((list) => list.id);
  const board = {
    ...rebuilt,
    lists: reconciled,
    // Preserve the live board's project map + optimistic-concurrency rev. The
    // engine-owned portion of each list is refreshed above.
    projects: existingBoard?.projects && typeof existingBoard.projects === "object" ? existingBoard.projects : {},
    rev: Number.isInteger(existingBoard?.rev) ? existingBoard.rev : 0,
    ...(existingBoard?.conversationsMigrated ? { conversationsMigrated: existingBoard.conversationsMigrated } : {})
  };
  return { board, removed, added, updated };
}
