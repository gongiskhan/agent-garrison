# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The full v1 spec lives at [`docs/SPEC.md`](./docs/SPEC.md) (the former
`AGENTS.md`). The live phased status lives at
[`docs/GARRISON_ROADMAP.md`](./docs/GARRISON_ROADMAP.md). All other
docs are under [`docs/`](./docs/) — drill in as needed.

## What this project is

Agent Garrison is a **local web app that composes and runs autonomous
Claude Code setups**. The composed agent is called an **Operative**.
You compose an Operative by stationing **Fittings** (APM-packaged git
repos) into **Faculty** slots, save the result as an APM manifest
(`apm.yml` with an `x-garrison` block), and hit Run. Garrison shells
out to Microsoft APM for install/audit/lockfile, materialises secrets
from a local AES-256-GCM vault, assembles the orchestrator system prompt,
and spawns Claude Code via the Anthropic Agent SDK in-process.

> **2026-06-07 Quarters pivot (in flight).** Garrison is being reframed from
> "spawns its own Operative" into a transparent **control plane over the user's
> real `~/.claude`**: APM is the single package writer; the owned/loose/parked
> state model and 6 roles (down from the prior flat-Faculty list) ship; the
> spawned Operative folds
> into the user's real Claude Code, with the orchestrator projected to
> `~/.claude/rules/garrison-orchestrator.md`. The hosted-session launcher (RC4)
> is **not yet wired**, so the runner below still genuinely spawns a process —
> that copy is accurate, not stale. See
> [`docs/CLAUDE_CONFIG_PLANE_HANDOFF.md`](./docs/CLAUDE_CONFIG_PLANE_HANDOFF.md)
> and the 2026-06-07 decision record.

