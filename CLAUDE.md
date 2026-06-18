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

> **2026-06-07 Quarters pivot (largely shipped).** Garrison is now a
> transparent **control plane over the user's real `~/.claude`**: APM is
> the single package writer; the owned/loose/parked state model and 6 roles
> (down from the prior flat-Faculty list) are live; the Orchestrator prompt
> is projected to `~/.claude/rules/garrison-orchestrator.md`. The
> hosted-session launcher (RC4) is **not yet wired**, so the runner still
> spawns a process via `spawnGateway`/`spawnClaude`. See
> [`docs/decisions/2026-06-07-faculties-as-roles-operative-folded.md`](./docs/decisions/2026-06-07-faculties-as-roles-operative-folded.md).

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

- **Garrison** — the platform (this app). Its job is **compose · run · observe · quarters**. Anything beyond that lives in Fittings.
- **Faculty** — a **role** slot in a composition. There are **8 roles** (`orchestrator`, `channels`, `gateway`, `runtimes`, `memory`, `observability`, `sessions`, `surfaces`); the former flat 24-Faculty list collapsed into them and Skills/Hooks/MCPs/Plugins/Scripts/Settings/Context/Plans became Quarters platform primitives. The 2026-06-18 split moved the runtime engines into `runtimes` and the auxiliary own-port viewers (screen-share, browser, outpost) into `surfaces`, slimming the overloaded `sessions` role to the Dev Env surface + artifact store. A subset of runtime Fittings is **own-port** — they serve their own React UI on their own HTTP port under the `sessions`/`surfaces`/`channels`/`observability` roles via the `own_port` flag. Garrison links to those views from the sidebar's Views section.
- **Quarters** — the `~/.claude` config surface (Skills, Hooks, MCPs, Plugins, Scripts, Settings, Context, Plans, Commands, Rules) surfaced at `/quarters`. APM is the single writer; Garrison autosaves via `reconcile.ts`. State = owned / loose / parked.
- **Views** — sidebar group, auto-populated for the current composition. Surfaces embedded views (Fittings declaring `placement: sidebar-surface`) and own-port live links (status read from `~/.garrison/ui-fittings/*.json` via `/api/fittings/views`).
- **Lifecycle for own-port Fittings** — declared via `x-garrison.lifecycle` (`operative-bound` is the default; `detached` opts out). The runner starts operative-bound own-port Fittings during `up` and stops them during `down` by killing the PID found in `~/.garrison/ui-fittings/<id>.json`. The status file is the single source of truth; `lsof` is never consulted. Eager-toggled Fittings are server-lifecycle — they survive both the startup orphan sweep and `down` — and every spawn writes a record under `~/.garrison/ui-fittings/spawn/<id>.json` tracking `secretsDelivered`, so a vault-consuming Fitting started keyless is healed (restarted with secrets) on vault unlock, `up`, or eager boot.
- **Armory** — `/armory`, the Fitting registry browser.
- **Fitting** — the concrete component installed into a slot.
- **Operative** — the composed, running agent (the user's real Claude Code session post-pivot).
- **Channel** — the way external surfaces (Slack, Web Channel) reach the Operative through the gateway. Garrison does not ship a built-in chat surface.
- **`x-garrison`** — Garrison's metadata block inside the APM `apm.yml` manifest. APM preserves `x-*` keys. Schema in [`docs/METADATA.md`](./docs/METADATA.md).

Legacy aliases the parser still accepts (with deprecation warnings):
`primitive:` → `faculty:`; `faculty: testing-framework` →
`faculty: skills`. The React directory `src/components/` keeps the
word "component" because there it means React component, not
Garrison Fitting.

YAML field names don't churn for cosmetic gain.
`x-garrison.component_shape` and `cardinality_hint` stay even though
their TypeScript counterparts have been renamed.

## High-level architecture

```
src/app/             Next.js routes — Compose, Run, Vault, Armory,
                     Quarters (/quarters/[type]), /fitting/<id>/...
                     per-Fitting overview + views. API under src/app/api/.
src/lib/             Backend runtime (flat, no sub-packages):
                       runner.ts           lifecycle (up/down/dev)
                       capabilities.ts     provides/consumes resolver
                       metadata.ts         x-garrison parser + validator
                       vault.ts            AES-256-GCM secret store
                       artifact-store.ts   namespaced filesystem store
                       fitting-views.ts    UI contract v2 router
                       quarters.ts         Quarters index (10 categories)
                       quarters-detail.ts  per-type detail reads
                       global-composition.ts  symlink-confined global comp
                       primitive-state.ts  owned/loose/parked classifier
                       claude-scan.ts      ~/.claude disk reader
                       reconcile.ts        APM write-through + echo suppression
                       state-transitions.ts promote/park/unpark + orphan cleanup
                       orchestrator-projection.ts  rules-file + append-system-prompt
                       provenance.ts       _garrison tag tracking
                       apm-exec.ts         injectable ApmRunner
                       atomic-write.ts     safe 0600-preserving writes
                       hooks-crud.ts       hooks read/write
                       mcp-writer.ts       MCP config write-through
                       trenches/           worktree + session management
                       validation/         four-check pipeline
                       worktree/           git worktree CRUD helpers
src/components/      React UI (Compose, Run, Vault, Chrome,
                     Quarters panels, fitting-views registry + status hook,
                     armory, garrison home).
packages/claude-pty/ PTY substrate — drives the interactive Claude Code TUI
                     under node-pty + @xterm/headless. Warm pool, rich
                     streaming, xterm screen reader. Used by dev-env Fitting
                     and web-channel. Entry: src/index.mjs.
packages/claude-chat/ Chat client built on claude-pty.
compositions/<id>/   apm.yml = source of truth per composition.
                     Filesystem is authoritative; no JSON shadow.
fittings/seed/       Local APM seed Fittings. Each is a self-contained APM
                     package; new ones ship as their own git repos.
data/library.json    Curated Fittings Registry.
data/vault.json      Encrypted secrets, file mode 0600.
scripts/             validate-fitting.ts, integration-check.mjs,
                     refresh-default-prompts.ts, spike/.
tests/               Vitest suite — runner, capabilities, metadata,
                     fitting-view-resolver, validation, seeds, etc.
```

The visible shell surfaces are **Garrison · Compose · Armory · Run ·
Vault · Quarters**, plus the sidebar **Views** group (auto-populated per
composition) and per-Fitting routes under `/fitting/<id>/...`. There is
no built-in Chat surface. Operative interaction goes through Channel
Fittings; observability is the runtime log on `/run` plus per-Fitting
logs under `/fitting/<id>`.

### Faculties — 8 roles (Quarters pivot + 2026-06-18 sessions split)

Faculties are now **roles only** (`facultyIds` in `src/lib/types.ts`):
`orchestrator`, `channels`, `gateway`, `runtimes`, `memory`, `observability`,
`sessions`, `surfaces`. The 2026-06-18 split carved the overloaded `sessions`
role into three: `sessions` keeps the Dev Env surface + artifact store,
`runtimes` holds the alternative execution engines (Agent SDK / Codex / Gemini),
and `surfaces` holds the auxiliary own-port viewers (screen-share / browser /
outpost). Everything else — Skills, Hooks, MCPs, Plugins, Scripts, Settings,
Context, Plans — is now a **Quarters platform primitive** surfaced over the real
`~/.claude`, not a Faculty.

**Own-port runtime residue** — survives at runtime under
`sessions`/`channels`/`observability` via the per-Fitting `own_port` metadata
flag: `dev-env` (7086), `screen-share` (7079), `outposts` (7082),
`monitor` (7077), `web-channel` (7083), `browser` (7084), `voice` (7085).
The Dev Env Fitting folds the former terminal/worktree-management/session-view
into one tabbed surface: every Claude Code session is a tab holding a Claude
PTY + shell PTY (left) and the live browser pane (right), with worktree / PR
/ commit-and-push actions in the menu.

### Quarters engine

`src/lib/global-composition.ts` — the symlink-confined global composition at
`~/.garrison/global-composition/` with `.claude` → symlink to `~/.claude`.
`apm install` writes through the link into the real `~/.claude`.

State model: **owned** (in `apm.yml` + `apm.lock.yaml`), **loose** (on disk,
not in lock), **parked** (off-disk under `~/.garrison/parked/`). APM is the
single writer for package files; Garrison owns orphan-cleanup on park.

`reconcile.ts` — importer with hash-compare echo suppression (only writes
when content actually changes). `state-transitions.ts` — promote/park/unpark
with orphan cleanup.

`orchestrator-projection.ts` — `buildOrchestratorInstructions` (soul +
orchestrator + `{{capabilities}}` fold) + `projectOrchestrator` (APM
instructions primitive → `~/.claude/rules/garrison-orchestrator.md`) +
`orchestratorAppendSystemPrompt` (per-launch fallback via
`--append-system-prompt`).

### Capabilities

Fittings declare `provides` / `consumes` in `x-garrison`. The
resolver in `src/lib/capabilities.ts` enforces cardinality (`one`,
`optional-one`, `any`). The `any` literal is the mechanism the
Orchestrator uses to **discover installed Fittings without
hardcoding** — no Garrison code change is needed when a new Fitting
is added.

Current kinds (per `capabilityKinds` in `src/lib/types.ts`): `orchestrator`,
`memory-store`, `data-source`, `channel`, `vault`, `artifact-store`,
`dev-env`, `screen-share`, `outpost`, `monitor`, `voice`, `view` (derived by
the resolver from `ui.views[]` / `own_port`, never declared in `provides`).

### The runner (`src/lib/runner.ts`)

`up` order:

1. `apm install` (live log streamed to the Run tab via SSE).
2. `materializeEnv` from the vault into the composition directory.
3. For each Fitting with `x-garrison.setup`: run the setup command in the
   Fitting's installed dir. Non-zero exit aborts `up`.
4. For each Fitting: run `x-garrison.verify`. No verify hook = hard failure.
5. Assemble the system prompt: soul + orchestrator + `{{capabilities}}` (each
   provider's `for_consumers` markdown indented under its capability line,
   falls back to `summary`). Write `assembled-system-prompt.md`.
   Also project to `~/.claude/rules/garrison-orchestrator.md`.
6. Spawn the Operative via the Anthropic Agent SDK in-process.
   Auth uses the user's Max account; no API key billing.

Two principles bake in:

- **Process survives tab close.** Closing the browser does not kill running
  Operatives. Ring buffer per Operative replays on reopen.
- **Verify-step discipline.** Every Fitting declares a verify hook; the runner
  never claims success without it.

`dev(composition)` is `up` plus a chokidar watcher on local-path deps;
file changes trigger `apm install` + restart.

**Setup vs verify**: setup is side-effect-causing prep (clones, `uv sync`,
host-config writes); verify is read-only. Don't mix.

### UI contract v2 (Phase 3)

Fittings declare N views in `x-garrison.ui.views[]`. Each view has an `id`,
a `placement` (`faculty-tab` | `sidebar-surface`), an `entry` path, and a
`route` fragment. The view registry at
`src/components/fitting-views/registry.tsx` is **static** in v2.

Cross-Fitting links use `garrison://<fitting-id>/<rest>` in message bodies.
Renderers translate them to `/fitting/<fitting-id>/<rest>`.

The deprecated v1 form `ui: { extension: "./ui/X.tsx" }` is normalised by
the parser into a single-view v2 manifest with `console.warn`.

### `for_consumers` over Orchestrator hardcoding (locality principle)

Provider-side usage guidance lives in the Fitting that provides the
capability, not in the Orchestrator prompt. The runner injects each
provider's `for_consumers` markdown under its line in the Orchestrator's
"tools available" block at assembly time. 8 KB byte cap per block. When
absent, the runner falls back to the provider's `summary`.

## Roadmap status

5 Stages (restructured 2026-05-26; prior Phase 1–9 numbering is preserved in
the decision log and old references).

- **Stage 1** — Replace IDE + CLI for working on agent-garrison itself.
  Largely shipped; refining for daily use. Browser Fitting still in flight.
- **Stage 2** — Disciplined dev pipeline (classify → plan → execute under
  `/goal` → validate → test → evidence → report). Design locked 2026-05-26;
  implementation pending. Active focus.
- **Stage 3** — Mobile / orchestrator-driven dev workflow. Scoped; depends
  on Stage 2.
- **Stage 4** — Replace claude.ai discussions in Garrison. Substrate shipped
  (Documents + Artifact Store); behavioral discipline missing.
- **Stage 5** — Autonomous loop (Tasks Faculty, heartbeat-driven pickup,
  plan-then-approve gating). Depends on Stages 2–4.

**Always read [`docs/GARRISON_ROADMAP.md`](./docs/GARRISON_ROADMAP.md)
for live status before planning new work** — stage state drifts faster
than this file.

## Permissions

- **Permission mode is `bypassPermissions`.** Anything stricter
  hangs because the UI has no permission-prompt surface yet.

## Working conventions

- **Don't optimise the Faculty list further before §10 DoD is
  observable.** New Faculties land only when a real Fitting needs one.
- **Don't add a new capability kind speculatively.** Add one when a Fitting
  can't be expressed without it (Claude-Code-justified, per the Honesty Test).
- **Verify or don't ship.** If a verify hook can't prove the change works,
  the change isn't done.
- **No Save buttons in Quarters surfaces.** Every config change autosaves
  (discrete = immediate, text/number/json = debounced). Drift is surfaced
  via `/api/settings/drift`.

## What to read next, by intent

- Spec / shape of v1 → [`docs/SPEC.md`](./docs/SPEC.md).
- Adding or auditing a Fitting →
  [`docs/METADATA.md`](./docs/METADATA.md),
  [`docs/FITTINGS.md`](./docs/FITTINGS.md),
  [`docs/CAPABILITIES.md`](./docs/CAPABILITIES.md).
- Faculty intent and failure modes → [`docs/FACULTIES.md`](./docs/FACULTIES.md).
- Verifying v1 readiness → [`docs/V1_DOD.md`](./docs/V1_DOD.md)
  and per-phase records under [`docs/phases/`](./docs/phases/).
- Policy and contribution rules →
  [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md),
  [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md).
- Why a choice was made → [`docs/DECISIONS.md`](./docs/DECISIONS.md).
- What's queued and what just shipped →
  [`docs/GARRISON_ROADMAP.md`](./docs/GARRISON_ROADMAP.md).
