import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ROOT_DIR } from "./paths";
import { garrisonDir } from "./claude-home";
import { writeFileAtomic } from "./atomic-write";
import { readComposition, selectedLibraryEntries } from "./compositions";
import { computeKanbanResolvedModel } from "./kanban-model";
import {
  deriveRuntimeTargets,
  mergeRuntimeTargets,
  type RouterTarget,
  type RuntimeEntry
} from "./runtime-selection";
import type { CompositionV4 } from "./compositions";
import type { FittingSelectionMap, LibraryEntry } from "./types";

// The routing-policy read/write surface for the Muster Orchestrator tab
// (successor to the retired own-port composer server's GET/PUT /routing +
// POST /simulate). Same contract: whole-document, baseline-sha guarded,
// validated + compiled BEFORE persisting, policy.json recompiled on every
// accepted write so routing.json (source of truth) and policy.json (derived
// cache) never diverge. The compile path mirrors runner.resolveRoutingSection:
// composed runtime fittings merge in as targets, then the composition's duty
// ladders repoint the matrix rows (applyDutyCells) — the Muster duties stay
// the routing truth.

const ROUTING_CORE_PATH = path.join(
  ROOT_DIR,
  "fittings/seed/orchestrator/lib/routing-core.mjs"
);
const SEED_ROUTING_PATH = path.join(
  ROOT_DIR,
  "fittings/seed/orchestrator/config/routing.seed.json"
);

// Loose view of the v2 policy config — routing.json is owned by the fitting's
// routing-core, not typed here; readers narrow the few fields they touch.
export type PolicyConfig = Record<string, unknown> & {
  activeProfile?: string;
  profiles?: Record<string, unknown>;
  targets?: RouterTarget[];
  primaryRuntime?: string;
  defaultWorkKind?: string;
  workKinds?: Record<string, { phasePlan?: string; description?: string }>;
  projects?: Record<string, { security_sensitive?: boolean }>;
  uxQa?: { severityThreshold?: string };
};

interface RoutingCore {
  isV2: (c: unknown) => boolean;
  migrateRoutingConfig: (c: unknown) => PolicyConfig;
  validateRoutingConfig: (c: unknown) => string[];
  compilePolicy: (c: unknown, profile?: string | null) => unknown;
  stableStringify: (v: unknown) => string;
  applyDutyCells: (c: unknown, m: unknown) => unknown;
  resolveRoute: (
    c: unknown,
    profile: string | null,
    classification: { taskType: string; tier: string; matchedException?: string | null }
  ) => { targetId?: string; ruleId?: string; target?: Record<string, unknown> | null };
  railFor: (c: unknown, workKind?: string | null) => TryItRail;
  classifyExecution: (input: {
    message: string;
    classification: { taskType: string; tier: string };
  }) => string;
  DEFAULT_PRIMARY_RUNTIME_ID: string;
}

async function loadRoutingCore(): Promise<RoutingCore> {
  // webpackIgnore keeps the fully-dynamic specifier out of the Next bundle —
  // without it webpack compiles this into an empty lazy context that rejects
  // every request (the empty-{{routing}} incident, see runner.ts).
  return (await import(
    /* webpackIgnore: true */ pathToFileURL(ROUTING_CORE_PATH).href
  )) as unknown as RoutingCore;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const scopedRoutingPath = (compositionDir: string) =>
  path.join(compositionDir, ".garrison", "routing.json");

export interface PolicyReadResult {
  config: PolicyConfig;
  baselineSha: string;
}

// Read the composition-scoped routing.json, seeding it from the fitting's seed
// config on first touch (like the retired server's loadConfigRaw) so the PUT
// baseline guard always covers the bytes actually on disk. A v1 file is
// migrated to v2 IN PLACE (original preserved as <path>.v1.bak, never
// clobbering an existing backup) — the retired server did this at startup;
// with no server the read path owns it. The baselineSha stays over the bytes
// actually on disk after any seeding/migration.
export async function readRoutingPolicy(compositionDir: string): Promise<PolicyReadResult> {
  const target = scopedRoutingPath(compositionDir);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch {
    raw = await fs.readFile(SEED_ROUTING_PATH, "utf8");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, raw);
  }
  const core = await loadRoutingCore();
  let parsed = JSON.parse(raw) as unknown;
  if (!core.isV2(parsed)) {
    const migrated = core.migrateRoutingConfig(parsed);
    const backup = `${target}.v1.bak`;
    try {
      await fs.access(backup);
    } catch {
      await writeFileAtomic(backup, JSON.stringify(parsed, null, 2) + "\n");
    }
    raw = JSON.stringify(migrated, null, 2) + "\n";
    await writeFileAtomic(target, raw);
    parsed = migrated;
  }
  const config = await backfillSeedSections(parsed as PolicyConfig);
  return { config, baselineSha: sha256(raw) };
}

