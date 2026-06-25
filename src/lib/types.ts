// Faculties are ROLES only (the Quarters pivot). Skills/Hooks/MCPs/Plugins/
// Scripts/Settings are no longer faculties — they are platform primitives
// surfaced in Quarters. The own-port runtime residue (dev-env, screen-share,
// outposts, browser, monitor, web-channel, voice) folds under these roles
// (sessions/channels/observability) and is detected via the `own_port`
// metadata flag, not a dedicated faculty. Legacy faculty names are accepted
// as deprecation aliases (see metadata.ts normalizeDeprecations).
// Vault is the runtime vault surface (/vault + the synthetic vault capability),
// not a composition faculty.
export const facultyIds = [
  "orchestrator",
  "channels",
  "gateway",
  // runtimes + surfaces split out of the overloaded `sessions` role
  // (2026-06-18): runtimes = alternative execution engines (Agent SDK, Codex,
  // Gemini) behind the uniform runtime bridge; surfaces = the auxiliary
  // own-port live viewers (screen share, standalone browser, remote Outpost).
  // `sessions` keeps the primary Dev Env surface + artifact store.
  "runtimes",
  "memory",
  "observability",
  "sessions",
  "surfaces",
  // modes: the operative's identity/persona layer (Gary/Joe/James souls +
  // shared voice + name-based mode switching) composed into the orchestrator's
  // system prompt. A real Fitting (the `modes` fitting) needs this slot and none
  // of the other roles fit it — the sanctioned trigger for a new faculty.
  "modes",
  // Optional capability faculties (2026-06-24) — the homes the promoted Claude
  // Code primitives (skills/agent-tools/plugins, recorded only as an internal
  // `component_shape`) fill. Named by what the capability is FOR in plain terms,
  // never by the primitive type behind it. Two are Agent-tier (everyday base
  // operative), five are Dev-tier (only relevant while doing development work).
  "knowledge", // Agent — create, edit, and organize documents and notes
  "research", // Agent — find things out and understand media
  "building", // Dev — write, test, and ship software autonomously
  "code-intelligence", // Dev — understand and navigate codebases
  "design", // Dev — design and prototype user interfaces
  "browser-qa", // Dev — drive a real browser to build and verify
  "coordination" // Dev — keep parallel work sessions out of each other's way
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

// The capability-kind vocabulary shrinks with the Quarters pivot: soul,
// agent-skill, and mcp-gateway are dropped (Skills become platform
// primitives; the spawned-operative machinery is retired). automation-runner
// was dropped 2026-06-07 then re-added 2026-06-13 (MR wave) for the scheduler
// + the Improver, same data-source precedent. The own-port runtime wiring
// kinds are kept.
//
// `view` is never declared in a fitting's `provides` — the resolver derives
// one provision per produced view from `ui.views[]` / `own_port` (see
// view-instances.ts), so any consumer can discover views with cardinality
// `any` without per-fitting manifest churn. Only `consumes` entries name it
// explicitly.
export const capabilityKinds = [
  "orchestrator",
  // modes: added 2026-06-22 — the identity/persona layer (souls + shared voice +
  // per-mode routing bias + mode switching) the `modes` Fitting provides and the
  // orchestrator consumes. Honesty-Test: a real Fitting needs it and no existing
  // kind expresses it.
  "modes",
  "memory-store",
  // data-source: re-added 2026-06-10 because trello-data-source is a real Fitting that cannot be expressed without it (Honesty-Test convention) — it was dropped 2026-06-07 with the parked PA fittings.
  "data-source",
  // automation-runner: re-added 2026-06-13 (MR wave) — the scheduler Fitting and the new Improver both need it; dropped 2026-06-07, re-added on the same data-source precedent (add a kind only when a real Fitting needs one).
  "automation-runner",
  // runtime: added 2026-06-14 (BRIEF v4 Runtime faculty) — a runtime Fitting (Claude Code, Codex, Gemini-CLI) hosts the agent loop and exposes a uniform delegate() bridge. Multiple may coexist; the composition names one primary, others secondary. Same "add a kind when a real Fitting needs one" precedent (codex-runtime / gemini-runtime need it).
  "runtime",
  "channel",
  "vault",
  "artifact-store",
  // dev-env: the consolidated Dev Env surface (2026-06-11). Replaces the
  // dropped terminal-session / worktree / session-view kinds, whose three
  // Fittings collapsed into the single dev-env Fitting.
  "dev-env",
  "screen-share",
  "outpost",
  "monitor",
  "voice",
  "view"
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
  "modes",
  "vault",
  "dev-env",
  "screen-share",
  "monitor",
  "voice"
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
  // Essential tier (HV wave): the roles every running agent genuinely needs —
  // the brain (orchestrator), persistence (memory), interface (channels), and
  // transport/execution path (gateway). Grouped under "Every agent needs these"
  // in the Compose grid; the rest are optional. Purely presentational — does not
  // affect capability resolution.
  essential?: boolean;
  // Display tier (2026-06-24): which Compose header the faculty sits under —
  // "agent" (everyday base operative, always available) or "dev" (only relevant
  // while doing development work, the kind of capability a dev mode activates).
  // ORTHOGONAL to `essential`: an optional faculty can be Agent; an essential
  // faculty can sit under either header. Purely presentational; does not affect
  // capability resolution. Anchored on the modes config (the dev mode, Joe,
  // activates the dev-tier faculties).
  tier?: "agent" | "dev";
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
  // Optional human-readable label for the step, shown in the Setup Instructions
  // editor on the fitting detail view. Falls back to the command when absent.
  label?: string;
}

export const uiPlacements = ["faculty-tab", "sidebar-surface"] as const;
export type UiPlacement = (typeof uiPlacements)[number];

export interface UiView {
  id: string;
  placement: UiPlacement;
  entry: string;
  route: string;
  // "full-bleed": the surface page suppresses the fitting-overview header and
  // width cap so the view owns the whole estate. Default chrome keeps the
  // overview above the view.
  chrome?: "default" | "full-bleed";
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

export type FittingLifecycle = "operative-bound" | "detached";

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
  // Ordered setup steps run (in order, aborting on the first non-zero exit) when
  // the composition is installed. Normalised to an array at parse time: a single
  // YAML `setup:` step becomes a one-element array, so downstream code (the
  // runner and the Setup Instructions editor) always sees a list. `undefined`
  // when the fitting declares no setup.
  setup?: SetupStep[];
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
  // Own-port Fittings serve their own React UI on their own port (Monitor
  // pattern) and register at runtime via ~/.garrison/ui-fittings/<id>.json.
  // After the faculties-as-roles pivot, own-port is declared per-Fitting via
  // this flag (not inferred from the Faculty), since a role like `sessions`
  // mixes own-port and non-own-port Fittings.
  own_port?: boolean;
  // Default port the own-port Fitting binds (informational; the runtime status
  // file is authoritative).
  default_port?: number;
  // For own-port Fittings:
  //   - "operative-bound" (default): Garrison starts/stops the Fitting alongside
  //     the operative's up/down lifecycle.
  //   - "detached": Garrison never auto-starts or auto-stops this Fitting; the
  //     user manages it manually (via /api/fittings/<id>/start|stop or shell).
  // The field is ignored for non-own-port Fittings.
  lifecycle?: FittingLifecycle;
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
