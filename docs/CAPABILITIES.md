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
via the `capabilityKinds` array in `src/lib/types.ts` (14 kinds):
`orchestrator`, `modes`, `memory-store`, `automation-runner`, `connector`,
`runtime`, `channel`, `vault`, `dev-env`, `screen-share`, `outpost`, `monitor`,
`voice`, `view`.

Dropped kinds, kept below under *Dropped kinds (historical)* for readers
tracing old manifests (the resolver rejects them today):

- Dropped in the Quarters pivot (2026-06-07): `soul`, `agent-skill`, `mcp-gateway`.
- Dropped in the Dev Env consolidation (2026-06-11): `terminal-session`, `worktree`, `session-view`; their three Fittings collapsed into the single `dev-env` Fitting/kind (Workspaces was deleted outright).
- `data-source` (dropped in the pivot, revived 2026-06-10 for
  trello-data-source, dropped again 2026-06-26): superseded by `connector`,
  which is strictly more general; Trello moved to the `trello` connector.
- `artifact-store`: retired with the artifact-store Faculty; the file-browser
  Fitting is the artifact surface today.

`automation-runner` was likewise dropped in the pivot and re-added 2026-06-13
(MR wave): the scheduler Fitting and the nightly Improver both need it, and its
runners re-home to a role faculty (script-shaped under `observability`,
cli-skill under `sessions`). Same "add a kind only when a real Fitting needs
one" precedent throughout.

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

## modes

The operative's identity/persona layer (added 2026-06-22): the souls
(Gary/Joe/James), the shared voice, the per-mode routing bias, and name-based
mode switching, composed into the orchestrator's system prompt. One operative,
three faces, one shared memory.

- **Cardinality:** singleton (listed in `singletonCapabilityKinds`).
- **Typically provides:** the `modes` Fitting (the `modes` faculty).
- **Typically consumes:** nothing; the orchestrator consumes it at
  `optional-one`.
- **Interface (TBD — runtime SDK milestone):** the runner folds the active
  mode's soul prompt into the assembled system prompt; mode switching is
  name-based in the message text.

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
direct user prompt. The scheduler daemon is the canonical example.

> Re-added 2026-06-13 (MR wave): dropped in the 2026-06-07 pivot, restored
> for the scheduler Fitting + the nightly Improver (the data-source precedent).
> The former `heartbeat`/`scheduler`/`automations` faculties are gone — runners
> re-home to a role faculty.

- **Cardinality:** any number; a composition can have multiple drivers
  on different cadences.
- **Typically provides:** Fittings re-homed to a role faculty —
  script-shaped runners (scheduler, improver, kanban-loop, automations)
  under `observability`.
- **Typically consumes:** the orchestrator (a runner needs something
  to dispatch to).
- **Interface (TBD — runtime SDK milestone):** must dispatch a
  job-like payload to the orchestrator's input boundary and surface
  outcomes the observability layer can record.

## connector

A connected external service exposing a discoverable catalog of callable
actions, Vault-sealed credentials, and optional inbound triggers (a webhook
routed through the Gateway, or a polling listener run by the Scheduler daemon).
Added 2026-06-26; strictly more general than the read-only `data-source` kind
it replaces: a connector both reads and acts, and a database such as Supabase
is just another connector.

- **Cardinality:** multi; many connected services coexist under the
  `connectors` faculty.
- **Typically provides:** one connector Fitting per service (trello, google,
  slack, deepgram, ...), declaring its catalog in the `x-garrison.connector`
  block (`auth`, `actions[]` with `mutates`/`args`, `triggers[]`).
- **Typically consumes:** `vault`; the named secrets it may read are listed in
  `x-garrison.secret_scope` (the per-connector scoping the Vault enforces).
- **Interface (TBD — runtime SDK milestone):** must expose the action catalog
  for discovery and execute a named action with templated args, with the
  credential injected at call time and never logged.

## runtime

A Fitting that hosts the agent loop and exposes a uniform
`delegate(task_spec) -> {summary, artifacts}` bridge. Added 2026-06-14
(BRIEF v4 Runtime faculty).

- **Cardinality:** multi; Claude Code, Codex, and Gemini-CLI runtimes may
  coexist under the `runtimes` role. The composition names one **primary**
  (drives user sessions; `primary_runtime` in the global config); others are
  **secondary** `delegate()` targets the Orchestrator routes work to.
- **Typically provides:** claude-code-runtime, codex-runtime, gemini-runtime,
  agent-sdk-runtime.
- **Typically consumes:** `vault` for engine credentials where needed.
- **Interface (TBD — runtime SDK milestone):** must implement the
  RuntimeAdapter contract (see `src/lib/runtime-selection.ts`).

## channel

An inbound/outbound message surface the operative uses to talk to
the principal — Slack, the web channel, etc. The channel pushes
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
  unlocked. Per-Fitting delivery is scoped by `secret_scope`.

## Own-port runtime kinds

