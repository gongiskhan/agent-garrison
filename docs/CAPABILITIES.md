# Capabilities

The capability kinds Fittings can `provides` or `consumes` in their
`x-garrison` block. Cardinality is enforced by the resolver
(`src/lib/capabilities.ts`); see [GOVERNANCE.md](./GOVERNANCE.md) and
[FITTINGS.md](./FITTINGS.md) for context.

The set grew across phases, then **shrank with the 2026-06-07 Quarters pivot**
(see [DECISIONS.md](./DECISIONS.md) and the decision record
`decisions/2026-06-07-faculties-as-roles-operative-folded.md`). The spawned
Operative folded into the user's real Claude Code, so the spawn-machinery kinds
were retired and Skills/automations became Quarters platform primitives rather
than capabilities. The current full list, as enforced by `src/lib/metadata.ts`
via the `capabilityKinds` array in `src/lib/types.ts`: `orchestrator`,
`memory-store`, `channel`, `vault`, `artifact-store`, `terminal-session`,
`worktree`, `session-view`, `screen-share`, `outpost`, `monitor`, `voice`,
`view`.

`view` is **derived, never declared**: fittings do not list it in `provides` —
the resolver synthesises one `view` provision per produced view (each
`ui.views[]` entry, plus an own-port fitting's `main` surface), named
`<fittingId>:<viewId>` (see `src/lib/view-instances.ts`). Only `consumes` names
it explicitly — e.g. the Workspaces Fitting consumes `view` with
`cardinality: any` to discover every view in the composition without
hardcoding. Derived provisions live only in the capability graph; they never
appear in the assembled prompt's capabilities block.

Dropped in the Quarters pivot (no longer valid kinds): `soul`, `agent-skill`, `automation-runner`, `data-source`, `mcp-gateway`.
Sections for these are kept below under *Dropped kinds (historical)* for readers
tracing old manifests; the resolver rejects them.

## Cardinality literals

Consumption blocks accept an explicit `cardinality` value. The three
literal tokens the resolver understands are:

- `one` (default if omitted) — exactly one provider must match. The
  resolver raises an error if zero or more than one is present.
- `optional-one` — zero or one provider may match. The resolver
  raises an error only if more than one is present.
- `any` — zero or more providers may match. The resolver accepts
  every match silently; the consumer Fitting can iterate the
  `matched` list at runtime.

Example:

```yaml
consumes:
  - { kind: channel, cardinality: any }
```

> **Interface stubs are TBD — runtime SDK milestone.** Each section
> below describes what each kind is for and what its interface will
> need to expose. The actual TypeScript signatures are intentionally
> not specified here so the runtime SDK milestone can design them
> against real implementation pressure rather than inheriting
> speculative shapes.

## Provider-side usage guidance (`for_consumers`)

A provider Fitting SHOULD ship a `for_consumers` block in its
`x-garrison` metadata for any non-obvious usage. The block is
free-form markdown describing when and how the Operative ought to
reach for the capability — trigger conditions, calling pattern,
anti-patterns. Consumer-side code does not interpret this field; the
runner injects it verbatim under the provider's line in the
Orchestrator's capabilities block at assembly time. Locality
principle: a Fitting that ships a capability also ships the doc on
how to use it.

The field is optional. When absent, the runner falls back to the
provider's `summary`. See `METADATA.md` for the schema row and the
8 KB byte cap.

---

## orchestrator

The capstone Fitting that governs the operative's behavior. There is
exactly one orchestrator per composition.

- **Cardinality:** singleton (the resolver enforces this across the
  whole composition).
- **Typically provides:** the Fitting that owns the orchestrator
  Faculty.
- **Typically consumes:** nothing — it is the consumer of everything
  else.
- **Interface (TBD — runtime SDK milestone):** must accept the user
  prompt, persist via `memory-store`, and read secrets from `vault`.
  Post-pivot the orchestrator is an APM-managed instructions primitive
  projected to `~/.claude/rules/garrison-orchestrator.md` (with
  `--append-system-prompt` as the higher-authority launch fallback), not a
  separately-spawned agent.

## Own-port runtime kinds

`terminal-session`, `worktree`, `session-view`, `screen-share`, `outpost`, and
`voice` are the runtime-residue capability kinds that survived the pivot. Their
Fittings serve their own React UI (or a headless backend, for `voice`) on their
own HTTP port (the Monitor pattern) and are surfaced under the `sessions` /
`channels` / `observability` roles via the metadata `own_port` flag — see
[UI-FITTINGS.md](./UI-FITTINGS.md). `terminal-session`, `worktree`,
`session-view`, `screen-share`, and `voice` are singletons; `outpost` is
multi. Consumers link by URL after a `GET /health` check rather than sharing
state.

## Dropped kinds (historical)

The following kinds were retired in the 2026-06-07 Quarters pivot. They are kept
here only to help read old manifests; `src/lib/metadata.ts` rejects them today.

## soul

The persona prompt that gives the Operative its identity, voice,
tone, and boundaries. The Orchestrator concatenates the Soul prompt
with its own at assembly time so the Operative reads as one coherent
character.

- **Cardinality:** singleton (the resolver enforces only one Soul
  per composition).
- **Typically provides:** a Fitting in the `soul` Faculty.
- **Typically consumes:** nothing.
- **Interface (TBD — runtime SDK milestone):** the runner reads the
  provider's `.apm/prompts/*.prompt.md` file at assembly time and
  prepends it to the Orchestrator prompt.

## agent-skill

A reusable procedure or sub-agent the orchestrator can invoke during a
session. Examples: a tier classifier, a summarizer, a test author.

- **Cardinality:** any number can provide; consumers may want exactly
  one named skill, any of a kind, or all available.
- **Typically provides:** Fittings in the `skills` or `classifier`
  Faculty.
- **Typically consumes:** the orchestrator (transitively, via being
  invoked).
- **Interface (TBD — runtime SDK milestone):** must accept a
  structured input from the orchestrator and return a structured
  output without spawning a long-lived process.

## memory-store

Within-session and cross-session recall for the operative.

- **Cardinality:** typically one; the resolver does not flag it as a
  singleton kind so a composition that needs more than one (e.g.,
  scratchpad + long-term) is still legal.
- **Typically provides:** the Fitting in the `memory` Faculty.
- **Typically consumes:** `vault` for any encrypted persistence.
- **Interface (TBD — runtime SDK milestone):** must support read,
  write, and a compaction/persistence cadence the orchestrator can
  trigger or observe.

## automation-runner

A scheduled or event-driven driver that wakes the operative without a
direct user prompt. The heartbeat is the canonical example.

- **Cardinality:** any number; a composition can have multiple drivers
  on different cadences.
- **Typically provides:** Fittings in the `heartbeat`, `scheduler`, or
  `automations` Faculty.
- **Typically consumes:** the orchestrator (a runner needs something
  to dispatch to).
- **Interface (TBD — runtime SDK milestone):** must dispatch a
  job-like payload to the orchestrator's input boundary and surface
  outcomes the observability layer can record.

## data-source

A read or read/write surface against an external system the
operative needs to inspect — Trello boards, Calendar events, GitHub
issues, etc.

- **Cardinality:** any number; a composition can pull from many
  sources.
- **Typically provides:** Fittings in the `data-sources` Faculty.
- **Typically consumes:** `vault` for the relevant API credentials.
- **Interface (TBD — runtime SDK milestone):** must expose a
  read API the orchestrator can call directly or via a CLI/skill;
  optionally a write API for sources that support mutation.

## channel

An inbound/outbound message surface the operative uses to talk to
the principal — Slack, iMessage, email, etc. The channel pushes
messages into the gateway and surfaces operative replies back.

- **Cardinality:** any number; a composition may host the operative
  on multiple channels simultaneously.
- **Typically provides:** Fittings in the `channels` Faculty.
- **Typically consumes:** `vault` for channel credentials, and the
  gateway endpoint the runtime exposes.
- **Interface (TBD — runtime SDK milestone):** must accept inbound
  messages from the external channel, post them to the gateway, and
  relay the reply back. FIFO ordering is preserved by the gateway
  when used.

## artifact-store

Host-provided filesystem storage for files the Operative or its
Fittings produce — markdown documents, recordings, audio, images.
Producer Fittings (Documents, Automations, Voice) layer their own
schemas on top.

- **Cardinality:** singleton per composition; the resolver expects
  exactly one provider when a Fitting consumes it.
- **Typically provides:** the Fitting in the `artifact-store`
  Faculty.
- **Typically consumes:** nothing in v1. Future versions may
  consume `vault` if encrypted artifacts ship.
- **Interface (TBD — runtime SDK milestone):** must support write,
  read, list (filtered by namespace, producer, time), and delete,
  plus a stable URL form (`garrison://artifacts/<id>`) the host app
  can route on. Filesystem is the v1 backend; later versions can
  swap in cloud or content-addressable storage without changing
  the consumer surface.

## monitor

Read-only observability into every entity Garrison spawns — PIDs,
status, ports, network connections, working directory, redacted
env, captured stdout/stderr. Discovery is parent-PID walk plus
`ps` + `lsof`; log capture is via a shared spawn helper (see
[DECISIONS.md](./DECISIONS.md)).

- **Cardinality:** singleton per composition; the resolver expects
  exactly one provider when a Fitting consumes it.
- **Typically provides:** the `monitor-default` Fitting under the
  `monitor` Faculty.
- **Typically consumes:** nothing in v1 (read-only over local PID
  observables).
- **Interface (TBD — runtime SDK milestone):** must support `list
  entities`, `get entity by PID`, `subscribe to live updates`
  (SSE), and `fetch logs` (paged + tailed). The default Fitting
  also serves its own React UI on its own port; consumers link by
  URL after a `GET /health` availability check rather than sharing
  components or state. See [UI-FITTINGS.md](./UI-FITTINGS.md) for
  the per-Fitting-own-port pattern.

## vault

Encrypted secret storage the runtime always provides synthetically.
Fittings consume this to read API keys and other secrets without
embedding them in the manifest.

- **Cardinality:** singleton, always provided by the runtime
  (`__runtime__` synthetic node in the resolver).
- **Typically provides:** the runtime, not a Fitting.
- **Typically consumes:** any Fitting needing secret material.
- **Interface (TBD — runtime SDK milestone):** must support keyed
  read of secrets the user has stored under the Vault tab. AES-256-GCM
  on disk; passphrase-derived key in memory only while the Vault is
  unlocked.
