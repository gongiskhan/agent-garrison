// WS6: the in-app tour descriptor's canonical TS type is the zod-inferred one
// from metadata.ts. Type-only import — erased at runtime, so no import cycle.
import type { TourDescriptor } from "./metadata";

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
  "coordination", // Dev — keep parallel work sessions out of each other's way
  // connectors (2026-06-26): authenticated, reusable connections to the external
  // services the operative acts on, each exposing a discoverable action catalog
  // with Vault-sealed auth. A new faculty because no existing role expresses "a
  // connected service with callable actions + triggers"; it absorbs the dropped
  // read-only data-source case (Honesty-Test: real connector Fittings need it).
  "connectors" // Agent — connect to external services and act on them
] as const;

export type FacultyId = (typeof facultyIds)[number];

/**
 * Fitting **categories** — the browsing axis for the Fittings views, kept
 * deliberately separate from `faculty`.
 *
 * `faculty` is the CONTRACT: which role slot a Fitting fills, what it
 * provides/consumes, and its cardinality. Sixteen slots
 * make a precise type system and an unusable menu, so faculty is no longer the
 * grouping axis — it survives as a per-Fitting label rendered on the card.
 *
 * `category` is presentation ONLY. Nothing in composition, routing, or the
 * provides/consumes graph may branch on it. Each Fitting's default is derived
 * from its faculty (CATEGORY_BY_FACULTY); a Fitting may override it in
 * `x-garrison.category` when the derived home reads wrong to a human.
 */
export const fittingCategories = [
  "Core",
  "Interfaces",
  "Building",
  "Knowledge",
  "Connections",
  "Operations",
] as const;

export type FittingCategory = (typeof fittingCategories)[number];

/** Default category per faculty. Presentation-only mapping. */
export const CATEGORY_BY_FACULTY: Record<FacultyId, FittingCategory> = {
  orchestrator: "Core",
  gateway: "Core",
  memory: "Core",
  channels: "Interfaces",
  surfaces: "Interfaces",
  sessions: "Interfaces",
  building: "Building",
  "code-intelligence": "Building",
  "browser-qa": "Building",
  design: "Building",
  knowledge: "Knowledge",
  research: "Knowledge",
  connectors: "Connections",
  coordination: "Connections",
  observability: "Operations",
  runtimes: "Operations",
};

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
  // identity: the editable persona + tone section authored by Orchestrator.
  // It replaces the retired persona/modes fitting path; "Hey Zeca" addresses
  // the one routed Operative. A composition-readiness rule requires one.
  "identity",
  "memory-store",
  // data-source: dropped 2026-06-26 — superseded by `connector`, which is
  // strictly more general (a connector both reads AND acts, with a callable
  // action catalog + Vault-sealed auth). Trello moved to the `trello` connector.
  // automation-runner: re-added 2026-06-13 (MR wave) — the scheduler Fitting and the new Improver both need it; dropped 2026-06-07, re-added on the same data-source precedent (add a kind only when a real Fitting needs one).
  "automation-runner",
  // connector (2026-06-26): a connected external service exposing callable
  // catalog actions + Vault-sealed auth + optional triggers. Strictly more
  // general than the read-only data-source kind it replaces. Real connector
  // Fittings (trello/google/slack/deepgram) cannot be expressed without it.
  "connector",
  // runtime: added 2026-06-14 (BRIEF v4 Runtime faculty) — a runtime Fitting (Claude Code, Codex, Gemini-CLI) hosts the agent loop and exposes a uniform delegate() bridge. Multiple may coexist; the composition names one primary, others secondary. Same "add a kind when a real Fitting needs one" precedent (codex-runtime / gemini-runtime need it).
  "runtime",
  // mcp-gateway: re-added 2026-07-10 - the per-session stdio/HTTP MCP sidecar
  // that exposes installed Faculty tools to Operative sessions.
  // Dropped in the Quarters pivot, re-added on the automation-runner precedent
  // (add a kind only when a real Fitting needs one): the mcp-gateway Fitting
  // provides it and the runtime dependency cannot be expressed without it.
  "mcp-gateway",
  "channel",
  "vault",
  // dev-env: the consolidated Dev Env surface (2026-06-11). Replaces the
  // dropped terminal-session / worktree / session-view kinds, whose three
  // Fittings collapsed into the single dev-env Fitting.
  "dev-env",
  "screen-share",
  "outpost",
  "monitor",
  "voice",
  // duty (2026-07-13, MARATHON-V3 D2): a unit of work with a start and an end,
  // provided by a Fitting, owning a skill. Duties + per-duty Levels replace the
  // former task-type/tier/phase/mode vocabulary. Honesty-Test: real Fittings
  // (Orchestrator routing inference and per-duty work Fittings) cannot be expressed without
  // it. Discovery is the derived-view pattern: consume kind:duty with
  // cardinality `any`. A Fitting provides ONE duty as the norm (multi allowed,
  // discouraged); the provision's `name` is the duty id and MUST match a
  // `duties[]` spec in the same manifest.
  "duty",
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
  // while doing development work).
  // ORTHOGONAL to `essential`: an optional faculty can be Agent; an essential
  // faculty can sit under either header. Purely presentational; does not affect
  // capability resolution. Development duties consume the dev-tier faculties.
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

