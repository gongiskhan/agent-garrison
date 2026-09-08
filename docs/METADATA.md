# Agent Garrison Metadata

`x-garrison` is Agent Garrison's metadata block inside an APM `apm.yml`
manifest. APM owns dependency resolution, install, audit, pack, and
lockfile pinning. Garrison reads this block to understand which
Faculty a Fitting fills, how it should be configured, what
capabilities it provides and consumes, how it verifies itself, and
whether it ships a trusted local UI extension.

## Placement

```yaml
name: garrison-tier-classifier
version: 0.1.0
target: claude
type: hybrid

x-garrison:
  faculty: classifier
  cardinality_hint: single
  component_shape: skill
  platforms: [claude-code]
  config_schema:
    - key: tier_floor
      type: integer
      default: 3
      description: Minimum tier this classifier raises every prompt to.
  provides:
    - kind: agent-skill
      name: tier-classifier
  verify:
    command: test -f .claude/skills/tier-classifier/SKILL.md && echo ok
    expect: ok
  ui:
    extension: ./ui/ClassifierInspector.tsx
```

> **Note (post-Quarters-pivot):** this example uses the legacy `faculty:
> classifier` and `provides: agent-skill`, both retired in the 2026-06-07 pivot.
> Neither is aliased: `classifier` is not in `metadata.ts` `FACULTY_ALIASES` and
> `agent-skill` is not a live capability kind, so this manifest no longer parses
> (it is kept as a historical illustration of the block's shape only). A skill
> like a tier classifier is now a Quarters **platform primitive** (a
> `type: skill` package compiled by APM), not a capability provider. See the
> live faculty/kind lists below.

## Schema

Top-level `x-garrison` fields:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `faculty` | enum | yes | One of the 16 explicit Faculty ids (see the list below). Tasks is derived and must not be declared by a Fitting. |
| `cardinality_hint` | enum | yes | `single` or `multi`. Validated against the Faculty definition. |
| `component_shape` | enum | yes | One of Garrison's closed Fitting shapes. (Field name retained from earlier naming for back-compat.) |
| `platforms` | string array | yes | `all`, `claude-code`, `codex`, or future platform ids. v1 accepts only `all` and `claude-code` at compose time. |
| `summary` | string | no | Human summary shown in the Fittings Registry and picker. |
| `for_consumers` | string | no | Free-form markdown the runner injects under this Fitting's line in the Orchestrator's capabilities block. Use it to ship usage guidance the consumer-side prompt should see. 8 KB byte cap. |
| `config_schema` | array | no | UI-renderable config fields. Defaults to `[]`. |
| `provides` | array | no | Capabilities this Fitting offers to others. Defaults to `[]`. See `CAPABILITIES.md`. |
| `consumes` | array | no | Capabilities this Fitting requires from the composition. Defaults to `[]`. See `CAPABILITIES.md`. |
| `setup` | object | no | Optional one-shot install/repair command run by the runner before `verify` on every `up`. See setup schema below. |
| `verify` | object | yes | Runtime verification command and expected output. |
| `ui` | object | see note | Embedded view declarations. **Every Fitting must have a view**: at least one `ui.views[]` entry, or `own_port: true`. The validation pipeline's architecture check rejects a viewless Fitting. See [UI-FITTINGS.md](./UI-FITTINGS.md) for the authoring guide (shared `garrison:*` views cover the common shapes with zero code). |
| `tasks` | object | no | Optional declaration that this Fitting backs the derived Tasks surface. |
| `own_port` | boolean | no | The Fitting serves its own UI/backend on its own HTTP port and registers at runtime via `~/.garrison/ui-fittings/<id>.json`. Own-port Fittings start with the operative at `up` and stop at `down` — fittings share the operative's lifecycle, always. |
| `default_port` | integer | no | Informational default port for an own-port Fitting; the runtime status file is authoritative. |
| `connector` | object | no | Connector Fittings only (`kind: connector`): auth method, action catalog, optional triggers. See the connector schema below. |
| `secret_scope` | string array | no | The named Vault secrets this Fitting may read; the Vault delivers only these to the Fitting's process. |
| `provider_mechanism` | object | no | Runtime Fittings only (GARRISON-RUNTIMES-V1 D3): HOW a provider override (base URL / auth credential / model) applies to this engine. Discriminated on `type`: `env` (any of `base_url_env`, `auth_env`, `model_arg`, `model_env` — at least one) or `config-file` (`config_file` + `config_format` [`json`\|`toml`] required; optional `config_key`, `model_key`). Strict: unknown keys fail the parse. A runtime without one is still a routing target, just without provider overrides. |
| `quarters_descriptor` | object | no | Runtime Fittings only (D5): which Quarters surface configures this engine. `tier: deep` + `id` maps to a REGISTERED implementation (`claude-code` → the existing full surface, untouched). `tier: generic` renders the descriptor-driven tier and requires `home_dir`; optional `settings_files[{path,format,label?}]`, `context_file`, `mcp_config{path,format,key?}`, `log_paths[]`, `categories[]`. Strict; generic file I/O serves ONLY the declared files. |

### Back-compat aliases

The parser accepts these deprecated forms for one minor version. Both
emit a `console.warn`:

- `primitive:` (rewritten to `faculty:`).
- The aliased legacy faculty names below (each rewritten to its role).
- `lifecycle:` (dropped and ignored — the 2026-07-29 fittings/views refit
  removed the eager/detached split; every own-port Fitting shares the
  operative's lifecycle).

Faculty ids (8 core roles + 7 optional capability faculties + `connectors`,
enforced by `facultyIds` in `src/lib/types.ts`):

`orchestrator`, `channels`, `gateway`, `runtimes`, `memory`, `observability`,
`sessions`, `surfaces`, `knowledge`, `research`, `building`,
`code-intelligence`, `design`, `browser-qa`, `coordination`, `connectors`.

Aliased legacy faculty ids (folded into roles by
`metadata.ts normalizeDeprecations`, with a `console.warn`): `terminal`,
`worktree-management`, `session-view`, `testing-framework` (all four fold into
`sessions`); `screen-share`, `outposts`, `browser` (fold into `surfaces`);
`web-channel`, `voice` (fold into `channels`); `monitor` (folds into
`observability`).

NOT aliased: the parked pre-pivot faculty ids (`heartbeat`, `scheduler`,
`data-sources`, `knowledge-base`, `automations`, `skills`, `classifier`,
`soul`, …). Their Fittings are de-listed from `data/library.json` and never
parsed; the parser rejects these ids outright.
Skills/Hooks/MCPs/Plugins/Scripts/Settings/Context/Plans are Quarters platform
primitives, not Faculties.

Fitting shapes:

`script`, `agent-instructions`, `manual-instructions`, `plugin`,
`skill`, `cli`, `hook`, `system-prompt`, `cli-skill`, `mcp`.

Config field schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `key` | string | yes | Stable config key. Must match `^[a-zA-Z_][a-zA-Z0-9_]*$`. |
| `type` | enum | yes | `string`, `integer`, `number`, `boolean`, `select`, `path`, or `secret-ref`. |
| `default` | scalar | no | Must match the field type when present. |
| `description` | string | yes | Short UI label/help text. |
| `required` | boolean | no | Defaults to `false`. |
| `options` | string array | conditional | Required for `select`. |

Capability provision schema (`provides[]`):

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `kind` | enum | yes | One of: `orchestrator`, `memory-store`, `automation-runner`, `connector`, `runtime`, `mcp-gateway`, `channel`, `vault`, `dev-env`, `screen-share`, `outpost`, `monitor`, `voice`, `duty`, `identity`, `view`. `duty` is a unit of work with per-duty levels; its provision `name` must match a `duties[]` spec. `identity` is provided by Orchestrator's authored Identity section. Dropped kinds include `modes`, `soul`, `agent-skill`, `data-source`, `artifact-store`, `terminal-session`, `worktree`, and `session-view`. `view` is consume-only: the resolver derives provisions (`<fittingId>:<viewId>`) from `ui.views[]`/`own_port`, never declared under `provides`. |
| `name` | string | yes | Disambiguator. Other Fittings can match by `kind` alone or by `kind:name`. |

Capability consumption schema (`consumes[]`):

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `kind` | enum | yes | One of the live capability kinds listed in the provision schema above. |
| `name` | string | no | Omit for kind-only matching; provide to require a specific named provider. |
| `cardinality` | enum | no | `one` (default), `optional-one`, or `any`. Enforced by the resolver. |

Setup schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `command` | string | yes | Shell command run from the Fitting's installed directory (`apm_modules/_local/<id>/`) on every `up`, before `verify`. |
| `idempotent` | boolean | yes | Author asserts the command is safe to run repeatedly. The runner runs it on every `up` regardless; the flag is informational. |
| `timeout_ms` | integer | no | Defaults to 60000. |

Setup runs after `apm install` and `materializeEnv`, and before `verify`. A non-zero exit aborts `up`; downstream verify and operative spawn do not run. Setup is the right place for clones, dependency installs, and one-shot host-config writes (see Memory Fitting and Slack Fitting for examples).

Verify schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `command` | string | yes | Shell command run from the composition directory after `apm install`. |
| `expect` | string | yes | Trimmed stdout must include this value. |
| `timeout_ms` | integer | no | Defaults to 10000. |

#### The two hooks run from DIFFERENT directories

This asymmetry is the single most common authoring mistake, so it is spelled out
once here and gated by `tests/hook-cwd-contract.test.ts`:

| Hook | cwd | Path shape in the command |
|---|---|---|
| `setup` | `<composition>/apm_modules/_local/<id>/` | fitting-relative — `bash scripts/setup.sh` |
| `verify` | `<composition>/` | composition-relative — `bash apm_modules/_local/<id>/scripts/verify.sh` |

Consequences worth internalising:

- A verify command written in the setup shape (`bash scripts/verify.sh`) exits
  127 on every `up`, which aborts the whole composition.
- **Inside a setup script, `$(pwd)` is the fitting's own installed dir, not the
  composition.** To reach a sibling Fitting, resolve relative to the script
  (`"$(cd "$(dirname "$0")/.." && pwd)"/../<other>`), never
  `"$(pwd)/apm_modules/_local/<other>"` — that resolves to
  `.../_local/<self>/apm_modules/_local/<other>` and always misses, which
  surfaces as a well-fitted dependency reporting as absent.
- A verify hook must not require a live gateway: `up` runs verify *before* it
  spawns the gateway, so a hard health check there can never pass on a cold
  start. Probe the Fitting's own wiring and treat gateway liveness as advisory.

Both hooks receive, in addition to the Fitting's own config projected as
`<FITTING_ID>_<KEY>`, the instance's gateway address as `GARRISON_GATEWAY_HOST`
/ `GARRISON_GATEWAY_PORT` / `GARRISON_GATEWAY_URL`. Never bake a port literal as
a fallback: every such literal in this repo named the codex instance's gateway
and silently crossed instances.

UI schema (contract v2):

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `views` | array | yes | One or more view declarations. See the view schema below. |

View schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `id` | string | yes | Stable view id, slug-shaped (`^[a-zA-Z][a-zA-Z0-9_-]*$`). Combined with the Fitting id to form the registry key the host app loads. |
| `placement` | enum | yes | `faculty-tab` (renders inline on the Compose pane next to the Fitting's config form) or `sidebar-surface` (gets its own page under `/fitting/<fitting-id>/...` and a left-nav entry). |
| `entry` | string | yes | Path relative to the Fitting root for a bespoke view (registered in the host's static registry), or a `garrison:<kind>` name to use a host-provided shared view (`garrison:skill`, `garrison:prompt`, `garrison:runtime`, `garrison:connector`, `garrison:manage` — see [UI-FITTINGS.md](./UI-FITTINGS.md)). The host app does NOT load from disk in v2 (see [SPEC.md](./SPEC.md) §9). |
| `route` | string | yes | Path fragment under the Fitting's prefix (`/<fitting-id>`). Supports react-router-style params (`/:id`, `/:id/edit`). The view resolver matches sub-paths against this template; first-match wins. |
| `chrome` | enum | no | `default` (slim fitting header above the view) or `full-bleed` (the surface page suppresses the header and width cap; the view owns the whole estate). |

### v1 → v2 normalization

The deprecated form `ui: { extension: "./ui/X.tsx" }` is rewritten by
`parseGarrisonMetadata` into a single-view v2 manifest:

```yaml
ui:
  views:
    - id: main
      placement: faculty-tab
      entry: ./ui/X.tsx
      route: /
```

A `console.warn` is emitted on rewrite. v1 manifests keep working
unchanged at the rendering layer.

Connector schema (`connector`, for Fittings that provide `kind: connector`):

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `auth` | enum | yes | `oauth2`, `api_key`, or `none`. Names HOW the credential is obtained; the credential itself is sealed in the Vault and never inlined here. |
| `actions` | array | no | The action catalog. Each entry: `name` (the callable action, e.g. `gmail.send`), optional `args` (templated argument names), optional `mutates` (true for write actions), optional `description`. |
| `triggers` | array | no | Inbound triggers. Each entry: `type` (`webhook` routed through the Gateway, or `listener` polled by the Scheduler daemon), optional `event`, optional `cron` (listener cadence), optional `description`. |
| `secrets` | array of strings | no | Subset of `secret_scope` a connector call receives; whole scope when absent. Each name must also be in `secret_scope` (a name outside it is ignored). For a Fitting that is also a running service and seals more than its connector needs (capture-service seals the Deepgram, ElevenLabs and APNs keys beside the capture token its connector uses), this keeps an automation child from seeing the rest. The Connectors page reads the connector as sealed when these names are present. |

`secret_scope` (top-level, array of strings, optional): the named Vault secrets
this Fitting is permitted to read. This is what makes per-connector scoping real —
vault materialization delivers ONLY these named secrets to the Fitting's process,
replacing the historical all-or-nothing delivery to any `kind: vault` consumer.

Duty schema (`duties[]`, for Fittings that provide `kind: duty` — one spec per
provision, spec `id` === provision `name`; MARATHON-V3 D2/D3/D4):

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `id` | string | yes | Kebab-case duty id (the provision name). |
| `title` | string | yes | Display title. |
| `description` | string | yes | Verb-shaped ("develop a change end to end"). |
| `levels` | array | yes | 1..n levels, 1-based. Each level: `description` (one line, routing-inference-readable) plus EXACTLY ONE of `cell` or `sequence`. |

Level `cell` (leaf): `skill` (optional — the skill this duty owns via the
Quarters ownership tag), `target` (optional — an engine-identity target id;
effort is NOT part of target identity), `effort` (optional — one of `low`,
`medium`, `high`, `xhigh`, `max`). Automation-shaped levels may leave `target`
and `effort` empty.

Level `sequence` (composite): ordered entries `{duty, level?}` — each entry
runs at the parent's level by default with an optional per-entry `level`
override (1-based). The duty graph must be a DAG; sequence references, level
ranges, and cycles are validated by the Resolver (`src/lib/resolver.ts`).
Levels are stored FLAT — no inheritance in the data model (the editor offers
copy-from-below + a diff line instead).

Tasks schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `source` | string | yes | Human source label, for example `trello`. |
| `truth_file` | string | yes | Markdown path inside the composition that mirrors task state. |

## Validation Rules

- A Fitting cannot declare `faculty: tasks`; Tasks is inferred from selected data sources.
- `cardinality_hint` must match the central Faculty table.
- `component_shape` must be accepted by the target Faculty.
- v1 composition validation rejects Fittings that do not support `all` or `claude-code`.
- Single-cardinality Faculties may have zero or one selected Fitting; multi-cardinality Faculties may have zero or more.
- Every selected Fitting must have a `verify` command. Missing verify metadata is a hard failure.
- `ui.extension` is loaded only for selected Fittings and only from local Fitting paths in v1.
- Capability `consumes` are resolved across the composition by the resolver in `src/lib/capabilities.ts`. See `CAPABILITIES.md`.

## Typed Validator Target

The validator module exports:

```ts
export function parseGarrisonMetadata(input: unknown): GarrisonMetadata;
export function validateFacultyCompatibility(metadata: GarrisonMetadata): void;
export function validateSelection(facultyId: FacultyId, selectedCount: number, metadata: GarrisonMetadata[]): void;
```

The resolver lives in `src/lib/capabilities.ts`:

```ts
export function resolveCapabilities(selected: ResolverInput[]): ResolverResult;
```

Validation errors are precise enough for the Compose tab to show the
failing Faculty and Fitting.
