import fs from "node:fs/promises";
import path from "node:path";
import { COMPOSITIONS_DIR, ROOT_DIR } from "./paths";
import { ensureDir, pathExists, slugify } from "./fs-utils";
import { authorApmDependencies } from "./apm-manifest";
import { readLibrary } from "./library";
import { validateSelection } from "./metadata";
import { resolveCapabilities, serializeCapabilityGraph } from "./capabilities";
import { facultyIds, dutyEfforts, type CapabilityIssue, type FittingSelectionMap, type Composition, type GlobalConfig, type LibraryEntry, type FacultyId, type SelectedFitting, type SerializedCapabilityGraph, type DutySpec } from "./types";
import { readYamlFile, writeYamlFile } from "./yaml";
import { z } from "zod";

export const DEFAULT_COMPOSITION_ID = "default";

const DEFAULT_ORCHESTRATOR_PROMPT = [
  "<!--",
  "Verification milestone: this prompt mandates ending every reply with the literal token",
  "[orchestrator-active] on its own line. The token is load-bearing for scripts/integration-check.mjs",
  "and tests/orchestrator-integration.test.ts. It is VISIBLE TO USERS in every chat reply until the",
  "next milestone removes the marker — that's expected, not a debug leak.",
  "",
  "Changes to this prompt only take effect on operative restart (Stop → Run). The HTTP gateway",
  "passes systemPrompt.append on the first SDK turn only; subsequent turns use resume:sessionId,",
  "and the SDK V1 API cannot update systemPrompt mid-session.",
  "-->",
  "",
  "# Agent Garrison Orchestrator",
  "",
  "You are the behavior spine for a local Agent Garrison operative.",
  "Coordinate installed Faculties, respect configured guardrails, report every meaningful action, and verify before claiming success.",
  "",
  "## Operating discipline",
  "",
  "- Be concise. State the result first; details follow only if useful.",
  "- Surface what you are about to do before doing it when the action is non-trivial.",
  "- If a request is ambiguous, ask one focused question rather than guessing.",
  "- If you cannot complete something, say so directly and explain what's blocking you.",
  "",
  "## Tools and Faculties available in this Operative",
  "",
  "Treat this list as the authoritative inventory of what's installed in this Composition — each provider's usage guidance is indented under its line:",
  "",
  // Load-bearing: the runner substitutes the resolved providers (with their
  // for_consumers guidance) here at assembly time — the locality principle.
  // Without it, assembleSystemPrompt warns and the Operative flies blind.
  "{{capabilities}}",
  "",
  "If a Faculty isn't in that list, the capability is not installed — say so and surface the missing Faculty as an installation suggestion. Don't fabricate tools.",
  "",
  "## Reply contract",
  "",
  "End every reply with the following token on its own line:",
  "",
  "    [orchestrator-active]",
  "",
  "This is a verification marker proving this prompt reached the model. Do not omit it, even on short replies.",
  ""
].join("\n");

const DEFAULT_SOUL_PROMPT = [
  "# Agent Garrison Soul",
  "",
  "You are called **Verity**. When asked your name, identify yourself as Verity.",
  "",
  "Your character:",
  "",
  "- Direct and transparent. Prefer inspectable steps over hidden behavior.",
  "- Local-first and dogfood-oriented; you live on the user's machine, not in the cloud.",
  "- You do not perform enthusiasm and do not over-apologize.",
  "- You push back kindly when it matters — when a request looks like it'll cause harm, waste effort, or rest on a wrong premise.",
  "- You keep the user informed without theatrics.",
  ""
].join("\n");

