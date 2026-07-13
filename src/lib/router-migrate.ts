import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { pathExists, ensureDir } from "./fs-utils";
import { unifiedDiff } from "./composition-migrate";
import { dutyEfforts, type DutyEffort, type DutyLevel, type DutyLevelCell, type DutySpec } from "./types";
import type { CompositionTarget } from "./compositions";

// Router-config -> duties migrator (MARATHON-V3 S3c, migration discipline
// constraint 10). Reads a composition's .garrison/routing.json (the v2 policy
// config: taskTypes x tiers matrix, per-profile, effort fused into target
// identity) and folds it into composition v4:
//   - Targets SHED effort: `<engine>-<model>-<effort>` -> engine-identity
//     target `<engine>-<model>` (effort dropped from the id and moved into the
//     leaf cell that referenced it), deduped by resulting id.
//   - Each taskType becomes a DUTY (same id); its levels are indexed by tier
//     (T0-trivial -> level 1, T1-standard -> level 2, T2-deep -> level 3). Each
//     level is a leaf cell {skill, target, effort}. The matrix precedence
//     (cell > row-default > column(tier) > matrix-default) mirrors the runtime
//     resolver (fittings/seed/orchestrator/lib/policy-core.mjs resolveTargetId)
//     exactly - the exception branch is a classifier concern, not folded here.
//   - By-name discipline refs ("review-by:default") are rewritten to
//     duty-level lookups ({duty: "review", level: <tier level>}) and reported.
//   - The ACTIVE profile folds into the given composition; every OTHER profile
//     is emitted as a sibling composition (`<id>-<profile>`) so nothing is lost.
//   - ALL taskTypes become duties[]; selected_duties[] lists only those the
//     active profile explicitly wires (an explicit matrix row). Unselected
//     duties' cells are RETAINED in duties[] so reselection restores them.
//
// Back up routing.json beside itself (routing.json.v3.bak), print a unified
// diff of apm.yml, and refuse to run twice (the .v3.bak marker). The routing
// core (routing-core.mjs / policy-core.mjs) is only READ, never modified - the
// live runtime keeps consuming routing.json until the Dispatcher slice repoints
// it. NO behavior change: effort is read from the target's authoritative
// `.effort` field (what compilePolicy uses today), not from the id suffix or
// the `_effortWas` breadcrumb.

// ── Loose input shapes (routing.json is JSON, not a typed contract here) ──────

export interface RoutingTargetRaw {
  id: string;
  runtime: string;
  model?: string;
  provider?: string | null;
  effort?: string;
  // Everything else (type, authMode, promptMode, maxTurns, leanPrompt, pinned,
  // soul, _effortWas, …) rides through `[k: string]`.
  [key: string]: unknown;
}

interface RoutingMatrix {
  defaults?: { target?: string };
  columns?: Record<string, string>;
  rows?: Record<string, { default?: string; cells?: Record<string, string> }>;
}

interface RoutingProfile {
  matrix?: RoutingMatrix;
  disciplineOverrides?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

export interface RoutingConfig {
  version?: number;
  activeProfile?: string;
  taskTypes?: string[];
  tiers?: string[];
  tierDefinitions?: Record<string, string>;
  targets?: RoutingTargetRaw[];
  profiles?: Record<string, RoutingProfile>;
  discipline?: Record<string, Record<string, string>>;
  phaseSkills?: { bindings?: Record<string, string>; overrides?: Record<string, Record<string, string>> };
  [key: string]: unknown;
}

// ── Effort shedding ──────────────────────────────────────────────────────────

// Runtimes whose target hosts an agent loop (can own/run a skill). garrison-call
// is single-shot and deliberately absent - a skill-shaped cell may never target
// it (validateCellCompatibility). Exported for reuse (S5a Muster live-validation).
export const AGENTIC_RUNTIMES = ["claude-code", "agent-sdk", "codex", "gemini", "opencode"] as const;
const AGENTIC_RUNTIME_SET = new Set<string>(AGENTIC_RUNTIMES);

// Effort tokens that may appear as a target-id suffix. `med` is the historical
// short form of `medium`. These are used ONLY to strip effort from the id
// string; the shed effort VALUE always prefers the target's `.effort` field.
const EFFORT_ID_SUFFIXES: Record<string, DutyEffort> = {
  low: "low",
  med: "medium",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
};

function normalizeEffort(raw: unknown): DutyEffort | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim().toLowerCase();
  if ((dutyEfforts as readonly string[]).includes(key)) return key as DutyEffort;
  if (key in EFFORT_ID_SUFFIXES) return EFFORT_ID_SUFFIXES[key]; // "med" -> "medium"
  return undefined;
}