// A composition-scoped routing.json created before a seed section landed (or
// degraded to empty machinery) renders a policy panel with no rails and runs
// with no coordination/gate config. Backfill the absent-or-empty sections from
// the fitting seed — served, not persisted: the baselineSha stays over the
// disk bytes, and the next accepted whole-document write heals the file.
//
// The phase machinery (phases / workKinds / phasePlans / phaseSkills /
// defaultWorkKind) backfills as ONE coherent group, and only when the config
// carries no work kinds and no phase plans of its own: seed phase-skill
// bindings reference seed phases (e.g. security-review), so filling one member
// against a config's own phase list produces a config that fails its own
// validation.
const INDEPENDENT_SECTIONS = ["coordination", "uxQa", "projects"] as const;
const PHASE_GROUP = ["phases", "workKinds", "phasePlans", "phaseSkills", "defaultWorkKind"] as const;

function sectionEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) return true;
    // {bindings: {}, overrides: {}} — structurally present, semantically empty.
    return keys.every((k) => {
      const inner = record[k];
      return (
        inner === undefined ||
        inner === null ||
        (typeof inner === "object" && !Array.isArray(inner) && Object.keys(inner as object).length === 0)
      );
    });
  }
  return false;
}

async function backfillSeedSections(config: PolicyConfig): Promise<PolicyConfig> {
  const missingIndependent = INDEPENDENT_SECTIONS.filter((key) => sectionEmpty(config[key]));
  const phaseGroupEmpty = sectionEmpty(config.workKinds) && sectionEmpty(config["phasePlans"]);
  if (missingIndependent.length === 0 && !phaseGroupEmpty) return config;
  const seed = JSON.parse(await fs.readFile(SEED_ROUTING_PATH, "utf8")) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...config };
  for (const key of missingIndependent) {
    if (seed[key] !== undefined) next[key] = structuredClone(seed[key]);
  }
  if (phaseGroupEmpty) {
    for (const key of PHASE_GROUP) {
      if (seed[key] !== undefined) next[key] = structuredClone(seed[key]);
    }
  }
  return next as PolicyConfig;
}

export type PolicyWriteResult =
  | { status: "conflict"; currentSha: string }
  | { status: "invalid"; errors: string[] }
  | { status: "ok"; baselineSha: string; warnings: string[] };

// Mirror of runner.buildRuntimeEntries: the composition's stationed runtime
// fittings in selection order, reduced to what deriveRuntimeTargets needs.
function runtimeEntriesFor(
  entries: LibraryEntry[],
  selections: FittingSelectionMap
): RuntimeEntry[] {
  return (selections.runtimes ?? []).map((selection) => {
    const entry = entries.find((candidate) => candidate.id === selection.id);
    return {
      id: selection.id,
      provides: entry?.metadata.provides ?? [],
      config: selection.config ?? {}
    };
  });
}

// Best-effort duty model (same degradation as runner.safeKanbanModel): a
// malformed duty graph degrades to the un-repointed routing.json rather than
// blocking the write.
function safeDutyModel(
  composition: Pick<CompositionV4, "id" | "duties" | "selectedDuties"> &
    Partial<Pick<CompositionV4, "targets">>,
  entries: LibraryEntry[]
): ReturnType<typeof computeKanbanResolvedModel> | null {
  try {
    return computeKanbanResolvedModel(composition, entries);
  } catch {
    return null;
  }
}

