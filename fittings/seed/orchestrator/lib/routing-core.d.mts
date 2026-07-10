// Hand-written types for routing-core.mjs so TypeScript consumers (the runner's
// assembly path, the own-port view) get types without a build step.

export type Role = "expert" | "standard" | "fast" | "image" | "video" | "review";
export type TaskType = "code" | "review" | "research" | "image" | "video" | "writing" | "ops" | "other";
export type Tier = "T0-trivial" | "T1-standard" | "T2-deep";
export type ContinuationKind = "plan" | "report" | "document" | "code-change" | "other";
export type ContinuationVerb = "store" | "ask" | "route" | "notify";
export type DisciplineField = "review" | "testing" | "evidence" | "distribution";

export interface RuntimeTarget {
  id: string;
  type: "runtime-target";
  runtime: string;
  provider: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "ultracode";
  soul?: string;
  pinned?: boolean;
  // agent-sdk runtime additions (BRIEF: Agent SDK Runtime). promptMode picks the
  // claude_code preset (full) vs a lean string; capabilities is the per-target
  // capability record the orchestrator reads before routing a block type.
  promptMode?: "full" | "lean";
  baseUrl?: string;
  acceptApiBilling?: boolean;
  capabilities?: {
    text?: boolean;
    toolUse?: boolean;
    image?: boolean;
    document?: boolean;
    webSearch?: boolean;
    mcp?: boolean;
  };
}
export interface SecondaryTarget {
  id: string;
  type: "secondary";
  runtime: string;
}
export interface WorkflowTarget {
  id: string;
  type: "workflow";
  workflow?: string;
}
export type Target = RuntimeTarget | SecondaryTarget | WorkflowTarget;

export interface RoutingException {
  id: string;
  when: string;
  role: Role;
}
export interface MatrixRow {
  default?: Role;
  cells?: Partial<Record<Tier, Role>>;
}
export interface RoutingMatrix {
  defaults?: { role?: Role };
  columns?: Partial<Record<Tier, Role>>;
  rows?: Partial<Record<TaskType, MatrixRow>>;
}
export interface ContinuationStep {
  verb: ContinuationVerb;
  arg?: string;
}
export interface Continuation {
  id: string;
  when: ContinuationKind;
  then: ContinuationStep[];
}
export type Discipline = Record<DisciplineField, string>;
export interface Profile {
  preRoute?: "on" | "off";
  roleMap: Partial<Record<Role, string>>;
  disciplineOverrides?: Partial<Record<Tier, Partial<Discipline>>>;
}
export interface RoutingConfig {
  version: number;
  activeProfile: string;
  roles?: Role[];
  taskTypes?: TaskType[];
  tiers?: Tier[];
  tierDefinitions?: Partial<Record<Tier, string>>;
  exceptions?: RoutingException[];
  matrix?: RoutingMatrix;
  discipline?: Partial<Record<Tier, Discipline>>;
  continuations?: Continuation[];
  targets?: Target[];
  profiles: Record<string, Profile>;
}

export interface Classification {
  taskType: TaskType;
  tier: Tier;
  contextKind?: string;
  matchedException?: string | null;
}
export interface RoleResolution {
  role: Role;
  ruleId: string;
  via: "exception" | "cell" | "row-default" | "column-default" | "global-default";
}
export interface RouteResolution extends RoleResolution {
  profile: string;
  targetId: string | null;
  target: Target | null;
}

export const ROLES: Role[];
export const TASK_TYPES: TaskType[];
export const TIERS: Tier[];
export const CONTINUATION_KINDS: ContinuationKind[];
export const CONTINUATION_VERBS: ContinuationVerb[];
export const DISCIPLINE_FIELDS: DisciplineField[];
export const ROUTING_VERSION: number;

export function resolveRole(config: RoutingConfig, classification: Classification): RoleResolution;
export function resolveRoute(config: RoutingConfig, profile: string | null, classification: Classification): RouteResolution;

// Mode bias (modes faculty): nudge the resolved compute-tier role per a mode's
// {floor, prefer}, then re-map the target. Pure; never mutates config/route.
// floor/prefer are COMPUTE roles only — biasRole ranks via COMPUTE_RANK and leaves
// the task-specific roles (image/video/review) untouched, so the type must not admit
// them (an image/video/review bias would type-check and then silently no-op).
export type ComputeRole = Extract<Role, "fast" | "standard" | "expert">;
export interface ModeBias { floor?: ComputeRole; prefer?: ComputeRole; }
export interface ModesConfigLike {
  modes?: Record<string, { routingBias?: string }>;
  routingBias?: Record<string, ModeBias>;
}
export function biasRole(role: Role, bias: ModeBias | null | undefined): Role;
export function modeBiasFor(mode: string, modesConfig: ModesConfigLike | null | undefined): ModeBias | null;

export function resolveDiscipline(config: RoutingConfig, profile: string | null, tier: Tier): Discipline;
export function compileRouting(config: RoutingConfig, profile?: string | null): string;
export function routingMarker(profileName: string, version?: number): string;
export function validateRoutingConfig(config: RoutingConfig): string[];
export function buildClassifierPrompt(config: RoutingConfig, userPrompt: string): string;
export function parseClassification(replyText: string, config: RoutingConfig): Classification | null;

