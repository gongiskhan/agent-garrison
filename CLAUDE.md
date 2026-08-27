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
> (down from the prior flat-Faculty list) are live; the layered Orchestrator
> document (editable Identity/routing doctrine plus generated capabilities,
> duties, and readiness) is the one runtime prompt source and is handed to the
> gateway at launch. The `projectOrchestrator` rules-file
> projection (`~/.claude/rules/garrison-orchestrator.md`) is implemented but
> not yet wired into `up()` — RC3 dormant. The
> hosted-session launcher (RC4) is **not yet wired**, so the runner still
> spawns a process via `spawnGateway`/`spawnClaude`. See
> [`docs/decisions/2026-06-07-faculties-as-roles-operative-folded.md`](./docs/decisions/2026-06-07-faculties-as-roles-operative-folded.md).

> **2026-08-24 Mesh.** Garrison is now installed as a full node on every
> machine. Shared state (cards, config, compositions, coordination, secrets)
> lives in the state service on dev-madrid (`services/state/`); code moves
> only through git on per-node branches; session artifacts stay on their
> node; memory rides vault-git-sync. See AGENTS.md for the state split,
> merge policy, and the accepted availability property (dev-madrid down =
> no new up() anywhere).

Positioning: **open-source, local-first, single-user, no auth, talks
only to `localhost`**. v1 targets Claude Code. The Honesty Test in
[`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md) §3 gates every design
choice.

## Commands

```bash
npm install                                            # one-time (postinstall fixes node-pty perms)
npm start                                              # PROD/node instance (8xxx, ~/.garrison)  [= prod:start]
npm run dev                                            # DEV instance  (18xxx, ~/.garrison-dev)
npm run dev:start                                      # start DEV detached, under its own LaunchAgent
npm run dev:stop                                       # stop DEV
npm run dev:status                                     # is DEV up? which commit is it on?
npm run promote -- "message"                           # commit in dev -> fast-forward prod -> redeploy
npm run node:redeploy                                  # build + restart the node, session, fittings (prod:redeploy = alias)
npm run typecheck                                      # tsc --noEmit
npm test                                               # vitest run
npm test -- tests/runner-setup.test.ts                 # single test file
npm run check:integration                              # live SDK + composition smoke
npm run test:integration                               # GARRISON_INTEGRATION=1 vitest run on orchestrator-integration
npm run refresh:prompts                                # regenerate default Orchestrator prompts
tsx scripts/validate-fitting.ts fittings/seed/<id>     # four-check validation pipeline
bash scripts/install-node.sh --name <n> --token <t> --state-url <url>   # enroll a machine as a mesh node
```

The validation pipeline is four checks: **architecture** (real),
**security** (placeholder pattern scanner), **prompt-injection**
(placeholder pattern scanner), **quality** (real). AI-driven
validators land in the runtime SDK milestone.

The remote-Mac snapshot workflow is RETIRED (2026-08-24 mesh): every machine
runs a full node installed by `scripts/install-node.sh`, builds and serves
locally, and moves code only through git on its `node/<id>` branch. The two
safety rules that workflow taught survive in the installer: symlink refusal,
and never syncing a working tree into a checkout a service is executing from
(carried in docs/INSTANCES.md).

## Terminology — don't drift

- **Garrison** — the platform (this app). Its job is **compose · run · observe · quarters**. Anything beyond that lives in Fittings.
- **Faculty** — a **role** slot in a composition. **16 in total** (`facultyIds` in `src/lib/types.ts`): **8 core roles** (`orchestrator`, `channels`, `gateway`, `runtimes`, `memory`, `observability`, `sessions`, `surfaces`) plus **7 optional capability faculties** added 2026-06-24 (`knowledge`, `research`, `building`, `code-intelligence`, `design`, `browser-qa`, `coordination`) — the purpose-named homes the promoted Claude Code primitives fill (the primitive type — skill/hook/mcp/plugin — survives only as an internal `component_shape`, never as a user-facing label) — plus the **`connectors`** faculty added 2026-06-26 (Agent-tier, multi): authenticated, Vault-sealed connections to external services (Trello, Google, Slack, Deepgram, …), each a Fitting providing the `connector` kind with an action catalog + sealed auth + optional triggers (it absorbs the dropped read-only `data-source` case). The former flat 24-Faculty list collapsed into the core roles and Skills/Hooks/MCPs/Plugins/Scripts/Settings/Context/Plans became Quarters platform primitives. The 2026-06-18 split moved the runtime engines into `runtimes` and the auxiliary own-port viewers (screen-share, browser, outpost) into `surfaces`, slimming the overloaded `sessions` role to the Dev Env surface + artifact store. A subset of runtime Fittings is **own-port** — they serve their own React UI on their own HTTP port under the `sessions`/`surfaces`/`channels`/`observability` roles via the `own_port` flag. Garrison links to those views from the sidebar's Fittings section. Every faculty also carries a display **tier** (`agent`/`dev`) driving the Compose grid's two headers. Legacy `modes` selections are removed during composition migration; live identity is authored inside Orchestrator.
- **Quarters** — the `~/.claude` config surface (Skills, Hooks, MCPs, Plugins, Scripts, Settings, Context, Plans, Commands, Rules) surfaced at `/quarters`. APM is the single writer; Garrison autosaves via `reconcile.ts`. State = owned / loose / parked.
- **The menu (sidebar)** — three groups: **Pinned** on top (always open), then **Command** and **Fittings**, both collapsible and both FLAT alphabetical (the 2026-08-26 refit dropped the category sub-groups; category survives as the Compose/library axis). Pinned takes both kinds — a `nav:`-prefixed Command route or a Fitting id — dragged in and dragged out, and it lives in the state service (`sidebar.pins` / `global`), so **the menu is the same on every node**; `~/.garrison/sidebar-pins.json` is only the standalone store and this node's degraded-read materialisation, and a pin write REFUSES when the service is unreachable. The Fittings group is auto-populated for the current composition and lists EVERY equipped Fitting (2026-07-29 refit: every Fitting has a view). Embedded views open at `/fitting/<id>` (the view IS the page — the old per-fitting overview/config page is gone); own-port live links embed at `/embed/<id>` (status read from `~/.garrison/ui-fittings/*.json` via `/api/fittings/views`).
- **Lifecycle for own-port Fittings** — fittings share the operative's lifecycle, always (2026-07-29 refit: the eager/detached split is gone; `x-garrison.lifecycle` is parsed-and-ignored with a deprecation warning). `up` starts EVERY own-port Fitting with the runner-projected env (gateway URL, composition id, selection config, vault) and heals running ones on env drift; `down` stops every one by killing the PID found in `~/.garrison/ui-fittings/<id>.json`. The status file is the single source of truth; `lsof` is never consulted. The startup orphan sweep reaps anything not protected by a RUNNING composition. `/api/fittings/[id]/start|restart` remain as recovery/code-reload controls (env parity via `operativeEnvForFitting`). Every spawn writes a record under `~/.garrison/ui-fittings/spawn/<id>.json` tracking `secretsDelivered`, so a vault-consuming Fitting started keyless is healed (restarted with secrets) on vault unlock or `up`.
- **Armory** — `/armory`, the Fitting registry browser.
- **Fitting** — the concrete component installed into a slot.
- **Operative** — RETIRED VOCABULARY (2026-08-24 mesh): user-facing surfaces
  say **session** (the running work) and **composition** (the configured
  thing); a **node** is one machine's Garrison; the four nodes form the
  **mesh**. The word survives only in internal identifiers and historical
  docs; `tests/vocabulary.test.ts` keeps it out of UI copy and manifest
  prose. Zeca remains the assistant persona defined inside a composition.
- **Channel** — the way external surfaces (Slack, Web Channel) reach the Operative through the gateway. Garrison does not ship a built-in chat surface.
- **`x-garrison`** — Garrison's metadata block inside the APM `apm.yml` manifest. APM preserves `x-*` keys. Schema in [`docs/METADATA.md`](./docs/METADATA.md).

Legacy aliases the parser still accepts (with deprecation warnings):
`primitive:` → `faculty:`; the aliased legacy faculty names in
`metadata.ts` `FACULTY_ALIASES` (e.g. `faculty: testing-framework` →
`faculty: sessions`, `faculty: monitor` → `faculty: observability`).
Parked pre-pivot faculty ids (`skills`, `classifier`, `soul`,
`knowledge-base`, …) are NOT aliased; their Fittings are de-listed from
the library and the parser rejects those ids.
The React directory `src/components/` keeps the
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
                       composition-clone.ts  clean copy of a composition
                       composition-transfer.ts  portable .garrison.json bundle
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
                       trenches/           outpost stream helpers
                       validation/         four-check pipeline
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
                     Portable form: a single `<id>.garrison.json` bundle
                     (Muster → Import / Export). See below.
fittings/seed/       Local APM seed Fittings. Each is a self-contained APM
                     package; new ones ship as their own git repos.
data/library.json    Curated Fittings Registry.
data/vault.json      Encrypted secrets, file mode 0600.
scripts/             validate-fitting.ts, integration-check.mjs,
                     refresh-default-prompts.ts, spike/.
tests/               Vitest suite — runner, capabilities, metadata,
                     fitting-view-resolver, validation, seeds, etc.
```

The visible shell surfaces are **Garrison · Composition · Vault ·
Quarters**, plus the collapsible sidebar **Quarters** and **Fittings** groups
(Fittings auto-populated per composition) and per-Fitting routes under
`/fitting/<id>/...`. As of the 2026-06-18 shell refit the **Run panel
merged into the Garrison dashboard** (the home route; `/run` redirects to
`/`) and the **Armory folded into Composition** (Fitting discovery is the
cross-Faculty search box on `/compose`; `/armory` redirects there). There is
no built-in Chat surface. Operative interaction goes through Channel
Fittings; observability is the runtime log on the dashboard plus per-Fitting
logs under `/fitting/<id>`.

### Faculties — 8 core roles (Quarters pivot + 2026-06-18 sessions split)

Faculties are now **roles only** (`facultyIds` in `src/lib/types.ts`):
`orchestrator`, `channels`, `gateway`, `runtimes`, `memory`, `observability`,
`sessions`, `surfaces`. The 2026-06-18 split carved the overloaded `sessions`
role into three: `sessions` keeps the Dev Env surface + artifact store,
`runtimes` holds the alternative execution engines (Agent SDK / Codex / Gemini /
OpenCode / Cursor),
and `surfaces` holds the auxiliary own-port viewers (screen-share / browser /
outpost). Everything else — Skills, Hooks, MCPs, Plugins, Scripts, Settings,
Context, Plans — is now a **Quarters platform primitive** surfaced over the real
`~/.claude`, not a Faculty.

**Own-port runtime residue** — survives at runtime under
`sessions`/`channels`/`observability` via the per-Fitting `own_port` metadata
flag: `dev-env` (27086), `screen-share` (27079), `outposts` (27082),
`monitor` (27077), `web-channel` (27083), `browser` (27084), `voice` (27085).
The Dev Env Fitting is one tabbed surface: every Claude Code session is a tab
holding a Claude PTY + shell PTY (left) and the live browser pane (right), with
PR / commit-and-push actions on the current branch in the menu. Sessions run in
the project repo root on the current branch - Garrison spins up no per-task
branches.

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

`orchestrator-projection.ts` — layered authored/generated Orchestrator assembly
+ `projectOrchestrator` (APM
instructions primitive → `~/.claude/rules/garrison-orchestrator.md`;
**implemented but not called by `up()` — RC3 dormant**) +
`orchestratorAppendSystemPrompt` (per-launch fallback via
`--append-system-prompt`). At runtime `up()` assembles the prompt and hands it
to the gateway through `GARRISON_SYSTEM_PROMPT_PATH`, not the rules file.

### Capabilities

Fittings declare `provides` / `consumes` in `x-garrison`. The
resolver in `src/lib/capabilities.ts` enforces cardinality (`one`,
`optional-one`, `any`). The `any` literal is the mechanism the
Orchestrator uses to **discover installed Fittings without
hardcoding** — no Garrison code change is needed when a new Fitting
is added.

Current kinds — **16**, per `capabilityKinds` in `src/lib/types.ts`:
`orchestrator`, `identity`, `memory-store`, `automation-runner`,
`connector`, `runtime`, `mcp-gateway`, `channel`, `vault`, `dev-env`,
`screen-share`, `outpost`, `monitor`, `voice`, `duty`, `view` (`view` is
derived by the resolver from `ui.views[]` / `own_port`, never declared in
`provides`). There is no persona Fitting: the Orchestrator provides `identity`,
its editable Identity section owns Zeca, and `duty` carries per-work behaviour.
Dropped:
`data-source` (2026-06-26, superseded by `connector`) and `artifact-store`
(the file-browser Fitting is the artifact surface).

### Composition transfer — import / export (`src/lib/composition-transfer.ts`)

A composition leaves the machine as **one JSON document**, `<id>.garrison.json`,
and comes back the same way. Surfaced as the **Import / Export** tab on Muster
(`/muster?section=transfer`, deep-linked from the shell's `+ New` menu);
`GET /api/compositions/<id>/export` (`?download=1` for the attachment) and
`POST /api/compositions/import` (`{bundle, id?, name?, preview?}`) are the API.

The bundle carries the `apm.yml` manifest verbatim (selections + per-fitting
config, duties, targets, global config), each authored side-file inline, a
`requirements` block naming the Fittings and vault keys it depends on, and an
`excluded` list stating what deliberately did not travel.

- **What travels is an ALLOW-list** (`EXPORT_FILE_RULES`), unlike
  `composition-clone.ts`'s deny-list — a clone stays local, a bundle is shared, so
  an unrecognised file beside a manifest must never ride along. Today: root
  `*.md` and `routing.*.json`, `.garrison/routing.json`,
  `.garrison/orchestrator-authored.json`, `.garrison/prompts/*.md`. **A new
  authored file type needs a rule here or it silently will not travel.**
- **What never travels**: `.env`, vault values, `local.yml` (the machine-local
  overlay — home paths and machine ports), `apm.lock.yaml`, `apm_modules/`,
  `.claude/`, legacy `.garrison/souls/`, the assembled prompt, session ids, decisions,
  run evidence, `owner.json`. Secrets are **named, never carried**; the importing
  machine reports which of those keys are unset there.
- **The same predicate validates an untrusted bundle on import**, so a hostile
  `files[].path` can only name a path the exporter could have produced. Import
  previews first (missing Fittings, unset keys, the id it will land on), stages
  into a hidden sibling and renames only when complete, and **never overwrites**
  an existing composition.
- `dependencies.apm` travels verbatim: its `path:` entries are relative to the
  composition directory and an import lands as a sibling, so they still resolve.

### Runtime engines (adding one)

Engine names live in the runtime Fitting's `provides: [{kind: runtime, name}]`;
nothing else derives them. A new exec-style engine (a stateless
`run`/`exec` subprocess per turn, prompt on stdin) is one Fitting +
a short list of registrations:

- `fittings/seed/<engine>-runtime/` — `apm.yml`, `lib/<engine>-adapter.mjs`
  (the RuntimeAdapter), `scripts/bridge.mjs` (`--probe` + `delegate`).
  The adapter file/class names are load-bearing: `resolveSecondaryDir` imports
  `lib/<engine>-adapter.mjs`.
- `data/library.json` — the registry entry that makes it selectable.
- `gateway-routing.mjs` — `EXEC_ADAPTER_CLASS` (the ONE registry; the secondary
  lane and the primary warm seam both read it), `EXEC_ENGINE_DEFAULTS`,
  `KNOWN_PRIMARY_ENGINES`, and `effortControllable` / `accountPlatformForTarget`
  when the engine lacks an effort control or an account vehicle.
- `AGENTIC_RUNTIMES` in `src/lib/router-migrate.ts` **and**
  `src/components/muster/cell-validation.ts`; the runtime marks in
  `MusterView.tsx` / `PolicyPanel.tsx`.
- `PRIMARY_CONTEXT_FILES` in `src/lib/orchestrator-projection.ts` when the engine
  reads a native context file — that map is also the list `up()` projects for.

**Cursor (2026-07-29).** `cursor-runtime` drives `cursor-agent -p
--output-format json` (prompt on stdin, one JSON result object, `--resume`
continuity), as a secondary target or as the PRIMARY. Two traps worth
remembering: (1) Cursor encodes reasoning **effort in the model id**
(`gpt-5.3-codex-low` vs `-high`) — there is no effort flag, so escalation means
routing to another model; (2) every instance profile redirects
`XDG_CONFIG_HOME`, and that is exactly where Cursor keeps its login, so the
fitting's setup hook symlinks the real `~/.config/cursor` into the instance's XDG
home — without it a logged-in box reads as unauthenticated. Cursor has no
Garrison AccountPlatform, so the Fitting declares no `account` key and its
targets declare no `provider` (the routing validator only knows providers from
the policy's `providers` section). `compositions/csg/` is the all-Cursor
composition: `primaryRuntime: cursor-runtime` plus a cursor-only target set.

**Routing inference.** The gateway calls Orchestrator before opening the
Operative turn because the result selects its duty, level, and target. Explicit
pins, already-routed cards, schedules/internal jobs, and clear deterministic
phrasing bypass inference. Ambiguous human requests use the composition's
explicit `dispatch` duty target; the default is a bounded, tool-free, one-turn
Anthropic Agent SDK call to Claude Haiku 4.5. Failure falls back
deterministically and records degraded reason, latency, and fallback count. The
retired `routing_on_primary` flag is accepted only by the one-time composition
migration that converts it to an explicit dispatch target; it is not a gateway
setting. Schema-v4 traffic never calls the former Stage-A classifier.

### The runner (`src/lib/runner.ts`)

`up` order:

1. `apm install` (live log streamed to the Run tab via SSE).
2. `materializeEnv` from the vault into the composition directory.
3. For each Fitting with `x-garrison.setup`: run the setup command in the
   Fitting's installed dir. Non-zero exit aborts `up`.
4. For each Fitting: run `x-garrison.verify`. No verify hook = hard failure.
5. Assemble the layered Orchestrator document: editable Identity/routing
   doctrine plus generated capabilities, duties/levels, and readiness (provider
   `for_consumers` markdown falls back to `summary`). Write
   `assembled-system-prompt.md`. Legacy `soul.md` is never injected.
   (The `projectOrchestrator` rules-file projection exists but is **not**
   called here yet — RC3 dormant.)
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

### UI contract v2 (Phase 3) — every Fitting has a view

Fittings declare N views in `x-garrison.ui.views[]`. Each view has an `id`,
a `placement` (`faculty-tab` | `sidebar-surface`), an `entry` path, and a
`route` fragment. The view registry at
`src/components/fitting-views/registry.tsx` is **static** in v2.

**A view is mandatory (2026-07-29 refit)**: every Fitting declares at least
one `ui.views[]` entry or `own_port: true`; the validation pipeline rejects a
viewless manifest. The common shapes need no code — point `entry` at a shared
host view: `garrison:skill` (SKILL.md frontmatter+body editor),
`garrison:prompt`, `garrison:runtime` (config + Test probe),
`garrison:connector`, `garrison:manage` (config + capabilities + files).
Authoring guide: `docs/UI-FITTINGS.md`.

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

## Capability contract - hard rules for Fittings that call a remote provider

A Fitting may wrap a **remote capability provider** - any service implementing the contract in
[`docs/CAPABILITY_CONTRACT.md`](./docs/CAPABILITY_CONTRACT.md). Garrison ships no such service and
depends on none; these rules keep such a Fitting swappable, honest, and safe on a personal machine.

- **Rule 2 - public contract only.** Call through the generated client or CLI, against documented public
  endpoints. No private endpoints, no provider internals, no second hand-written HTTP path per capability.
- **Rule 3 - never ask a provider to special-case Garrison.** Missing behaviour changes the contract for every
  client. An origin/client header is diagnostics, never behaviour.
- **Rule 4 - every call carries a user-scoped key.** The user mints it; it lives in the Vault and reaches the
  Fitting only through `x-garrison.secret_scope` (fail-closed: no scope, no secrets). No shared or ambient
  credential, no anonymous capability endpoint.
- **Rule 5 - no tenancy machinery here.** Scoping and isolation are the provider's job, proven by the provider's
  tests. A Fitting stores no tenant ids, builds no per-tenant paths, implements no isolation logic. The trust
  boundary here is one machine, one user.
- **Rule 6 - local default, remote opt-in.** Every capability Fitting ships a local or null backend as the
  DEFAULT; the remote backend is configuration (base URL via `config_schema`, key via `secret_scope`). No
  provider key, URL, or dependency in the shipped defaults - a fresh clone with an empty vault must compose and
  run, and `verify` must pass unconfigured.
- **Rule 9 - no bridge code here.** A provider that needs to reach back into this machine does so through its own
  bridge. This repo ships no counterpart daemon, no inbound listener, no delegation endpoint.

The "talks only to `localhost`" positioning above describes Garrison's own shell. User-equipped Fittings have
always egressed with vault-held keys (`deepgram-voice`, the model runtimes). An opt-in, key-scoped capability
client is that same shape, not a new category.

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

## Instances, ports, and deploying (HARD RULES)

Garrison runs as **profiled instances out of this one checkout**, and as a
**mesh of full nodes** — one per machine (dev-madrid, Mac Pro, Mac mini,
MacBook Air), each enrolled against the state service on dev-madrid
(`services/state/`, tailnet-only authenticated API; see AGENTS.md for the
mesh state split and merge policy). Each machine's tailnet address is that
node's always-on surface and must never serve a sandbox process.

**One committed port map, one offset per profile.** The compositions carry a
single port map (the 7xxx family). Every instance is that map plus a fixed
offset, defined once in `src/lib/instance-profile.ts` and mirrored in
`scripts/garrison-instance.sh`:

| profile | offset | app | gateway | fittings | scheduler | home |
|---|---|---|---|---|---|---|
| **node** | **0** | **8777** | **5777** | **80xx** | **8099** | `~/.garrison` + that machine's real `~/.claude` |
| dev | +10000 | 18777 | 15777 | 180xx | 18099 | `~/.garrison-dev` |
| codex | +20000 | 28777 | 25777 | 280xx | 28099 | `~/.garrison-codex` |

(`prod` survives one release as a spelled-out alias for `node`. The 2026-08-24
mesh re-axis moved the committed map to the 8xxx family — node-at-offset-0
serves exactly the ports the old prod profile served, so nothing live moved.)

- **HARD RULE — never hardcode a port.** Ports come from the composition,
  shifted by `profilePort()` / `applyPortOffsetToConfig()`. A literal `7777`,
  `4777`, `24777` or `27xxx` in new code is a bug: it pins one instance and
  silently sends the other instance's traffic there. `tests/instance-isolation.test.ts`
  pins the launcher and the TS module against each other.
- **HARD RULE — the node profile and the sandboxes never share a port, a
  `GARRISON_HOME`, or a Claude config dir.** On every machine, the `node`
  profile owns that machine's real `~/.claude`; a dev/codex sandbox pointing
  there would edit the user's live Claude Code config.
- **HARD RULE — one instance per composition working tree.** The launcher
  isolates ports, `GARRISON_HOME` and the Claude config dir, but
  `COMPOSITIONS_DIR` is checkout-relative, so all three profiles resolve the
  SAME `compositions/<id>/`. A second instance's `up` would run `apm install`
  and every setup hook inside the tree the first instance's operative is
  executing from, overwrite its materialised `.env` from a different vault, and
  its `down` would wipe that `.env` away. `up()` therefore claims the tree via
  `.garrison/owner.json` (`src/lib/composition-owner.ts`) and refuses when
  another **profile** holds it; `down()` releases. Keyed on profile, not pid, so
  restarts and redeploys re-enter freely. If you need two instances at once,
  point them at **different compositions**.
- **HARD RULE — the user's browser is almost never on the Garrison machine.**
  Garrison runs everything on the box it is installed on, but it is *used* from
  other machines and mobile over the HTTPS tailnet address
  (`https://dev-madrid.tail31efa.ts.net:<serve-port>`). So no server — shell or
  fitting — may hand the client an absolute machine-local URL
  (`http://localhost:…`, `http://127.0.0.1:…`, or a `GARRISON_*_URL` /
  `ui-fittings/*.json` value) for use as an iframe/img/link/fetch/WS target:
  remotely it is unreachable AND mixed content (a silently blank pane).
  Client-delivered URLs must be **relative** (same-origin), or a
  **loopback + tailnet pair** the client resolves by page host. Shell pattern:
  `src/lib/tailnet-serve.ts` + `resolveViewUrl`
  (`src/components/fitting-views/browser-view-url.ts`); fitting-local pattern:
  `fittings/seed/drill/lib/tailnet-serve.mjs` + `resolveEmbedUrl`
  (`drill/ui/main.tsx`). Server-to-server loopback calls on the box are fine.
  Every new client-facing surface must be verified from a non-localhost origin
  before it ships.
- **HARD RULE — a new own-port view must be published to the tailnet.** Its port
  needs a `tailscale serve` mapping or the embedded view is a blank pane over
  HTTPS (a plain-HTTP frame is blocked as mixed content).
  `npm run node:redeploy` runs `scripts/tailnet-serve-views.mjs` for this;
  never hand an HTTPS page an `http://` URL.
- **HARD RULE — only the node profile is published to the tailnet.**
  `scripts/tailnet-serve-views.mjs` refuses a sandbox shell and a machine
  with no `~/.garrison/node.json` identity. With every node at offset 0 the
  serve-port formula (8400 + port%1000) is a mesh INVARIANT: same fitting,
  same serve port on every machine, so peer view URLs are computable without
  asking the peer (`tests/mesh-serve-ports.test.ts`).
- **Never start an instance by hand.** Always
  `bash scripts/garrison-instance.sh <prod|dev|codex> <start|build|env>` (or
  `npm run dev` / `npm run prod:start`). A bare `next dev` inherits whatever
  home and port the shell happens to carry.
- Prod serves a **built** artifact from `.next-prod`; dev's `next dev` uses
  `.next`. Keep them apart — a shared dist dir breaks the dev server's dynamic
  routes.

### The two-tree model — where you are allowed to edit

There are two checkouts of this repo on the box, on the SAME branch. Dev is
simply ahead of prod.

| | tree | port | GARRISON_HOME | Claude home | served by |
|---|---|---|---|---|---|
| **DEV** | `~/dev/agent-garrison-dev` | 7777 | `~/.garrison-dev` | `~/.claude-garrison-dev` | `next dev` (edit = live on save) |
| **PROD** | `~/dev/agent-garrison` | 8777 | `~/.garrison` | the real `~/.claude` | `next start` on `.next-prod` |

Fittings follow the same offset: local-voice dev 7081 / prod 8081, jarvis-os
7097 / 8097, dev-env 7086 / 8086, kanban-loop 7089 / 8089.

- **HARD RULE — all editing happens in the DEV tree.** `~/dev/agent-garrison`
  is READ-ONLY. It never receives a hand edit; it only ever fast-forwards onto
  a dev commit via `garrison-promote.sh`. That is what keeps the always-on
  surface alive while work is in flight — an unfinished edit cannot reach it,
  because prod's files simply do not change until a promote.
- If `garrison-promote.sh` reports local edits in prod, someone broke that
  rule. Move the work to the dev tree; do not commit it in prod.
- Dev is **on-demand**, not always-on: this box has 8 GB of RAM and prod
  already holds a Next server, the outpost, the scheduler, four own-port
  Fittings and a live operative. Start dev to test, stop it when done.
- `scripts/garrison-dev.sh start` brings up the dev SERVER only. The dev
  operative is a separate, explicit `garrison-dev.sh up` — booting a second
  Jarvis automatically would put two voice agents on one microphone.

### "Faz commit" means promote

When the user says they are happy with a change and asks for a commit, that is
one command — it commits, lands the code on prod, and restarts prod onto it:

```bash
npm run promote -- "what changed"      # scripts/garrison-promote.sh
```

which does, in order: commit in the dev tree -> fast-forward the prod tree ->
`npm install` in prod **only if the lockfile moved** -> `prod:redeploy`. A
commit that is not promoted has changed nothing the user can see.

Promoting also **pushes to GitHub by default** (best-effort — offline never
blocks the deploy; commits are authored as gabrielsvarela1). Skip it with
`npm run promote -- --no-push "msg"`.

### Deploying — reload for app changes, redeploy when a long-lived process holds the code

**Reach for `npm run node:reload` first.** It builds and restarts the Next app
server and leaves the operative and the own-port fittings running. That is enough
for anything confined to the app: `src/app/**`, `src/components/**`, and the
`src/lib/**` modules the app imports. A full redeploy for those costs minutes,
drops the running session, and re-runs 44 verify hooks to prove nothing that
changed.

**Use `npm run node:redeploy` when the change is in code a LONG-LIVED process is
holding in memory**: `fittings/seed/**` (fitting servers, runtime adapters, the
gateway), `packages/**`, `compositions/*/apm.yml` (stationing, accounts, targets -
read at `up()`), or any change whose effect needs a fresh spawn to appear.

When in doubt, reload; if the behaviour you changed lives in the operative,
redeploy after. A wrong reload costs one more command; a reflexive redeploy costs
minutes every single time.

### Deploying — HARD RULE: commit is not landed until prod is redeployed

Committed code changes nothing a user can see: prod serves a build, and the
operative plus own-port fittings are long-lived processes still holding the OLD
code in memory. Restarting the app server alone leaves a half-updated system.

**After committing/pushing a significant change, run:**

```bash
npm run node:redeploy        # scripts/garrison-redeploy.sh (prod:redeploy = alias)
```

which does, in order: `prod build` → `down` (operative + fittings on the old
code) → restart the supervisor → wait for `:8777` → `up` (operative + eager
fittings on the new code). A failed build stops the deploy with the last good
build still serving.

**Supervisors are per-host.** On this Mac prod is the LaunchAgent
**`com.garrison.jarvis`** (`RunAtLoad` + `KeepAlive`, wrapper at
`~/.local/bin/garrison-launch.sh`), restarted with
`launchctl kickstart -k gui/$UID/com.garrison.jarvis`. On Linux hosts it is the
systemd user unit **`garrison-prod.service`** (`Restart=always`,
`WantedBy=default.target`, user lingering on). `garrison-redeploy.sh` detects
which is present; it used to call `systemctl` unconditionally, so
`prod:redeploy` had never worked on this Mac.

Dev has its own LaunchAgent, **`com.garrison.dev`**, deliberately
`RunAtLoad=false` / `KeepAlive=false` — dev must never resurrect itself on boot
or after a crash. Only prod is always-on. Install/repair it with
`npm run dev:install`.

During a redeploy, `garrison-redeploy.sh` writes
`~/.garrison/.redeploy-in-progress`; prod's launcher waiter sees the marker and
stands down, so its `up()` and the redeploy's `up()` cannot race over the same
operative.

Do **not** add a second scheduler unit: prod's launcher already runs the
scheduler on 8099 against `~/.garrison`, and a standalone unit on the same jobs
file double-fires every scheduled job.

## Permissions

- **Only a streamed Web Agent SDK turn with a durable thread uses
  `permissionMode: "default"`.** Its blocking `canUseTool` requests become
  durable, generation-bound permission cards with explicit Deny, Allow once,
  and SDK-suggested Always allow choices. Approval is unavailable unless the
  complete tool input is visible; Always allow additionally requires every
  exact SDK permission update to be visible.
- **Every non-Web/headless lane remains `bypassPermissions`** — JSON `/chat`,
  Kanban, scheduler, Slack, dispatch/classification, and PTY execution must not
  wait on a browser-only control surface. Permission resolver closures are
  process-local: after a gateway restart the durable pending card remains an
  honest record, but answering it returns `409` until continuity work lands.

## Working conventions

- **HARD RULE — never create a git branch unless explicitly told to.**
  No `git checkout -b`, `git branch <new>`, `git switch -c`, or
  worktree/agent isolation that spawns a branch. Switching to an
  **existing** branch is fine. Work stays on the current/specified
  branch; to recover "lost" work, check existing branches / reflog /
  stash and `git checkout` the existing branch — don't invent one.
- **Branch discipline (mesh, 2026-08-24): every node works on its permanent
  `node/<id>` branch — dev-madrid included — and `main` is updated by the
  nightly convergence card or an on-demand converge.** Node branches are
  created ONCE by `scripts/install-node.sh`; the no-new-branches hard rule
  stands for everything else. TRANSITION NOTE: until the mini and Air
  installs land and the nightly card has run green, direct pushes to `main`
  from dev-madrid remain sanctioned; GitHub prints "Bypassed rule
  violations" on them — that output is EXPECTED (the owner holds the bypass)
  and means the push landed. Never flag it or offer a PR.
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
- Instance ports, lifecycles, when changes reach prod / fittings restart →
  [`docs/INSTANCES.md`](./docs/INSTANCES.md).
- Adding or auditing a Fitting →
  [`docs/METADATA.md`](./docs/METADATA.md),
  [`docs/FITTINGS.md`](./docs/FITTINGS.md),
  [`docs/CAPABILITIES.md`](./docs/CAPABILITIES.md).
- Implementing a `src/lib` module or UI surface → [`docs/architecture.md`](./docs/architecture.md).
- Faculty intent and failure modes → [`docs/FACULTIES.md`](./docs/FACULTIES.md).
- Verifying v1 readiness → [`docs/V1_DOD.md`](./docs/V1_DOD.md)
  and per-phase records under [`docs/phases/`](./docs/phases/).
- Policy and contribution rules →
  [`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md),
  [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md).
