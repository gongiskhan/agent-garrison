// Project the composition's resolved model to the Kanban board (D15, slice S4a).
//
// The Kanban board runs as its own Node process (fittings/seed/kanban-loop) and
// cannot import the TypeScript Resolver. So at up() the runner computes the
// resolved model here and writes a small JSON the board reads
// (fittings/seed/kanban-loop/lib/resolved-model.mjs → loadResolvedModel):
//
//   { version, compositionId,
//     kanbanLists: string[],                              // the ordered phase-list set (deriveKanbanLists)
//     sequences: { [dutyId]: { [level]: string[] } },     // v1-compatible leaf ids
//     duties, selectedDuties, targets,                    // routing-inference vocabulary
//     steps: { [dutyId]: { [level]: ResolvedStep[] } },   // exact v4 execution cells
//     ladders: { [name]: ResolvedRung[] },                // v3: named model tiers, floor -> top
//     dutyLadder: { [dutyId]: { ladder, rungs, defaultIndex, ceilingIndex } } }
//
// This is additive: the board falls back to its built-in default pipeline when
// the file is absent, and only a FRESH board seed reads it — an existing
// board.json is left untouched. A malformed duty graph writes an empty
// kanbanLists so the board keeps its default pipeline rather than a broken one.

import path from "node:path";
import fs from "node:fs/promises";
import { garrisonDir } from "./claude-home";
import { writeFileAtomic } from "./atomic-write";
import { resolveModel, resolveSequence } from "./resolver";
import type { CompositionLadders, CompositionTarget, CompositionV4 } from "./compositions";
import type { LibraryEntry } from "./types";

// The ladder every duty climbs when it names none.
const DEFAULT_LADDER = "standard";

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
  // Agent-SDK harness knobs from the target's params. Carried on the cell so the
  // duty-repoint (applyDutyCells) that injects the cell's target into the routing
  // matrix does not strip them — without this, a coding duty routed through an
  // agent-sdk target silently loses its claude_code profile (promptMode) and runs
  // the default 12-turn cap instead of the composition's value.
  promptMode: string | null;
  maxTurns: number | null;
}

export interface KanbanResolvedStep {
  duty: string;
  level: number;
  description: string;
  skill: string | null;
  targetId: string | null;
  runtime: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  params: Record<string, string | number | boolean>;
}

// A ladder rung, resolved: the rung id + its target id joined with the target's
// engine identity, so a stretch launcher can route to a rung without a second
// lookup (same join the cells above do). runtime/provider/model are null when the
// rung names a target the composition does not declare — projected rather than
// dropped, exactly as an unresolvable cell target is.
export interface KanbanLadderRung {
  id: string;
  target: string;
  runtime: string | null;
  provider: string | null;
  model: string | null;
  params: Record<string, string | number | boolean>;
}

// A duty's resolved ladder: the rungs it may climb, where it starts, and how far
// it may go unaided. `ladder` is null for the SYNTHETIC one-rung ladder derived
// from a duty's level-1 cell — the fallback that lets every pre-ladder duty keep
// working with no YAML edit at all.
export interface KanbanDutyLadder {
  ladder: string | null;
  rungs: KanbanLadderRung[];
  defaultIndex: number;
  ceilingIndex: number;
}

export interface KanbanResolvedModel {
  version: 3;
  compositionId: string;
  kanbanLists: string[];
  sequences: Record<string, Record<string, string[]>>;
  // duty -> level -> resolved cell (the legacy duties->router repoint input).
  cells: Record<string, Record<string, KanbanDutyCell>>;
  // Duty flags used by the board's context controller and explicit Discuss gate.
  holds?: Record<string, boolean>;
  gates?: Record<string, string>;
  // v2: enough of the Resolver output for Orchestrator routing inference to choose a
  // top-level (duty, level), plus the composition targets and fully-resolved leaf
  // execution steps. Runtime/model come from the assigned target; effort comes
  // from the leaf cell (target identity deliberately does not own effort).
  duties?: ReturnType<typeof resolveModel>["duties"];
  selectedDuties?: string[];
  targets?: CompositionTarget[];
  steps?: Record<string, Record<string, KanbanResolvedStep[]>>;
  // v3 (Conversations A2): the composition's named model ladders, resolved, and
  // per-selected-duty where on its ladder a stretch starts and stops. Rung = model
  // tier, level = depth of work; effort still comes from the level cell.
  ladders?: Record<string, KanbanLadderRung[]>;
  dutyLadder?: Record<string, KanbanDutyLadder>;
}

