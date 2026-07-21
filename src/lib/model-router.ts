import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "./paths";
import type { LibraryEntry } from "./types";

export const ROUTING_MARKER_PREFIX = "<!-- garrison:routing v1";

export const taskTypes = [
  "code",
  "review",
  "research",
  "image",
  "video",
  "writing",
  "ops",
  "other"
] as const;

export const routeTiers = ["T0-trivial", "T1-standard", "T2-deep"] as const;
export const effortLevels = ["low", "medium", "high", "xhigh", "ultracode"] as const;
export const targetTypes = ["native-model", "skill", "workflow", "ollama"] as const;
export const continuationVerbs = ["store", "ask", "route", "notify"] as const;

export type TaskType = (typeof taskTypes)[number];
export type RouteTier = (typeof routeTiers)[number];
export type EffortLevel = (typeof effortLevels)[number];
export type TargetType = (typeof targetTypes)[number];
export type ContinuationVerb = (typeof continuationVerbs)[number];

export interface RouterClassification {
  taskType: TaskType;
  tier: RouteTier;
  contextKind?: string;
  matchedException?: string;
}

export interface RouterTarget {
  id: string;
  label: string;
  type: TargetType;
  enabled?: boolean;
  model?: string;
  effort?: EffortLevel;
  providerModel?: string;
  skill?: string;
  workflow?: string;
  description?: string;
}

export interface RoutingException {
  id: string;
  description?: string;
  taskType?: TaskType;
  tier?: RouteTier;
  contextKind?: string;
  promptIncludes?: string;
  target: string;
}

export interface DisciplineSettings {
  review: "none" | "self-review" | `review-by:${string}`;
  testing: "none" | "tests" | "full-gates";
  evidence: "none" | "text" | "table" | "gate-status" | "video";
  distribution: "none" | "link" | `channel:${string}` | `automation:${string}`;
}

export interface ContinuationRule {
  id: string;
  verb: ContinuationVerb;
  when: string;
  instruction: string;
}

export interface RouterProfile {
  id: string;
  label: string;
  inherits?: string;
  defaultTarget: string;
  exceptions?: RoutingException[];
  matrix?: Partial<Record<TaskType, Partial<Record<RouteTier, string>>>>;
  discipline: Record<RouteTier, DisciplineSettings>;
  continuations: ContinuationRule[];
}

export interface RoutingConfig {
  version: 1;
  activeProfile: string;
  targets: RouterTarget[];
  profiles: RouterProfile[];
  pool?: {
    enabled: boolean;
    size: number;
    maxSessions: number;
    maxTurns: number;
    idleTimeoutMs: number;
    classifierModel: string;
    slashInjection?: "unknown" | "works" | "respawn-fallback";
  };
}

export interface ResolvedRoute {
  classification: RouterClassification;
  profile: RouterProfile;
  target: RouterTarget;
  matchedRule: string;
  inheritedFrom?: string;
  honored: boolean;
  mismatch?: string;
}

const taskTypeSet = new Set<string>(taskTypes);
const tierSet = new Set<string>(routeTiers);
const effortSet = new Set<string>(effortLevels);
const targetTypeSet = new Set<string>(targetTypes);
const verbSet = new Set<string>(continuationVerbs);