interface CompositionManifest {
  name: string;
  version: string;
  target: string;
  dependencies?: {
    apm?: Array<string | { path: string }>;
  };
  "x-garrison"?: {
    composition?: {
      // v4 marker (MARATHON-V3 assumption 6). Absent / any value other than 4
      // is treated as v3 — v3 parsing is byte-for-byte unchanged.
      schema?: number;
      id?: string;
      name?: string;
      global_config?: GlobalConfig;
      selections?: FittingSelectionMap;
      // v4 additions (all optional; empty/absent on v3). Kept as `unknown` here
      // and validated by the zod schemas below — the manifest interface stays a
      // loose parse shape, the schemas are the contract.
      duties?: unknown;
      selected_duties?: unknown;
      targets?: unknown;
      prompt_sources?: {
        orchestrator: string;
        soul: string;
      };
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Composition v4 (MARATHON-V3 assumption 6 + D8). The x-garrison.composition
// block gains `schema: 4` and three composition-level blocks: `duties`
// (definitions/overrides), `selected_duties`, and `targets` (engine identity
// only). Fitting config values stay in `selections[].config` (unchanged). A
// missing/other `schema` value = v3; a v3 file parses exactly as before, with
// empty duties/selected_duties/targets.

// Engine-identity target. Runtime + model + optional provider/params ONLY.
// `effort` is deliberately NOT part of target identity — it lives per-cell in a
// duty level (DutyLevelCell). A target declaring `effort` is rejected loudly.
export interface CompositionTarget {
  id: string;
  runtime: string;
  model: string;
  provider?: string;
  params?: Record<string, string | number | boolean>;
}

// The four v4-only fields a parsed composition carries beyond the v3 shape.
// CompositionV4 extends Composition so every existing `Composition` consumer
// keeps working unchanged; only v4-aware callers read these fields.
export interface CompositionV4 extends Composition {
  // 4 for a v4 file; 3 for any pre-v4 file (absent or non-4 marker).
  schema: number;
  duties: DutySpec[];
  selectedDuties: string[];
  targets: CompositionTarget[];
}

// A machine-local overlay (local.yml beside apm.yml, gitignored). A partial
// mirror of x-garrison.composition holding ONLY global_config + selections[]
// .config values, so a shared composition never carries a home directory or a
// machine port. Deep-merged over the parsed manifest at read (overlay wins).
export interface LocalOverlay {
  global_config?: Partial<GlobalConfig> & Record<string, unknown>;
  selections?: FittingSelectionMap;
}

// The composition-side duty schema. Kept structurally identical to the
// canonical dutySchema in metadata.ts (which owns fitting-side duty parsing but
// does not export its schema). The `DutySpec[]` return annotation in
// parseCompositionV4 is the compile-time lock: if this shape drifts from the
// shared DutySpec type in types.ts, tsc fails. See report note re: exporting
// metadata.ts's dutySchema to collapse these into one runtime schema.
const dutyLevelCellSchema = z.object({
  skill: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  effort: z.enum(dutyEfforts).optional()
});
const dutySequenceEntrySchema = z.object({
  duty: z.string().min(1),
  level: z.number().int().min(1).optional()
});
const dutyLevelSchema = z
  .object({
    description: z.string().min(1, "each duty level needs a one-line description"),
    cell: dutyLevelCellSchema.optional(),
    sequence: z.array(dutySequenceEntrySchema).min(1).optional()
  })
  .superRefine((level, ctx) => {
    if ((level.cell === undefined) === (level.sequence === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a duty level is either a cell (leaf) or a sequence (composite) - exactly one"
      });
    }
  });
const dutySpecSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, "duty id must be kebab-case"),
  title: z.string().min(1),
  description: z.string().min(1),
  levels: z.array(dutyLevelSchema).min(1, "a duty declares at least one level"),
  // S1b compact-controller hold: composition-inline duties carry it too (zod
  // strips undeclared keys, so omitting it here silently dropped the flag).
  context_hold: z.boolean().optional()
});

const compositionTargetSchema = z.object({
  id: z.string().min(1),
  runtime: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1).optional(),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
});

interface ParsedCompositionV4 {
  schema: number;
  duties: DutySpec[];
  selectedDuties: string[];
  targets: CompositionTarget[];
}

type CompositionBlock = NonNullable<NonNullable<CompositionManifest["x-garrison"]>["composition"]>;

// Parse the v4-only blocks out of an x-garrison.composition block. Pure and
// fs-free; exported for unit testing. Throws loudly on a malformed duty, a
// non-string selected duty, or a target that carries `effort`.
export function parseCompositionV4(block: CompositionBlock): ParsedCompositionV4 {
  const rawSchema = typeof block.schema === "number" ? block.schema : 3;
  const schema = rawSchema === 4 ? 4 : 3;
  const duties: DutySpec[] =
    block.duties === undefined ? [] : z.array(dutySpecSchema).parse(block.duties);
  const selectedDuties: string[] =
    block.selected_duties === undefined ? [] : z.array(z.string().min(1)).parse(block.selected_duties);
  const targets = parseCompositionTargets(block.targets);
  return { schema, duties, selectedDuties, targets };
}

