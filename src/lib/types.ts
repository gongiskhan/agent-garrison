export const facultyIds = [
  "heartbeat",
  "scheduler",
  "data-sources",
  "knowledge-base",
  "automations",
  "skills",
  "memory",
  "classifier",
  "gateway",
  "channels",
  "observability",
  "soul",
  "orchestrator",
  "artifact-store",
  "terminal",
  "screen-share",
  "worktree-management",
  "session-view",
  "outposts",
  "sync",
  "monitor"
] as const;

export type FacultyId = (typeof facultyIds)[number];

export type Cardinality = "single" | "multi";

export const fittingShapes = [
  "script",
  "agent-instructions",
  "manual-instructions",
  "plugin",
  "skill",
  "cli",
  "hook",
  "system-prompt",
  "cli-skill",
  "mcp"
] as const;

export type FittingShape = (typeof fittingShapes)[number];

export const capabilityKinds = [
  "orchestrator",
  "soul",
  "agent-skill",
  "memory-store",
  "automation-runner",
  "data-source",
  "channel",
  "vault",
  "artifact-store",
  "terminal-session",
  "worktree",
  "session-view",
  "screen-share",
  "outpost",
  "mcp-gateway",
  "monitor"
] as const;

export type CapabilityKind = (typeof capabilityKinds)[number];

export type ConsumeCardinality = "one" | "optional-one" | "any";

export interface CapabilityProvision {
  kind: CapabilityKind;
  name: string;
}

export interface CapabilityConsumption {
  kind: CapabilityKind;
  name?: string;
  cardinality?: ConsumeCardinality;
}

export const singletonCapabilityKinds: readonly CapabilityKind[] = [
  "orchestrator",
  "soul",
  "vault",
  "terminal-session",
  "screen-share",
  "worktree",
  "session-view",
  "monitor"
];

export type PlatformId = "all" | "claude-code" | "codex" | string;

export interface FacultyDefinition {
  id: FacultyId;
  order: number;
  name: string;
  cardinality: Cardinality;
  shapes: FittingShape[];
  notes: string;
  governing?: boolean;
}

export interface ConfigSchemaField {
  key: string;
  type: "string" | "integer" | "number" | "boolean" | "select" | "path" | "secret-ref";
  default?: string | number | boolean;
  description: string;
  required?: boolean;
  options?: string[];
}

export interface SetupStep {
  command: string;
  idempotent: boolean;
  timeout_ms?: number;
}

export const uiPlacements = ["faculty-tab", "sidebar-surface"] as const;
export type UiPlacement = (typeof uiPlacements)[number];

export interface UiView {
  id: string;
  placement: UiPlacement;
  entry: string;
  route: string;
}

export interface SpawnConfig {
  preset: "claude_code" | "none";
  allowed_tools?: string[];
  disallowed_tools?: string[];
  exclude_dynamic_sections?: boolean;
  base_path?: string;
  mcp?: string[];
}

export interface PortNeed {
  name: string;
  default?: number;
}

export interface PortPool {
  start: number;
  end: number;
}

export interface ProjectConfig {
  id: string;
  name: string;
  rootPath: string;
  worktreeBase: string;
  portNeeds: PortNeed[];
  startupCommands: string[];
  envTemplate: Record<string, string>;
  defaultBaseBranch: string;
  portPool?: PortPool;
}

export interface Tier {
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  needs_testing?: boolean;
  needs_agents_team?: boolean;
}

export interface WorktreeBinding {
  soul: string;
  sessionId: string;
  mode: "headless" | "interactive";
  tier: Tier;
  tierFlags: string[];
  terminalTabId?: string;
  spawnedAt: string;
  lastSummaryAt?: string;
}

export type WorktreeStatus = "active" | "merged" | "discarded";

export interface GarrisonMetadata {
  faculty: FacultyId;
  cardinality_hint: Cardinality;
  component_shape: FittingShape;
  platforms: PlatformId[];
  summary?: string;
  for_consumers?: string;
  config_schema: ConfigSchemaField[];
  provides: CapabilityProvision[];
  consumes: CapabilityConsumption[];
  setup?: SetupStep;
  verify: {
    command: string;
    expect: string;
    timeout_ms: number;
  };
  ui?: {
    views: UiView[];
  };
  tasks?: {
    source: string;
    truth_file: string;
  };
  spawn?: SpawnConfig;
}

export interface RatingInfo {
  github_stars_url?: string;
  global?: number;
  claude_code?: number;
  [key: string]: string | number | undefined;
}

export interface LibraryEntry {
  id: string;
  name: string;
  faculty: FacultyId;
  repo: string;
  localPath?: string;
  summary: string;
  platforms: PlatformId[];
  ratings: RatingInfo;
  metadata: GarrisonMetadata;
}

export interface SelectedFitting {
  id: string;
  config: Record<string, string | number | boolean>;
}

export type FittingSelectionMap = Partial<Record<FacultyId, SelectedFitting[]>>;

export interface GuardrailsConfig {
  max_tasks_per_tick: number;
  max_spend_per_day: number;
  max_tool_calls_per_tick: number;
}

export interface GlobalConfig {
  projects_root: string;
  vault: string;
  platform: "claude-code";
  guardrails: GuardrailsConfig;
  permissions_mode: "full-auto" | "auto" | "allow-file-edits" | "conservative";
  observability_config: {
    log_sink: string;
    alert_channel?: string;
  };
}

export interface DerivedTasks {
  source: string;
  truthFile: string;
  fittingId: string;
}

export interface CapabilityIssue {
  fittingId: string;
  code: "missing-required" | "ambiguous-singleton" | "too-many-for-optional" | "unknown-kind";
  kind: CapabilityKind;
  name?: string;
  message: string;
}

export interface SerializedCapabilityGraph {
  consumers: Array<{
    fittingId: string;
    consumption: CapabilityConsumption;
    providers: Array<{ fittingId: string; kind: CapabilityKind; name: string }>;
  }>;
}

export interface Composition {
  id: string;
  name: string;
  directory: string;
  manifestPath: string;
  selections: FittingSelectionMap;
  globalConfig: GlobalConfig;
  derivedTasks?: DerivedTasks;
  capabilityIssues: CapabilityIssue[];
  capabilityGraph: SerializedCapabilityGraph;
}

export interface VaultSecret {
  key: string;
  value: string;
}

export interface VerifyResult {
  fittingId: string;
  faculty: FacultyId;
  command: string;
  expect: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
}

export interface RunnerState {
  compositionId: string;
  status: "idle" | "starting" | "running" | "verifying" | "stopping" | "stopped" | "failed";
  devMode: boolean;
  pid?: number;
  startedAt?: string;
  lastError?: string;
  verifyResults: VerifyResult[];
}