export interface ProjectConfig {
  id: string;
  name: string;
  rootPath: string;
  portNeeds: PortNeed[];
  startupCommands: string[];
  envTemplate: Record<string, string>;
  defaultBaseBranch: string;
}

// A connector Fitting's action-catalog entry — one callable action on the
// connected service. `mutates` flags write actions (rendered distinctly and
// weighed by the planner); `args` names the templated arguments the action takes.
export interface ConnectorAction {
  name: string;
  args?: string[];
  mutates?: boolean;
  description?: string;
}

// An inbound trigger a connector can register: a webhook routed through the
// Gateway, or a polling listener run by the Scheduler daemon.
export interface ConnectorTrigger {
  type: "webhook" | "listener";
  event?: string;
  cron?: string;
  description?: string;
}

// The connector metadata sub-block: how the connector authenticates (the
// credential is sealed in the Vault — never inlined here), the catalog of
// actions it exposes, and any triggers. Present only on Fittings that provide
// kind:connector.
// OAuth2 provider config a connector declares so Garrison can run the
// authorization-code flow. The client id/secret are NOT inlined — they name
// Vault secrets (the user registers their own OAuth app), keeping the manifest
// secret-free.
export interface ConnectorOAuth {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdSecret: string; // Vault secret NAME holding the OAuth client id
  clientSecretSecret: string; // Vault secret NAME holding the OAuth client secret
}

export interface ConnectorSpec {
  auth: "oauth2" | "api_key" | "none";
  actions: ConnectorAction[];
  triggers?: ConnectorTrigger[];
  oauth?: ConnectorOAuth;
}

// ---------------------------------------------------------------------------
// Duties (MARATHON-V3 D2/D3/D4). A duty is work with a start and an end,
// provided by a Fitting, owning a skill. Each duty has 1..n LEVELS; a level is
// either a leaf CELL {skill, target, effort} or an ordered SEQUENCE of duty
// references. Levels are stored FLAT — every level carries its full explicit
// content; inheritance lives only in the editor (copy-from-below + diff line),
// never in the data model. The duty graph must be a DAG; the Resolver
// (src/lib/resolver.ts) validates it.

export const dutyEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type DutyEffort = (typeof dutyEfforts)[number];

// A leaf level's cell. All fields optional: automation-shaped duty levels may
// leave target and effort empty (D14); skill-shaped cells name the skill the
// duty owns. `target` names an engine-identity target (model/runtime/provider —
// effort deliberately NOT part of target identity; it lives here in the cell).
export interface DutyLevelCell {
  skill?: string;
  target?: string;
  effort?: DutyEffort;
}

// One entry of a composite level's ordered sequence: a duty reference, run at
// the parent's level by default, with an optional per-entry level override
// (1-based index into the referenced duty's levels).
export interface DutySequenceEntry {
  duty: string;
  level?: number;
}

// A duty level: leaf (cell) XOR composite (sequence) — exactly one is set,
// enforced at parse time (metadata.ts dutyLevelSchema superRefine); both stay
// optional here because zod's inferred output can't carry the union.
// `description` is the one-line summary Orchestrator routing inference reads
// ("level 1: quick fix, no plan").
export interface DutyLevel {
  description: string;
  cell?: DutyLevelCell;
  sequence?: DutySequenceEntry[];
}