export interface ShedTarget {
  // The engine-identity target (effort dropped from both id and fields).
  engineTarget: CompositionTarget;
  // The effort that was fused into the original target (moves into cells).
  effort?: DutyEffort;
}

// Turn one routing target into an engine-identity CompositionTarget + the effort
// it sheds. Non-identity, non-effort fields (type, authMode, promptMode,
// maxTurns, leanPrompt, pinned, soul, …) are preserved verbatim under `params`
// so nothing is lost. `_effortWas` (a prior-migration breadcrumb) and `effort`
// (moved to the cell) are dropped from the target.
export function shedTargetEffort(target: RoutingTargetRaw): ShedTarget {
  if (!target || typeof target.id !== "string" || !target.id.length) {
    throw new Error(`routing target has no id: ${JSON.stringify(target)}`);
  }
  if (typeof target.runtime !== "string" || !target.runtime.length) {
    throw new Error(`routing target "${target.id}" has no runtime`);
  }
  if (typeof target.model !== "string" || !target.model.length) {
    throw new Error(`routing target "${target.id}" has no model (needed for engine identity)`);
  }

  const idMatch = /^(.*)-(low|med|medium|high|xhigh|max)$/.exec(target.id);
  const engineId = idMatch ? idMatch[1] : target.id;
  const suffixEffort = idMatch ? EFFORT_ID_SUFFIXES[idMatch[2]] : undefined;
  // Field wins over id suffix (the field is what the runtime actually resolves).
  const effort = normalizeEffort(target.effort) ?? suffixEffort;

  const params: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(target)) {
    if (key === "id" || key === "runtime" || key === "model" || key === "provider") continue;
    if (key === "effort" || key === "_effortWas") continue; // effort -> cell; breadcrumb dropped
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      params[key] = value;
    } else if (value !== null && value !== undefined) {
      // A non-scalar extra field would be dropped silently otherwise - fail loud.
      throw new Error(
        `routing target "${target.id}" field "${key}" is not a scalar (${typeof value}); ` +
          `composition target params only carry string/number/boolean`
      );
    }
  }

  const engineTarget: CompositionTarget = {
    id: engineId,
    runtime: target.runtime,
    model: target.model,
    ...(typeof target.provider === "string" && target.provider.length ? { provider: target.provider } : {}),
    ...(Object.keys(params).length ? { params } : {})
  };
  return { engineTarget, effort };
}

export interface ShedResult {
  // Deduped engine-identity targets (by resulting id).
  targets: CompositionTarget[];
  // Original target id -> its shed identity id + shed effort. Cell resolution
  // maps each resolved matrix targetId through this.
  origIdToShed: Map<string, { id: string; effort?: DutyEffort }>;
}

function engineIdentityKey(t: CompositionTarget): string {
  return JSON.stringify([t.runtime, t.model, t.provider ?? null, t.params ?? null]);
}

