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
from a local AES-256-GCM vault, assembles the orchestrator+soul system
prompt, and spawns Claude Code via the Anthropic Agent SDK in-process.

Positioning: **open-source, local-first, single-user, no auth, talks
only to `localhost`**. v1 targets Claude Code. The Honesty Test in
[`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md) §3 gates every design
choice.

## Commands

```bash
npm install                                            # one-time (postinstall fixes node-pty perms)
npm start                                              # next dev + trenches WS, concurrently
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

- **Garrison** — the platform (this app).
- **Faculty** — a slot in a composition. 14 composition + 4 Workbench + derived **Tasks**.
- **Workbench** — shell area at `/workbench` that renders Fittings whose Faculty has `family: "workbench"`. Distinct from **Armory** (`/armory`), which is the Fitting registry browser.
- **Fitting** — the concrete component installed into a slot.
- **Operative** — the composed, running agent.
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
src/app/             Next.js routes — Compose, Run, Vault, Chat,
                     Workbench (Phase 5 tool area, /workbench),
                     Trenches (legacy standalone terminals page),
                     Armory (Fitting registry browser, /armory),
                     /fitting/<id>/... per-Fitting sidebar surfaces.
                     API routes under src/app/api/.
src/lib/             Backend runtime: runner.ts (lifecycle),
                     capabilities.ts (provides/consumes resolver),
                     metadata.ts (x-garrison parser + validator),
                     vault.ts (AES-256-GCM secret store),
                     artifact-store.ts, fitting-views.ts (UI contract
                     v2 router), preflight.ts, hosts.ts,
                     worktrees.ts, sequoias-sessions.ts.
src/components/      React UI (Compose, Run, Vault, Chrome,
                     fitting-views registry, trenches, armory,
                     workbench, chat).
compositions/<id>/   apm.yml = source of truth per composition.
                     Filesystem is authoritative; no JSON shadow.
fittings/seed/       16 local APM seed Fittings + a README.md
                     summarising capability wiring. New Fittings
                     ship as their own git repos.
data/library.json    Curated Fittings Registry (14 entries today;
                     the six originals plus Phase 1–3 additions).
data/vault.json      Encrypted secrets, file mode 0600.
scripts/             validate-fitting.ts, trenches-ws.mjs
                     (node-pty WS server), integration-check.mjs,
                     refresh-default-prompts.ts, spike/.
tests/               vitest suite — runner, capabilities, metadata,
                     fitting-view-resolver, validation, seeds, etc.
```

### Faculties (14 composition + 4 Workbench + derived Tasks)

**Composition faculties:** `heartbeat`, `scheduler`, `data-sources`,
`knowledge-base`, `automations`, `skills`, `memory`, `classifier`,
`gateway`, `channels`, `observability`, `soul`, `orchestrator`,
`artifact-store`. Tasks is *derived* from a data source and never
declared by a Fitting.

**Workbench faculties** (`family: "workbench"`, render in `/workbench`):
`terminal`, `screen-share`, `worktree-management`, `session-view`.

Long-form intent and failure modes per Faculty in
[`docs/FACULTIES.md`](./docs/FACULTIES.md).

### Capabilities

Fittings declare `provides` / `consumes` in `x-garrison`. The
resolver in `src/lib/capabilities.ts` enforces cardinality (`one`,
`optional-one`, `any`). The `any` literal is the mechanism the
Orchestrator uses to **discover installed Fittings without
hardcoding** — no Garrison code change is needed when a new Fitting
is added.

Current kinds (started at 5, grew to 9 across Phases 1–3, grew to 13
in Phase 5 for Workbench Faculties): `orchestrator`, `soul`,
`agent-skill`, `memory-store`, `automation-runner`, `data-source`,
`channel`, `artifact-store`, `vault`, `terminal-session`, `worktree`,
`session-view`, `screen-share`. `vault` is always provided by the
runtime synthetic node (`__runtime__`). `terminal-session` is
singleton.

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
5. Assemble the system prompt: Orchestrator + Soul concatenation,
   substitute the `{{capabilities}}` placeholder with one bullet
   per resolved provider, with each provider's `for_consumers`
   markdown indented underneath (falls back to `summary`). Write
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

Cross-Fitting links use `garrison://<fitting-id>/<rest>` in chat or
message bodies. The chat renderer translates them to
`/fitting/<fitting-id>/<rest>` and renders Next.js `<Link>`s.
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

## Roadmap status (as of 2026-05-11)

- **Phase 1** — PA-shaped seed Operative. **Done (2026-05-06).**
- **Phase 2** — Real PA functionality. In progress / partially
  landed; see roadmap for per-T status.
- **Phase 3** — Documents Fitting + Artifact Store + UI contract
  v2. **Done (2026-05-08).**
- **Phase 4** — Plan-then-execute (Variant A sub-agent Fitting).
  **Done (2026-05-08).**
- **Phase 5** — Workbench (family of tool Faculties; Sequoias
  decomposition as verification milestone). **Shell + seeds + Sequoias
  parity all shipped 2026-05-11.** 4 Workbench Faculties (`terminal`,
  `screen-share`, `worktree-management`, `session-view`) + 4 seed
  Fittings. Workbench shell at `/workbench`. Trenches legacy page stays
  until T8 (Sequoias retirement) is met. Naming: Workbench = tool area;
  Armory = Fitting registry browser.
- **Phase 5.5** — Sequoias parity port (port allocation engine, env
  rewriting, `package.json` patching, Claude Code hook wiring). **Done
  (2026-05-11).** Live status pipeline:
  `Claude Code hook → /api/workbench/sessions/hook → setSessionStatus →
  ~/.garrison/sessions/state.json → SessionView poll`. Modules:
  `src/lib/worktree/ports.ts`, `src/lib/worktree/env-rewriter.ts`,
  `src/lib/worktree/package-json-patcher.ts`, `src/lib/claude-hooks.ts`,
  `src/lib/garrison-sessions.ts`. T8 (retire Sequoias) blocker is now
  only the 3-day daily-use validation gate.
- **Phase 6** — Automations Faculty (EKOA port). Not started.
- **Phase 7** — Tasks Faculty (Kanban-as-control-plane). Not started.

**Always read [`docs/GARRISON_ROADMAP.md`](./docs/GARRISON_ROADMAP.md)
for live status before planning new work** — phase state drifts
faster than this file.

## Permissions / Memory / Slack / Trello specifics

- **Permission mode is `bypassPermissions`.** Anything stricter
  hangs because the UI has no permission-prompt surface yet.
- **Memory Fitting** wraps the user's existing
  `~/.claude/memory-compiler/` (Python, three Claude Code hooks,
  Anthropic-API atomic-article extraction into the Obsidian vault
  at `~/Projects/ekus/obsidian-vault/Compiled/`). The Fitting does
  **not** bundle the compiler — its setup script clones the repo
  if missing, runs `uv sync`, and wires the SessionStart /
  SessionEnd / PreCompact hooks into `~/.claude/settings.json` if
  absent.
- **Slack channel** is ported from
  `~/Projects/awc-gateway-slack/` (real webhook adapter +
  channel-agnostic gateway), **not Ekus**. Ekus's "Slack" is
  poll-based curl from inside a session.
- **Trello data source** ports
  `mac-mini/gateway/heartbeat/trello.py` from Ekus (144-line
  stdlib REST client) plus the Trello skill. Phase 7 will replace
  it with a local Tasks Faculty + a `trello-sync` Fitting that
  consumes it.

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