// A duty spec as declared by the providing Fitting's manifest `duties[]` block
// (the provision name = the duty id), or defined/overridden by the composition
// file (D8 — the composition absorbs duty definitions).
export interface DutySpec {
  id: string;
  title: string;
  // Verb-shaped description ("develop a change end to end", "review a diff").
  description: string;
  levels: DutyLevel[];
  // S1b: when true, a turn running this duty holds off the compact controller —
  // compaction is deferred to the next duty boundary (which discharges the hold),
  // never mid-duty. Optional/additive; absent reads as no hold.
  context_hold?: boolean;
  // S3d (D9b): a duty gate. `explicit` means the engine does NOT auto-advance the
  // card off this duty - it holds pending an explicit human go (a Move, or a "go"
  // message routed as steering). Only meaningful on the discuss duty today. Absent
  // (the default) = pass-through: the card advances automatically on the verdict.
  gate?: "explicit";
}

export interface GarrisonMetadata {
  faculty: FacultyId;
  /** Presentation-only browsing axis; resolved from `faculty` when omitted. */
  category?: FittingCategory;
  cardinality_hint: Cardinality;
  /**
   * Station this Fitting in every composition unless explicitly unfitted. Only
   * for Fittings whose verify hook passes on a bare box — see the schema comment
   * in metadata.ts for why membership is not free.
   */
  default_fit?: boolean;
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
  // Duty specs for each kind:duty provision this Fitting declares (one per
  // provision; provision name === duty id). Empty for non-duty Fittings.
  duties?: DutySpec[];
  verify: {
    command: string;
    expect: string;
    timeout_ms: number;
  };
  ui?: {
    views: UiView[];
    // WS6: optional in-app tours declared inline on the fitting (additive).
    tours?: TourDescriptor[];
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
  // Connector Fittings (kind:connector) declare their auth method, action
  // catalog, and optional triggers here. Absent on non-connector Fittings.
  connector?: ConnectorSpec;
  // The named Vault secrets this Fitting is permitted to read. This is what
  // makes per-connector secret scoping real: vault materialization delivers
  // ONLY these named secrets to the Fitting's process (see vault scoping),
  // replacing the historical all-or-nothing delivery to any kind:vault consumer.
  secret_scope?: string[];
  // D3 (GARRISON-RUNTIMES-V1): how a provider override (base URL / auth
  // credential / model) is applied to this runtime engine. Absent on
  // non-runtime Fittings and on runtimes that take no provider overrides.
  provider_mechanism?: ProviderMechanism;
  // D5: the Quarters descriptor this runtime ships — deep (registered
  // implementation by id) or generic (descriptor-rendered native-config surface).
  quarters_descriptor?: QuartersDescriptor;
  // RUNTIME-ACCOUNTS-V1 D6: how a (non-Anthropic) runtime logs in natively.
  // The UI runs `command` in a PTY with the same guided surface as the
  // Anthropic setup-token flow; env_var/storage_hint document where the
  // resulting credential lives. Best-effort — absent on most Fittings.
  login?: RuntimeLoginSpec;
}

// D6: a runtime Fitting's native login declaration.
export interface RuntimeLoginSpec {
  command: string;
  env_var?: string;
  storage_hint?: string;
}

// D3: the declared provider-override mechanism of a runtime Fitting.
// Discriminated on `type` so consumers (the composer target editor, the launch
// wiring) get the arm-specific required fields without re-validating. The env
// arm's "declares at least one override channel" rule is enforced by the zod
// refinement only — TS cannot express it without an unusable union explosion.
export type ProviderMechanism =
  | {
      type: "env";
      base_url_env?: string;
      auth_env?: string;
      model_arg?: string;
      model_env?: string;
      /**
       * Per-provider-slot overrides of the env pair above, keyed by the provider
       * id the fitting's own table uses. An engine fronting several endpoint
       * families needs one pair per family, so a self-hosted endpoint's key never
       * contends with the vendor cloud's.
       */
      provider_env?: Record<string, { base_url_env?: string; auth_env?: string }>;
      notes?: string;
    }
  | {
      type: "config-file";
      config_file: string;
      config_format: "json" | "toml";
      config_key?: string;
      model_key?: string;
      notes?: string;
    };

// D5: one native settings file surfaced by the generic Quarters tier.
export interface QuartersSettingsFile {
  path: string;
  format: "json" | "toml";
  label?: string;
}

// D5: the Quarters descriptor a runtime Fitting ships. Discriminated on `tier`:
// the generic tier is rendered FROM the descriptor, so its home_dir is required
// (the zod refinement enforces it at parse time; the union carries it to
// consumers so the generic renderer never null-checks its anchor directory).
export type QuartersDescriptor =
  | {
      tier: "deep";
      id: string;
      home_dir?: string;
      settings_files?: QuartersSettingsFile[];
      context_file?: string;
      mcp_config?: { path: string; format: "json" | "toml"; key?: string };
      log_paths?: string[];
      categories?: string[];
    }
  | {
      tier: "generic";
      id: string;
      home_dir: string;
      settings_files?: QuartersSettingsFile[];
      context_file?: string;
      mcp_config?: { path: string; format: "json" | "toml"; key?: string };
      log_paths?: string[];
      categories?: string[];
    };

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
  /**
   * Presentation-only grouping for the Fittings views, hoisted from
   * `metadata.category` and resolved from `faculty` when the manifest omits it.
   * Optional on the type (test fixtures build entries by hand) but always
   * populated by resolveLibraryEntry. Never branch contract logic on this.
   */
  category?: FittingCategory;
  repo: string;
  localPath?: string;
  summary: string;
  platforms: PlatformId[];
  ratings: RatingInfo;
  metadata: GarrisonMetadata;
  // Present only on clones (S3): "<sourceId>@<version>" recording the upstream
  // Fitting this was copied from. The clone is a first-class, independent local
  // Fitting — upstream updates never touch it; drift is measured against the
  // clone-time snapshot in the copy's clone.json, not against upstream.
  cloned_from?: string;
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
  // The Runtime-Faculty fitting that hosts the orchestrator (the PRIMARY
  // runtime). Defaults to "claude-code-runtime" (the node-pty engine) when
  // unset — preserving the historical gateway/PTY behavior. Other composed
  // runtimes become model-router targets; only the primary runs the
  // orchestrator loop. See src/lib/runtime-selection.ts.
  primary_runtime?: string;
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
  /**
   * Fittings the user has explicitly UNFITTED. Only meaningful for `default_fit`
   * Fittings: membership is otherwise presence-based, so an absent id already
   * means "not stationed". This list is what makes removing an auto-fitted
   * Fitting stick across a read (which would otherwise union it straight back).
   */
  unfitted: string[];
  globalConfig: GlobalConfig;
  derivedTasks?: DerivedTasks;
  capabilityIssues: CapabilityIssue[];
  capabilityGraph: SerializedCapabilityGraph;
}