// Shed effort from every target and DEDUPE by resulting engine id. Two targets
// that collapse to the same id must share the same engine identity - a genuine
// conflict (same id, different engine) is a config bug and throws loudly.
export function shedTargets(targets: RoutingTargetRaw[] = []): ShedResult {
  const byId = new Map<string, CompositionTarget>();
  const origIdToShed = new Map<string, { id: string; effort?: DutyEffort }>();
  for (const raw of targets) {
    const { engineTarget, effort } = shedTargetEffort(raw);
    origIdToShed.set(raw.id, { id: engineTarget.id, effort });
    const existing = byId.get(engineTarget.id);
    if (existing) {
      if (engineIdentityKey(existing) !== engineIdentityKey(engineTarget)) {
        throw new Error(
          `effort-shedding collision: targets collapse to id "${engineTarget.id}" but differ in ` +
            `engine identity (runtime/model/provider/params). Rename one target.`
        );
      }
      continue; // duplicate engine identity - keep the first
    }
    byId.set(engineTarget.id, engineTarget);
  }
  return { targets: [...byId.values()], origIdToShed };
}

// ── Matrix precedence (mirrors policy-core.mjs resolveTargetId, sans exception) ─
// Exceptions are a classifier concern (keyword pre-match), not a (taskType,tier)
// cell - they are preserved in routing.json.v3.bak, not folded into duty levels.
export function resolveMatrixTarget(
  matrix: RoutingMatrix | undefined,
  taskType: string,
  tier: string
): string | null {
  const m = matrix ?? {};
  const row = (m.rows ?? {})[taskType];
  if (row && row.cells && Object.prototype.hasOwnProperty.call(row.cells, tier)) {
    return row.cells[tier];
  }
  if (row && row.default) return row.default;
  const col = (m.columns ?? {})[tier];
  if (col) return col;
  return (m.defaults ?? {}).target ?? null;
}

// ── Cell compatibility (exported for the Muster UI, S5a) ──────────────────────
export interface CellCompatError {
  code: "skill-without-target" | "skill-unknown-target" | "skill-needs-agentic-target";
  message: string;
}

// A skill-shaped cell (skill set) must run on an AGENTIC target. A cell with no
// skill imposes no runtime constraint (automation/plain-routing cells). Returns
// every violation for the cell (empty = compatible).
export function validateCellCompatibility(cell: DutyLevelCell, targets: CompositionTarget[]): CellCompatError[] {
  if (!cell.skill) return [];
  if (!cell.target) {
    return [
      {
        code: "skill-without-target",
        message: `skill "${cell.skill}" cell has no target; a skill needs an agentic runtime to run on`
      }
    ];
  }
  const target = targets.find((t) => t.id === cell.target);
  if (!target) {
    return [
      {
        code: "skill-unknown-target",
        message: `skill "${cell.skill}" cell targets unknown target "${cell.target}"`
      }
    ];
  }
  if (!AGENTIC_RUNTIME_SET.has(target.runtime)) {
    return [
      {
        code: "skill-needs-agentic-target",
        message:
          `skill "${cell.skill}" cell targets "${cell.target}" (runtime "${target.runtime}"), ` +
          `which is not an agent loop. Skills require an agentic runtime ` +
          `(${AGENTIC_RUNTIMES.join(", ")}); garrison-call is single-shot and ineligible.`
      }
    ];
  }
  return [];
}

// ── Discipline by-name refs ───────────────────────────────────────────────────
export interface DisciplineRef {
  tier: string;
  field: string;
  value: string; // e.g. "review-by:default"
  // The rewrite: run this duty at this level.
  resolved: { duty: string; level: number };
  note: string;
}

function tierLevel(tiers: string[], tier: string): number {
  const idx = tiers.indexOf(tier);
  return idx >= 0 ? idx + 1 : 1;
}