// Where the board reads its model from — mirror the board's own convention
// (GARRISON_KANBAN_DIR wins, else <garrison home>/kanban-loop).
export function kanbanModelPath(): string {
  const dir = process.env.GARRISON_KANBAN_DIR?.trim();
  return path.join(dir && dir.length > 0 ? dir : path.join(garrisonDir(), "kanban-loop"), "model.json");
}

// The projection is machine-global because the Kanban fitting is machine-global.
// When the active composition cannot supply a resolved duty model, remove the
// previous composition's projection instead of letting the board/gateway reuse
// stale execution cells. `force` keeps the absent-file fallback idempotent.
export async function clearKanbanResolvedModel(file = kanbanModelPath()): Promise<void> {
  await fs.rm(file, { force: true });
}

// Compute the board's resolved model from the composition's duties + the selected
// fittings' duty provisions. Pure: builds the shape, does not touch disk.
export function computeKanbanResolvedModel(
  composition: Pick<CompositionV4, "id" | "duties" | "selectedDuties"> &
    Partial<Pick<CompositionV4, "targets" | "ladders">>,
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
  const steps: Record<string, Record<string, KanbanResolvedStep[]>> = {};
  const targets = composition.targets ?? [];
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  if (model.errors.length === 0) {
    for (const [id, duty] of Object.entries(model.duties)) {
      const perLevel: Record<string, string[]> = {};
      const perLevelSteps: Record<string, KanbanResolvedStep[]> = {};
      duty.levels.forEach((_level, index) => {
        const level = index + 1;
        try {
          const resolved = resolveSequence(id, level, model.duties);
          perLevel[String(level)] = resolved.map((step) => step.duty);
          perLevelSteps[String(level)] = resolved.map((step) => {
            const targetId = step.cell.target ?? null;
            const target = targetId ? targetsById.get(targetId) : undefined;
            return {
              duty: step.duty,
              level: step.level,
              description: step.description,
              skill: step.cell.skill ?? null,
              targetId,
              runtime: target?.runtime ?? null,
              provider: target?.provider ?? null,
              model: target?.model ?? null,
              effort: step.cell.effort ?? null,
              params: { ...(target?.params ?? {}) }
            };
          });
        } catch {
          // A misuse (unknown ref surfacing at runtime) — skip this level rather
          // than fail the whole projection.
        }
      });
      sequences[id] = perLevel;
      steps[id] = perLevelSteps;
    }
  }

  // Per-duty per-level resolved cells (leaf levels only): the muster cell
  // joined with its target's spec. This is what repoints the router matrix at
  // the composition's duty ladders (applyDutyCells) — without it a muster duty
  // edit would be dead weight on the live routing path.
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
          type: typeof params.type === "string" ? params.type : null,
          promptMode: typeof params.promptMode === "string" ? params.promptMode : null,
          maxTurns: typeof params.maxTurns === "number" ? params.maxTurns : null
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

  // Model ladders (Conversations A2). Resolved eagerly and STRICTLY: an unknown
  // rung id or a duty pointing at a ladder that does not exist throws here, at
  // projection time — which is up(). The alternative is a launcher discovering
  // mid-conversation that the rung it was told to climb to does not exist, with
  // a live stretch to strand.
  const ladders = resolveLadders(composition.ladders ?? {}, targetsById);
  const dutyLadder = resolveDutyLadders(model.duties, model.selectedDuties, ladders, targetsById);

  return {
    version: 3,
    compositionId: composition.id,
    kanbanLists: model.errors.length === 0 ? model.kanbanLists : [],
    sequences,
    cells,
    holds,
    gates,
    duties: model.duties,
    selectedDuties: model.selectedDuties,
    targets,
    steps,
    ladders,
    dutyLadder
  };
}

