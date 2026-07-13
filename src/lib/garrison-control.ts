// The garrison-control read tool (GARRISON-UNIFY-V1 D15, slice S4b).
//
// D15 acceptance 9: "All three doors (web-channel direct, Kanban, the garrison
// skill via a garrison-control read tool) consult the SAME resolved model with
// divergence zero." This module IS door 3's consult surface — the garrison skill
// reads the composition's resolved (duty, level) -> sequence model through it
// (exposed at /api/garrison-control) instead of guessing from
// policy.defaultWorkKind — and the single READ-ONLY source that answer comes from.
//
// READ-ONLY BY CONSTRUCTION: it computes the resolved model from the active
// composition and answers three questions about it — the whole model, a
// (duty, level) sequence, and readiness. It exports NO mutation; every write to a
// composition goes through Muster (app/api/muster/model.ts). The resolved
// sequences it returns are produced by the SAME functions that write the board's
// model.json (computeKanbanResolvedModel -> resolveSequence) and drive the Kanban
// board (resolved-model.mjs), so door 3's answer is byte-identical to door 1's
// (gateway dispatch) and door 2's (board) — divergence zero is a property of the
// shared model layer, not something each door re-derives and hopes agrees.
//
// Pure core (buildControlModel / resolvedSequenceFrom) is fs-free and unit-tested;
// the fs wrappers (getResolvedModel / getResolvedSequence / getReadiness) read the
// active composition exactly as Muster does (resolveActiveComposition +
// readComposition + selectedLibraryEntries), so the two surfaces never resolve two
// different models.

import {
  resolveModel,
  type DutyGraphError,
  type ResolvedDuty,
  type ResolverFittingInput,
  type RuleResult
} from "./resolver";
import { computeKanbanResolvedModel } from "./kanban-model";
import { readComposition, selectedLibraryEntries } from "./compositions";
import { resolveActiveComposition } from "./active-composition";
import type { DutySpec, GarrisonMetadata } from "./types";

export interface ControlModel {
  compositionId: string;
  // Every known duty by id (fitting-provided, overlaid by composition definitions).
  duties: Record<string, ResolvedDuty>;
  // Duty ids selected in this composition, in order.
  selectedDuties: string[];
  // The ordered phase-list union — the Kanban list set (D15).
  kanbanLists: string[];
  // Precomputed (duty -> level -> ordered leaf ids). This IS the resolved sequence
  // each door walks; byte-identical to the board's model.json.
  sequences: Record<string, Record<string, string[]>>;
  // D10 readiness rules, each met/unmet with a message.
  rules: RuleResult[];
  ready: boolean;
  // Duty-graph errors (unresolved refs, cycles, ...). Empty on a healthy model.
  errors: DutyGraphError[];
}

export interface ControlReadiness {
  rules: RuleResult[];
  ready: boolean;
}

export interface ControlSequence {
  duty: string;
  level: number;
  // The ordered leaf phase-list ids the card visits, or [] when the (duty, level)
  // resolves to nothing (unknown duty, out-of-range level, or an errored graph).
  sequence: string[];
}

type ControlFitting = { id: string; metadata: GarrisonMetadata };

// The pure core: composition + resolved fittings in, control model out. No fs, no
// network — callers hand it data, tests hand it fixtures. It runs the SAME two
// resolver entry points the rest of the system uses: resolveModel (duties /
// selected / readiness / errors) and computeKanbanResolvedModel (kanbanLists + the
// precomputed per-(duty, level) sequences the board reads from model.json). Two
// passes, zero duplicated resolution logic, so the sequences are identical to what
// the runner projects to disk.
export function buildControlModel(args: {
  composition: { id: string; duties: DutySpec[]; selectedDuties: string[] };
  fittings: ControlFitting[];
}): ControlModel {
  const fittings: ResolverFittingInput[] = args.fittings.map((f) => ({ id: f.id, metadata: f.metadata }));
  const resolved = resolveModel({
    fittings,
    compositionDuties: args.composition.duties,
    selectedDuties: args.composition.selectedDuties
  });
  const projected = computeKanbanResolvedModel(
    {
      id: args.composition.id,
      duties: args.composition.duties,
      selectedDuties: args.composition.selectedDuties
    },
    args.fittings
  );
  return {
    compositionId: args.composition.id,
    duties: resolved.duties,
    selectedDuties: resolved.selectedDuties,
    kanbanLists: projected.kanbanLists,
    sequences: projected.sequences,
    rules: resolved.rules,
    ready: resolved.ready,
    errors: resolved.errors
  };
}

// The resolved sequence for a (duty, level): the ordered leaf phase-list ids a
// card carrying this duty/level VISITS (it skips every other list). Reads the
// precomputed map, so it is exactly what the board's resolveCardSequence and the
// gateway's dispatch consult return for the same (duty, level). An unknown
// duty/level yields [] rather than throwing — a read tool answers a caller, it
// does not fail one.
export function resolvedSequenceFrom(
  model: Pick<ControlModel, "sequences">,
  duty: string,
  level: number
): string[] {
  const perLevel = model.sequences?.[duty];
  const seq = perLevel?.[String(level)];
  return Array.isArray(seq) ? seq : [];
}

// ── fs wrappers (read the active composition) ─────────────────────────────────

async function loadControlModel(compositionId?: string): Promise<ControlModel> {
  const id = compositionId?.trim() || (await resolveActiveComposition()).id;
  const composition = await readComposition(id);
  const entries = await selectedLibraryEntries(composition.selections);
  return buildControlModel({
    composition: {
      id: composition.id,
      duties: composition.duties,
      selectedDuties: composition.selectedDuties
    },
    fittings: entries.map((entry) => ({ id: entry.id, metadata: entry.metadata }))
  });
}

// getResolvedModel — the whole resolved model for the active composition (or an
// explicit id). This is the one object doors 1/2/3 all consult.
export async function getResolvedModel(compositionId?: string): Promise<ControlModel> {
  return loadControlModel(compositionId);
}

// getResolvedSequence — the ordered phase-list sequence a (duty, level) card walks.
// The garrison skill (door 3) calls this to register a card that flows through the
// SAME resolved sequence a board- or gateway-entered card would.
export async function getResolvedSequence(
  duty: string,
  level: number,
  compositionId?: string
): Promise<ControlSequence> {
  const model = await loadControlModel(compositionId);
  return { duty, level, sequence: resolvedSequenceFrom(model, duty, level) };
}

// getReadiness — the D10 readiness rules + overall ready flag for the active
// composition (a read-only projection of the same resolved model).
export async function getReadiness(compositionId?: string): Promise<ControlReadiness> {
  const model = await loadControlModel(compositionId);
  return { rules: model.rules, ready: model.ready };
}
