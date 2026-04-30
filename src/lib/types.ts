export const primitiveIds = [
  "heartbeat",
  "scheduler",
  "data-sources",
  "knowledge-base",
  "automations",
  "testing-framework",
  "memory",
  "classifier",
  "gateway",
  "channels",
  "observability",
  "soul",
  "orchestrator"
] as const;

export type PrimitiveId = (typeof primitiveIds)[number];

export type Cardinality = "single" | "multi";

export const componentShapes = [
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

export type ComponentShape = (typeof componentShapes)[number];

export type PlatformId = "all" | "claude-code" | "codex" | string;

export interface PrimitiveDefinition {
  id: PrimitiveId;
  order: number;
  name: string;
  cardinality: Cardinality;
  shapes: ComponentShape[];
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

export interface GarrisonMetadata {
  primitive: PrimitiveId;
  cardinality_hint: Cardinality;
  component_shape: ComponentShape;
  platforms: PlatformId[];
  summary?: string;
  config_schema: ConfigSchemaField[];
  verify: {
    command: string;
    expect: string;
    timeout_ms: number;
  };
  ui?: {
    extension: string;
  };
  tasks?: {
    source: string;
    truth_file: string;
  };
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
  primitive: PrimitiveId;
  repo: string;
  localPath?: string;
  summary: string;
  platforms: PlatformId[];
  ratings: RatingInfo;
  metadata: GarrisonMetadata;
}

export interface SelectedComponent {
  id: string;
  config: Record<string, string | number | boolean>;
}

export type ComponentSelectionMap = Partial<Record<PrimitiveId, SelectedComponent[]>>;

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
  componentId: string;
}

export interface Composition {
  id: string;
  name: string;
  directory: string;
  manifestPath: string;
  selections: ComponentSelectionMap;
  globalConfig: GlobalConfig;
  derivedTasks?: DerivedTasks;
}

export interface VaultSecret {
  key: string;
  value: string;
}

export interface VerifyResult {
  componentId: string;
  primitive: PrimitiveId;
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