export function validateRoutingConfig(config: RoutingConfig): string[] {
  const errors: string[] = [];
  if (config.version !== 1) errors.push("version must be 1");
  const targetIds = new Set<string>();
  for (const target of config.targets ?? []) {
    if (!isSlug(target.id)) errors.push(`target id is invalid: ${target.id}`);
    if (targetIds.has(target.id)) errors.push(`duplicate target id: ${target.id}`);
    targetIds.add(target.id);
    if (!targetTypeSet.has(target.type)) errors.push(`target ${target.id} has unknown type ${target.type}`);
    if (target.effort && !effortSet.has(target.effort)) {
      errors.push(`target ${target.id} has unknown effort ${target.effort}`);
    }
    if (target.type === "native-model" && !target.model) errors.push(`native target ${target.id} needs model`);
    if (target.type === "skill" && !target.providerModel) {
      errors.push(`skill target ${target.id} needs providerModel`);
    }
    if (target.type === "workflow" && !target.workflow) errors.push(`workflow target ${target.id} needs workflow`);
  }

  const profileIds = new Set<string>();
  for (const profile of config.profiles ?? []) {
    if (!isSlug(profile.id)) errors.push(`profile id is invalid: ${profile.id}`);
    if (profileIds.has(profile.id)) errors.push(`duplicate profile id: ${profile.id}`);
    profileIds.add(profile.id);
  }
  if (!profileIds.has(config.activeProfile)) errors.push(`activeProfile not found: ${config.activeProfile}`);

  for (const profile of config.profiles ?? []) {
    if (profile.inherits && !profileIds.has(profile.inherits)) {
      errors.push(`profile ${profile.id} inherits missing profile ${profile.inherits}`);
    }
    if (!targetIds.has(profile.defaultTarget)) {
      errors.push(`profile ${profile.id} defaultTarget missing: ${profile.defaultTarget}`);
    }
    for (const exception of profile.exceptions ?? []) {
      if (!isSlug(exception.id)) errors.push(`profile ${profile.id} exception id invalid: ${exception.id}`);
      if (exception.taskType && !taskTypeSet.has(exception.taskType)) {
        errors.push(`exception ${exception.id} taskType invalid: ${exception.taskType}`);
      }
      if (exception.tier && !tierSet.has(exception.tier)) {
        errors.push(`exception ${exception.id} tier invalid: ${exception.tier}`);
      }
      if (!targetIds.has(exception.target)) {
        errors.push(`exception ${exception.id} target missing: ${exception.target}`);
      }
    }
    for (const [taskType, row] of Object.entries(profile.matrix ?? {})) {
      if (!taskTypeSet.has(taskType)) errors.push(`profile ${profile.id} matrix task invalid: ${taskType}`);
      for (const [tier, target] of Object.entries(row ?? {})) {
        if (!tierSet.has(tier)) errors.push(`profile ${profile.id} matrix tier invalid: ${tier}`);
        if (!targetIds.has(target)) {
          errors.push(`profile ${profile.id} matrix ${taskType}/${tier} target missing: ${target}`);
        }
      }
    }
    for (const tier of routeTiers) {
      const discipline = profile.discipline?.[tier];
      if (!discipline) errors.push(`profile ${profile.id} missing discipline for ${tier}`);
    }
    for (const rule of profile.continuations ?? []) {
      if (!isSlug(rule.id)) errors.push(`profile ${profile.id} continuation id invalid: ${rule.id}`);
      if (!verbSet.has(rule.verb)) {
        errors.push(`profile ${profile.id} continuation ${rule.id} invalid verb ${rule.verb}`);
      }
    }
  }

  return errors;
}

export async function readRoutingConfig(filePath: string): Promise<RoutingConfig> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as RoutingConfig;
}

export async function writeRoutingConfig(filePath: string, config: RoutingConfig): Promise<void> {
  const errors = validateRoutingConfig(config);
  if (errors.length > 0) throw new Error(errors.join("; "));
  await fs.writeFile(filePath, `${stableJson(config)}\n`, "utf8");
}

