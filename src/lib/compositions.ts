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
import { resolvePrimaryFromPolicy } from "./routing-primary";

export const DEFAULT_COMPOSITION_ID = "default";

const DEFAULT_ORCHESTRATOR_PROMPT = [
  "<!--",
  "Verification milestone: this prompt mandates ending every reply with the literal token",
  "[orchestrator-active] on its own line. The token is load-bearing for scripts/integration-check.mjs",
  "and tests/orchestrator-integration.test.ts. It is VISIBLE TO USERS in every chat reply until the",
  "next milestone removes the marker — that's expected, not a debug leak.",
  "",
  "Changes to this prompt only take effect on a session restart (Stop → Run). The HTTP gateway",
  "passes systemPrompt.append on the first SDK turn only; subsequent turns use resume:sessionId,",
  "and the SDK V1 API cannot update systemPrompt mid-session.",
  "-->",
  "",
  "# Agent Garrison Orchestrator",
  "",
  "You are the behavior spine for a local Agent Garrison session.",
  "Coordinate installed Faculties, respect configured guardrails, report every meaningful action, and verify before claiming success.",
  "",
  "## Operating discipline",
  "",
  "- Be concise. State the result first; details follow only if useful.",
  "- Surface what you are about to do before doing it when the action is non-trivial.",
  "- If a request is ambiguous, ask one focused question rather than guessing.",
  "- If you cannot complete something, say so directly and explain what's blocking you.",
  "",
  "## Tools and Faculties available in this Composition",
  "",
  "Treat this list as the authoritative inventory of what's installed in this Composition — each provider's usage guidance is indented under its line:",
  "",
  // Load-bearing: the runner substitutes the resolved providers (with their
  // for_consumers guidance) here at assembly time — the locality principle.
  // Without it, assembleSystemPrompt warns and the session flies blind.
  "{{capabilities}}",
  "",
  "If a Faculty isn't in that list, the capability is not installed — say so and surface the missing Faculty as an installation suggestion. Don't fabricate tools.",
  "",
  "## Register",
  "",
  "Speak caveman in every reply. Drop articles, filler, pleasantries, hedging.",
  "Fragments fine. Short synonyms. Technical terms, code, identifiers and error",
  "strings stay exact. Pattern: `[thing] [action] [reason]. [next step].`",
  "",
  "Write normally - not caveman - for security warnings, confirmations of",
  "irreversible actions, and any sequence where dropped conjunctions would make the",
  "ORDER ambiguous. Code, commit messages, PR bodies and file contents are artifacts",
  "other people read: never caveman. Resume after.",
  "",
  "Off only on \"stop caveman\" / \"normal mode\".",
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
      ladders?: unknown;
      prompt_sources?: {
        orchestrator: string;
        // Read-only compatibility for pre-v4 manifests. New and rewritten v4
        // compositions author identity inside Orchestrator and never emit it.
        soul?: string;
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

// One rung of a model ladder: a NAMED model tier pointing at a composition
// target. A ladder is ordered floor -> top and a duty escalates by climbing it.
// A rung is model TIER only — orthogonal to a duty LEVEL, which is depth of
// work; effort still comes from the level's cell, never from the rung.
export interface CompositionLadderRung {
  id: string;
  target: string;
}

// Ladders by name (`standard`, `adversarial`, …). A duty names one via
// `ladder:` (absent = `standard`) and picks its starting/ceiling rung by id.
export type CompositionLadders = Record<string, CompositionLadderRung[]>;

// The four v4-only fields a parsed composition carries beyond the v3 shape.
// CompositionV4 extends Composition so every existing `Composition` consumer
// keeps working unchanged; only v4-aware callers read these fields.
export interface CompositionV4 extends Composition {
  // 4 for a v4 file; 3 for any pre-v4 file (absent or non-4 marker).
  schema: number;
  duties: DutySpec[];
  selectedDuties: string[];
  targets: CompositionTarget[];
  // Named model ladders. Optional and additive: a composition that declares
  // none still runs — every duty then falls back to a synthetic one-rung ladder
  // derived from its own level-1 cell (kanban-model.ts).
  ladders?: CompositionLadders;
}

const LEGACY_RUNTIME_ENGINE: Record<string, string> = {
  "agent-sdk-runtime": "agent-sdk",
  "claude-code-runtime": "claude-code",
  "openai-agents-runtime": "openai-agents",
  "codex-runtime": "codex",
  "gemini-runtime": "gemini",
  "cursor-runtime": "cursor",
  "opencode-runtime": "opencode"
};

const DEFAULT_DISPATCH_TARGET = {
  runtime: "agent-sdk",
  provider: "anthropic",
  model: "claude-haiku-4-5"
} as const;

/**
 * One-time compatibility migration for the retired gateway flag. The old flag
 * meant "run routing on whatever the primary happens to be"; v4 records that
 * choice explicitly on dispatch-fast instead. When the old primary cannot be
 * reconstructed, migration deliberately lands on the supported Haiku target:
 * the retired flag must never remain public just because an old composition is
 * incomplete. A present false flag is removed without authoring a new target.
 */
export function migrateLegacyRoutingOnPrimaryManifest(
  manifest: CompositionManifest,
  opts: { primaryRuntimeId?: string | null } = {}
): { changed: boolean; warning?: string } {
  const block = manifest["x-garrison"]?.composition as (CompositionBlock & Record<string, unknown>) | undefined;
  const selections = block?.selections as FittingSelectionMap | undefined;
  const gateways = selections?.gateway ?? [];
  const gateway = gateways.find((item) => item.id === "http-gateway");
  if (!gateway || !block || !Object.prototype.hasOwnProperty.call(gateway.config ?? {}, "routing_on_primary")) {
    return { changed: false };
  }
  const raw = gateway?.config?.routing_on_primary;
  const enabled = raw === true || String(raw ?? "").trim().toLowerCase() === "true";
  if (!enabled) {
    delete gateway.config.routing_on_primary;
    return { changed: true };
  }

  const primaryRuntimeId = typeof opts.primaryRuntimeId === "string" ? opts.primaryRuntimeId.trim() : "";
  const runtimeSelection = primaryRuntimeId
    ? (selections?.runtimes ?? []).find((selection) => selection.id === primaryRuntimeId)
    : undefined;
  const engine = runtimeSelection ? LEGACY_RUNTIME_ENGINE[runtimeSelection.id] : null;
  const duties = Array.isArray(block.duties) ? block.duties as Array<Record<string, unknown>> : [];
  const dispatchDuty = duties.find((duty) => duty.id === "dispatch");
  const targetId = "dispatch-fast";
  const targets = Array.isArray(block.targets) ? block.targets as Array<Record<string, unknown>> : [];
  const targetIndex = targets.findIndex((target) => target.id === targetId);
  const legacyModel = typeof runtimeSelection?.config?.model === "string" && runtimeSelection.config.model.trim()
    ? runtimeSelection.config.model.trim()
    : null;
  const legacyProvider = typeof runtimeSelection?.config?.provider === "string" && runtimeSelection.config.provider.trim()
    ? runtimeSelection.config.provider.trim()
    : undefined;
  const resolved = engine && legacyModel
    ? { runtime: engine, model: legacyModel, ...(legacyProvider ? { provider: legacyProvider } : {}) }
    : DEFAULT_DISPATCH_TARGET;
  const warning = engine && legacyModel
    ? undefined
    : primaryRuntimeId
      ? `legacy routing_on_primary=true could not resolve a model for policy primary "${primaryRuntimeId}"; migrated to dispatch-fast on Claude Haiku 4.5`
      : "legacy routing_on_primary=true had no resolvable policy primary; migrated to dispatch-fast on Claude Haiku 4.5";
  const replacement: Record<string, unknown> = {
    id: targetId,
    ...resolved,
    params: {
      type: "runtime-target",
      promptMode: "lean",
      maxTurns: 1,
      timeoutMs: 8000,
      ...((resolved.runtime === "agent-sdk" || ("provider" in resolved && resolved.provider === "anthropic"))
        ? { authMode: "subscription" }
        : {})
    }
  };
  if (targetIndex >= 0) targets[targetIndex] = replacement;
  else targets.push(replacement);
  block.targets = targets;
  if (!dispatchDuty) {
    duties.push({
      id: "dispatch",
      title: "Dispatch",
      description: "Read an inbound task and route it to the right duty and level.",
      levels: [{
        description: "Bounded routing inference on the explicitly migrated dispatch target.",
        cell: { target: targetId, effort: "low" }
      }]
    });
    block.duties = duties;
  } else {
    const levels = Array.isArray(dispatchDuty.levels) ? dispatchDuty.levels as Array<Record<string, unknown>> : [];
    const first = levels[0];
    if (first) {
      first.cell = {
        ...((first.cell && typeof first.cell === "object") ? first.cell as Record<string, unknown> : {}),
        target: targetId,
        effort: "low"
      };
      delete first.sequence;
    } else {
      dispatchDuty.levels = [{
        description: "Bounded routing inference on the explicitly migrated dispatch target.",
        cell: { target: targetId, effort: "low" }
      }];
    }
  }
  delete gateway.config.routing_on_primary;
  return { changed: true, ...(warning ? { warning } : {}) };
}

function hasLegacyRoutingOnPrimary(manifest: CompositionManifest): boolean {
  const selections = manifest["x-garrison"]?.composition?.selections;
  const gateway = (selections?.gateway ?? []).find((item) => item.id === "http-gateway");
  const raw = gateway?.config?.routing_on_primary;
  return raw === true || String(raw ?? "").trim().toLowerCase() === "true";
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
  context_hold: z.boolean().optional(),
  // S3d (D9b) duty gate: composition-inline duties carry it too - zod strips
  // undeclared keys, so an unlisted `gate` would be silently dropped here exactly
  // as context_hold was. `explicit` holds the card on the duty for an explicit go.
  gate: z.enum(["explicit"]).optional(),
  // Duty ladder lines (Conversations A2). `ladder` names the ladder in
  // x-garrison.composition.ladders this duty climbs (absent = "standard");
  // `default` is the rung a stretch starts on and `ceiling` the highest rung it
  // may reach unaided. Both are RUNG ids, never target ids - the ladder owns the
  // targets, so retargeting a tier is one edit in one place.
  ladder: z.string().min(1).optional(),
  default: z.string().min(1).optional(),
  ceiling: z.string().min(1).optional()
});

// A ladder rung. Kebab-case id (the name a duty's default/ceiling references)
// plus the composition target it resolves to. Rung ids are unique WITHIN a
// ladder - a duplicate makes `default: middle` ambiguous, so it is rejected at
// parse time rather than silently resolving to the first match.
const ladderRungSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, "ladder rung id must be kebab-case"),
  target: z.string().min(1)
});
const laddersSchema = z.record(
  z
    .array(ladderRungSchema)
    .min(1, "a ladder declares at least one rung")
    .superRefine((rungs, ctx) => {
      const seen = new Set<string>();
      for (const rung of rungs) {
        if (seen.has(rung.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `ladder rung "${rung.id}" is declared twice - rung ids are unique within a ladder`
          });
        }
        seen.add(rung.id);
      }
    })
);

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
  ladders?: CompositionLadders;
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
  const ladders = block.ladders === undefined ? undefined : laddersSchema.parse(block.ladders);
  return { schema, duties, selectedDuties, targets, ladders };
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
      // Hidden siblings are private staging directories (for example an
      // in-progress composition clone). Tolerant reads below also ensure a
      // directory being deleted or only partly materialised is never scaffolded
      // back into existence by a list request.
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
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

