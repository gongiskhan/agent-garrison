// The Resolver (MARATHON-V3 D1). Compose-time code, fixed — the floor that
// makes everything above it swappable. It reads the composition's duty
// definitions + the selected fittings' duty provisions, validates the duty
// graph (all references resolve, level references valid, the graph is a DAG),
// enforces the composition validation rules (D10), and emits the resolved
// model everything else consumes: the Muster page, the Kanban column set, the
// orchestrator's locked prompt blocks, and the garrison-control read tool.
//
// NO prompt logic lives here, and its semantics are not configurable beyond
// the composition it reads (constraint 11). Pure functions only — no fs, no
// network; callers (compositions.ts, the board, the prompt assembler) hand it
// data and consume the model.

import type { DutyLevel, DutyLevelCell, DutySpec, GarrisonMetadata } from "./types";

export interface DutyGraphError {
  code:
    | "missing-duty-ref"
    | "missing-level"
    | "level-out-of-range"
    | "cycle"
    | "duplicate-duty";
  dutyId: string;
  level?: number;
  message: string;
}

// One resolved step of a card's journey: a leaf (duty, level) with its cell.
export interface ResolvedLeafStep {
  duty: string;
  level: number;
  cell: DutyLevelCell;
  description: string;
}

export interface ResolvedDuty extends DutySpec {
  // The fitting that provides this duty; undefined when the duty is defined
  // only in the composition file (a composition-local duty).
  providerFittingId?: string;
}

// D10: essentials are validation rules, not a fixed tier. The default set is
// Garrison's; a v4 composition may declare its own additions. Each rule checks
// presence of a capability kind, a faculty, or a duty id in the resolved
// model. `identity` is provided by the Identity Fitting (D7); `dispatch` is
// the Dispatcher duty (D6).
export interface ReadinessRule {
  id: string;
  description: string;
  require:
    | { kind: string; atLeast?: number }
    | { faculty: string }
    | { dutyId: string };
}

export const DEFAULT_READINESS_RULES: ReadinessRule[] = [
  { id: "orchestrator", description: "an orchestrator", require: { kind: "orchestrator" } },
  { id: "runtime", description: "at least one runtime", require: { kind: "runtime", atLeast: 1 } },
  { id: "channel", description: "at least one channel", require: { kind: "channel", atLeast: 1 } },
  { id: "memory", description: "a memory store", require: { kind: "memory-store" } },
  { id: "gateway", description: "a gateway", require: { faculty: "gateway" } },
  { id: "identity", description: "an identity", require: { kind: "identity" } },
  { id: "dispatcher", description: "a dispatcher duty", require: { dutyId: "dispatch" } }
];

export interface RuleResult {
  rule: ReadinessRule;
  met: boolean;
  message: string;
}

export interface ResolverFittingInput {
  id: string;
  metadata: GarrisonMetadata;
}

export interface ResolvedModel {
  // Every known duty by id (fitting-provided, overlaid by composition
  // definitions — the composition file wins, D8).
  duties: Record<string, ResolvedDuty>;
  // Duty ids considered selected (in the composition).
  selectedDuties: string[];
  // Ordered leaf-duty ids: every leaf duty appearing in any selected
  // composite's resolved sequences (transitively) or standing alone. This IS
  // the Kanban list set (D15) and the duties-and-levels prompt table's rows.
  kanbanLists: string[];
  errors: DutyGraphError[];
  rules: RuleResult[];
  ready: boolean;
}

