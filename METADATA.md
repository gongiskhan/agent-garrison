# Agent Garrison Metadata

`x-garrison` is Agent Garrison's metadata block inside an APM `apm.yml` manifest. APM owns dependency resolution, install, audit, pack, and lockfile pinning. Garrison reads this block to understand which primitive a package fills, how it should be configured, how it verifies itself, and whether it ships a trusted local UI extension.

## Placement

```yaml
name: garrison-tier-classifier
version: 0.1.0
target: claude
type: hybrid

x-garrison:
  primitive: classifier
  cardinality_hint: single
  component_shape: skill
  platforms: [claude-code]
  config_schema:
    - key: tier_floor
      type: integer
      default: 3
      description: Minimum tier this classifier raises every prompt to.
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
| `primitive` | enum | yes | One of the 13 explicit primitive ids. Tasks is derived and must not be declared by a package. |
| `cardinality_hint` | enum | yes | `single` or `multi`. Validated against the primitive definition. |
| `component_shape` | enum | yes | One of Garrison's closed component shapes. |
| `platforms` | string array | yes | `all`, `claude-code`, `codex`, or future platform ids. v1 accepts only `all` and `claude-code` at compose time. |
| `summary` | string | no | Human summary shown in the Library and picker. |
| `config_schema` | array | no | UI-renderable config fields. Defaults to `[]`. |
| `verify` | object | yes | Runtime verification command and expected output. |
| `ui` | object | no | Optional trusted React extension metadata. |
| `tasks` | object | no | Optional declaration that this component backs the derived Tasks surface. |

Primitive ids:

`heartbeat`, `scheduler`, `data-sources`, `knowledge-base`, `automations`, `testing-framework`, `memory`, `classifier`, `gateway`, `channels`, `observability`, `soul`, `orchestrator`.

Component shapes:

`script`, `agent-instructions`, `manual-instructions`, `plugin`, `skill`, `cli`, `hook`, `system-prompt`, `cli-skill`, `mcp`.

Config field schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `key` | string | yes | Stable config key. Must match `^[a-zA-Z_][a-zA-Z0-9_]*$`. |
| `type` | enum | yes | `string`, `integer`, `number`, `boolean`, `select`, `path`, or `secret-ref`. |
| `default` | scalar | no | Must match the field type when present. |
| `description` | string | yes | Short UI label/help text. |
| `required` | boolean | no | Defaults to `false`. |
| `options` | string array | conditional | Required for `select`. |

Verify schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `command` | string | yes | Shell command run from the composition directory after `apm install`. |
| `expect` | string | yes | Trimmed stdout must include this value. |
| `timeout_ms` | integer | no | Defaults to 10000. |

UI schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `extension` | string | yes | Path relative to the package root. Trusted, unsandboxed static React render in v1. |

Tasks schema:

| Field | Type | Required | Notes |
|---|---:|---:|---|
| `source` | string | yes | Human source label, for example `trello`. |
| `truth_file` | string | yes | Markdown path inside the composition that mirrors task state. |

## Validation Rules

- A package cannot declare `primitive: tasks`; Tasks is inferred from selected data sources.
- `cardinality_hint` must match the central primitive table.
- `component_shape` must be accepted by the target primitive.
- v1 composition validation rejects components that do not support `all` or `claude-code`.
- Single-cardinality primitives may have zero or one selected component; multi-cardinality primitives may have zero or more.
- Every selected component must have a `verify` command. Missing verify metadata is a hard failure.
- `ui.extension` is loaded only for selected components and only from local package paths in v1.

## Typed Validator Target

The validator module should export:

```ts
export function parseGarrisonMetadata(input: unknown): GarrisonMetadata;
export function validatePrimitiveCompatibility(metadata: GarrisonMetadata): void;
export function validateSelection(primitiveId: PrimitiveId, selected: LibraryEntry[]): void;
```

Validation errors should be precise enough for the Compose tab to show the failing primitive and component.