`dev-env`, `screen-share`, `outpost`, and `voice` are the runtime-residue
capability kinds that survived the pivot. Their Fittings serve their own React
UI (or a headless backend, for `voice`) on their own HTTP port (the Monitor
pattern) and are surfaced under the `sessions` / `surfaces` / `channels` /
`observability` roles via the metadata `own_port` flag — see
[UI-FITTINGS.md](./UI-FITTINGS.md). `dev-env`, `screen-share`, and `voice` are
singletons; `outpost` is multi. Consumers link by URL after a `GET /health`
check rather than sharing state.

## dev-env

The consolidated dev surface (port 7086): every Claude Code session —
hook-detected or Dev-Env-created — is a tab pairing a Claude PTY and a shell
PTY with the app's live browser pane; git worktree create/delete, quick
prompts, and PTY-driven PR/commit flows are built in. Singleton. Replaces the
dropped `terminal-session`, `worktree`, and `session-view` kinds (2026-06-11
consolidation). The http-gateway's worktree passthrough proxies this
Fitting's `/worktrees` endpoints.

## screen-share

A stand-alone UI server (default port 7079) that captures the host screen in a
polling loop and exposes the latest frame. Singleton; lives under the
`surfaces` role.

## outpost

A bridge to a remote machine (Tailscale-connected Macs today): lists registered
outposts, surfaces connection status, and forwards RPC calls to the
outpost-host daemon. Multi; lives under the `surfaces` role.

## monitor

Read-only observability into every entity Garrison spawns — PIDs,
status, ports, network connections, working directory, redacted
env, captured stdout/stderr. Discovery is parent-PID walk plus
`ps` + `lsof`; log capture is via a shared spawn helper (see
[DECISIONS.md](./DECISIONS.md)).

- **Cardinality:** singleton per composition; the resolver expects
  exactly one provider when a Fitting consumes it.
- **Typically provides:** the `monitor-default` Fitting under the
  `observability` role.
- **Typically consumes:** nothing in v1 (read-only over local PID
  observables).
- **Interface (TBD — runtime SDK milestone):** must support `list
  entities`, `get entity by PID`, `subscribe to live updates`
  (SSE), and `fetch logs` (paged + tailed). The default Fitting
  also serves its own React UI on its own port; consumers link by
  URL after a `GET /health` availability check rather than sharing
  components or state. See [UI-FITTINGS.md](./UI-FITTINGS.md) for
  the per-Fitting-own-port pattern.

## voice

Speech in and out for the operative: transcribe audio to text and synthesize
replies to audio. Singleton; the deepgram-voice Fitting provides it today
(POST /stt, POST /tts) with its key Vault-sealed via `secret_scope`.

## view

Derived, never declared: Fittings do not list `view` in `provides` —
the resolver synthesises one `view` provision per produced view (each
`ui.views[]` entry, plus an own-port fitting's `main` surface), named
`<fittingId>:<viewId>` (see `src/lib/view-instances.ts`). Only `consumes`
names it explicitly — a consumer declares `view` with `cardinality: any` to
discover every view in the composition without hardcoding. Derived provisions
live only in the capability graph; they never appear in the assembled prompt's
capabilities block.

---

## Dropped kinds (historical)

The following kinds were retired (dates above). They are kept here only to help
read old manifests; `src/lib/metadata.ts` rejects them today.

## soul

The persona prompt that gives the Operative its identity, voice,
tone, and boundaries. The Orchestrator concatenates the Soul prompt
with its own at assembly time so the Operative reads as one coherent
character. Superseded by the `modes` kind (the souls live inside the
modes Fitting today).

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
Superseded by Quarters platform primitives (Skills) and the optional
capability faculties.

- **Cardinality:** any number can provide; consumers may want exactly
  one named skill, any of a kind, or all available.
- **Typically provides:** Fittings in the `skills` or `classifier`
  Faculty.
- **Typically consumes:** the orchestrator (transitively, via being
  invoked).
- **Interface (TBD — runtime SDK milestone):** must accept a
  structured input from the orchestrator and return a structured
  output without spawning a long-lived process.

## data-source

A read or read/write surface against an external system the
operative needs to inspect — Trello boards, Calendar events, GitHub
issues, etc. Dropped in the Quarters pivot, re-added 2026-06-10 when
trello-data-source was revived, dropped again 2026-06-26: superseded by
`connector`, which both reads and acts. Trello is the `trello` connector
today.

- **Cardinality:** any number; a composition can pull from many
  sources.
- **Typically provided by:** Fittings in the `memory` role (external
  data the Operative recalls and manipulates).
- **Typically consumes:** `vault` for the relevant API credentials.

## artifact-store

Host-provided filesystem storage for files the Operative or its
Fittings produce — markdown documents, recordings, audio, images.
Retired with the artifact-store Faculty; the file-browser Fitting is the
artifact surface today (scoped workspace root, Monaco viewing/editing,
rendered markdown, inline images).

- **Cardinality:** singleton per composition.
- **Typically provided by:** the Fitting in the former `artifact-store`
  Faculty.
- **Interface (historical):** write, read, list (filtered by namespace,
  producer, time), delete, plus a stable URL form
  (`garrison://artifacts/<id>`) the host app can route on.
