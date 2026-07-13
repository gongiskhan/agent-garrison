// The board, DRIVEN BY the resolved model (GARRISON-UNIFY-V1 D15, slice S4a).
//
// D15 — "Kanban is the duty surface": the FIXED HUMAN columns are only Backlog,
// To-do, Done and Needs-attention. Every LEAF DUTY that appears in a selected
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

// The four fixed human columns (D15). Discuss is NOT a fixed human column — it
// only exists as a phase list when the composition declares a discuss duty.
export const HUMAN_HEAD = ["backlog", "todo"];
export const HUMAN_TAIL = ["done", "needs-attention"];

// The phases whose FAIL edge loops a card back to implement (they can send work
// backwards). This is phase SEMANTICS — which phases are gates — not a pipeline
// order (the order is always the card's resolved sequence). It matches the
// canonical develop pipeline's gate lists.
export const GATE_PHASES = new Set([
  "review",
  "adversarial-review",
  "test",
  "adversarial-test",
  "walkthrough",
  "validate"
]);

export function kanbanModelFile(root) {
  return path.join(
    root || process.env.GARRISON_KANBAN_DIR || path.join(os.homedir(), ".garrison", "kanban-loop"),
    "model.json"
  );
}

// Read the runner-projected resolved model, or null when absent/unreadable/empty.
// A model with no kanbanLists is treated as absent (nothing to derive from), so
// the caller falls back to the default pipeline.
export function loadResolvedModel(root) {
  try {
    const file = kanbanModelFile(root);
    if (!existsSync(file)) return null;
    const model = JSON.parse(readFileSync(file, "utf8"));
    if (!model || !Array.isArray(model.kanbanLists) || model.kanbanLists.length === 0) return null;
    return model;
  } catch {
    return null;
  }
}

// A generic phase-list config for a leaf-duty id that has no canonical template
// (e.g. a bespoke duty like `code` / `research` a composition declares). The
// caller (buildBoard) fills in id/order/validNext.
function genericAgentTemplate(id) {
  return {
    kind: "agent",
    trigger: "immediate",
    phase: id,
    executePrompt: `Run the ${id} phase for this card; write the ${id} phase's gate-status entry under the run directory before choosing the next list.`,
    routerPrompt: `When the ${id} phase is complete (or already satisfied), end with the next list id on its own final line.`
  };
}