// ── v2 policy API (GARRISON-UNIFY-V1 S1; implemented in policy-core.mjs,
// re-exported here so routing-core stays the single entry module) ────────────
export type Phase =
  | "plan"
  | "implement"
  | "review"
  | "adversarial-review"
  | "test"
  | "adversarial-test"
  | "design-audit"
  | "walkthrough"
  | "validate"
  | "codex-checkpoint"
  | "report";
export type EvidenceKind = "video" | "logs" | "text" | "none";
export type Execution = "interactive" | "autonomous";

export interface PolicyMatrixRowV2 {
  default?: string;
  cells?: Partial<Record<Tier, string>>;
}
export interface PolicyMatrixV2 {
  defaults?: { target?: string };
  columns?: Partial<Record<Tier, string>>;
  rows?: Record<string, PolicyMatrixRowV2>;
}
export interface PolicyProfileV2 {
  preRoute?: "on" | "off";
  matrix: PolicyMatrixV2;
  computeLadder?: string[];
  disciplineOverrides?: Partial<Record<Tier, Partial<Discipline>>>;
  exceptionOverrides?: Record<string, string>;
}
export interface PolicyExceptionV2 {
  id: string;
  when: string;
  target?: string;
}
export interface PhasePlan {
  phases: Array<string | { id: string; on?: boolean }>;
  evidence?: EvidenceKind;
}
export interface WorkKind {
  phasePlan: string;
  description?: string;
}
export interface PhaseSkills {
  bindings: Record<string, string>;
  overrides: Record<string, Record<string, string>>;
}
export interface Project {
  security_sensitive?: boolean;
  profile?: Record<string, unknown>;
}
export interface PolicyConfigV2 {
  version: 2;
  activeProfile: string;
  taskTypes?: string[];
  tiers?: Tier[];
  tierDefinitions?: Partial<Record<Tier, string>>;
  exceptions?: PolicyExceptionV2[];
  targets?: Target[];
  profiles: Record<string, PolicyProfileV2>;
  discipline?: Partial<Record<Tier, Discipline>>;
  continuations?: Continuation[];
  phases?: string[];
  phasePlans?: Record<string, PhasePlan>;
  workKinds?: Record<string, WorkKind>;
  defaultWorkKind?: string | null;
  phaseSkills?: PhaseSkills;
  projects?: Record<string, Project>;
}

export interface CompiledPolicyCell {
  targetId: string | null;
  rule: string;
  type: string | null;
  runtime: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
}
export interface CompiledPolicy {
  policyVersion: number;
  activeProfile: string;
  preRoute: "on" | "off";
  taskTypes: string[];
  tiers: Tier[];
  tierDefinitions: Partial<Record<Tier, string>>;
  targets: Record<string, Target>;
  computeLadder: string[];
  exceptions: Array<{ id: string; when: string; targetId: string | null }>;
  matrix: Record<string, Record<string, CompiledPolicyCell>>;
  discipline: Record<string, Discipline>;
  continuations: Continuation[];
  phases: string[];
  phasePlans: Record<string, PhasePlan>;
  workKinds: Record<string, WorkKind>;
  defaultWorkKind: string | null;
  phaseSkills: PhaseSkills;
  projects: Record<string, Project>;
}

export interface RailPhase {
  id: string;
  on: boolean;
  off_reason?: "card-toggle" | "phase-plan";
  skill: string | null;
}
export interface Rail {
  workKind: string;
  evidence: EvidenceKind;
  phases: RailPhase[];
}

export const PHASES: Phase[];
export const TASK_TYPES_V2: string[];
export const POLICY_VERSION: number;

export function isV2(config: unknown): config is PolicyConfigV2;
export function migrateRoutingConfig(config: RoutingConfig | PolicyConfigV2): PolicyConfigV2;
export function validatePolicyConfig(config: PolicyConfigV2): string[];
export function resolveRouteV2(
  config: PolicyConfigV2,
  profile: string | null,
  classification: Classification
): RouteResolution;
export function resolveDisciplineV2(config: PolicyConfigV2, profile: string | null, tier: Tier): Discipline;
export function compileRoutingV2(config: PolicyConfigV2, profile?: string | null): string;
export function routingMarkerV2(profileName: string): string;
export function compilePolicy(config: RoutingConfig | PolicyConfigV2, profile?: string | null): CompiledPolicy;
export function stableStringify(value: unknown): string;
export function railFor(
  config: PolicyConfigV2 | CompiledPolicy,
  workKind?: string | null,
  cardToggles?: Record<string, boolean> | null
): Rail;
export function inferPhasePlan(
  config: PolicyConfigV2,
  profile: string | null,
  tier: Tier
): { inferred: true; tier: Tier; evidence: EvidenceKind; phases: Array<{ id: string; on: boolean }> };
export function biasTarget(targetId: string, bias: ModeBias | null | undefined, computeLadder: string[]): string;
export function resolvePhaseTarget(policy: CompiledPolicy, phase: string, tier: string): CompiledPolicyCell;
