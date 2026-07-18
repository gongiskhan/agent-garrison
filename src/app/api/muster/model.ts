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

import path from "node:path";
import {
  resolveModel,
  validateDutyGraph,
  type DutyGraphError,
  type ResolvedDuty,
  type ResolverFittingInput,
  type RuleResult
} from "@/lib/resolver";
import {
  computeCapabilityResolution,
  defaultConfigForEntry,
  getCompositionDirectory,
  getCompositionManifestPath,
  listCompositions,
  readComposition,
  selectedLibraryEntries,
  validateCompositionSelections,
  type CompositionTarget
} from "@/lib/compositions";
import { resolveActiveComposition } from "@/lib/active-composition";
import { readLibrary } from "@/lib/library";
import { authorApmDependencies } from "@/lib/apm-manifest";
import { ROOT_DIR } from "@/lib/paths";
import { cloneFitting } from "@/lib/clone";
import { getFaculty, facultyRoleCopy } from "@/lib/faculties";
import { readYamlFile } from "@/lib/yaml";
import { writeFileAtomic } from "@/lib/atomic-write";
import { resolvePrimaryFromPolicy, writePrimaryRuntimeToPolicy } from "@/lib/routing-primary";
import { validateCellCompatibility } from "@/lib/router-migrate";
import { dump as dumpYaml } from "js-yaml";
import { dutyEfforts } from "@/lib/types";
import type {
  Cardinality,
  CapabilityIssue,
  ConfigSchemaField,
  DutyEffort,
  DutyLevel,
  DutyLevelCell,
  DutySpec,
  FacultyId,
  FittingSelectionMap,
  FittingShape,
  LibraryEntry,
  SelectedFitting
} from "@/lib/types";

// Config values that must never reach the browser in the GET payload (codex S5a
// finding): a target's params can carry secrets or absolute home paths. We
// redact any param whose key looks secret-bearing, or whose string value is an
// absolute/home path, before returning targets to the client.
const SECRET_KEY_RE = /(secret|token|key|password|credential|auth)/i;
const pathish = (v: unknown) =>
  typeof v === "string" && (/^(\/|~)/.test(v) || v.includes("/home/") || v.includes("/Users/"));

function sanitizeTargets(targets: CompositionTarget[]): CompositionTarget[] {
  return targets.map((t) => {
    if (!t.params) return t;
    const params: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(t.params)) {
      params[k] = SECRET_KEY_RE.test(k) || pathish(v) ? "[redacted]" : v;
    }
    return { ...t, params };
  });
}

// Redact secret-keyed / path-shaped values from a fitting's selection config
// before it reaches the browser (codex S5b finding: a stored tls_key path or a
// secret in selection.config was returned verbatim from the standing GET).
function sanitizeConfig(
  config: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = SECRET_KEY_RE.test(k) || pathish(v) ? "[redacted]" : v;
  }
  return out;
}

export interface MusterCompositionRef {
  id: string;
  name: string;
}

export interface MusterDutyCandidate {
  id: string;
  title: string;
  description: string;
  fittingId: string;
}

export interface MusterRuntimeOption {
  id: string;
  fittingId: string;
}