Positioning: **open-source, local-first, single-user, no auth, talks
only to `localhost`**. v1 targets Claude Code. The Honesty Test in
[`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md) §3 gates every design
choice.

## Commands

```bash
npm install                                            # one-time (postinstall fixes node-pty perms)
npm start                                              # next dev + outpost host, concurrently
npm run typecheck                                      # tsc --noEmit
npm test                                               # vitest run
npm test -- tests/runner-setup.test.ts                 # single test file
npm run check:integration                              # live SDK + composition smoke
npm run test:integration                               # GARRISON_INTEGRATION=1 vitest run on orchestrator-integration
npm run refresh:prompts                                # regenerate default Orchestrator/Soul prompts
tsx scripts/validate-fitting.ts fittings/seed/<id>     # four-check validation pipeline
```

The validation pipeline is four checks: **architecture** (real),
**security** (placeholder pattern scanner), **prompt-injection**
(placeholder pattern scanner), **quality** (real). AI-driven
validators land in the runtime SDK milestone.

## Terminology — don't drift

- **Garrison** — the platform (this app). Its job is **compose · run · observe**. Anything beyond that lives in Fittings.
- **Faculty** — a **role** slot in a composition. Post-pivot there are **6 roles** (`orchestrator`, `channels`, `gateway`, `memory`, `observability`, `sessions`); the former flat 24-Faculty list collapsed into them and Skills/Hooks/MCPs/Plugins/Scripts/Settings/Context/Plans became Quarters platform primitives. A subset of runtime Fittings (`dev-env`, `screen-share`, `outposts`, `monitor`, `web-channel`, `browser`, `voice`) is **own-port** — they serve their own React UI (or a headless backend, for `voice`) on their own HTTP port (Monitor pattern) under the `sessions`/`channels`/`observability` roles via the `own_port` flag. Garrison links to those views from the sidebar's Views section; it does not embed them.
- **Views** — sidebar group, auto-populated for the current composition. Surfaces embedded views (Fittings declaring `placement: sidebar-surface`) and own-port live links (status read from `~/.garrison/ui-fittings/*.json` via `/api/fittings/views`). Garrison knows that Fittings have **views**; it does not know about "tools".
- **Lifecycle for own-port Fittings** — declared via `x-garrison.lifecycle` (`operative-bound` is the default; `detached` opts out). The runner starts operative-bound own-port Fittings during `up` and stops them during `down` by killing the PID found in `~/.garrison/ui-fittings/<id>.json`. The status file is the single source of truth; `lsof` is never consulted. Two refinements: eager-toggled Fittings are server-lifecycle — they survive both the startup orphan sweep and `down` — and every spawn writes a record under `~/.garrison/ui-fittings/spawn/<id>.json` tracking `secretsDelivered`, so a vault-consuming Fitting that started keyless is healed (restarted with secrets) on vault unlock, `up`, or eager boot.
- **Armory** — `/armory`, the Fitting registry browser.
- **Fitting** — the concrete component installed into a slot.
- **Operative** — the composed, running agent.
- **Channel** — the way external surfaces (Slack, a future Web Channel, etc.) reach the Operative through the gateway. Garrison does not ship a built-in chat surface — talking to the Operative is the Channel Fittings' job.
- **`x-garrison`** — Garrison's metadata block inside the APM
  `apm.yml` manifest. APM preserves `x-*` keys; Garrison reads this
  block. Schema in [`docs/METADATA.md`](./docs/METADATA.md).

Legacy aliases the parser still accepts (with deprecation warnings):
`primitive:` → `faculty:`; `faculty: testing-framework` →
`faculty: skills`. The React directory `src/components/` keeps the
word "component" because there it means React component, not
Garrison Fitting (per the 2026-05-04 decision).

YAML field names don't churn for cosmetic gain.
`x-garrison.component_shape` and `cardinality_hint` stay even though
their TypeScript counterparts have been renamed.

## High-level architecture

```
src/app/             Next.js routes — Compose, Run, Vault, Armory,
                     /fitting/<id>/... per-Fitting overview + views.
                     API routes under src/app/api/.
src/lib/             Backend runtime: runner.ts (lifecycle),
                     capabilities.ts (provides/consumes resolver),
                     metadata.ts (x-garrison parser + validator),
                     vault.ts (AES-256-GCM secret store),
                     artifact-store.ts, fitting-views.ts (UI contract
                     v2 router), preflight.ts, hosts.ts,
                     own-port-lifecycle.ts, view-instances.ts.
src/components/      React UI (Compose, Run, Vault, Chrome,
                     fitting-views registry + status hook, armory,
                     garrison home).
compositions/<id>/   apm.yml = source of truth per composition.
                     Filesystem is authoritative; no JSON shadow.
fittings/seed/       Local APM seed Fittings + a README.md
                     summarising capability wiring. New Fittings
                     ship as their own git repos.
data/library.json    Curated Fittings Registry.
data/vault.json      Encrypted secrets, file mode 0600.
scripts/             validate-fitting.ts, integration-check.mjs,
                     refresh-default-prompts.ts, spike/.
tests/               vitest suite — runner, capabilities, metadata,
                     fitting-view-resolver, validation, seeds, etc.
```

The visible shell surfaces are **Garrison · Compose · Armory · Run ·
Vault**, plus the sidebar **Views** group (auto-populated per
composition) and per-Fitting routes under `/fitting/<id>/...`. There is
no built-in Chat, Tools, or Operative test surface. Operative
interaction goes through Channel Fittings; observability is the runtime
log on `/run` plus per-Fitting logs under `/fitting/<id>`.

### Faculties — 6 roles (the 2026-06-07 Quarters pivot)

Faculties are now **roles only** (`facultyIds` in `src/lib/types.ts`):
`orchestrator`, `channels`, `gateway`, `memory`, `observability`, `sessions`.
The flat 24-Faculty list was collapsed into these six. Everything else —
Skills, Hooks, MCPs, Plugins, Scripts, Settings, Context, Plans — is now a
**Quarters platform primitive** surfaced over the real `~/.claude`, not a
Faculty. Legacy faculty names are accepted as deprecation aliases. See
[`docs/decisions/2026-06-07-faculties-as-roles-operative-folded.md`](./docs/decisions/2026-06-07-faculties-as-roles-operative-folded.md).

**Own-port runtime residue** — survives at runtime under
`sessions`/`channels`/`observability` via the per-Fitting `own_port` metadata
flag (not a selectable faculty): `dev-env` (default port 7086),
`screen-share` (7079), `outposts` (7082), `monitor` (7077),
`web-channel` (7083), `browser` (7084), and `voice` (7085). The Dev Env
Fitting (2026-06-11 consolidation) folds the former terminal (7078),
worktree-management (7080), and session-view (7081) Fittings into one tabbed
surface. Their Fittings serve their own React UI on the
listed port (Monitor pattern, though `voice` is a headless backend) and register themselves at runtime via
`~/.garrison/ui-fittings/<id>.json`. The sidebar Views section
surfaces them; Garrison does not embed them. See
[`docs/decisions/2026-05-17-dissolve-workbench.md`](./docs/decisions/2026-05-17-dissolve-workbench.md)
and [`docs/UI-FITTINGS.md`](./docs/UI-FITTINGS.md).

Long-form intent and failure modes per Faculty in
[`docs/FACULTIES.md`](./docs/FACULTIES.md).

### Capabilities

Fittings declare `provides` / `consumes` in `x-garrison`. The
resolver in `src/lib/capabilities.ts` enforces cardinality (`one`,
`optional-one`, `any`). The `any` literal is the mechanism the
Orchestrator uses to **discover installed Fittings without
hardcoding** — no Garrison code change is needed when a new Fitting
is added.

Current kinds (per `capabilityKinds` in `src/lib/types.ts`): `orchestrator`,
`memory-store`, `data-source`, `channel`, `vault`, `artifact-store`,
`dev-env`, `screen-share`, `outpost`,
`monitor`, `voice`, `view` (derived by the resolver from `ui.views[]` /
`own_port`, never declared in `provides`).
**Dropped in the 2026-06-07 Quarters pivot:** `soul`, `agent-skill`,
`automation-runner`, `mcp-gateway`. `data-source` was dropped with them but
re-added 2026-06-10 for the revived trello-data-source Fitting (memory role).
**Dropped in the 2026-06-11 Dev Env consolidation:** `terminal-session`,
`worktree`, `session-view` — collapsed into the singleton `dev-env` kind.
`vault` is always provided by the runtime synthetic node (`__runtime__`).
`dev-env` is singleton.

### The runner (`src/lib/runner.ts`)

`up` order:

1. `apm install` (live log streamed to the Run tab via SSE).
2. `materializeEnv` from the vault into the composition directory.
3. For each Fitting with `x-garrison.setup`: run the setup command
   in the Fitting's installed dir (`apm_modules/_local/<id>/`).
   Non-zero exit aborts `up`; downstream verify and Operative spawn
   do not run.
4. For each Fitting: run `x-garrison.verify`. Refuses silent
   success — no verify hook = hard failure.
5. Assemble the system prompt: an identity prompt (the default
   `.garrison/prompts/soul.md` — there is no separate soul Faculty
   post-pivot) followed by the Orchestrator, substituting the
   `{{capabilities}}` placeholder with one bullet per resolved
   provider, each provider's `for_consumers` markdown indented
   underneath (falls back to `summary`). Write
   `assembled-system-prompt.md`.
6. Spawn the Operative via the Anthropic Agent SDK **in-process**;
   the assembled prompt is passed as `append`. Auth uses the user's
   Max account; no API key billing. (Phase 4 observation: the SDK's
   `Query.interrupt()` is the kill switch — first-class
   cancellation primitive.)

Two principles bake in:

- **Process survives tab close.** Closing the browser does not
  kill running Operatives. Ring buffer per Operative replays on
  reopen.
- **Verify-step discipline.** Every Fitting declares a verify hook;
  the runner never claims success without it.

`dev(composition)` is `up` plus a chokidar watcher on local-path
deps; file changes trigger `apm install` + restart.

### UI contract v2 (Phase 3)

Fittings declare N views in `x-garrison.ui.views[]`. Each view has
an `id`, a `placement` (`faculty-tab` | `sidebar-surface`), an
`entry` path, and a `route` fragment (react-router-style params:
`/:id`, `/:id/edit`). The view registry at
`src/components/fitting-views/registry.tsx` is **static** in v2.
Dynamic disk loading is a v3 concern.

Cross-Fitting links use `garrison://<fitting-id>/<rest>` in message
bodies (e.g. channel replies). Renderers translate them to
`/fitting/<fitting-id>/<rest>` and render Next.js `<Link>`s.
`garrison://artifacts/<id>` for a markdown artifact resolves
transparently to `garrison://documents/<id>`.

The deprecated v1 form `ui: { extension: "./ui/X.tsx" }` is
normalised by the parser into a single-view v2 manifest with
`placement: faculty-tab` and a `console.warn`.

### `for_consumers` over Orchestrator hardcoding (locality principle)

Provider-side usage guidance lives in the Fitting that provides
the capability, not in the Orchestrator prompt. The runner injects
each provider's `for_consumers` markdown under its line in the
Orchestrator's "tools available" block at assembly time. 8 KB byte
cap per block. When absent, the runner falls back to the
provider's `summary`.

## Roadmap status

Restructured 2026-05-26: prior Phases 1–9 collapsed into 5 Stages,
priority inverted so developer-environment replacement leads and
personal-assistant / multi-machine work defers behind it. Old phase
numbering is preserved verbatim in the decision log and references
below for historical continuity.

- **Stage 1** — Replace IDE + CLI for working on agent-garrison
  itself. Largely shipped (former Phase 3 Documents/Artifact Store
  + Phase 5 Workbench-then-flat-Faculties + UI contract v2).
  Refining for daily use; Browser Fitting still in flight; Sequoias
  retirement gated on 3-day daily-use validation.
- **Stage 2** — Disciplined dev pipeline (classify → plan → execute
  under `/goal` → validate → test → evidence → report). Design
  locked 2026-05-26; implementation pending. Active focus.
- **Stage 3** — Mobile / orchestrator-driven dev workflow. Scoped;
  depends on Stage 2.
- **Stage 4** — Replace claude.ai discussions in Garrison.
  Substrate shipped (Documents + Artifact Store, formerly Phase 3);
  behavioral discipline (PM/Architect hat, document-during-
  conversation) still missing.
- **Stage 5** — Autonomous loop (Tasks Faculty as substrate,
  heartbeat-driven pickup, plan-then-approve gating). Depends on
  Stages 2–4.

Already-shipped legacy phase work that the stage list rolls up:
former Phase 1 (PA seed Operative) and Phase 4 (plan-then-execute
sub-agent) are done; their outputs (Memory/Slack/Trello/
Orchestrator/Classifier Fittings, sub-agent Fitting pattern) sit
inside the deferred PA bucket or contribute to Stage 2 pipeline
parts. Former Phase 6 (Outposts) and Phase 9 (Knowledge & Self-
Improvement) are explicitly deferred to post-Stage-5.

A **Web Channel Fitting** (browser-based channel surface) is the
planned successor to the deleted built-in chat — it is now Stage 3
work. Until it lands, Slack is the only shipped channel.

**Always read [`docs/GARRISON_ROADMAP.md`](./docs/GARRISON_ROADMAP.md)
for live status before planning new work** — stage state drifts faster
than this file.

## Permissions

- **Permission mode is `bypassPermissions`.** Anything stricter
  hangs because the UI has no permission-prompt surface yet.

Per-Fitting setup details (memory hook stacks, channel webhook
adapters, data-source clients, etc.) belong in the Fittings'
own READMEs and `apm.yml` files, not here. The Honesty Test
([`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md) §3) rejects naming a
specific downstream user's directory layout, repo URLs, or workflow
in Garrison's project doc.

## Working conventions

- **Don't optimise the Faculty list further before §10 DoD is
  observable.** New Faculties land only when a real Fitting needs
  one.
- **Don't add a new capability kind speculatively.** Add one when
  a Fitting can't be expressed without it (Claude-Code-justified,
  per the Honesty Test).
- **Verify or don't ship.** If a verify hook can't prove the
  change works, the change isn't done.
- **Setup vs verify**: setup is side-effect-causing prep (clones,
  `uv sync`, host-config writes); verify is read-only. Don't mix.

## What to read next, by intent

- Spec / shape of v1 → [`docs/SPEC.md`](./docs/SPEC.md).
- Adding or auditing a Fitting →
  [`docs/METADATA.md`](./docs/METADATA.md),
  [`docs/FITTINGS.md`](./docs/FITTINGS.md),
  [`docs/CAPABILITIES.md`](./docs/CAPABILITIES.md).
- Faculty intent and failure modes →
  [`docs/FACULTIES.md`](./docs/FACULTIES.md).
- Verifying v1 readiness → [`docs/V1_DOD.md`](./docs/V1_DOD.md)
  and per-phase records under
  [`docs/phases/`](./docs/phases/).
- Policy and contribution rules →
  [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md),
  [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md).
- Why a choice was made →
  [`docs/DECISIONS.md`](./docs/DECISIONS.md).
- What's queued and what just shipped →
  [`docs/GARRISON_ROADMAP.md`](./docs/GARRISON_ROADMAP.md).