// Whole-document policy write. Validate + compile FIRST — a config that
// validates but cannot compile is never persisted (routing.json and
// policy.json must not diverge). Commit order: routing.json (source of truth)
// first, policy.json (derived cache) second; a crash between the two heals at
// the next up() recompile, preserving the edit.
export async function writeRoutingPolicy(
  compositionId: string,
  next: unknown,
  baseline?: string | null
): Promise<PolicyWriteResult> {
  const composition = await readComposition(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  return writeRoutingPolicyForComposition(composition, entries, next, baseline);
}

// The fs-scoped core, injectable for tests: everything about the composition
// arrives as data, so a sandboxed directory + synthetic entries exercise the
// full guard/compile/commit path without touching the checkout's compositions.
export type PolicyWriteComposition = Pick<
  CompositionV4,
  "id" | "directory" | "selections" | "duties" | "selectedDuties"
> &
  Partial<Pick<CompositionV4, "targets">>;

export async function writeRoutingPolicyForComposition(
  composition: PolicyWriteComposition,
  entries: LibraryEntry[],
  next: unknown,
  baseline?: string | null
): Promise<PolicyWriteResult> {
  const { baselineSha: currentSha } = await readRoutingPolicy(composition.directory);
  if (baseline && baseline !== currentSha) {
    return { status: "conflict", currentSha };
  }
  const core = await loadRoutingCore();
  if (!core.isV2(next)) {
    return {
      status: "invalid",
      errors: [
        "routing.json must be v2 (policyVersion 2); v1 configs are migrated at load, not accepted on PUT"
      ]
    };
  }
  const errors = core.validateRoutingConfig(next);
  if (errors.length) return { status: "invalid", errors };

  // Primary-runtime guard: an explicit non-default primaryRuntime must name a
  // STATIONED runtime fitting of this composition (the default id keeps
  // default semantics — the claude-code engine is synthesized even when its
  // fitting is not composed).
  const config = next as PolicyConfig;
  const primary = typeof config.primaryRuntime === "string" ? config.primaryRuntime.trim() : "";
  if (primary && primary !== core.DEFAULT_PRIMARY_RUNTIME_ID) {
    const stationed = new Set((composition.selections.runtimes ?? []).map((s) => s.id));
    if (!stationed.has(primary)) {
      return {
        status: "invalid",
        errors: [
          `primaryRuntime "${primary}" is not a stationed runtime fitting of this composition — station it under the runtimes faculty (stationed: ${[...stationed].join(", ") || "none"}), or leave primaryRuntime as ${core.DEFAULT_PRIMARY_RUNTIME_ID}`
        ]
      };
    }
  }

  // Compile exactly what the runner would compile at assembly: runtime-fitting
  // targets merged in, duty ladders repointing the matrix rows.
  let compiled: unknown = mergeRuntimeTargets(
    structuredClone(config) as { targets?: RouterTarget[] },
    deriveRuntimeTargets(runtimeEntriesFor(entries, composition.selections))
  );
  const dutyModel = safeDutyModel(composition, entries);
  let policyBytes: string;
  try {
    if (dutyModel) compiled = core.applyDutyCells(compiled, dutyModel);
    policyBytes = core.stableStringify(
      core.compilePolicy(compiled, config.activeProfile ?? null)
    );
  } catch (err) {
    return {
      status: "invalid",
      errors: [`policy compile failed: ${err instanceof Error ? err.message : String(err)}`]
    };
  }

  const serialized = JSON.stringify(next, null, 2) + "\n";
  await writeFileAtomic(scopedRoutingPath(composition.directory), serialized);
  const policyFile =
    process.env.GARRISON_POLICY_PATH ?? path.join(garrisonDir(), "orchestrator", "policy.json");
  await fs.mkdir(path.dirname(policyFile), { recursive: true });
  await writeFileAtomic(policyFile, policyBytes);
  return { status: "ok", baselineSha: sha256(serialized), warnings: [] };
}

// ── Try-it dry run (port of the retired server's tryIt branch) ───────────────

export interface TryItRailPhase {
  id: string;
  on: boolean;
  skill?: string | null;
  off_reason?: string;
  target?: { targetId?: string; model: string | null; effort: string | null; runtime: string | null };
}

export interface TryItRail {
  evidence?: string;
  phases: TryItRailPhase[];
}

export interface TryItGates {
  securityReview: {
    included: boolean;
    byPlan: boolean;
    byProject: boolean;
    project: string | null;
    reason: string;
  };
  uxQa: { included: boolean; severityThreshold: string; reason: string };
}

export interface TryItResult {
  classification: { taskType: string; tier: string; matchedException: string | null; execution: string };
  workKind: string | null;
  project: string | null;
  rail: TryItRail | { error: string } | null;
  gates: TryItGates | null;
  dryRun: true;
}

// Deterministic keyword heuristic for the dry-run strip — pure, no model. The
// live classifier still runs at the gateway for real turns.
export function heuristicClassify(prompt: string): {
  taskType: string;
  tier: string;
  matchedException: null;
} {
  const p = String(prompt || "").toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => p.includes(w));
  let taskType = "code";
  if (has("research", "investigate", "compare", "find out", "look into")) taskType = "research";
  else if (has("review", "audit")) taskType = "review";
  else if (has("unit test", "e2e", "add a test", "write tests", "test coverage")) taskType = "test";
  else if (has("logo", "icon", "image", "picture", "diagram")) taskType = "image";
  else if (has("video", "screencast", "record a demo")) taskType = "video";
  else if (has("readme", "documentation", " docs", "blog", "draft", "write up")) taskType = "writing";
  else if (has("deploy", "infra", "pipeline", "provision", " ops")) taskType = "ops";
  else if (has("plan ", "design a", "architecture")) taskType = "plan";
  else if (has("implement", "build", "add ", "create", "feature", "fix", "bug", "page", "endpoint", "api"))
    taskType = "implement";
  let tier = "T1-standard";
  if (has("trivial", "rename", "typo", "one-line", "quick tweak", "small fix")) tier = "T0-trivial";
  else if (has("architecture", "migration", "security", "redesign", "overhaul", "whole system", "tricky", "complex"))
    tier = "T2-deep";
  return { taskType, tier, matchedException: null };
}