// Merge fitting-provided duty specs with composition-level definitions.
// Composition definitions WIN by id (the composition file is the truth; the
// fitting's spec is its shipped default). Duplicate ids across two fittings
// are an error — duties are globally identified.
export function collectDuties(
  fittings: ResolverFittingInput[],
  compositionDuties: DutySpec[] = []
): { duties: Record<string, ResolvedDuty>; errors: DutyGraphError[] } {
  const duties: Record<string, ResolvedDuty> = {};
  const errors: DutyGraphError[] = [];
  for (const fitting of fittings) {
    for (const spec of fitting.metadata.duties ?? []) {
      if (duties[spec.id] && duties[spec.id].providerFittingId !== fitting.id) {
        errors.push({
          code: "duplicate-duty",
          dutyId: spec.id,
          message: `duty "${spec.id}" is provided by both ${duties[spec.id].providerFittingId} and ${fitting.id}`
        });
        continue;
      }
      duties[spec.id] = { ...spec, providerFittingId: fitting.id };
    }
  }
  for (const spec of compositionDuties) {
    const existing = duties[spec.id];
    duties[spec.id] = existing
      ? { ...spec, providerFittingId: existing.providerFittingId }
      : { ...spec };
  }
  return { duties, errors };
}

// Static validation of the duty graph:
// 1. every sequence entry references a known duty;
// 2. an explicit per-entry level override is within the referenced duty's
//    range;
// 3. an entry WITHOUT an override runs at the parent's level — so the
//    referenced duty must have a level at the parent level's index;
// 4. the duty-reference graph is a DAG (an edge A→B exists when any level of
//    A sequences B).
export function validateDutyGraph(duties: Record<string, ResolvedDuty>): DutyGraphError[] {
  const errors: DutyGraphError[] = [];

  for (const duty of Object.values(duties)) {
    duty.levels.forEach((level, index) => {
      const levelNumber = index + 1;
      if (!level.sequence) return;
      for (const entry of level.sequence) {
        const referenced = duties[entry.duty];
        if (!referenced) {
          errors.push({
            code: "missing-duty-ref",
            dutyId: duty.id,
            level: levelNumber,
            message: `duty "${duty.id}" level ${levelNumber} references unknown duty "${entry.duty}"`
          });
          continue;
        }
        const effective = entry.level ?? levelNumber;
        if (effective < 1) {
          errors.push({
            code: "level-out-of-range",
            dutyId: duty.id,
            level: levelNumber,
            message: `duty "${duty.id}" level ${levelNumber} runs "${entry.duty}" at invalid level ${effective} (levels are 1-based)`
          });
          continue;
        }
        if (effective > referenced.levels.length) {
          errors.push({
            code: entry.level ? "level-out-of-range" : "missing-level",
            dutyId: duty.id,
            level: levelNumber,
            message:
              `duty "${duty.id}" level ${levelNumber} runs "${entry.duty}" at level ${effective}, ` +
              `but "${entry.duty}" has only ${referenced.levels.length} level(s)`
          });
        }
      }
    });
  }

  // DFS cycle detection over duty→duty reference edges.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const visit = (id: string, path: string[]): void => {
    color.set(id, GREY);
    const duty = duties[id];
    for (const level of duty?.levels ?? []) {
      for (const entry of level.sequence ?? []) {
        if (!duties[entry.duty]) continue;
        const state = color.get(entry.duty) ?? WHITE;
        if (state === GREY) {
          errors.push({
            code: "cycle",
            dutyId: entry.duty,
            message: `duty graph cycle: ${[...path, id, entry.duty].join(" → ")}`
          });
        } else if (state === WHITE) {
          visit(entry.duty, [...path, id]);
        }
      }
    }
    color.set(id, BLACK);
  };
  for (const id of Object.keys(duties)) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id, []);
  }

  return errors;
}