/**
 * Bootstrap-on-read, confined to the DEFAULT composition.
 *
 * `readComposition` used to call `ensureComposition(id)` for whatever id it was
 * handed, which made every read path a WRITE path: any stale reference to a
 * deleted composition - a fitting still holding GARRISON_COMPOSITION_ID, a
 * scheduler job, a kanban card, an open browser tab - silently re-created it as an
 * empty "Dogfood Operative" skeleton. Deleting a composition could therefore never
 * stick, and the ghost reappeared in the switcher with no way to tell what had
 * resurrected it.
 *
 * A fresh install still needs SOMETHING to exist, so the default id keeps its
 * bootstrap. Every other id must already be on disk; a read of a composition that
 * is not there is an error, not an invitation to invent one.
 */
async function ensureReadableComposition(id: string): Promise<void> {
  if (id === DEFAULT_COMPOSITION_ID) await ensureComposition(id);
}

export async function readComposition(id = DEFAULT_COMPOSITION_ID): Promise<CompositionV4> {
  await ensureReadableComposition(id);
  const manifestPath = getCompositionManifestPath(id);
  const manifest = await readYamlFile<CompositionManifest>(manifestPath);
  if (!manifest) {
    throw new Error(
      `no composition "${id}" - it has no manifest at ${manifestPath}. ` +
        `If something still points at a deleted composition, repoint it; reads never create one.`
    );
  }
  const policyPrimary = hasLegacyRoutingOnPrimary(manifest)
    ? await resolvePrimaryFromPolicy(getCompositionDirectory(id))
    : null;
  const legacy = migrateLegacyRoutingOnPrimaryManifest(manifest, { primaryRuntimeId: policyPrimary });
  if (legacy.changed) await writeYamlFile(manifestPath, manifest);
  if (legacy.warning) console.warn(`[garrison] ${id}: ${legacy.warning}`);
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

  // Derive `unfitted` from the DESIRED set rather than asking callers to track
  // it: the Compose grid and the Muster swap endpoint are independent writers,
  // and any id a caller forgot to add here would silently re-station itself on
  // the next read. A caller that sends no selections at all is not expressing an
  // opt-out, so the stored list is preserved untouched in that case.
  const library = await readLibrary();
  const nextUnfitted = update.selections
    ? deriveUnfitted(nextSelections, library)
    : normalizeUnfitted(current.unfitted);

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
  // Preserve v4 composition-level blocks (schema/duties/selected_duties/targets/ladders)
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
      // Omit the key entirely when nothing is unfitted, so a composition that
      // simply takes every default stays byte-clean in the diff.
      ...(nextUnfitted.length ? { unfitted: nextUnfitted } : {}),
      prompt_sources: {
        orchestrator: ".garrison/prompts/orchestrator.md"
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

  const manifestPath = getCompositionManifestPath(id);
  if (!(await pathExists(manifestPath))) {
    await writeYamlFile(manifestPath, createManifest(id, "Dogfood Operative"));
  }
}

export async function refreshDefaultPrompts(id: string): Promise<{ orchestratorPath: string }> {
  const compositionDir = getCompositionDirectory(id);
  await ensureDir(path.join(compositionDir, ".garrison", "prompts"));
  const orchestratorPath = path.join(compositionDir, ".garrison", "prompts", "orchestrator.md");
  await fs.writeFile(orchestratorPath, DEFAULT_ORCHESTRATOR_PROMPT, "utf8");
  return { orchestratorPath };
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
          orchestrator: ".garrison/prompts/orchestrator.md"
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
    unfitted: normalizeUnfitted((composition as { unfitted?: unknown } | undefined)?.unfitted),
    globalConfig: composition?.global_config ?? defaultGlobalConfig(),
    // Derived Tasks disconnected (decision F4): Trello-as-tasks is retired in
    // favour of the Kanban; no Fitting backs a derived-Tasks surface anymore.
    derivedTasks: undefined,
    capabilityIssues: [],
    capabilityGraph: { consumers: [] },
    schema: v4.schema,
    duties: v4.duties,
    selectedDuties: v4.selectedDuties,
    targets: v4.targets,
    ...(v4.ladders ? { ladders: v4.ladders } : {})
  };
}