// Gate reasoning for a dry-run request: whether security-review and ux-qa
// WOULD run for this work kind + project, and why. Pure over the passed config
// + base rail.
function tryItGates(
  config: PolicyConfig,
  baseRail: TryItRail | null,
  workKind: string | null,
  projectLabel: string | null
): TryItGates {
  const phaseOn = (id: string) => {
    const p = (baseRail?.phases || []).find((x) => x.id === id);
    return !!(p && p.on);
  };
  const kindLabel = workKind || config.defaultWorkKind || "the selected work kind";

  const byPlanSec = phaseOn("security-review");
  const project = projectLabel && config.projects ? config.projects[projectLabel] : null;
  const byProjectSec = !!(project && project.security_sensitive);
  let secReason: string;
  if (byPlanSec) secReason = `the ${kindLabel} plan explicitly includes a security-review phase`;
  else if (byProjectSec)
    secReason = `project "${projectLabel}" is marked security-sensitive, so the security-review phase is added`;
  else if (projectLabel)
    secReason = `project "${projectLabel}" is not security-sensitive and the ${kindLabel} plan omits security-review`;
  else
    secReason = `no project selected and the ${kindLabel} plan omits security-review (the classifier never adds it on its own)`;

  const byPlanUx = phaseOn("ux-qa");
  const severityThreshold = config.uxQa?.severityThreshold || "major";
  const uxReason = byPlanUx
    ? `the ${kindLabel} plan includes ux-qa - findings at or above "${severityThreshold}" loop the slice back; below are recorded as notes`
    : `the ${kindLabel} plan omits ux-qa`;

  return {
    securityReview: {
      included: byPlanSec || byProjectSec,
      byPlan: byPlanSec,
      byProject: byProjectSec,
      project: projectLabel || null,
      reason: secReason
    },
    uxQa: { included: byPlanUx, severityThreshold, reason: uxReason }
  };
}

export type SimulateOutcome =
  | { status: "ok"; result: TryItResult }
  | { status: "unknown-profile"; profile: string; known: string[] };

// Deterministic dry-run: heuristic classification + the fully-resolved phase
// rail for the chosen work kind. Every ON chip is enriched with the target it
// resolves to at the classified tier; OFF chips stay in the rail (honesty).
export async function simulateTryIt(
  compositionDir: string,
  input: { prompt: string; workKind?: string | null; project?: string | null }
): Promise<SimulateOutcome> {
  const { config } = await readRoutingPolicy(compositionDir);
  const core = await loadRoutingCore();
  const profile = String(config.activeProfile ?? "");
  if (!config.profiles || !(profile in config.profiles)) {
    return { status: "unknown-profile", profile, known: Object.keys(config.profiles || {}) };
  }
  const classification = heuristicClassify(input.prompt);
  const execution = core.classifyExecution({
    message: String(input.prompt || ""),
    classification
  });
  const workKind = input.workKind || config.defaultWorkKind || null;
  const project = typeof input.project === "string" && input.project ? input.project : null;
  let rail: TryItRail | { error: string };
  let gates: TryItGates | null = null;
  try {
    const base = core.railFor(config, workKind);
    gates = tryItGates(config, base, workKind, project);
    rail = {
      ...base,
      phases: base.phases.map((ph) => {
        if (!ph.on) return ph;
        const r = core.resolveRoute(config, profile, {
          taskType: ph.id,
          tier: classification.tier
        });
        const t = (r.target ?? {}) as { model?: string; effort?: string; runtime?: string };
        return {
          ...ph,
          target: {
            targetId: r.targetId,
            model: t.model ?? null,
            effort: t.effort ?? null,
            runtime: t.runtime ?? null
          }
        };
      })
    };
  } catch (err) {
    rail = { error: err instanceof Error ? err.message : String(err) };
  }
  return {
    status: "ok",
    result: {
      classification: { ...classification, execution },
      workKind,
      project,
      rail,
      gates,
      dryRun: true
    }
  };
}