export interface VaultSecret {
  key: string;
  value: string;
}

// What the HTTP layer is allowed to say about a secret. GET /api/vault/secrets
// used to return every VaultSecret with its plaintext `value`, so a single
// unauthenticated request from any tailnet device dumped the whole vault (the
// app is fronted by `tailscale serve`, which proxies to loopback — so a
// remote-address check cannot tell a remote caller from a local one). The wire
// shape is masked; the plaintext leaves the server only through an explicit,
// audited, one-key-at-a-time reveal.
export interface MaskedVaultSecret {
  key: string;
  // Whether a non-empty value is stored. Distinguishes "set but hidden" from
  // "present as an empty string", which the UI renders differently.
  set: boolean;
  // A short, non-reconstructable hint (head + tail) so a human can tell two
  // similar-looking credentials apart without revealing either.
  preview: string;
}

// A PUT entry. `value` ABSENT means "leave whatever is stored untouched" — the
// UI holds masks, not plaintext, so echoing a masked row back must never
// overwrite the real secret with its own preview.
export interface VaultSecretUpdate {
  key: string;
  value?: string;
}

// A row in the Vault UI. Starts life as the masked wire shape; `value` appears
// only once the row has been explicitly revealed or typed into. `dirty` is what
// the save path keys on — a revealed-but-untouched row must round-trip as
// "unchanged", not as a write of the value it happens to be displaying.
export interface VaultSecretRow extends MaskedVaultSecret {
  value?: string;
  dirty?: boolean;
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