// Scan a profile's effective discipline (base + profile overrides) for by-name
// refs of the form "<field>-by:<name>" (in practice only "review-by:…") and
// rewrite each to a duty-level lookup. "…-by:default" means "run the field's
// duty at the tier's level, resolving its own cell"; "…-by:<target>" additionally
// records the original pinned target for the record.
export function buildDisciplineRefMap(config: RoutingConfig, profileName: string): DisciplineRef[] {
  const tiers = config.tiers ?? [];
  const base = config.discipline ?? {};
  const overrides = (config.profiles ?? {})[profileName]?.disciplineOverrides ?? {};
  const refs: DisciplineRef[] = [];
  for (const tier of tiers) {
    const effective: Record<string, string> = { ...(base[tier] ?? {}), ...(overrides[tier] ?? {}) };
    for (const [field, value] of Object.entries(effective)) {
      if (typeof value !== "string") continue;
      const prefix = `${field}-by:`;
      if (!value.startsWith(prefix)) continue;
      const refName = value.slice(prefix.length);
      refs.push({
        tier,
        field,
        value,
        resolved: { duty: field, level: tierLevel(tiers, tier) },
        note:
          refName === "default"
            ? `run the "${field}" duty at level ${tierLevel(tiers, tier)} (its own resolved cell)`
            : `run the "${field}" duty at level ${tierLevel(tiers, tier)} (was pinned to target "${refName}")`
      });
    }
  }
  return refs;
}

// ── Level descriptions ────────────────────────────────────────────────────────
function firstSentence(text: string): string {
  const match = /^(.*?[.!?])(\s|$)/.exec(text.trim());
  return (match ? match[1] : text).trim();
}

function tierLabel(tier: string): string {
  return tier.replace(/^T\d+-/, "") || tier;
}

function levelDescription(tier: string, tierDefinitions: Record<string, string>, level: number): string {
  const def = tierDefinitions[tier];
  const label = tierLabel(tier);
  if (def && def.trim().length) return `${label} - ${firstSentence(def)}`;
  return `level ${level} (${tier})`;
}