export async function readCompositionWithDerivedTasks(id = DEFAULT_COMPOSITION_ID): Promise<CompositionV4> {
  await ensureReadableComposition(id);
  const manifest = await readYamlFile<CompositionManifest>(getCompositionManifestPath(id));
  if (!manifest) {
    throw new Error(
      `no composition "${id}" - it has no manifest. ` +
        `If something still points at a deleted composition, repoint it; reads never create one.`
    );
  }
  const policyPrimary = hasLegacyRoutingOnPrimary(manifest)
    ? await resolvePrimaryFromPolicy(getCompositionDirectory(id))
    : null;
  const legacy = migrateLegacyRoutingOnPrimaryManifest(manifest, { primaryRuntimeId: policyPrimary });
  if (legacy.changed) await writeYamlFile(getCompositionManifestPath(id), manifest);
  if (legacy.warning) console.warn(`[garrison] ${id}: ${legacy.warning}`);
  const overlay = await readLocalOverlay(id);
  const composition = manifestToComposition(id, applyLocalOverlay(manifest, overlay));
  // Station every default-fit Fitting the composition has not unfitted, BEFORE
  // resolving library entries — the capability graph, the readiness rules and the
  // runner all have to see the same set the user sees.
  const library = await readLibrary();
  const withDefaults = applyDefaultFit(composition.selections, library, composition.unfitted);
  const entries = await selectedLibraryEntries(withDefaults);
  // Self-heal selections grouped under a stale faculty key (e.g. fittings
  // saved under `sessions` before the 2026-06-18 split). The UI then always
  // sees the current grouping, and the next save persists it.
  const selections = migrateSelectionsByFaculty(withDefaults, entries);
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

/**
 * Fittings that station themselves in every composition (`x-garrison.default_fit`).
 * Ordered by id so the derived `unfitted` list is stable across saves and a diff
 * never churns.
 */
export function defaultFitEntries(entries: LibraryEntry[]): LibraryEntry[] {
  return entries
    .filter((entry) => entry.metadata.default_fit === true)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Union the stored selections with every `default_fit` Fitting the composition
 * has not explicitly unfitted.
 *
 * Membership in a composition is otherwise presence-based, which cannot express
 * "deliberately not stationed" — so removing an auto-fitted Fitting would be
 * undone by the very next read. `unfitted` is that missing vocabulary, and it is
 * consulted ONLY for default-fit ids: for everything else absence already means
 * absence, and honouring the list there would let a stale entry veto a Fitting
 * the user has since re-added by hand.
 *
 * A stored entry always wins over the default: it carries the user's config.
 */
export function applyDefaultFit(
  selections: FittingSelectionMap,
  entries: LibraryEntry[],
  unfitted: string[] = []
): FittingSelectionMap {
  const excluded = new Set(unfitted);
  const stored = new Set(
    Object.values(selections)
      .flatMap((items) => items ?? [])
      .map((item) => item.id)
  );
  const additions = defaultFitEntries(entries).filter(
    (entry) => !stored.has(entry.id) && !excluded.has(entry.id)
  );
  if (!additions.length) return selections;
  const next: FittingSelectionMap = {};
  for (const [faculty, items] of Object.entries(selections)) {
    next[faculty as FacultyId] = [...(items ?? [])];
  }
  for (const entry of additions) {
    (next[entry.faculty] ??= []).push(defaultConfigForEntry(entry));
  }
  return next;
}

/**
 * The `unfitted` list implied by a desired selection set: every default-fit
 * Fitting the user did NOT ask for. Derived at save time from the full desired
 * map rather than tracked by the UI, so the Compose grid and the Muster swap
 * endpoint — two independent writers — cannot disagree about it.
 */
export function deriveUnfitted(
  selections: FittingSelectionMap,
  entries: LibraryEntry[]
): string[] {
  const selected = new Set(
    Object.values(selections)
      .flatMap((items) => items ?? [])
      .map((item) => item.id)
  );
  return defaultFitEntries(entries)
    .map((entry) => entry.id)
    .filter((id) => !selected.has(id));
}

function normalizeUnfitted(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0))].sort();
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
