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
> is assembled (soul + orchestrator + `{{capabilities}}`/`{{routing}}`) and
> handed to the gateway at launch. The `projectOrchestrator` rules-file
> projection (`~/.claude/rules/garrison-orchestrator.md`) is implemented but
> not yet wired into `up()` — RC3 dormant. The
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
npm start                                              # PROD instance (8xxx, ~/.garrison)  [= prod:start]
npm run dev                                            # DEV instance  (7xxx, ~/.garrison-dev)
npm run dev:start                                      # start DEV detached, under its own LaunchAgent
npm run dev:stop                                       # stop DEV
npm run dev:status                                     # is DEV up? which commit is it on?
npm run promote -- "message"                           # commit in dev -> fast-forward prod -> redeploy
npm run prod:redeploy                                  # build + restart prod, operative, fittings
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
- **Faculty** — a **role** slot in a composition. **17 in total** (`facultyIds` in `src/lib/types.ts`): **9 core roles** (`orchestrator`, `channels`, `gateway`, `runtimes`, `memory`, `observability`, `sessions`, `surfaces`, `modes`) plus **7 optional capability faculties** added 2026-06-24 (`knowledge`, `research`, `building`, `code-intelligence`, `design`, `browser-qa`, `coordination`) — the purpose-named homes the promoted Claude Code primitives fill (the primitive type — skill/hook/mcp/plugin — survives only as an internal `component_shape`, never as a user-facing label) — plus the **`connectors`** faculty added 2026-06-26 (Agent-tier, multi): authenticated, Vault-sealed connections to external services (Trello, Google, Slack, Deepgram, …), each a Fitting providing the `connector` kind with an action catalog + sealed auth + optional triggers (it absorbs the dropped read-only `data-source` case). The former flat 24-Faculty list collapsed into the core roles and Skills/Hooks/MCPs/Plugins/Scripts/Settings/Context/Plans became Quarters platform primitives. The 2026-06-18 split moved the runtime engines into `runtimes` and the auxiliary own-port viewers (screen-share, browser, outpost) into `surfaces`, slimming the overloaded `sessions` role to the Dev Env surface + artifact store. A subset of runtime Fittings is **own-port** — they serve their own React UI on their own HTTP port under the `sessions`/`surfaces`/`channels`/`observability` roles via the `own_port` flag. Garrison links to those views from the sidebar's Views section. Every faculty also carries a display **tier** (`agent`/`dev`) driving the Compose grid's two headers — orthogonal to essential/optional, anchored on the modes config.
- **Quarters** — the `~/.claude` config surface (Skills, Hooks, MCPs, Plugins, Scripts, Settings, Context, Plans, Commands, Rules) surfaced at `/quarters`. APM is the single writer; Garrison autosaves via `reconcile.ts`. State = owned / loose / parked.
- **Views** — sidebar group, auto-populated for the current composition. Surfaces embedded views (Fittings declaring `placement: sidebar-surface`) and own-port live links (status read from `~/.garrison/ui-fittings/*.json` via `/api/fittings/views`).
- **Lifecycle for own-port Fittings** — declared via `x-garrison.lifecycle` (`operative-bound` is the default; `detached` opts out). During `up` the runner auto-starts ONLY the eager-toggled own-port Fittings; non-eager ones start on demand from the Views UI (`/api/fittings/[id]/start`, which injects the running composition's env — gateway URL, composition id, selection config, vault — via `operativeEnvForFitting`). `down` still stops every running operative-bound Fitting by killing the PID found in `~/.garrison/ui-fittings/<id>.json`. The status file is the single source of truth; `lsof` is never consulted. Eager-toggled Fittings are server-lifecycle — they survive both the startup orphan sweep and `down` — and every spawn writes a record under `~/.garrison/ui-fittings/spawn/<id>.json` tracking `secretsDelivered`, so a vault-consuming Fitting started keyless is healed (restarted with secrets) on vault unlock, `up`, or eager boot.
- **Armory** — `/armory`, the Fitting registry browser.
- **Fitting** — the concrete component installed into a slot.
- **Operative** — the composed, running agent (the user's real Claude Code session post-pivot).
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
Quarters**, plus the collapsible sidebar **Quarters** and **Views** groups
(Views auto-populated per composition) and per-Fitting routes under
`/fitting/<id>/...`. As of the 2026-06-18 shell refit the **Run panel
merged into the Garrison dashboard** (the home route; `/run` redirects to
`/`) and the **Armory folded into Composition** (Fitting discovery is the
cross-Faculty search box on `/compose`; `/armory` redirects there). There is
no built-in Chat surface. Operative interaction goes through Channel
Fittings; observability is the runtime log on the dashboard plus per-Fitting
logs under `/fitting/<id>`.

### Faculties — 9 roles (Quarters pivot + 2026-06-18 sessions split + 2026-06-22 modes)

Faculties are now **roles only** (`facultyIds` in `src/lib/types.ts`):
`orchestrator`, `channels`, `gateway`, `runtimes`, `memory`, `observability`,
`sessions`, `surfaces`, `modes`. The 2026-06-18 split carved the overloaded `sessions`
role into three: `sessions` keeps the Dev Env surface + artifact store,
`runtimes` holds the alternative execution engines (Agent SDK / Codex / Gemini),
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

`orchestrator-projection.ts` — `buildOrchestratorInstructions` (soul +
orchestrator + `{{capabilities}}` fold) + `projectOrchestrator` (APM
instructions primitive → `~/.claude/rules/garrison-orchestrator.md`;
**implemented but not called by `up()` — RC3 dormant**) +
`orchestratorAppendSystemPrompt` (per-launch fallback via
`--append-system-prompt`). At runtime `up()` assembles the prompt and hands it
to the gateway (`GARRISON_SYSTEM_PROMPT_PATH` / souls config), not the rules
file.

### Capabilities

Fittings declare `provides` / `consumes` in `x-garrison`. The
resolver in `src/lib/capabilities.ts` enforces cardinality (`one`,
`optional-one`, `any`). The `any` literal is the mechanism the
Orchestrator uses to **discover installed Fittings without
hardcoding** — no Garrison code change is needed when a new Fitting
is added.

Current kinds — **17**, per `capabilityKinds` in `src/lib/types.ts`:
`orchestrator`, `modes`, `identity`, `memory-store`, `automation-runner`,
`connector`, `runtime`, `mcp-gateway`, `channel`, `vault`, `dev-env`,
`screen-share`, `outpost`, `monitor`, `voice`, `duty`, `view` (`view` is
derived by the resolver from `ui.views[]` / `own_port`, never declared in
`provides`). `modes` is **superseded (2026-07-13, MARATHON-V3 D7) by
`identity`** — no seed Fitting provides `modes`; the persona Fitting is
`identity-gary`, and `duty` carries the per-duty behaviour. Dropped:
`data-source` (2026-06-26, superseded by `connector`) and `artifact-store`
(the file-browser Fitting is the artifact surface).

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

## Instances, ports, and deploying (HARD RULES)

Garrison runs as **profiled instances out of this one checkout**. The tailnet
address `https://dev-madrid.tail31efa.ts.net` is **always-on PROD** and must
never serve a dev process.

**One committed port map, one offset per profile.** The compositions carry a
single port map (the 7xxx family). Every instance is that map plus a fixed
offset, defined once in `src/lib/instance-profile.ts` and mirrored in
`scripts/garrison-instance.sh`:

| profile | offset | app | gateway | outpost | fittings | scheduler | home |
|---|---|---|---|---|---|---|---|
| dev | 0 | 7777 | 4777 | 3702 | 70xx | 7099 | `~/.garrison-dev` |
| **prod** | **+1000** | **8777** | **5777** | **4702** | **80xx** | **8099** | `~/.garrison` + real `~/.claude` |
| codex | +20000 | 27777 | 24777 | 23702 | 270xx | 27099 | `~/.garrison-codex` |

- **HARD RULE — never hardcode a port.** Ports come from the composition,
  shifted by `profilePort()` / `applyPortOffsetToConfig()`. A literal `7777`,
  `4777`, `24777` or `27xxx` in new code is a bug: it pins one instance and
  silently sends the other instance's traffic there. `tests/instance-isolation.test.ts`
  pins the launcher and the TS module against each other.
- **HARD RULE — prod and dev never share a port, a `GARRISON_HOME`, or a
  Claude config dir.** Only prod owns the real `~/.claude`; a dev instance
  pointing there would edit the user's live Claude Code config.
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
  `npm run prod:redeploy` runs `scripts/tailnet-serve-views.mjs` for this;
  never hand an HTTPS page an `http://` URL.
- **HARD RULE — only prod is published to the tailnet.**
  `scripts/tailnet-serve-views.mjs` refuses to run from a non-prod shell. The
  serve-port formula aliases prod's 80xx onto dev's 70xx, so publishing dev
  would hand tailnet users a dev server.
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

Fittings follow the same offset: local-voice dev 7090 / prod 8090, jarvis-os
7092 / 8092, dev-env 7086 / 8086, kanban-loop 7089 / 8089.

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

### Deploying — HARD RULE: commit is not landed until prod is redeployed

Committed code changes nothing a user can see: prod serves a build, and the
operative plus own-port fittings are long-lived processes still holding the OLD
code in memory. Restarting the app server alone leaves a half-updated system.

**After committing/pushing a significant change, run:**

```bash
npm run prod:redeploy        # scripts/garrison-redeploy.sh
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

- **Permission mode is `bypassPermissions`.** Anything stricter
  hangs because the UI has no permission-prompt surface yet.

## Working conventions

- **HARD RULE — never create a git branch unless explicitly told to.**
  No `git checkout -b`, `git branch <new>`, `git switch -c`, or
  worktree/agent isolation that spawns a branch. Switching to an
  **existing** branch is fine. Work stays on the current/specified
  branch; to recover "lost" work, check existing branches / reflog /
  stash and `git checkout` the existing branch — don't invent one.
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

Do not scatter knowledge across other stores. `bd remember`, Serena memories, and
the former `knowledge`-fitting recall MCP are **not** part of this setup.

For task tracking, do not use TodoWrite/markdown TODO files for anything durable —
prefer the in-session task tools for transient work and the memory tiers above for
anything that must survive the session.