export function compileRoutingMarkdown(config: RoutingConfig, profileId = config.activeProfile): string {
  const errors = validateRoutingConfig(config);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const profile = getProfile(config, profileId);
  const lines: string[] = [];
  lines.push(`${ROUTING_MARKER_PREFIX} profile=${profile.id} -->`);
  lines.push("# Model Routing Policy");
  lines.push("");
  lines.push(`Active profile: ${profile.id} (${profile.label})`);
  lines.push("");
  lines.push("Every assistant reply must end with `[route: <target-id> | rule: <id> | profile: <name>]`.");
  lines.push("The gateway pre-routes user prompts, writes telemetry, and may switch or restart the interactive Claude TUI to honor the selected target.");
  lines.push("Continue to preserve `[orchestrator-active]` in replies.");
  lines.push("");
  lines.push("## Targets");
  for (const target of config.targets) {
    const state = target.enabled === false ? "disabled" : "active";
    const details = targetDetails(target);
    lines.push(`- ${target.id} (${target.type}, ${state})${details ? ` — ${details}` : ""}`);
  }
  lines.push("");
  lines.push("## Matrix");
  for (const taskType of taskTypes) {
    const cells = routeTiers.map((tier) => {
      const route = resolveMatrixCell(config, profile, taskType, tier);
      return `${tier}: ${route.targetId} (${route.rule})`;
    });
    lines.push(`- ${taskType}: ${cells.join("; ")}`);
  }
  lines.push("");
  lines.push("## Ordered Exceptions");
  const exceptions = collectExceptions(config, profile);
  if (exceptions.length === 0) {
    lines.push("- none");
  } else {
    for (const item of exceptions) {
      const e = item.exception;
      const criteria = [
        e.taskType ? `taskType=${e.taskType}` : null,
        e.tier ? `tier=${e.tier}` : null,
        e.contextKind ? `contextKind=${e.contextKind}` : null,
        e.promptIncludes ? `promptIncludes=${JSON.stringify(e.promptIncludes)}` : null
      ].filter(Boolean).join(", ");
      lines.push(`- ${e.id} [${item.profileId}] -> ${e.target}${criteria ? ` when ${criteria}` : ""}`);
    }
  }
  lines.push("");
  lines.push("## Discipline");
  for (const tier of routeTiers) {
    const d = resolveDiscipline(config, profile, tier);
    lines.push(`- ${tier}: review=${d.review}; testing=${d.testing}; evidence=${d.evidence}; distribution=${d.distribution}`);
  }
  lines.push("");
  lines.push("## Continuations");
  const continuations = collectContinuations(config, profile);
  if (continuations.length === 0) {
    lines.push("- none");
  } else {
    for (const item of continuations) {
      const c = item.rule;
      lines.push(`- ${c.id} [${item.profileId}] ${c.verb}: when ${c.when}; ${c.instruction}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function resolveRoute(
  config: RoutingConfig,
  classification: RouterClassification,
  profileId = config.activeProfile,
  prompt = ""
): ResolvedRoute {
  const errors = validateRoutingConfig(config);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const profile = getProfile(config, profileId);
  const route = resolveRouteId(config, profile, classification, prompt, new Set());
  const target = config.targets.find((candidate) => candidate.id === route.targetId);
  if (!target) throw new Error(`resolved missing target: ${route.targetId}`);
  const honored = target.enabled !== false && target.type !== "ollama";
  return {
    classification,
    profile,
    target,
    matchedRule: route.rule,
    inheritedFrom: route.inheritedFrom,
    honored,
    mismatch: honored ? undefined : `target ${target.id} is disabled`
  };
}

export function parseClassifierReply(reply: string): RouterClassification {
  const json = extractJsonObject(reply);
  const parsed = JSON.parse(json) as Partial<RouterClassification>;
  const taskType = parsed.taskType;
  const tier = parsed.tier;
  if (!taskType || !taskTypeSet.has(taskType)) throw new Error(`classifier returned invalid taskType: ${taskType}`);
  if (!tier || !tierSet.has(tier)) throw new Error(`classifier returned invalid tier: ${tier}`);
  return {
    taskType,
    tier,
    ...(typeof parsed.contextKind === "string" ? { contextKind: parsed.contextKind } : {}),
    ...(typeof parsed.matchedException === "string" ? { matchedException: parsed.matchedException } : {})
  };
}

export function heuristicClassify(prompt: string): RouterClassification {
  const lower = prompt.toLowerCase();
  let taskType: TaskType = "other";
  if (/\b(review|diff|pr|pull request)\b/.test(lower)) taskType = "review";
  else if (/\b(research|find|latest|source|cite)\b/.test(lower)) taskType = "research";
  else if (/\b(image|photo|picture|render|illustration)\b/.test(lower)) taskType = "image";
  else if (/\b(video|walkthrough|recording)\b/.test(lower)) taskType = "video";
  else if (/\b(write|draft|copy|email|doc)\b/.test(lower)) taskType = "writing";
  else if (/\b(deploy|ops|cron|incident|server|scheduler)\b/.test(lower)) taskType = "ops";
  else if (/\b(code|implement|fix|test|bug|refactor|typescript|python|api)\b/.test(lower)) taskType = "code";
  const tier: RouteTier =
    prompt.length < 120 && !/\b(deep|architecture|migration|end-to-end|e2e|full)\b/.test(lower)
      ? "T0-trivial"
      : /\b(deep|architecture|migration|security|full|e2e|end-to-end|critical)\b/.test(lower) || prompt.length > 1200
        ? "T2-deep"
        : "T1-standard";
  return { taskType, tier };
}

export function replyRouteToken(route: Pick<ResolvedRoute, "target" | "matchedRule" | "profile">): string {
  return `[route: ${route.target.id} | rule: ${route.matchedRule} | profile: ${route.profile.id}]`;
}

export function findRoutingConfigPath(entries: LibraryEntry[]): string | null {
  // The orchestrator fitting was renamed from model-router (GARRISON-UNIFY-V1
  // S2); accept the legacy id so a not-yet-migrated composition still resolves.
  const entry = entries.find(
    (candidate) => (candidate.id === "orchestrator" || candidate.id === "model-router") && candidate.localPath
  );
  if (!entry?.localPath) return null;
  const configPath = path.resolve(ROOT_DIR, entry.localPath, "routing.json");
  if (!configPath.startsWith(ROOT_DIR + path.sep)) return null;
  return configPath;
}

function resolveRouteId(
  config: RoutingConfig,
  profile: RouterProfile,
  classification: RouterClassification,
  prompt: string,
  seen: Set<string>
): { targetId: string; rule: string; inheritedFrom?: string } {
  if (seen.has(profile.id)) throw new Error(`routing profile inheritance cycle at ${profile.id}`);
  seen.add(profile.id);

  for (const exception of profile.exceptions ?? []) {
    if (exceptionMatches(exception, classification, prompt)) {
      return { targetId: exception.target, rule: exception.id };
    }
  }

  const cell = profile.matrix?.[classification.taskType]?.[classification.tier];
  if (cell) {
    return { targetId: cell, rule: `cell:${profile.id}:${classification.taskType}:${classification.tier}` };
  }

  if (profile.inherits) {
    const parent = getProfile(config, profile.inherits);
    const inherited = resolveRouteId(config, parent, classification, prompt, seen);
    return { ...inherited, rule: `inherit:${profile.id}:${inherited.rule}`, inheritedFrom: parent.id };
  }

  return { targetId: profile.defaultTarget, rule: `default:${profile.id}` };
}

function resolveMatrixCell(
  config: RoutingConfig,
  profile: RouterProfile,
  taskType: TaskType,
  tier: RouteTier
): { targetId: string; rule: string } {
  const resolved = resolveRouteId(config, profile, { taskType, tier }, "", new Set());
  return { targetId: resolved.targetId, rule: resolved.rule };
}

function resolveDiscipline(config: RoutingConfig, profile: RouterProfile, tier: RouteTier): DisciplineSettings {
  if (profile.discipline?.[tier]) return profile.discipline[tier];
  if (profile.inherits) return resolveDiscipline(config, getProfile(config, profile.inherits), tier);
  throw new Error(`missing discipline for ${profile.id}/${tier}`);
}

function collectExceptions(
  config: RoutingConfig,
  profile: RouterProfile,
  seen = new Set<string>()
): Array<{ profileId: string; exception: RoutingException }> {
  if (seen.has(profile.id)) return [];
  seen.add(profile.id);
  const local = (profile.exceptions ?? []).map((exception) => ({ profileId: profile.id, exception }));
  if (!profile.inherits) return local;
  return [...local, ...collectExceptions(config, getProfile(config, profile.inherits), seen)];
}

function collectContinuations(
  config: RoutingConfig,
  profile: RouterProfile,
  seen = new Set<string>()
): Array<{ profileId: string; rule: ContinuationRule }> {
  if (seen.has(profile.id)) return [];
  seen.add(profile.id);
  const local = (profile.continuations ?? []).map((rule) => ({ profileId: profile.id, rule }));
  if (!profile.inherits) return local;
  return [...local, ...collectContinuations(config, getProfile(config, profile.inherits), seen)];
}

function exceptionMatches(
  exception: RoutingException,
  classification: RouterClassification,
  prompt: string
): boolean {
  if (exception.taskType && exception.taskType !== classification.taskType) return false;
  if (exception.tier && exception.tier !== classification.tier) return false;
  if (exception.contextKind && exception.contextKind !== classification.contextKind) return false;
  if (exception.promptIncludes && !prompt.toLowerCase().includes(exception.promptIncludes.toLowerCase())) {
    return false;
  }
  return true;
}

function getProfile(config: RoutingConfig, profileId: string): RouterProfile {
  const profile = config.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`unknown routing profile: ${profileId}`);
  return profile;
}

function targetDetails(target: RouterTarget): string {
  if (target.type === "native-model") {
    return `model=${target.model}; effort=${target.effort ?? "medium"}`;
  }
  if (target.type === "skill") {
    return `skill=${target.skill ?? target.id}; providerModel=${target.providerModel}`;
  }
  if (target.type === "workflow") {
    return `workflow=${target.workflow}`;
  }
  return "Coming soon";
}

function isSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(value);
}

function extractJsonObject(reply: string): string {
  const trimmed = reply.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("classifier did not return a JSON object");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForJson(value), null, 2);
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortForJson((value as Record<string, unknown>)[key]);
  }
  return out;
}
