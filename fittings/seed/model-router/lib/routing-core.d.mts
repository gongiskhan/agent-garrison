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
export function resolveDiscipline(config: RoutingConfig, profile: string | null, tier: Tier): Discipline;
export function compileRouting(config: RoutingConfig, profile?: string | null): string;
export function routingMarker(profileName: string): string;
export function validateRoutingConfig(config: RoutingConfig): string[];
export function buildClassifierPrompt(config: RoutingConfig, userPrompt: string): string;
export function parseClassification(replyText: string, config: RoutingConfig): Classification | null;