// Join each declared ladder's rungs with their targets. Pure; no validation
// beyond the shape the parser already enforced — a rung naming an undeclared
// target still projects (nulls), matching how an unresolvable cell target is
// handled, so one missing target is a visible hole rather than a dead board.
function resolveLadders(
  ladders: CompositionLadders,
  targetsById: Map<string, CompositionTarget>
): Record<string, KanbanLadderRung[]> {
  const resolved: Record<string, KanbanLadderRung[]> = {};
  for (const [name, rungs] of Object.entries(ladders)) {
    resolved[name] = rungs.map((rung) => {
      const spec = targetsById.get(rung.target);
      return {
        id: rung.id,
        target: rung.target,
        runtime: spec?.runtime ?? null,
        provider: spec?.provider ?? null,
        model: spec?.model ?? null,
        params: { ...(spec?.params ?? {}) }
      };
    });
  }
  return resolved;
}

// Where each SELECTED duty sits on its ladder.
//
// A duty that declares any ladder line (`ladder`/`default`/`ceiling`) resolves
// against the named ladder (absent name = "standard"): an unknown ladder, an
// unknown rung id, or a ceiling BELOW the default all throw — a duty whose
// escalation range is nonsense must not reach a launcher.
//
// A duty that declares NONE gets a synthetic one-rung ladder built from its
// level-1 cell target (defaultIndex = ceilingIndex = 0), so every pre-ladder
// duty keeps routing exactly where it always did with zero YAML edits. A duty
// with no level-1 cell target at all (a composite, or an automation cell) has
// no tier to name and is simply left out of the map.
function resolveDutyLadders(
  duties: ReturnType<typeof resolveModel>["duties"],
  selectedDuties: string[],
  ladders: Record<string, KanbanLadderRung[]>,
  targetsById: Map<string, CompositionTarget>
): Record<string, KanbanDutyLadder> {
  const dutyLadder: Record<string, KanbanDutyLadder> = {};
  for (const id of selectedDuties) {
    const duty = duties[id];
    if (!duty) continue;
    const named = duty.ladder ?? null;
    const hasLadderLines = named !== null || duty.default !== undefined || duty.ceiling !== undefined;

    if (!hasLadderLines) {
      const target = duty.levels[0]?.cell?.target;
      if (!target) continue;
      const spec = targetsById.get(target);
      dutyLadder[id] = {
        ladder: null,
        rungs: [
          {
            id: target,
            target,
            runtime: spec?.runtime ?? null,
            provider: spec?.provider ?? null,
            model: spec?.model ?? null,
            params: { ...(spec?.params ?? {}) }
          }
        ],
        defaultIndex: 0,
        ceilingIndex: 0
      };
      continue;
    }

    const ladderName = named ?? DEFAULT_LADDER;
    const rungs = ladders[ladderName];
    if (!rungs || rungs.length === 0) {
      throw new Error(
        `duty "${id}" names ladder "${ladderName}", which the composition does not declare ` +
          `(declared ladders: ${Object.keys(ladders).join(", ") || "none"})`
      );
    }
    const indexOfRung = (rungId: string, field: "default" | "ceiling"): number => {
      const index = rungs.findIndex((rung) => rung.id === rungId);
      if (index < 0) {
        throw new Error(
          `duty "${id}" ${field} rung "${rungId}" is not on ladder "${ladderName}" ` +
            `(rungs: ${rungs.map((rung) => rung.id).join(" -> ")})`
        );
      }
      return index;
    };
    const defaultIndex = duty.default === undefined ? 0 : indexOfRung(duty.default, "default");
    const ceilingIndex = duty.ceiling === undefined ? rungs.length - 1 : indexOfRung(duty.ceiling, "ceiling");
    if (ceilingIndex < defaultIndex) {
      throw new Error(
        `duty "${id}" has ceiling "${rungs[ceilingIndex].id}" below its default "${rungs[defaultIndex].id}" ` +
          `on ladder "${ladderName}" - a duty cannot start above the rung it may climb to`
      );
    }
    dutyLadder[id] = { ladder: ladderName, rungs: rungs.map((rung) => ({ ...rung })), defaultIndex, ceilingIndex };
  }
  return dutyLadder;
}

// Compute + write the board's resolved model. Returns the written model. The
// caller wraps this best-effort so a projection failure never aborts up().
export async function writeKanbanResolvedModel(
  composition: Pick<CompositionV4, "id" | "duties" | "selectedDuties"> &
    Partial<Pick<CompositionV4, "targets" | "ladders">>,
  entries: Pick<LibraryEntry, "id" | "metadata">[]
): Promise<KanbanResolvedModel> {
  const model = computeKanbanResolvedModel(composition, entries);
  await writeFileAtomic(kanbanModelPath(), JSON.stringify(model, null, 2));
  return model;
}
