// The Muster model assembler (GARRISON-UNIFY-V1 D12, slice S5a). Muster is the
// one shell-owned page where the whole system is configured; every surface on it
// reads ONE resolved model built by resolveModel (resolver.ts) over the active
// composition's fittings + composition-level duties. This module is the reusable
// assembly the GET route and the write routes (duty add/remove, cell target/effort)
// all share, so the page and its mutations never drift from a second resolver call.
//
// Pure core (`buildMusterPayload`) is fs-free and unit-tested; the fs wrappers
// (`assembleMusterModel`, `setSelectedDuty`, `setCellTarget`) read/write the
// composition manifest. Writes touch ONLY x-garrison.composition.{selected_duties,
// duties}; everything else in the manifest round-trips untouched.

import {
  resolveModel,
  type DutyGraphError,
  type ResolvedDuty,
  type ResolverFittingInput,
  type RuleResult
} from "@/lib/resolver";
import {
  getCompositionManifestPath,
  listCompositions,
  readComposition,
  selectedLibraryEntries,
  type CompositionTarget
} from "@/lib/compositions";
import { resolveActiveComposition } from "@/lib/active-composition";
import { readYamlFile, writeYamlFile } from "@/lib/yaml";
import type { DutyEffort, DutyLevelCell, DutySpec } from "@/lib/types";

export interface MusterCompositionRef {
  id: string;
  name: string;
}

export interface MusterModel {
  compositionId: string;
  compositionName: string;
  // Every composition, for the header switcher.
  compositions: MusterCompositionRef[];
  // Every known duty by id (fitting-provided, overlaid by composition definitions).
  duties: Record<string, ResolvedDuty>;
  // Duty ids selected in this composition, in order.
  selectedDuties: string[];
  // Engine-identity targets a leaf cell can be assigned (drag / tap-to-place).
  targets: CompositionTarget[];
  // D10 readiness rules, each met/unmet with a message.
  rules: RuleResult[];
  ready: boolean;
  // Duty-graph errors (unresolved refs, cycles, ...). Empty on a healthy model.
  errors: DutyGraphError[];
}

// The pure core: composition + resolved fittings in, Muster model out. No fs,
// no network — callers hand it data, tests hand it fixtures.
export function buildMusterPayload(args: {
  composition: {
    id: string;
    name: string;
    duties: DutySpec[];
    selectedDuties: string[];
    targets: CompositionTarget[];
  };
  fittings: ResolverFittingInput[];
  compositions: MusterCompositionRef[];
}): MusterModel {
  const resolved = resolveModel({
    fittings: args.fittings,
    compositionDuties: args.composition.duties,
    selectedDuties: args.composition.selectedDuties
  });
  return {
    compositionId: args.composition.id,
    compositionName: args.composition.name,
    compositions: args.compositions,
    duties: resolved.duties,
    selectedDuties: resolved.selectedDuties,
    targets: args.composition.targets,
    rules: resolved.rules,
    ready: resolved.ready,
    errors: resolved.errors
  };
}

// The concrete composition id: an explicit id, else the active-composition
// pointer resolved. Callers that both read AND write must resolve ONCE and reuse
// the result, so a read and its follow-up write can never target two different
// compositions if the active pointer moves between them.
async function resolveCompositionId(compositionId?: string): Promise<string> {
  return compositionId?.trim() || (await resolveActiveComposition()).id;
}

// The fs wrapper: resolve the active composition (or an explicit id), read it +
// its selected fittings + the composition list, and assemble the model.
export async function assembleMusterModel(compositionId?: string): Promise<MusterModel> {
  const id = await resolveCompositionId(compositionId);
  const composition = await readComposition(id);
  const entries = await selectedLibraryEntries(composition.selections);
  const all = await listCompositions();
  return buildMusterPayload({
    composition: {
      id: composition.id,
      name: composition.name,
      duties: composition.duties,
      selectedDuties: composition.selectedDuties,
      targets: composition.targets
    },
    fittings: entries.map((entry) => ({ id: entry.id, metadata: entry.metadata })),
    compositions: all.map((c) => ({ id: c.id, name: c.name }))
  });
}

