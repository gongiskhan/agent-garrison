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
> classifier` and `provides: agent-skill`, both retired in the 2026-06-07 pivot
> but still accepted as deprecation aliases (with a `console.warn`). A skill like
> a tier classifier is now a Quarters **platform primitive** (a `type: skill`
> package compiled by APM), not a capability provider. See the live faculty/kind
> lists below.

## Schema

Top-level `x-garrison` fields:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `faculty` | enum | yes | One of the 14 explicit Faculty ids. Tasks is derived and must not be declared by a Fitting. |
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
| `ui` | object | no | Optional trusted React extension metadata. |
| `tasks` | object | no | Optional declaration that this Fitting backs the derived Tasks surface. |

### Back-compat aliases

The parser accepts these deprecated forms for one minor version. Both
emit a `console.warn`:

- `primitive:` (rewritten to `faculty:`).
- `faculty: testing-framework` (rewritten to `faculty: skills`).

Faculty ids (the 6 roles, post-2026-06-07 Quarters pivot):

`orchestrator`, `channels`, `gateway`, `memory`, `observability`, `sessions`.

The legacy flat-Faculty ids (`heartbeat`, `scheduler`, `data-sources`,
`knowledge-base`, `automations`, `skills`, `classifier`, `soul`, …) are accepted
as deprecation aliases by `metadata.ts normalizeDeprecations` and fold into the
roles above; Skills/Hooks/MCPs/Plugins/Scripts/Settings/Context/Plans are now
Quarters platform primitives, not Faculties.

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
| `kind` | enum | yes | One of: `orchestrator`, `memory-store`, `data-source`, `automation-runner`, `runtime`, `channel`, `vault`, `artifact-store`, `dev-env`, `screen-share`, `outpost`, `monitor`, `voice`, `view`. (Dropped in the Quarters pivot: `soul`, `agent-skill`, `mcp-gateway`; `automation-runner` was dropped then re-added 2026-06-13 for the scheduler + Improver; `runtime` added 2026-06-14 for the BRIEF v4 Runtime faculty. Dropped in the 2026-06-11 Dev Env consolidation: `terminal-session`, `worktree`, `session-view` — all three collapsed into `dev-env`.) `view` is consume-only in manifests: the resolver derives provisions (`<fittingId>:<viewId>`) from `ui.views[]`/`own_port` — never declare it under `provides`. |
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

UI schema (contract v2):

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `views` | array | yes | One or more view declarations. See the view schema below. |

View schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `id` | string | yes | Stable view id, slug-shaped (`^[a-zA-Z][a-zA-Z0-9_-]*$`). Combined with the Fitting id to form the registry key the host app loads. |
| `placement` | enum | yes | `faculty-tab` (renders inline on the Compose pane next to the Fitting's config form) or `sidebar-surface` (gets its own page under `/fitting/<fitting-id>/...` and a left-nav entry). |
| `entry` | string | yes | Path relative to the Fitting root. Authoritative declaration; the host app does NOT load from disk in v2 (see [SPEC.md](./SPEC.md) §9). |
| `route` | string | yes | Path fragment under the Fitting's prefix (`/<fitting-id>`). Supports react-router-style params (`/:id`, `/:id/edit`). The view resolver matches sub-paths against this template; first-match wins. |
| `chrome` | enum | no | `default` (overview header above the view) or `full-bleed` (the surface page suppresses the fitting-overview header and width cap; the view owns the whole estate). |

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