// The structural fields buildBoard OWNS (recomputed from the model), never taken
// from a template: id, order and validNext are derived, so strip them so a
// template can only contribute BEHAVIOUR (prompts, trigger, gate flags).
function phaseConfigFromTemplate(template, id) {
  const base = template ? { ...template } : genericAgentTemplate(id);
  delete base.id;
  delete base.order;
  delete base.validNext;
  base.kind = base.kind || "agent";
  base.phase = base.phase || id;
  return base;
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

// The fail edge for a gate phase: loop back to implement when the card's sequence
// contains it, else the card's first phase (a gate with no implement upstream
// still has somewhere to send failed work).
function failEdgeFor(sequence) {
  return sequence.includes("implement") ? "implement" : sequence[0];
}

// The next list a card advances to from `currentPhase`, per ITS resolved
// sequence — the next leaf after the current one, or "done" when it is the last.
// THIS is the "goal hook" decider: which phase comes next is the card's sequence,
// never a hardcoded column order. Returns null when the card has no sequence, or
// is not currently on its sequence (caller falls back to the board's validNext).
export function nextListForCard(card, currentPhase, model = null) {
  const seq = resolveCardSequence(card, model);
  if (!seq) return null;
  const idx = seq.indexOf(currentPhase);
  if (idx < 0) return null;
  return idx + 1 < seq.length ? seq[idx + 1] : "done";
}

// The valid next-list ids for a card on `currentPhase`, per its resolved
// sequence: the forward step, plus the implement fail-edge for a gate phase.
// Returns null for a card with no usable sequence (→ legacy board validNext).
export function validNextForCard(card, currentPhase, model = null) {
  const seq = resolveCardSequence(card, model);
  if (!seq) return null;
  const idx = seq.indexOf(currentPhase);
  if (idx < 0) return null;
  const forward = idx + 1 < seq.length ? seq[idx + 1] : "done";
  if (GATE_PHASES.has(currentPhase)) {
    const fail = failEdgeFor(seq);
    if (fail && fail !== forward) return [forward, fail];
  }
  return [forward];
}

// Build a whole board from a resolved model: the fixed human head, the phase
// lists derived from `model.kanbanLists` (in that order), and the fixed human
// tail. Each phase list's BEHAVIOUR comes from `opts.templates[id]` (the caller
// passes the canonical per-phase configs) or a generic template; its ORDER and
// validNext are derived from the model — the forward step is the next phase in
// the union, plus an implement fail-edge for gate phases. Pure: no fs, no I/O.
export function buildBoard(model, opts = {}) {
  const templates = opts.templates || {};
  const phases = Array.isArray(model?.kanbanLists) ? model.kanbanLists.filter((x) => typeof x === "string") : [];
  const first = phases[0] || "done";
  const hasImplement = phases.includes("implement");
  const failEdge = hasImplement ? "implement" : first;

  const lists = [];
  let order = 0;
  const push = (list) => lists.push({ ...list, order: order++ });

  push({
    id: "backlog",
    title: "Backlog",
    kind: "manual",
    trigger: "manual",
    onEnter: "infer-title-and-project",
    validNext: ["todo"]
  });
  push({
    id: "todo",
    title: "To Do",
    kind: "manual",
    trigger: "manual",
    validNext: [first]
  });

  phases.forEach((id, i) => {
    const forward = i + 1 < phases.length ? phases[i + 1] : "done";
    const validNext = GATE_PHASES.has(id) && failEdge && failEdge !== forward ? [forward, failEdge] : [forward];
    const cfg = phaseConfigFromTemplate(templates[id], id);
    push({ ...cfg, id, title: cfg.title || titleFor(id), validNext });
  });

  push({ id: "done", title: "Done", kind: "manual", trigger: "manual", terminal: true, validNext: [] });
  push({
    id: "needs-attention",
    title: "Needs attention",
    kind: "manual",
    trigger: "manual",
    notifyOnEntry: true,
    // The human touchpoint routes back to To-do, the first phase, and implement
    // (a re-run entry point) when the pipeline has one.
    validNext: hasImplement ? ["todo", first, "implement"] : ["todo", first]
  });

  return { version: 3, lists, projects: {} };
}

// Reconcile an EXISTING board's phase-list SET to the current resolved model
// (D15, S4a finding): rebuild the list STRUCTURE from the model — add lists for
// newly-selected duties, drop lists for deselected ones — while preserving the
// board's non-structural state (the `projects` map + `rev`). List MEMBERSHIP is
// derived by scanning card files (never stored on the board), so rebuilding
// board.json touches no card state; the caller separately relocates any card
// stranded on a removed list so nothing is lost. Returns
// { board, removed, added } where removed/added are the list ids that left/joined
// the board (used by the caller to move stranded cards + to log the reconcile).
// Pure: no fs, no I/O.
export function reconcileBoardLists(existingBoard, model, opts = {}) {
  const rebuilt = buildBoard(model, opts);
  const oldIds = new Set((existingBoard?.lists || []).map((l) => l.id));
  const newIds = new Set(rebuilt.lists.map((l) => l.id));
  const removed = [...oldIds].filter((id) => !newIds.has(id));
  const added = [...newIds].filter((id) => !oldIds.has(id));
  const board = {
    ...rebuilt,
    // Preserve the live board's project map + optimistic-concurrency rev; the human
    // columns + phase-list defs come fresh from the model (phase lists are engine-
    // owned, D16, so there is no user list config to preserve).
    projects: existingBoard?.projects && typeof existingBoard.projects === "object" ? existingBoard.projects : {},
    rev: Number.isInteger(existingBoard?.rev) ? existingBoard.rev : 0
  };
  return { board, removed, added };
}

// A human title for a derived phase list id ("adversarial-review" → "Adversarial
// Review"). Only used when a template omits a title.
function titleFor(id) {
  return String(id)
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
