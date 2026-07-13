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

export interface KanbanResolvedModel {
  version: 1;
  compositionId: string;
  kanbanLists: string[];
  sequences: Record<string, Record<string, string[]>>;
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
  composition: Pick<CompositionV4, "id" | "duties" | "selectedDuties">,
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

  return {
    version: 1,
    compositionId: composition.id,
    kanbanLists: model.errors.length === 0 ? model.kanbanLists : [],
    sequences
  };
}

// Compute + write the board's resolved model. Returns the written model. The
// caller wraps this best-effort so a projection failure never aborts up().
export async function writeKanbanResolvedModel(
  composition: Pick<CompositionV4, "id" | "duties" | "selectedDuties">,
  entries: Pick<LibraryEntry, "id" | "metadata">[]
): Promise<KanbanResolvedModel> {
  const model = computeKanbanResolvedModel(composition, entries);
  await writeFileAtomic(kanbanModelPath(), JSON.stringify(model, null, 2));
  return model;
}