- Why a choice was made → [`docs/DECISIONS.md`](./docs/DECISIONS.md).
- What's queued and what just shipped →
  [`docs/GARRISON_ROADMAP.md`](./docs/GARRISON_ROADMAP.md).


## Memory

Durable knowledge lives in **two tiers** — use these, not ad-hoc note stores:

- **Hot index — the native memory tool** (`~/.claude/projects/<slug>/memory/MEMORY.md`
  plus per-topic notes): small, hand-curated, **auto-loaded into every session**.
  This is the default place to record a durable fact, preference, or piece of
  project context. Keep it short; it is always in context.
- **Cold archive — Basic Memory** (Obsidian vault at `~/ObsidianVault`, searchable +
  shared across Claude/Codex/Gemini): the long-term, query-on-demand store. A
  SessionEnd/PreCompact hook auto-captures session checkpoints into it; use its
  `search` / `read_note` tools to recall older context.

Kanban cards explicitly labelled `personal` add a second, deterministic ingestion
path: each Done generation is retained under `Personal/Kanban Completions` as a
bounded, provenance-marked **source record**. A real project still controls the run
cwd; a project-less personal card runs in `$GARRISON_HOME/personal`. Descriptions,
checklists, and agent closeouts are not automatically promoted to durable facts, and
the capture excludes transcripts, diffs, environment values, attachment bodies, and
session identifiers. The personal workspace's cwd-scoped native runtime memory is a
separate hot index; a `.claude` folder is not the shared memory store.

Do not scatter knowledge across other stores. `bd remember`, Serena memories, and
the former `knowledge`-fitting recall MCP are **not** part of this setup.

For task tracking, do not use TodoWrite/markdown TODO files for anything durable —
prefer the in-session task tools for transient work and the memory tiers above for
anything that must survive the session.