export interface MusterModel {
  compositionId: string;
  compositionName: string;
  // Every composition, for the header switcher.
  compositions: MusterCompositionRef[];
  // Duties available from library fittings not yet stationed. Selecting one
  // atomically stations its provider and selects the duty.
  dutyCandidates: MusterDutyCandidate[];
  runtimeOptions: MusterRuntimeOption[];
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
  dutyCandidates?: MusterDutyCandidate[];
  runtimeOptions?: MusterRuntimeOption[];
}): MusterModel {
  const resolved = resolveModel({
    fittings: args.fittings,
    compositionDuties: args.composition.duties,
    selectedDuties: args.composition.selectedDuties
  });
  const candidates = new Map<string, MusterDutyCandidate>();
  for (const candidate of args.dutyCandidates ?? []) {
    if (!resolved.duties[candidate.id] && !resolved.selectedDuties.includes(candidate.id)) {
      candidates.set(candidate.id, candidate);
    }
  }
  return {
    compositionId: args.composition.id,
    compositionName: args.composition.name,
    compositions: args.compositions,
    dutyCandidates: [...candidates.values()].sort((a, b) => a.title.localeCompare(b.title)),
    runtimeOptions: args.runtimeOptions ?? [],
    duties: resolved.duties,
    selectedDuties: resolved.selectedDuties,
    targets: sanitizeTargets(args.composition.targets),
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
  const [all, library] = await Promise.all([listCompositions(), readLibrary()]);
  const stationed = new Set(entries.map((entry) => entry.id));
  const dutyCandidates: MusterDutyCandidate[] = library.flatMap((entry) =>
    stationed.has(entry.id)
      ? []
      : (entry.metadata.duties ?? []).map((duty) => ({
          id: duty.id,
          title: duty.title,
          description: duty.description,
          fittingId: entry.id
        }))
  );
  const runtimeOptions = entries.flatMap((entry) =>
    entry.metadata.provides
      .filter((provision) => provision.kind === "runtime")
      .map((provision) => ({ id: provision.name, fittingId: entry.id }))
  );
  return buildMusterPayload({
    composition: {
      id: composition.id,
      name: composition.name,
      duties: composition.duties,
      selectedDuties: composition.selectedDuties,
      targets: composition.targets
    },
    fittings: entries.map((entry) => ({ id: entry.id, metadata: entry.metadata })),
    compositions: all.map((c) => ({ id: c.id, name: c.name })),
    dutyCandidates,
    runtimeOptions
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
  // Atomic write (codex S5a finding): a direct truncate-and-write races with a
  // concurrent autosave and can corrupt the composition. writeFileAtomic does
  // temp+rename (0600-preserving), so a reader never sees a partial file.
  const raw = dumpYaml(manifest, { lineWidth: 100, noRefs: true, sortKeys: false });
  await writeFileAtomic(manifestPath, raw);
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
    const composition = await readComposition(id);
    const library = await readLibrary();
    const provider = library.find((entry) =>
      (entry.metadata.duties ?? []).some((duty) => duty.id === dutyId)
    );
    if (!provider) {
      throw new Error(`unknown duty "${dutyId}" — cannot select a duty no fitting or composition defines`);
    }

    const nextSelections = cloneSelections(composition.selections);
    const current = nextSelections[provider.faculty] ?? [];
    if (!current.some((selection) => selection.id === provider.id)) {
      nextSelections[provider.faculty] = [...current, defaultConfigForEntry(provider)];
    }
    await validateCompositionSelections(nextSelections);

    const selectedDuties = composition.selectedDuties.includes(dutyId)
      ? [...composition.selectedDuties]
      : [...composition.selectedDuties, dutyId];
    const nextEntries = await selectedLibraryEntries(nextSelections);
    const resolved = resolveModel({
      fittings: nextEntries.map((entry) => ({ id: entry.id, metadata: entry.metadata })),
      compositionDuties: composition.duties,
      selectedDuties
    });
    if (!resolved.duties[dutyId] || resolved.errors.length > 0) {
      const detail = resolved.errors.map((error) => error.message).join("; ");
      throw new Error(
        `cannot station ${provider.id} for duty "${dutyId}": ${detail || "the duty did not resolve"}`
      );
    }

    const dependencies = authorApmDependencies(
      nextEntries.map((entry) =>
        entry.localPath ? { absPath: path.join(ROOT_DIR, entry.localPath) } : { repo: entry.repo }
      ),
      getCompositionDirectory(id)
    );
    await mutateManifestAtomic(id, (manifest) => {
      const block = manifest["x-garrison"]!.composition!;
      block.selections = nextSelections;
      block.selected_duties = selectedDuties;
      const deps =
        manifest.dependencies && typeof manifest.dependencies === "object"
          ? (manifest.dependencies as Record<string, unknown>)
          : {};
      manifest.dependencies = { ...deps, apm: dependencies };
    });
    return assembleMusterModel(id);
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
  // Server-side validation (codex S5a finding): the client checks are bypassable
  // via a direct API call, so enforce here too. (a) the target must EXIST in the
  // composition's targets; (b) the RESULTING cell must pass validateCellCompatibility
  // (a skill cell requires an agentic target — garrison-call is ineligible) so an
  // invalid cell is never persisted.
  if (patch.target !== undefined && !model.targets.some((t) => t.id === patch.target)) {
    throw new Error(`unknown target "${patch.target}" — not defined in this composition`);
  }
  const resultingCell: DutyLevelCell = {
    ...spec.cell,
    ...(patch.target !== undefined ? { target: patch.target } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {})
  };
  const compatErrors = validateCellCompatibility(resultingCell, model.targets);
  if (compatErrors.length > 0) {
    throw new Error(`incompatible cell: ${compatErrors.map((e) => e.message).join("; ")}`);
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

// ── Level management (add / remove / describe) ────────────────────────────────
// A duty's level ladder is editable: levels can be appended, removed, and have
// their descriptions rewritten. The Dispatcher reads level DESCRIPTIONS to pick
// a depth, so the description is first-class here, not cosmetic. All three
// writers materialise the duty spec into the composition (the composition file
// wins, D8) exactly like setCellTarget, then write atomically.

// Find (or materialise) the manifest duties[] entry for a resolved duty.
function materializeDutyEntry(
  block: CompositionBlock,
  duty: ResolvedDuty
): { id?: unknown; title?: unknown; description?: unknown; levels?: unknown } {
  const duties: Array<{ id?: unknown; levels?: unknown }> = Array.isArray(block.duties)
    ? (block.duties as Array<{ id?: unknown; levels?: unknown }>)
    : (block.duties = []);
  let entry = duties.find((d) => d && d.id === duty.id);
  if (!entry) {
    entry = toDutySpec(duty);
    duties.push(entry);
  }
  return entry;
}

// The default effort for a level appended after `prev`: one notch deeper,
// capped at the scale's end. A deeper level defaults to more effort.
function bumpedEffort(prev?: DutyEffort): DutyEffort {
  const at = dutyEfforts.indexOf(prev ?? "medium");
  return dutyEfforts[Math.min(at + 1, dutyEfforts.length - 1)];
}

// Append a level to a duty. The new level clones the last one's shape (a leaf
// cell keeps its skill + target with a bumped effort; a composite keeps its
// sequence) under a placeholder description that tells the operator to write
// the real routing criterion — the Dispatcher picks levels BY description.
export async function addDutyLevel(
  compositionId: string | undefined,
  dutyId: string,
  description?: string
): Promise<MusterModel> {
  const id = await resolveCompositionId(compositionId);
  const model = await assembleMusterModel(id);
  const duty = model.duties[dutyId];
  if (!duty) throw new Error(`unknown duty "${dutyId}"`);
  const last = duty.levels[duty.levels.length - 1];
  const n = duty.levels.length + 1;
  const desc =
    description?.trim() ||
    `level ${n}: deeper than level ${n - 1} - describe when the Dispatcher should pick this level`;
  const next: DutyLevel = last?.cell
    ? { description: desc, cell: { ...structuredClone(last.cell), effort: bumpedEffort(last.cell.effort) } }
    : { description: desc, sequence: structuredClone(last?.sequence ?? []) };
  await mutateCompositionBlock(id, (block) => {
    const entry = materializeDutyEntry(block, duty);
    const levels = (entry.levels ?? (entry.levels = [])) as DutyLevel[];
    levels.push(next);
  });
  return assembleMusterModel(id);
}

// Remove one level from a duty. Refuses to leave a duty level-less, and refuses
// a removal that would break the duty graph (another duty's sequence running
// this duty at a level that would no longer exist) — the same validateDutyGraph
// the resolver runs, applied to the hypothetical post-removal model, so the
// guard can never drift from the live validation.
export async function removeDutyLevel(
  compositionId: string | undefined,
  dutyId: string,
  level: number
): Promise<MusterModel> {
  const id = await resolveCompositionId(compositionId);
  const model = await assembleMusterModel(id);
  const duty = model.duties[dutyId];
  if (!duty) throw new Error(`unknown duty "${dutyId}"`);
  if (!duty.levels[level - 1]) {
    throw new Error(`duty "${dutyId}" has no level ${level} (has ${duty.levels.length})`);
  }
  if (duty.levels.length === 1) {
    throw new Error(`duty "${dutyId}" has only one level - a duty cannot be level-less; remove the duty instead`);
  }
  const hypothetical = structuredClone(model.duties);
  hypothetical[dutyId].levels.splice(level - 1, 1);
  const before = new Set(validateDutyGraph(model.duties).map((e) => e.message));
  const broken = validateDutyGraph(hypothetical).filter((e) => !before.has(e.message));
  if (broken.length > 0) {
    throw new Error(`cannot remove level ${level} of "${dutyId}": ${broken[0].message}`);
  }
  await mutateCompositionBlock(id, (block) => {
    const entry = materializeDutyEntry(block, duty);
    const levels = entry.levels as DutyLevel[] | undefined;
    if (!levels || !levels[level - 1]) throw new Error(`duty "${dutyId}" level ${level} missing in manifest`);
    levels.splice(level - 1, 1);
  });
  return assembleMusterModel(id);
}

// Rewrite one level's description — the Dispatcher's routing criterion for
// that depth. Autosaved from the Muster UI (debounced), never a Save button.
export async function describeDutyLevel(
  compositionId: string | undefined,
  dutyId: string,
  level: number,
  description: string
): Promise<MusterModel> {
  const id = await resolveCompositionId(compositionId);
  const desc = description.trim();
  if (!desc) throw new Error("a level description cannot be empty - the Dispatcher routes by it");
  const model = await assembleMusterModel(id);
  const duty = model.duties[dutyId];
  if (!duty) throw new Error(`unknown duty "${dutyId}"`);
  if (!duty.levels[level - 1]) {
    throw new Error(`duty "${dutyId}" has no level ${level} (has ${duty.levels.length})`);
  }
  await mutateCompositionBlock(id, (block) => {
    const entry = materializeDutyEntry(block, duty);
    const levels = entry.levels as Array<{ description?: string }> | undefined;
    if (!levels || !levels[level - 1]) throw new Error(`duty "${dutyId}" level ${level} missing in manifest`);
    levels[level - 1].description = desc;
  });
  return assembleMusterModel(id);
}

export interface CompositionTargetUpdate {
  originalId?: string;
  id: string;
  runtime: string;
  provider?: string;
  model: string;
  promptMode: "lean" | "full" | null;
  maxTurns: number | null;
}

// Create or edit one engine-identity target. Extra params owned by migrations
// or other policy surfaces round-trip untouched; this editor owns only
// promptMode/maxTurns. The resulting target set is compatibility-checked against
// every resolved duty cell before one atomic manifest write.
export async function upsertCompositionTarget(
  compositionId: string | undefined,
  update: CompositionTargetUpdate
): Promise<MusterModel> {
  const id = await resolveCompositionId(compositionId);
  const targetId = update.id.trim();
  const runtime = update.runtime.trim();
  const modelName = update.model.trim();
  const originalId = update.originalId?.trim() || undefined;
  if (!/^[a-z][a-z0-9-]*$/.test(targetId)) {
    throw new Error("target id must be kebab-case");
  }
  if (!runtime) throw new Error("runtime is required");
  if (!modelName) throw new Error("model is required");
  if (update.maxTurns !== null && (!Number.isInteger(update.maxTurns) || update.maxTurns < 1 || update.maxTurns > 100)) {
    throw new Error("maxTurns must be an integer from 1 to 100");
  }

  const composition = await readComposition(id);
  const currentIndex = originalId
    ? composition.targets.findIndex((target) => target.id === originalId)
    : -1;
  if (originalId && currentIndex === -1) throw new Error(`target "${originalId}" does not exist`);
  const current = currentIndex >= 0 ? composition.targets[currentIndex] : undefined;
  const duplicate = composition.targets.findIndex((target) => target.id === targetId);
  if (duplicate !== -1 && duplicate !== currentIndex) {
    throw new Error(`target "${targetId}" already exists`);
  }

  const entries = await selectedLibraryEntries(composition.selections);
  const runtimeNames = new Set(
    entries.flatMap((entry) =>
      entry.metadata.provides
        .filter((provision) => provision.kind === "runtime")
        .map((provision) => provision.name)
    )
  );
  // Legacy compositions can contain a target whose runtime predates the
  // stationable provision catalog. Permit editing that target while its runtime
  // stays unchanged; selecting any new runtime still requires a stationed
  // runtime fitting.
  if (!runtimeNames.has(runtime) && current?.runtime !== runtime) {
    throw new Error(`runtime "${runtime}" is not provided by a stationed runtime fitting`);
  }
  const params: Record<string, string | number | boolean> = { ...(current?.params ?? {}) };
  if (update.promptMode === null) delete params.promptMode;
  else params.promptMode = update.promptMode;
  if (update.maxTurns === null) delete params.maxTurns;
  else params.maxTurns = update.maxTurns;
  const nextTarget: CompositionTarget = {
    id: targetId,
    runtime,
    model: modelName,
    ...(update.provider?.trim() ? { provider: update.provider.trim() } : {}),
    ...(Object.keys(params).length ? { params } : {})
  };
  const nextTargets = composition.targets.map((target, index) =>
    index === currentIndex ? nextTarget : target
  );
  if (currentIndex === -1) nextTargets.push(nextTarget);

  const resolved = resolveModel({
    fittings: entries.map((entry) => ({ id: entry.id, metadata: entry.metadata })),
    compositionDuties: composition.duties,
    selectedDuties: composition.selectedDuties
  });
  if (originalId && originalId !== targetId) {
    const used = Object.values(resolved.duties).some((duty) =>
      duty.levels.some((level) => level.cell?.target === originalId)
    );
    if (used) throw new Error(`target "${originalId}" is assigned to a duty cell and cannot be renamed`);
  }
  for (const duty of Object.values(resolved.duties)) {
    for (const level of duty.levels) {
      if (!level.cell) continue;
      const errors = validateCellCompatibility(level.cell, nextTargets);
      if (errors.length) {
        throw new Error(`target update would invalidate duty "${duty.id}": ${errors[0].message}`);
      }
    }
  }

  await mutateCompositionBlock(id, (block) => {
    block.targets = nextTargets;
  });
  return assembleMusterModel(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Standing Fittings (GARRISON-UNIFY-V1 D12, slice S5b). The non-duty half of the
// Muster page: the infrastructure faculty slots (channels/gateway/runtimes/…)
// each showing its current fitting(s), config, health, and a swap picker. This
// section owns the fitting SELECTIONS axis; the Duties section (above) owns the
// duty-routing axis. Writes go through writeStandingSelections — validate →
// re-author apm deps → atomic write — the same discipline the S5a cell/duty
// writers use, extended to membership changes (which must re-author deps).

// The standing faculty slots this section surfaces: the infrastructure roles.
// EXCLUDES `orchestrator`/`modes` (behavior — the Orchestrator panel, S5c) and
// the optional capability faculties (Compose's capability blocks). A fitting
// that PROVIDES kind:duty is a duty fitting and is filtered out even when it
// sits inside a standing slot, so the Duties section stays its only home.
const STANDING_FACULTIES: FacultyId[] = [
  "channels",
  "gateway",
  "runtimes",
  "memory",
  "observability",
  "sessions",
  "surfaces",
  "connectors"
];

export interface StandingFittingView {
  id: string;
  name: string;
  summary: string;
  faculty: FacultyId;
  componentShape: FittingShape;
  clonedFrom?: string;
  // own-port fitting → the client overlays live health from /api/fittings/views.
  ownPort: boolean;
  // provides kind:runtime → eligible to be the composition's primary runtime.
  providesRuntime: boolean;
  isPrimaryRuntime: boolean;
  configSchema: ConfigSchemaField[];
  config: Record<string, string | number | boolean>;
}

// A pickable library entry for a slot's swap picker (the D9 library picker,
// scoped to the slot's faculty — seed + local + clones).
export interface StandingCandidate {
  id: string;
  name: string;
  summary: string;
  clonedFrom?: string;
}

export interface StandingSlot {
  faculty: FacultyId;
  facultyName: string;
  // What the role does (facultyRoleCopy.role) — the card's one-line subhead.
  role: string;
  cardinality: Cardinality;
  fittings: StandingFittingView[];
  candidates: StandingCandidate[];
}

// A runtime template the create-runtime flow can clone from.
export interface RuntimeTemplate {
  id: string;
  name: string;
  summary: string;
  clonable: boolean;
}

export interface StandingModel {
  compositionId: string;
  compositionName: string;
  slots: StandingSlot[];
  runtimeTemplates: RuntimeTemplate[];
  primaryRuntime: string;
}

function providesKind(entry: LibraryEntry, kind: string): boolean {
  return entry.metadata.provides.some((p) => p.kind === kind);
}

// The pure core: composition selections + resolved entries + library in, the
// standing model out. No fs — callers hand it data, tests hand it fixtures.
export function buildStandingPayload(args: {
  composition: { id: string; name: string; selections: FittingSelectionMap; primaryRuntime: string };
  entries: LibraryEntry[];
  library: LibraryEntry[];
}): StandingModel {
  const byId = new Map(args.entries.map((entry) => [entry.id, entry]));
  const slots: StandingSlot[] = STANDING_FACULTIES.map((facultyId) => {
    const faculty = getFaculty(facultyId);
    const selected = args.composition.selections[facultyId] ?? [];
    const fittings: StandingFittingView[] = [];
    for (const selection of selected) {
      const entry = byId.get(selection.id);
      if (!entry) continue; // unknown id — validateCompositionSelections surfaces it
      if (providesKind(entry, "duty")) continue; // a duty fitting lives in the Duties section
      fittings.push({
        id: entry.id,
        name: entry.name,
        summary: entry.summary,
        faculty: facultyId,
        componentShape: entry.metadata.component_shape,
        clonedFrom: entry.cloned_from,
        ownPort: entry.metadata.own_port === true,
        providesRuntime: providesKind(entry, "runtime"),
        isPrimaryRuntime: facultyId === "runtimes" && entry.id === args.composition.primaryRuntime,
        configSchema: entry.metadata.config_schema,
        config: sanitizeConfig(selection.config ?? {})
      });
    }
    const candidates: StandingCandidate[] = args.library
      .filter((entry) => entry.faculty === facultyId && !providesKind(entry, "duty"))
      .map((entry) => ({ id: entry.id, name: entry.name, summary: entry.summary, clonedFrom: entry.cloned_from }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      faculty: facultyId,
      facultyName: faculty.name,
      role: facultyRoleCopy[facultyId].role,
      cardinality: faculty.cardinality,
      fittings,
      candidates
    };
  });

  const runtimeTemplates: RuntimeTemplate[] = args.library
    .filter((entry) => entry.faculty === "runtimes" && providesKind(entry, "runtime"))
    .map((entry) => ({ id: entry.id, name: entry.name, summary: entry.summary, clonable: Boolean(entry.localPath) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    compositionId: args.composition.id,
    compositionName: args.composition.name,
    slots,
    runtimeTemplates,
    primaryRuntime: args.composition.primaryRuntime
  };
}

// The default primary when the composition names none — the historical
// gateway/PTY engine (mirrors GlobalConfig.primary_runtime's documented default).
const DEFAULT_PRIMARY_RUNTIME = "claude-code-runtime";

export async function assembleStandingModel(compositionId?: string): Promise<StandingModel> {
  const id = await resolveCompositionId(compositionId);
  const composition = await readComposition(id);
  const entries = await selectedLibraryEntries(composition.selections);
  const library = await readLibrary();
  return buildStandingPayload({
    composition: {
      id: composition.id,
      name: composition.name,
      selections: composition.selections,
      primaryRuntime:
        (await resolvePrimaryFromPolicy(composition.directory)) ??
        composition.globalConfig.primary_runtime ??
        DEFAULT_PRIMARY_RUNTIME
    },
    entries,
    library
  });
}

function assertStandingFaculty(faculty: string): FacultyId {
  if (!(STANDING_FACULTIES as string[]).includes(faculty)) {
    throw new Error(`"${faculty}" is not a standing faculty slot`);
  }
  return faculty as FacultyId;
}

// Mutate the whole manifest atomically (temp+rename, 0600-preserving). Unlike
// mutateCompositionBlock this exposes the top-level manifest so a membership
// change can re-author dependencies.apm alongside x-garrison.composition.
async function mutateManifestAtomic(
  compositionId: string,
  mutate: (manifest: Manifest) => void
): Promise<void> {
  const manifestPath = getCompositionManifestPath(compositionId);
  const manifest = await readYamlFile<Manifest>(manifestPath);
  if (!manifest || !manifest["x-garrison"]?.composition) {
    throw new Error(`composition "${compositionId}" has no x-garrison.composition block`);
  }
  mutate(manifest);
  const raw = dumpYaml(manifest, { lineWidth: 100, noRefs: true, sortKeys: false });
  await writeFileAtomic(manifestPath, raw);
}

// Persist a whole new selections map: validate first (cardinality + faculty
// compatibility), re-author the apm dependency list from the resulting
// membership (else a swapped-in fitting would never install), then write both
// x-garrison.composition.selections and dependencies.apm in one atomic pass.
// Everything else in the manifest (duties/targets/global_config/…) round-trips
// untouched because the mutator only assigns those two keys.
async function writeStandingSelections(
  compositionId: string,
  nextSelections: FittingSelectionMap
): Promise<void> {
  await validateCompositionSelections(nextSelections);
  const entries = await selectedLibraryEntries(nextSelections);
  const dependencies = authorApmDependencies(
    entries.map((entry) =>
      entry.localPath ? { absPath: path.join(ROOT_DIR, entry.localPath) } : { repo: entry.repo }
    ),
    getCompositionDirectory(compositionId)
  );
  await mutateManifestAtomic(compositionId, (manifest) => {
    const block = manifest["x-garrison"]!.composition!;
    block.selections = nextSelections;
    const deps =
      manifest.dependencies && typeof manifest.dependencies === "object"
        ? (manifest.dependencies as Record<string, unknown>)
        : {};
    manifest.dependencies = { ...deps, apm: dependencies };
  });
}

function cloneSelections(selections: FittingSelectionMap): FittingSelectionMap {
  const out: FittingSelectionMap = {};
  for (const [key, items] of Object.entries(selections)) {
    out[key as FacultyId] = (items ?? []).map((s) => ({ id: s.id, config: { ...(s.config ?? {}) } }));
  }
  return out;
}

// Build the next selections for a swap in one faculty slot. Single-cardinality
// slots hold exactly one fitting (toId replaces it; no toId clears it). Multi
// slots replace fromId with toId (or add / remove when only one side is given),
// never duplicating a fitting already present.
function applyStandingSwap(
  selections: FittingSelectionMap,
  facultyId: FacultyId,
  change: { toId?: string; fromId?: string },
  library: LibraryEntry[]
): FittingSelectionMap {
  const faculty = getFaculty(facultyId);
  const next = cloneSelections(selections);
  const current = next[facultyId] ?? [];

  let toSelection: SelectedFitting | undefined;
  if (change.toId) {
    const entry = library.find((e) => e.id === change.toId);
    if (!entry) throw new Error(`unknown fitting "${change.toId}"`);
    toSelection = defaultConfigForEntry(entry);
  }

  let updated: SelectedFitting[];
  if (faculty.cardinality === "single") {
    updated = toSelection ? [toSelection] : [];
  } else if (change.fromId) {
    const idx = current.findIndex((s) => s.id === change.fromId);
    if (idx === -1) {
      // An explicit fromId that is NOT a current selection is a malformed request
      // (codex S5b finding) — reject it rather than silently adding toId, which
      // would change membership from a bad id.
      throw new Error(`cannot swap: "${change.fromId}" is not currently stationed`);
    } else if (toSelection) {
      updated = current.some((s) => s.id === toSelection!.id)
        ? current.filter((s) => s.id !== change.fromId) // toId already present — collapse the dup
        : current.map((s, i) => (i === idx ? toSelection! : s));
    } else {
      updated = current.filter((s) => s.id !== change.fromId); // removal
    }
  } else if (toSelection) {
    updated = current.some((s) => s.id === toSelection!.id) ? current : [...current, toSelection];
  } else {
    updated = current;
  }

  if (updated.length === 0) delete next[facultyId];
  else next[facultyId] = updated;
  return next;
}

// A consumer left without a provider by a swap (reference loss). Surfaced to the
// UI so it can OFFER removal (a confirm) — never auto-removed.
export interface OrphanedConsumer {
  fittingId: string;
  faculty: FacultyId;
  kind: string;
  name?: string;
  message: string;
}

function missingRequiredKey(issue: CapabilityIssue): string {
  return `${issue.fittingId}|${issue.kind}|${issue.name ?? ""}`;
}

// The consumers newly orphaned by a swap: missing-required capability issues
// present AFTER the swap that were not present before it.
function newlyOrphaned(
  before: CapabilityIssue[],
  after: CapabilityIssue[],
  afterEntries: LibraryEntry[]
): OrphanedConsumer[] {
  const had = new Set(before.filter((i) => i.code === "missing-required").map(missingRequiredKey));
  const facultyById = new Map(afterEntries.map((e) => [e.id, e.faculty]));
  return after
    .filter((i) => i.code === "missing-required" && !had.has(missingRequiredKey(i)))
    .map((i) => ({
      fittingId: i.fittingId,
      faculty: (facultyById.get(i.fittingId) ?? "channels") as FacultyId,
      kind: i.kind,
      name: i.name,
      message: i.message
    }));
}

export interface StandingSwapResult {
  model: StandingModel;
  orphaned: OrphanedConsumer[];
}

// Swap the fitting in a standing slot. `toId` is placed; `fromId` (multi slots)
// is the one it replaces. Validates + persists atomically, then reports any
// consumer the swap orphaned (never removes it — the UI offers that).
export async function swapStandingFitting(
  compositionId: string | undefined,
  faculty: string,
  toId?: string,
  fromId?: string
): Promise<StandingSwapResult> {
  const id = await resolveCompositionId(compositionId);
  const facultyId = assertStandingFaculty(faculty);
  const composition = await readComposition(id);
  const library = await readLibrary();

  const beforeEntries = await selectedLibraryEntries(composition.selections);
  const beforeIssues = computeCapabilityResolution(beforeEntries).issues;

  const nextSelections = applyStandingSwap(composition.selections, facultyId, { toId, fromId }, library);
  await writeStandingSelections(id, nextSelections);

  const afterEntries = await selectedLibraryEntries(nextSelections);
  const afterIssues = computeCapabilityResolution(afterEntries).issues;
  const orphaned = newlyOrphaned(beforeIssues, afterIssues, afterEntries);

  return { model: await assembleStandingModel(id), orphaned };
}

// Autosave one config value into a standing fitting's selection. A config edit
// does not change membership, so deps re-author to the same list — writing
// through writeStandingSelections keeps a single validated, atomic write path.
export async function setStandingConfig(
  compositionId: string | undefined,
  faculty: string,
  fittingId: string,
  key: string,
  value: string | number | boolean
): Promise<StandingModel> {
  const id = await resolveCompositionId(compositionId);
  const facultyId = assertStandingFaculty(faculty);
  const composition = await readComposition(id);
  const current = composition.selections[facultyId] ?? [];
  if (!current.some((s) => s.id === fittingId)) {
    throw new Error(`fitting "${fittingId}" is not stationed in ${facultyId}`);
  }
  const next = cloneSelections(composition.selections);
  next[facultyId] = (next[facultyId] ?? []).map((s) =>
    s.id === fittingId ? { id: s.id, config: { ...s.config, [key]: value } } : s
  );
  await writeStandingSelections(id, next);
  return assembleStandingModel(id);
}

// Make a stationed runtime the composition's primary runtime (the engine that
// runs the orchestrator loop). routing.json is the runner's source of truth;
// remove the deprecated manifest fallback after the policy write succeeds.
export async function setPrimaryRuntime(
  compositionId: string | undefined,
  fittingId: string
): Promise<StandingModel> {
  const id = await resolveCompositionId(compositionId);
  const composition = await readComposition(id);
  const runtimes = composition.selections.runtimes ?? [];
  const selected = runtimes.find((selection) => selection.id === fittingId);
  if (!selected) {
    throw new Error(`"${fittingId}" is not a stationed runtime — station it before making it primary`);
  }

  // Config fields display their schema defaults even when an older manifest has
  // an empty selection.config. Once this runtime becomes executable policy,
  // materialise those displayed values so runner.up() receives the same model /
  // provider the operator just saw (for example Codex -> gpt-5-codex, not the
  // gateway's historical opus fallback). Explicit values always win.
  const entries = await selectedLibraryEntries(composition.selections);
  const entry = entries.find((candidate) => candidate.id === fittingId);
  if (!entry || !providesKind(entry, "runtime")) {
    throw new Error(`"${fittingId}" is not a stationed runtime — station it before making it primary`);
  }
  const defaults = defaultConfigForEntry(entry).config ?? {};
  const missingDefault = Object.keys(defaults).some(
    (key) => selected.config?.[key] === undefined
  );
  if (missingDefault) {
    const nextSelections = cloneSelections(composition.selections);
    nextSelections.runtimes = (nextSelections.runtimes ?? []).map((selection) =>
      selection.id === fittingId
        ? { id: selection.id, config: { ...defaults, ...(selection.config ?? {}) } }
        : selection
    );
    // Persist before publishing the primary policy: a runner can never observe
    // the new primary id while its displayed defaults are still absent.
    await writeStandingSelections(id, nextSelections);
  }
  await writePrimaryRuntimeToPolicy(composition.directory, fittingId);
  await mutateManifestAtomic(id, (manifest) => {
    const block = manifest["x-garrison"]!.composition!;
    if (block.global_config && typeof block.global_config === "object") {
      delete (block.global_config as Record<string, unknown>).primary_runtime;
    }
  });
  return assembleStandingModel(id);
}

export interface CreateRuntimeResult {
  model: StandingModel;
  newFittingId: string;
}

// Create a new runtime by cloning a runtime template, then station the clone in
// the runtimes slot with its default config. The UI then configures it, tests
// it, and (optionally) sets it primary. cloneFitting throws CloneError (with a
// status) on a bad/duplicate id — the route maps that to the HTTP status.
export async function createRuntime(
  compositionId: string | undefined,
  templateId: string,
  newId?: string
): Promise<CreateRuntimeResult> {
  const id = await resolveCompositionId(compositionId);
  const library = await readLibrary();
  const template = library.find((e) => e.id === templateId);
  if (!template) throw new Error(`unknown runtime template "${templateId}"`);
  if (template.faculty !== "runtimes" || !providesKind(template, "runtime")) {
    throw new Error(`"${templateId}" is not a runtime template`);
  }
  const clone = await cloneFitting(templateId, newId ? { newId } : {});

  const composition = await readComposition(id);
  const next = cloneSelections(composition.selections);
  const runtimes = next.runtimes ?? [];
  if (!runtimes.some((s) => s.id === clone.id)) runtimes.push(defaultConfigForEntry(clone));
  next.runtimes = runtimes;
  await writeStandingSelections(id, next);

  return { model: await assembleStandingModel(id), newFittingId: clone.id };
}

export interface RuntimeCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface RuntimeTestResult {
  fittingId: string;
  ok: boolean;
  checks: RuntimeCheck[];
  // Transparency: this is a static readiness check, not a live model handshake.
  note: string;
}

// Test a stationed runtime's connection. Honest scope: a STATIC readiness check
// (stationed, is-a-runtime, declares an override mechanism, required config set)
// — not a live model round-trip, which needs the fitting installed + the runtime
// bridge spawned (that happens when the operative starts). The note says so.
export async function testRuntimeConnection(
  compositionId: string | undefined,
  fittingId: string
): Promise<RuntimeTestResult> {
  const id = await resolveCompositionId(compositionId);
  const composition = await readComposition(id);
  const library = await readLibrary();
  const entry = library.find((e) => e.id === fittingId);
  const selection = (composition.selections.runtimes ?? []).find((s) => s.id === fittingId);

  const checks: RuntimeCheck[] = [];
  checks.push({
    label: "Stationed",
    ok: Boolean(selection),
    detail: selection ? undefined : "not stationed in the runtimes slot"
  });
  checks.push({
    label: "Is a runtime",
    ok: Boolean(entry && providesKind(entry, "runtime")),
    detail: entry ? (providesKind(entry, "runtime") ? undefined : "does not provide kind:runtime") : "fitting not found"
  });
  const mechanism = entry?.metadata.provider_mechanism;
  checks.push({
    label: "Override mechanism",
    ok: Boolean(mechanism),
    detail: mechanism ? mechanism.type : "no provider_mechanism declared"
  });
  const config = selection?.config ?? {};
  const missing = (entry?.metadata.config_schema ?? [])
    .filter((f) => f.required)
    .filter((f) => config[f.key] === undefined || config[f.key] === "");
  checks.push({
    label: "Required config set",
    ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.map((f) => f.key).join(", ")}` : undefined
  });

  return {
    fittingId,
    ok: checks.every((c) => c.ok),
    checks,
    note: "Static readiness check (stationing, runtime kind, override mechanism, required config). A live model handshake runs when the operative starts."
  };
}
