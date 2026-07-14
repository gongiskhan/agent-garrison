// Project the composition's resolved model to the Kanban board (D15, slice S4a).
//
// The Kanban board runs as its own Node process (fittings/seed/kanban-loop) and
// cannot import the TypeScript Resolver. So at up() the runner computes the
// resolved model here and writes a small JSON the board reads
// (fittings/seed/kanban-loop/lib/resolved-model.mjs → loadResolvedModel):
//
//   { version, compositionId,
//     kanbanLists: string[],                              // the ordered phase-list set (deriveKanbanLists)
//     sequences: { [dutyId]: { [level]: string[] } } }    // each duty/level → its ordered leaf ids
//
// This is additive: the board falls back to its built-in default pipeline when
// the file is absent, and only a FRESH board seed reads it — an existing
// board.json is left untouched. A malformed duty graph writes an empty
// kanbanLists so the board keeps its default pipeline rather than a broken one.

import path from "node:path";
import { garrisonDir } from "./claude-home";
import { writeFileAtomic } from "./atomic-write";
import { resolveModel, resolveSequence } from "./resolver";
import type { CompositionV4 } from "./compositions";
import type { LibraryEntry } from "./types";

// One duty level's resolved execution cell: the muster cell (target id +
// effort) joined with the target's spec so .mjs consumers (the board, the
// gateway's applyDutyCells merge) need no second lookup. Leaf levels only —
// a composite (sequence) level has no cell of its own.
export interface KanbanDutyCell {
  target: string;
  effort: string | null;
  runtime: string | null;
  model: string | null;
  provider: string | null;
  type: string | null;
}

export interface KanbanResolvedModel {
  version: 2;
  compositionId: string;
  kanbanLists: string[];
  sequences: Record<string, Record<string, string[]>>;
  // duty -> level -> resolved cell (the duties->router repoint input).
  cells: Record<string, Record<string, KanbanDutyCell>>;
  // duty id -> context_hold (S1b): the duties that hold off the compact controller
  // until a duty boundary. Only truthy entries are projected. The engine reads
  // holds[card.list] (the current phase = leaf duty id) to hint contextHold.
  // Optional so a hand-built model (tests, older callers) stays valid; the board's
  // contextHoldFor treats an absent map as "no holds".
  holds?: Record<string, boolean>;
  // duty id -> gate (S3d D9b): the duties whose gate is `explicit` (the engine holds
  // the card on the duty for an explicit human go instead of auto-advancing). Only
  // explicit entries are projected; the board's dutyGateExplicit treats an absent map
  // as "no gates" (pass-through). Optional for the same hand-built-model reason as holds.
  gates?: Record<string, string>;
}

// Where the board reads its model from — mirror the board's own convention
// (GARRISON_KANBAN_DIR wins, else <garrison home>/kanban-loop).
export function kanbanModelPath(): string {
  const dir = process.env.GARRISON_KANBAN_DIR?.trim();
  return path.join(dir && dir.length > 0 ? dir : path.join(garrisonDir(), "kanban-loop"), "model.json");
}

// Compute the board's resolved model from the composition's duties + the selected
// fittings' duty provisions. Pure: builds the shape, does not touch disk.
export function computeKanbanResolvedModel(
  composition: Pick<CompositionV4, "id" | "duties" | "selectedDuties"> & Partial<Pick<CompositionV4, "targets">>,
  entries: Pick<LibraryEntry, "id" | "metadata">[]
): KanbanResolvedModel {
  const model = resolveModel({
    fittings: entries.map((entry) => ({ id: entry.id, metadata: entry.metadata })),
    compositionDuties: composition.duties,
    selectedDuties: composition.selectedDuties.length ? composition.selectedDuties : undefined
  });

  // A card carries a (duty, level); precompute every selected duty's ordered leaf
  // ids at every level so the board can look up sequences[duty][level] without the
  // Resolver. resolveSequence assumes a validated graph, so only expand when the
  // model has no errors (else the board keeps its default pipeline).
  const sequences: Record<string, Record<string, string[]>> = {};
  if (model.errors.length === 0) {
    for (const [id, duty] of Object.entries(model.duties)) {
      const perLevel: Record<string, string[]> = {};
      duty.levels.forEach((_level, index) => {
        const level = index + 1;
        try {
          perLevel[String(level)] = resolveSequence(id, level, model.duties).map((step) => step.duty);
        } catch {
          // A misuse (unknown ref surfacing at runtime) — skip this level rather
          // than fail the whole projection.
        }
      });
      sequences[id] = perLevel;
    }
  }

  // Per-duty per-level resolved cells (leaf levels only): the muster cell
  // joined with its target's spec. This is what repoints the router matrix at
  // the composition's duty ladders (applyDutyCells) — without it a muster duty
  // edit would be dead weight on the live routing path.
  const targetsById = new Map((composition.targets ?? []).map((t) => [t.id, t]));
  const cells: Record<string, Record<string, KanbanDutyCell>> = {};
  if (model.errors.length === 0) {
    for (const [id, duty] of Object.entries(model.duties)) {
      const perLevel: Record<string, KanbanDutyCell> = {};
      duty.levels.forEach((level, index) => {
        const target = level.cell?.target;
        if (!target) return;
        const spec = targetsById.get(target);
        const params = spec?.params ?? {};
        perLevel[String(index + 1)] = {
          target,
          effort: level.cell?.effort ?? null,
          runtime: spec?.runtime ?? null,
          model: spec?.model ?? null,
          provider: spec?.provider ?? null,
          type: typeof params.type === "string" ? params.type : null
        };
      });
      if (Object.keys(perLevel).length) cells[id] = perLevel;
    }
  }

  // Per-duty context_hold flags (S1b): project only the truthy ones so the board
  // reads holds[dutyId] === true. Independent of the error gate — a hold is a
  // single boolean off the merged duty spec, safe to project even when sequence
  // expansion is skipped.
  const holds: Record<string, boolean> = {};
  for (const [id, duty] of Object.entries(model.duties)) {
    if (duty.context_hold === true) holds[id] = true;
  }

  // Per-duty gate flags (S3d D9b): project only the `explicit` gates so the board
  // reads gates[dutyId] === "explicit". Same independent-of-the-error-gate treatment
  // as holds - a gate is a single flag off the merged duty spec.
  const gates: Record<string, string> = {};
  for (const [id, duty] of Object.entries(model.duties)) {
    if (duty.gate === "explicit") gates[id] = "explicit";
  }

  return {
    version: 2,
    compositionId: composition.id,
    kanbanLists: model.errors.length === 0 ? model.kanbanLists : [],
    sequences,
    cells,
    holds,
    gates
  };
}

// Compute + write the board's resolved model. Returns the written model. The
// caller wraps this best-effort so a projection failure never aborts up().
export async function writeKanbanResolvedModel(
  composition: Pick<CompositionV4, "id" | "duties" | "selectedDuties"> & Partial<Pick<CompositionV4, "targets">>,
  entries: Pick<LibraryEntry, "id" | "metadata">[]
): Promise<KanbanResolvedModel> {
  const model = computeKanbanResolvedModel(composition, entries);
  await writeFileAtomic(kanbanModelPath(), JSON.stringify(model, null, 2));
  return model;
}