// Expand (duty, level) into the ordered flat list of leaf steps a card visits
// (D15: a card visits exactly its resolved sequence and skips the rest).
// Assumes a validated graph; unknown refs/levels throw loudly here (runtime
// misuse), they do not silently skip.
export function resolveSequence(
  dutyId: string,
  level: number,
  duties: Record<string, ResolvedDuty>
): ResolvedLeafStep[] {
  const duty = duties[dutyId];
  if (!duty) throw new Error(`resolveSequence: unknown duty "${dutyId}"`);
  const spec: DutyLevel | undefined = duty.levels[level - 1];
  if (!spec) {
    throw new Error(
      `resolveSequence: duty "${dutyId}" has no level ${level} (has ${duty.levels.length})`
    );
  }
  if (spec.cell) {
    return [{ duty: dutyId, level, cell: spec.cell, description: spec.description }];
  }
  const steps: ResolvedLeafStep[] = [];
  for (const entry of spec.sequence ?? []) {
    steps.push(...resolveSequence(entry.duty, entry.level ?? level, duties));
  }
  return steps;
}

// The Kanban list set (D15): every leaf duty appearing in any selected duty's
// resolved sequences (at ANY of its levels, transitively), plus selected
// duties that are themselves leaves at any level. Ordered by first discovery
// (selected order, then sequence order). Human state lists (Backlog, To-do,
// Done, Needs attention) are fixed and NOT the resolver's concern.
export function deriveKanbanLists(
  selectedDuties: string[],
  duties: Record<string, ResolvedDuty>
): string[] {
  const lists: string[] = [];
  const push = (id: string) => {
    // Dispatch chooses a duty; it is not an executable Kanban phase. Keep it in
    // selectedDuties/readiness while excluding it from the board vocabulary.
    if (id === "dispatch") return;
    if (!lists.includes(id)) lists.push(id);
  };
  const walk = (id: string, seen: Set<string>): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const duty = duties[id];
    if (!duty) return;
    for (const level of duty.levels) {
      if (level.cell) push(id);
      for (const entry of level.sequence ?? []) walk(entry.duty, seen);
    }
  };
  for (const id of selectedDuties) walk(id, new Set());
  return lists;
}

export function evaluateReadiness(
  fittings: ResolverFittingInput[],
  duties: Record<string, ResolvedDuty>,
  selectedDuties: string[],
  rules: ReadinessRule[] = DEFAULT_READINESS_RULES
): RuleResult[] {
  const faculties = new Set<string>();
  for (const fitting of fittings) {
    faculties.add(fitting.metadata.faculty);
  }
  const dutyIds = new Set([...Object.keys(duties)].filter((id) => selectedDuties.includes(id)));

  return rules.map((rule) => {
    let met = false;
    const require = rule.require;
    if ("kind" in require) {
      const count = fittings.reduce(
        (n, f) => n + f.metadata.provides.filter((p) => p.kind === require.kind).length,
        0
      );
      met = count >= (require.atLeast ?? 1);
    } else if ("faculty" in require) {
      met = faculties.has(require.faculty);
    } else {
      met = dutyIds.has(require.dutyId);
    }
    return {
      rule,
      met,
      message: met
        ? `${rule.description}: present`
        : `composition is missing ${rule.description}`
    };
  });
}

// The single entry point: composition duties + selected fittings in, resolved
// model out. This is what Muster, the board, the locked prompt blocks, and
// garrison-control all read — one source (final-gate acceptance 3).
export function resolveModel(input: {
  fittings: ResolverFittingInput[];
  compositionDuties?: DutySpec[];
  selectedDuties?: string[];
  rules?: ReadinessRule[];
}): ResolvedModel {
  const { duties, errors: collectErrors } = collectDuties(
    input.fittings,
    input.compositionDuties ?? []
  );
  const graphErrors = validateDutyGraph(duties);
  const errors = [...collectErrors, ...graphErrors];
  const selectedDuties = input.selectedDuties ?? Object.keys(duties);
  const kanbanLists = errors.length === 0 ? deriveKanbanLists(selectedDuties, duties) : [];
  const rules = evaluateReadiness(input.fittings, duties, selectedDuties, input.rules);
  const ready = errors.length === 0 && rules.every((r) => r.met);
  return { duties, selectedDuties, kanbanLists, errors, rules, ready };
}
