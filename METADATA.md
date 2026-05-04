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

## Schema

Top-level `x-garrison` fields:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `faculty` | enum | yes | One of the 13 explicit Faculty ids. Tasks is derived and must not be declared by a Fitting. |
| `cardinality_hint` | enum | yes | `single` or `multi`. Validated against the Faculty definition. |
| `component_shape` | enum | yes | One of Garrison's closed Fitting shapes. (Field name retained from earlier naming for back-compat.) |
| `platforms` | string array | yes | `all`, `claude-code`, `codex`, or future platform ids. v1 accepts only `all` and `claude-code` at compose time. |
| `summary` | string | no | Human summary shown in the Fittings Registry and picker. |
| `config_schema` | array | no | UI-renderable config fields. Defaults to `[]`. |
| `provides` | array | no | Capabilities this Fitting offers to others. Defaults to `[]`. See `CAPABILITIES.md`. |
| `consumes` | array | no | Capabilities this Fitting requires from the composition. Defaults to `[]`. See `CAPABILITIES.md`. |
| `verify` | object | yes | Runtime verification command and expected output. |
| `ui` | object | no | Optional trusted React extension metadata. |
| `tasks` | object | no | Optional declaration that this Fitting backs the derived Tasks surface. |

### Back-compat aliases

The parser accepts these deprecated forms for one minor version. Both
emit a `console.warn`:

- `primitive:` (rewritten to `faculty:`).
- `faculty: testing-framework` (rewritten to `faculty: skills`).

Faculty ids:

`heartbeat`, `scheduler`, `data-sources`, `knowledge-base`,
`automations`, `skills`, `memory`, `classifier`, `gateway`, `channels`,
`observability`, `soul`, `orchestrator`.

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
| `kind` | enum | yes | One of: `orchestrator`, `agent-skill`, `memory-store`, `automation-runner`, `vault`. |
| `name` | string | yes | Disambiguator. Other Fittings can match by `kind` alone or by `kind:name`. |

Capability consumption schema (`consumes[]`):

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `kind` | enum | yes | One of the five capability kinds. |
| `name` | string | no | Omit for kind-only matching; provide to require a specific named provider. |
| `cardinality` | enum | no | `one` (default), `optional-one`, or `any`. Enforced by the resolver. |

Verify schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `command` | string | yes | Shell command run from the composition directory after `apm install`. |
| `expect` | string | yes | Trimmed stdout must include this value. |
| `timeout_ms` | integer | no | Defaults to 10000. |

UI schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `extension` | string | yes | Path relative to the Fitting root. Trusted, unsandboxed static React render in v1. |

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