// ── Manifest mutation (writes x-garrison.composition only) ────────────────────

interface CompositionBlock {
  selected_duties?: unknown;
  duties?: unknown;
  [key: string]: unknown;
}
interface Manifest {
  "x-garrison"?: { composition?: CompositionBlock; [key: string]: unknown };
  [key: string]: unknown;
}

async function mutateCompositionBlock(
  compositionId: string,
  mutate: (block: CompositionBlock) => void
): Promise<void> {
  const manifestPath = getCompositionManifestPath(compositionId);
  const manifest = await readYamlFile<Manifest>(manifestPath);
  const block = manifest?.["x-garrison"]?.composition;
  if (!manifest || !block) {
    throw new Error(`composition "${compositionId}" has no x-garrison.composition block`);
  }
  mutate(block);
  await writeYamlFile(manifestPath, manifest);
}

// A clean DutySpec (no resolver-added providerFittingId) to persist into the
// composition's duties[] when overriding a fitting-provided duty (D8).
function toDutySpec(duty: ResolvedDuty): DutySpec {
  return {
    id: duty.id,
    title: duty.title,
    description: duty.description,
    levels: structuredClone(duty.levels)
  };
}

// Add or remove a duty from selected_duties. `add` requires the duty be known
// (present in the resolved model). Returns the freshly assembled model.
export async function setSelectedDuty(
  compositionId: string | undefined,
  dutyId: string,
  action: "add" | "remove"
): Promise<MusterModel> {
  const id = await resolveCompositionId(compositionId);
  const model = await assembleMusterModel(id);
  if (action === "add" && !model.duties[dutyId]) {
    throw new Error(`unknown duty "${dutyId}" — cannot select a duty no fitting or composition defines`);
  }
  await mutateCompositionBlock(id, (block) => {
    const selected: string[] = Array.isArray(block.selected_duties)
      ? (block.selected_duties as string[])
      : (block.selected_duties = []);
    const at = selected.indexOf(dutyId);
    if (action === "add" && at === -1) selected.push(dutyId);
    if (action === "remove" && at !== -1) selected.splice(at, 1);
  });
  return assembleMusterModel(id);
}

// Set a leaf level's target and/or effort. Writes into composition.duties,
// materialising the full duty spec there first when it lives only in a fitting
// (the composition file wins, D8). Rejects a composite level (no cell to set).
export async function setCellTarget(
  compositionId: string | undefined,
  dutyId: string,
  level: number,
  patch: { target?: string; effort?: DutyEffort }
): Promise<MusterModel> {
  const id = await resolveCompositionId(compositionId);
  const model = await assembleMusterModel(id);
  const duty = model.duties[dutyId];
  if (!duty) throw new Error(`unknown duty "${dutyId}"`);
  const spec = duty.levels[level - 1];
  if (!spec) throw new Error(`duty "${dutyId}" has no level ${level} (has ${duty.levels.length})`);
  if (!spec.cell) {
    throw new Error(`duty "${dutyId}" level ${level} is a composite (sequence), not an assignable leaf cell`);
  }
  await mutateCompositionBlock(id, (block) => {
    const duties: Array<{ id?: unknown; levels?: unknown }> = Array.isArray(block.duties)
      ? (block.duties as Array<{ id?: unknown; levels?: unknown }>)
      : (block.duties = []);
    let entry = duties.find((d) => d && d.id === dutyId);
    if (!entry) {
      entry = toDutySpec(duty);
      duties.push(entry);
    }
    const levels = (entry.levels ?? (entry.levels = [])) as Array<{ cell?: DutyLevelCell }>;
    const target = levels[level - 1];
    if (!target) throw new Error(`duty "${dutyId}" level ${level} missing in manifest`);
    const cell = (target.cell ?? (target.cell = {})) as DutyLevelCell;
    if (patch.target !== undefined) cell.target = patch.target;
    if (patch.effort !== undefined) cell.effort = patch.effort;
  });
  return assembleMusterModel(id);
}