function parseCompositionTargets(raw: unknown): CompositionTarget[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("x-garrison.composition.targets must be an array");
  }
  for (const candidate of raw) {
    if (candidate && typeof candidate === "object" && "effort" in candidate) {
      const id = (candidate as { id?: unknown }).id ?? "(unnamed)";
      throw new Error(
        `composition target "${String(id)}" declares an "effort" field. Targets are ` +
          `engine identity only (runtime/model/provider); effort is a per-level cell ` +
          `property (DutyLevelCell). Move effort into the duty level's cell.`
      );
    }
  }
  return z.array(compositionTargetSchema).parse(raw);
}

export function defaultGlobalConfig(): GlobalConfig {
  return {
    projects_root: "~/dev",
    vault: "default",
    platform: "claude-code",
    guardrails: {
      max_tasks_per_tick: 5,
      max_spend_per_day: 25,
      max_tool_calls_per_tick: 30
    },
    permissions_mode: "auto",
    observability_config: {
      log_sink: "runner"
    }
  };
}

export async function listCompositions(): Promise<Composition[]> {
  await ensureDefaultComposition();
  await ensureDir(COMPOSITIONS_DIR);
  const entries = await fs.readdir(COMPOSITIONS_DIR, { withFileTypes: true });
  // Tolerant reads, deliberately NOT readComposition: its ensureComposition
  // would scaffold a manifest back into any directory listed here, resurrecting
  // a composition that is mid-delete (a real race with a concurrent session or
  // test fixture removing one). A directory whose manifest is missing or
  // unreadable is SKIPPED - listing never creates state.
  const compositions = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const manifest = await readYamlFile<CompositionManifest>(getCompositionManifestPath(entry.name));
          if (!manifest) return null;
          const overlay = await readLocalOverlay(entry.name);
          return manifestToComposition(entry.name, applyLocalOverlay(manifest, overlay));
        } catch {
          return null;
        }
      })
  );
  return compositions
    .filter((c): c is CompositionV4 => c !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function readComposition(id = DEFAULT_COMPOSITION_ID): Promise<CompositionV4> {
  await ensureComposition(id);
  const manifestPath = getCompositionManifestPath(id);
  const manifest = await readYamlFile<CompositionManifest>(manifestPath);
  if (!manifest) {
    throw new Error(`Missing manifest for composition ${id}`);
  }
  const overlay = await readLocalOverlay(id);
  return manifestToComposition(id, applyLocalOverlay(manifest, overlay));
}

export async function writeComposition(
  id: string,
  update: {
    name?: string;
    selections?: FittingSelectionMap;
    globalConfig?: GlobalConfig;
  }
): Promise<Composition> {
  await ensureComposition(id);
  const manifestPath = getCompositionManifestPath(id);
  const manifest = (await readYamlFile<CompositionManifest>(manifestPath)) ?? createManifest(id, id);
  const current = manifestToComposition(id, manifest);
  const nextName = update.name ?? current.name;
  const nextSelections = normalizeSelections(update.selections ?? current.selections);
  const nextGlobalConfig = update.globalConfig ?? current.globalConfig;
  await validateCompositionSelections(nextSelections);

  const selectedEntries = await selectedLibraryEntries(nextSelections);
  const dependencies = authorApmDependencies(
    selectedEntries.map((entry) =>
      entry.localPath ? { absPath: path.join(ROOT_DIR, entry.localPath) } : { repo: entry.repo }
    ),
    getCompositionDirectory(id)
  );

  manifest.name = slugify(nextName) || id;
  manifest.version = manifest.version ?? "0.1.0";
  manifest.target = "claude";
  manifest.dependencies = { ...(manifest.dependencies ?? {}), apm: dependencies };
  // Preserve v4 composition-level blocks (schema/duties/selected_duties/targets)
  // this writer does not author. Spreading the previous block first keeps them
  // intact; the explicit keys below overwrite only what this call owns. Without
  // the spread, saving selections from the UI would silently drop the v4 data.
  const previousComposition = manifest["x-garrison"]?.composition ?? {};
  manifest["x-garrison"] = {
    ...(manifest["x-garrison"] ?? {}),
    composition: {
      ...previousComposition,
      id,
      name: nextName,
      global_config: nextGlobalConfig,
      selections: nextSelections,
      prompt_sources: {
        orchestrator: ".garrison/prompts/orchestrator.md",
        soul: ".garrison/prompts/soul.md"
      }
    }
  };
  await writeYamlFile(manifestPath, manifest);
  return readCompositionWithDerivedTasks(id);
}

export function getCompositionDirectory(id: string): string {
  return path.join(COMPOSITIONS_DIR, slugify(id) || DEFAULT_COMPOSITION_ID);
}

export function getCompositionManifestPath(id: string): string {
  return path.join(getCompositionDirectory(id), "apm.yml");
}

export function getCompositionLocalOverlayPath(id: string): string {
  return path.join(getCompositionDirectory(id), "local.yml");
}

// Read the machine-local overlay (local.yml) beside a composition's apm.yml.
// Optional; returns null when absent. Accepts either a bare {global_config,
// selections} document or one nested under x-garrison.composition (a partial
// mirror of the manifest), so a copied manifest fragment works as-is.
export async function readLocalOverlay(id: string): Promise<LocalOverlay | null> {
  const raw = await readYamlFile<Record<string, unknown>>(getCompositionLocalOverlayPath(id));
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const nested = (raw as { "x-garrison"?: { composition?: unknown } })["x-garrison"]?.composition;
  const source = (isPlainObject(nested) ? nested : raw) as {
    global_config?: LocalOverlay["global_config"];
    selections?: FittingSelectionMap;
  };
  const overlay: LocalOverlay = {};
  if (isPlainObject(source.global_config)) overlay.global_config = source.global_config;
  if (isPlainObject(source.selections)) overlay.selections = source.selections;
  return overlay.global_config || overlay.selections ? overlay : null;
}

// Deep-merge the local overlay over a parsed manifest's composition block:
// global_config deep-merges (nested objects merge key-by-key, overlay scalars
// win); selections merge by fitting id within each faculty, with config keys
// shallow-merged per selection (overlay keys win). Returns the manifest
// unchanged when there is nothing to overlay. Pure — never mutates its inputs.
export function applyLocalOverlay(
  manifest: CompositionManifest,
  overlay: LocalOverlay | null
): CompositionManifest {
  if (!overlay || (!overlay.global_config && !overlay.selections)) {
    return manifest;
  }
  const composition = manifest["x-garrison"]?.composition ?? {};
  const mergedComposition: CompositionBlock = { ...composition };
  if (overlay.global_config) {
    mergedComposition.global_config = deepMergePlain(
      (composition.global_config ?? {}) as Record<string, unknown>,
      overlay.global_config
    ) as unknown as GlobalConfig;
  }
  if (overlay.selections) {
    mergedComposition.selections = mergeSelectionConfigs(
      composition.selections ?? {},
      overlay.selections
    );
  }
  return {
    ...manifest,
    "x-garrison": {
      ...(manifest["x-garrison"] ?? {}),
      composition: mergedComposition
    }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Keys that would let a malicious local.yml pollute Object.prototype (codex S3b1
// finding): __proto__ / constructor / prototype are dropped from any merge.
const FORBIDDEN_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMergePlain(
  base: Record<string, unknown>,
  over: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) continue;
    const existing = out[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMergePlain(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Merge overlay selections into base selections by faculty then by fitting id.
// A matching id gets its config shallow-merged (overlay keys win). An id present
// ONLY in the overlay is IGNORED with a warning (codex S3b1 finding): the
// composition file owns MEMBERSHIP (D8); local.yml carries only machine-local
// VALUES for already-selected fittings, so it must never silently add a fitting
// to the composition. Base order is preserved.
function mergeSelectionConfigs(
  base: FittingSelectionMap,
  over: FittingSelectionMap
): FittingSelectionMap {
  const out: FittingSelectionMap = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(over)]);
  for (const key of keys) {
    const facultyKey = key as FacultyId;
    const baseItems = base[facultyKey] ?? [];
    const overItems = over[facultyKey] ?? [];
    const byId = new Map<string, SelectedFitting>(
      baseItems.map((item) => [item.id, { id: item.id, config: { ...(item.config ?? {}) } }])
    );
    for (const item of overItems) {
      const existing = byId.get(item.id);
      if (existing) {
        existing.config = { ...existing.config, ...(item.config ?? {}) };
      } else {
        console.warn(
          `[garrison] local.yml overlay names fitting "${item.id}" (${facultyKey}) not selected in the composition — ignored (the overlay overrides config, it cannot add membership)`
        );
      }
    }
    out[facultyKey] = [...byId.values()];
  }
  return out;
}

export async function ensureDefaultComposition(): Promise<void> {
  await ensureComposition(DEFAULT_COMPOSITION_ID);
}

export async function ensureComposition(id: string): Promise<void> {
  await ensureDir(COMPOSITIONS_DIR);
  const compositionDir = getCompositionDirectory(id);
  await ensureDir(compositionDir);
  await ensureDir(path.join(compositionDir, ".garrison", "prompts"));

  const orchestratorPath = path.join(compositionDir, ".garrison", "prompts", "orchestrator.md");
  if (!(await pathExists(orchestratorPath))) {
    await fs.writeFile(orchestratorPath, DEFAULT_ORCHESTRATOR_PROMPT, "utf8");
  }

  const soulPath = path.join(compositionDir, ".garrison", "prompts", "soul.md");
  if (!(await pathExists(soulPath))) {
    await fs.writeFile(soulPath, DEFAULT_SOUL_PROMPT, "utf8");
  }

  const manifestPath = getCompositionManifestPath(id);
  if (!(await pathExists(manifestPath))) {
    await writeYamlFile(manifestPath, createManifest(id, "Dogfood Operative"));
  }
}

export async function refreshDefaultPrompts(id: string): Promise<{ orchestratorPath: string; soulPath: string }> {
  const compositionDir = getCompositionDirectory(id);
  await ensureDir(path.join(compositionDir, ".garrison", "prompts"));
  const orchestratorPath = path.join(compositionDir, ".garrison", "prompts", "orchestrator.md");
  const soulPath = path.join(compositionDir, ".garrison", "prompts", "soul.md");
  await fs.writeFile(orchestratorPath, DEFAULT_ORCHESTRATOR_PROMPT, "utf8");
  await fs.writeFile(soulPath, DEFAULT_SOUL_PROMPT, "utf8");
  return { orchestratorPath, soulPath };
}

function createManifest(id: string, name: string): CompositionManifest {
  return {
    name: slugify(name) || id,
    version: "0.1.0",
    target: "claude",
    dependencies: {
      apm: []
    },
    "x-garrison": {
      composition: {
        id,
        name,
        global_config: defaultGlobalConfig(),
        selections: {},
        prompt_sources: {
          orchestrator: ".garrison/prompts/orchestrator.md",
          soul: ".garrison/prompts/soul.md"
        }
      }
    }
  };
}

export function manifestToComposition(id: string, manifest: CompositionManifest): CompositionV4 {
  const composition = manifest["x-garrison"]?.composition;
  const selections = normalizeSelections(composition?.selections ?? {});
  const v4 = parseCompositionV4(composition ?? {});
  return {
    id: composition?.id ?? id,
    name: composition?.name ?? manifest.name,
    directory: getCompositionDirectory(id),
    manifestPath: getCompositionManifestPath(id),
    selections,
    globalConfig: composition?.global_config ?? defaultGlobalConfig(),
    // Derived Tasks disconnected (decision F4): Trello-as-tasks is retired in
    // favour of the Kanban; no Fitting backs a derived-Tasks surface anymore.
    derivedTasks: undefined,
    capabilityIssues: [],
    capabilityGraph: { consumers: [] },
    schema: v4.schema,
    duties: v4.duties,
    selectedDuties: v4.selectedDuties,
    targets: v4.targets
  };
}

export async function readCompositionWithDerivedTasks(id = DEFAULT_COMPOSITION_ID): Promise<CompositionV4> {
  await ensureComposition(id);
  const manifest = await readYamlFile<CompositionManifest>(getCompositionManifestPath(id));
  if (!manifest) {
    throw new Error(`Missing manifest for composition ${id}`);
  }
  const overlay = await readLocalOverlay(id);
  const composition = manifestToComposition(id, applyLocalOverlay(manifest, overlay));
  const entries = await selectedLibraryEntries(composition.selections);
  // Self-heal selections grouped under a stale faculty key (e.g. fittings
  // saved under `sessions` before the 2026-06-18 split). The UI then always
  // sees the current grouping, and the next save persists it.
  const selections = migrateSelectionsByFaculty(composition.selections, entries);
  const { issues, graph } = computeCapabilityResolution(entries);
  return {
    ...composition,
    selections,
    // Derived Tasks disconnected (decision F4) — see manifestToComposition.
    derivedTasks: undefined,
    capabilityIssues: issues,
    capabilityGraph: graph
  };
}

export function computeCapabilityIssues(entries: LibraryEntry[]): CapabilityIssue[] {
  return computeCapabilityResolution(entries).issues;
}

export function computeCapabilityResolution(entries: LibraryEntry[]): {
  issues: CapabilityIssue[];
  graph: SerializedCapabilityGraph;
} {
  const result = resolveCapabilities(
    entries.map((entry) => ({ id: entry.id, metadata: entry.metadata }))
  );
  const graph = serializeCapabilityGraph(result.graph);
  if (result.ok) {
    return { issues: [], graph };
  }
  const issues = result.errors.map((error) => ({
    fittingId: error.fittingId,
    code: error.code,
    kind: error.kind,
    name: error.name,
    message: error.message
  }));
  return { issues, graph };
}

export async function selectedLibraryEntries(selections: FittingSelectionMap): Promise<LibraryEntry[]> {
  const library = await readLibrary();
  const selectedIds = new Set(
    Object.values(selections)
      .flatMap((items) => items ?? [])
      .map((item) => item.id)
  );
  return library.filter((entry) => selectedIds.has(entry.id));
}

export async function validateCompositionSelections(selections: FittingSelectionMap): Promise<void> {
  const library = await readLibrary();
  const byId = new Map(library.map((entry) => [entry.id, entry]));
  for (const facultyId of facultyIds) {
    const selected = selections[facultyId] ?? [];
    const metadata = selected.map((item) => {
      const entry = byId.get(item.id);
      if (!entry) {
        throw new Error(`Unknown fitting ${item.id}`);
      }
      return entry.metadata;
    });
    validateSelection(facultyId, selected.length, metadata);
  }
}

function normalizeSelections(selections: FittingSelectionMap): FittingSelectionMap {
  const normalized: FittingSelectionMap = {};
  for (const facultyId of facultyIds) {
    const items = selections[facultyId];
    if (!items || items.length === 0) {
      continue;
    }
    normalized[facultyId] = items.map((item) => ({
      id: item.id,
      config: item.config ?? {}
    }));
  }
  return normalized;
}

/**
 * Re-bucket each selected fitting under its CURRENT library faculty (by id),
 * preserving config. Self-heals compositions saved before a faculty move — e.g.
 * the 2026-06-18 sessions -> sessions/runtimes/surfaces split: a fitting left
 * under a stale role key migrates to its real role on read, and the next save
 * persists the correction. Unknown ids keep their stored key so validation can
 * still surface them. Returns the original map unchanged when nothing moved.
 */
export function migrateSelectionsByFaculty(
  selections: FittingSelectionMap,
  entries: LibraryEntry[]
): FittingSelectionMap {
  const facultyById = new Map(entries.map((entry) => [entry.id, entry.faculty]));
  const migrated: FittingSelectionMap = {};
  let moved = false;
  for (const [key, items] of Object.entries(selections)) {
    for (const item of items ?? []) {
      const target = (facultyById.get(item.id) ?? key) as FacultyId;
      if (target !== key) moved = true;
      (migrated[target] ??= []).push(item);
    }
  }
  return moved ? migrated : selections;
}

export function defaultConfigForEntry(entry: LibraryEntry): SelectedFitting {
  return {
    id: entry.id,
    config: Object.fromEntries(
      entry.metadata.config_schema
        .filter((field) => field.default !== undefined)
        .map((field) => [field.key, field.default as string | number | boolean])
    )
  };
}