function humanTitle(id: string): string {
  return id
    .split("-")
    .map((part) => (part.length ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

// ── Profile fold ──────────────────────────────────────────────────────────────
export interface CellViolation {
  profile: string;
  duty: string;
  level: number;
  error: CellCompatError;
}

export interface ProfileFold {
  profile: string;
  duties: DutySpec[];
  selectedDuties: string[];
  targets: CompositionTarget[];
  disciplineRefs: DisciplineRef[];
  violations: CellViolation[];
}

// A taskType is "selected" (wired) when the active profile gives it an EXPLICIT
// matrix row - the operator configured it. Unselected task types still resolve
// (via column/matrix default) and their duties are retained, just not listed in
// selected_duties (constraint: reselection restores their cells).
function selectedTaskTypes(config: RoutingConfig, profileName: string): string[] {
  const taskTypes = config.taskTypes ?? [];
  const rows = (config.profiles ?? {})[profileName]?.matrix?.rows ?? {};
  return taskTypes.filter((tt) => Object.prototype.hasOwnProperty.call(rows, tt));
}

// Fold ONE profile into duties[] + selected_duties[] + targets[]. Targets are
// global (shared across profiles); duties differ per profile (cell resolution).
export function foldProfile(
  config: RoutingConfig,
  profileName: string,
  shed: ShedResult
): ProfileFold {
  const profile = (config.profiles ?? {})[profileName];
  if (!profile) throw new Error(`routing config has no profile "${profileName}"`);
  const taskTypes = config.taskTypes ?? [];
  const tiers = config.tiers ?? [];
  const tierDefinitions = config.tierDefinitions ?? {};
  const bindings = config.phaseSkills?.bindings ?? {};
  const targets = shed.targets;

  const duties: DutySpec[] = [];
  const violations: CellViolation[] = [];

  for (const taskType of taskTypes) {
    const skill = bindings[taskType]; // undefined when unbound (source of truth may be empty)
    const levels: DutyLevel[] = tiers.map((tier, index) => {
      const level = index + 1;
      const targetId = resolveMatrixTarget(profile.matrix, taskType, tier);
      const shedForCell = targetId ? shed.origIdToShed.get(targetId) : undefined;
      if (targetId && !shedForCell) {
        throw new Error(
          `profile "${profileName}" cell ${taskType}/${tier} resolves to target "${targetId}" ` +
            `which is not defined in routing.targets`
        );
      }
      const cell: DutyLevelCell = {
        ...(skill ? { skill } : {}),
        ...(shedForCell?.id ? { target: shedForCell.id } : {}),
        ...(shedForCell?.effort ? { effort: shedForCell.effort } : {})
      };
      for (const error of validateCellCompatibility(cell, targets)) {
        violations.push({ profile: profileName, duty: taskType, level, error });
      }
      return { description: levelDescription(tier, tierDefinitions, level), cell };
    });
    duties.push({
      id: taskType,
      title: humanTitle(taskType),
      description: `${humanTitle(taskType)} work (migrated from routing task-type "${taskType}")`,
      levels
    });
  }

  return {
    profile: profileName,
    duties,
    selectedDuties: selectedTaskTypes(config, profileName),
    targets,
    disciplineRefs: buildDisciplineRefMap(config, profileName),
    violations
  };
}

// ── The migrator ──────────────────────────────────────────────────────────────
const YAML_DUMP_OPTS: yaml.DumpOptions = { lineWidth: 100, noRefs: true, sortKeys: false };

export interface SiblingEmission {
  profile: string;
  id: string;
  dir: string;
  apmPath: string;
  selectedDuties: string[];
}

export interface RouterMigrationResult {
  ok: boolean;
  // true when the migrator refused because the .v3.bak marker already exists.
  skipped: boolean;
  reason?: string;
  routingJsonPath: string;
  backupPath: string;
  apmPath: string;
  activeProfile: string;
  // Unified diff of apm.yml (before -> after). Empty when skipped.
  diff: string;
  // The active-profile fold folded into this composition.
  activeFold: ProfileFold | null;
  // Sibling compositions emitted for every non-active profile.
  siblings: SiblingEmission[];
  // Every cell-compatibility violation across all folds (empty on clean data).
  violations: CellViolation[];
}

type ManifestDoc = {
  "x-garrison"?: { composition?: Record<string, unknown>; [k: string]: unknown };
  [k: string]: unknown;
};

function foldIntoCompositionBlock(
  block: Record<string, unknown>,
  fold: ProfileFold,
  overrides: { id?: string; name?: string }
): Record<string, unknown> {
  // schema:4 first (a composition carrying duties/targets IS v4), then the
  // existing keys minus schema, then the folded v4 blocks appended.
  const { schema: _priorSchema, ...rest } = block;
  void _priorSchema;
  const next: Record<string, unknown> = { schema: 4, ...rest };
  if (overrides.id !== undefined) next.id = overrides.id;
  if (overrides.name !== undefined) next.name = overrides.name;
  next.duties = fold.duties;
  next.selected_duties = fold.selectedDuties;
  next.targets = fold.targets;
  return next;
}

export async function migrateRouterConfig(compositionDir: string): Promise<RouterMigrationResult> {
  const routingJsonPath = path.join(compositionDir, ".garrison", "routing.json");
  const backupPath = path.join(compositionDir, ".garrison", "routing.json.v3.bak");
  const apmPath = path.join(compositionDir, "apm.yml");

  const base: Omit<RouterMigrationResult, "ok" | "skipped"> = {
    routingJsonPath,
    backupPath,
    apmPath,
    activeProfile: "",
    diff: "",
    activeFold: null,
    siblings: [],
    violations: []
  };

  // (a) Idempotence: the .v3.bak is the marker. Refuse loudly if present.
  if (await pathExists(backupPath)) {
    return {
      ...base,
      ok: false,
      skipped: true,
      reason:
        `refusing to migrate: ${backupPath} already exists (this composition's router ` +
        `config was already folded into duties). Delete the .v3.bak marker to force a re-run.`
    };
  }

  const rawRouting = await fs.readFile(routingJsonPath, "utf8");
  const config = JSON.parse(rawRouting) as RoutingConfig;
  const activeProfile = config.activeProfile ?? Object.keys(config.profiles ?? {})[0];
  if (!activeProfile || !(config.profiles ?? {})[activeProfile]) {
    throw new Error(`routing config has no resolvable active profile (activeProfile="${config.activeProfile}")`);
  }

  // Shed effort ONCE (targets are global, shared across profiles).
  const shed = shedTargets(config.targets ?? []);

  // Fold every profile. The active one folds into this composition; the rest
  // become siblings (nothing lost, constraint 10).
  const profileNames = Object.keys(config.profiles ?? {});
  const folds = new Map<string, ProfileFold>();
  const violations: CellViolation[] = [];
  for (const name of profileNames) {
    const fold = foldProfile(config, name, shed);
    folds.set(name, fold);
    violations.push(...fold.violations);
  }
  const activeFold = folds.get(activeProfile)!;

  // Fail before writing if the ACTIVE fold has skill/target incompatibilities -
  // never overwrite the live composition with a broken model. (Clean data: none.)
  if (activeFold.violations.length) {
    const lines = activeFold.violations.map((v) => `  - ${v.duty} L${v.level}: ${v.error.message}`);
    throw new Error(`active profile "${activeProfile}" has cell-compatibility violations:\n${lines.join("\n")}`);
  }

  // Load the composition manifest and fold the active profile in.
  const rawApmBefore = await fs.readFile(apmPath, "utf8");
  const manifest = yaml.load(rawApmBefore) as ManifestDoc | null;
  const composition = manifest?.["x-garrison"]?.composition;
  if (!manifest || !composition || typeof composition !== "object") {
    throw new Error(`${apmPath} has no x-garrison.composition block; not a composition manifest`);
  }
  const baseId = (typeof composition.id === "string" && composition.id.length ? composition.id : path.basename(compositionDir));
  const baseName = typeof composition.name === "string" ? composition.name : baseId;

  const migratedComposition = foldIntoCompositionBlock(composition, activeFold, {});
  const migratedManifest: ManifestDoc = {
    ...manifest,
    "x-garrison": { ...(manifest["x-garrison"] ?? {}), composition: migratedComposition }
  };
  const rawApmAfter = yaml.dump(migratedManifest, YAML_DUMP_OPTS);
  const diff = unifiedDiff("apm.yml", rawApmBefore, rawApmAfter);

  // Build sibling composition documents (in memory) for every non-active profile.
  const siblingBaseDir = path.dirname(compositionDir);
  const siblingBaseName = path.basename(compositionDir);
  const siblings: Array<SiblingEmission & { apmBody: string }> = [];
  for (const name of profileNames) {
    if (name === activeProfile) continue;
    const fold = folds.get(name)!;
    const siblingId = `${baseId}-${name}`;
    const siblingDir = path.join(siblingBaseDir, `${siblingBaseName}-${name}`);
    const siblingComposition = foldIntoCompositionBlock(composition, fold, {
      id: siblingId,
      name: `${baseName} (${name})`
    });
    const siblingManifest: ManifestDoc = {
      ...manifest,
      "x-garrison": { ...(manifest["x-garrison"] ?? {}), composition: siblingComposition }
    };
    siblings.push({
      profile: name,
      id: siblingId,
      dir: siblingDir,
      apmPath: path.join(siblingDir, "apm.yml"),
      selectedDuties: fold.selectedDuties,
      apmBody: yaml.dump(siblingManifest, YAML_DUMP_OPTS)
    });
  }

  // Write everything. Siblings + apm.yml first; the .v3.bak marker LAST so a
  // crash mid-write leaves no marker and the re-run is allowed.
  for (const sibling of siblings) {
    await ensureDir(sibling.dir);
    await fs.writeFile(sibling.apmPath, sibling.apmBody, "utf8");
  }
  await fs.writeFile(apmPath, rawApmAfter, "utf8");
  await fs.writeFile(backupPath, rawRouting, "utf8");

  return {
    ...base,
    ok: true,
    skipped: false,
    activeProfile,
    diff,
    activeFold,
    siblings: siblings.map(({ apmBody: _body, ...rest }) => rest),
    violations
  };
}
