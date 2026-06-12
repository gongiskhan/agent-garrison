# Exploration Report — Router & Improver Fittings

Read-only exploration of `agent-garrison` (`/Users/ggomes/dev/garrison`), produced to feed an
external architecture decision for two new Fittings: a **routing orchestrator** (with a UI view)
and a **nightly self-improvement runner**. Every claim cites a file path; quotes are short.
Uncertain or half-migrated areas are flagged explicitly. Each section is marked
**[STABLE]**, **[IN FLUX]**, or **[BROKEN]**.

Branch: `main` @ `7836f85`. Working tree has uncommitted changes (notably a new
`fittings/seed/http-gateway/scripts/gateway-pty.mjs` and `packages/`), so several facts below
are **untracked working-tree state**, not committed history.

---

## 1. CLAUDE CODE EXECUTION PATH — **[IN FLUX]**

### How Garrison invokes Claude Code today

The live path is **node-pty driving the interactive Claude Code TUI**, not the in-process
Anthropic Agent SDK. There are two invocation surfaces, both in `src/lib/runner.ts` `up()`:

- **Gateway path (default).** `resolveGatewayFitting(compositionId)` (`runner.ts:128`, def `:681`)
  hard-codes the entry `scripts/gateway.mjs`; `spawnGateway` (`runner.ts:138`, def `:727`) runs
  `node <fittingDir>/scripts/gateway.mjs`.
- **No-gateway fallback.** `spawnClaude` (`runner.ts:147`, def `:813`) shells the `claude` binary
  directly with headless flags (verified at `runner.ts:813-836`):
  `--append-system-prompt-file <promptPath> --permission-mode bypassPermissions
  --input-format stream-json --output-format stream-json --print`.

`gateway.mjs` then dispatches by engine env (verified `fittings/seed/http-gateway/scripts/gateway.mjs:729-735`):
`GARRISON_GATEWAY_ENGINE` defaults to `"pty"` → `await import("./gateway-pty.mjs")` (interactive
claude TUI); `=sdk` → `await import("./gateway-legacy.mjs")` ("the legacy in-process Agent SDK …
as a rollback path", `gateway.mjs:727-732`).

### The node-pty substrate — `packages/claude-pty/`

A workspace package (`package.json:26-27` declares `@garrison/claude-pty` as a `file:` dep, plus
`node-pty ^1.1.0`). Entry barrel `src/index.mjs`; the core is `src/session.mjs`:
- `OperativePtySession` (long-lived) and `oneShotTurn` (spawn → one turn → dispose,
  `session.mjs:265-288`, verified).
- `pty.mjs` spawns the binary attached to a real PTY and mirrors output into an `@xterm/headless`
  Terminal; callers read structured state off the mirror.
- `gateway-pty.mjs` drives one persistent interactive `claude` TUI through `OperativePtySession`.

**Status: working and current** — `packages/claude-pty/` and `gateway-pty.mjs` are
**untracked/modified working-tree files** dated 2026-06-12; an auto-memory note records a
"pty-everywhere migration" moving "all model calls onto claude-pty". `tier-classifier` and
`coding-subagent` already consume it.

### What remains of the previous mechanism (Agent SDK)

- **Dead in `src/lib/`.** `package.json` has **no `@anthropic-ai/*` dependency** — only
  `@garrison/claude-chat`, `@garrison/claude-pty`, `node-pty` (`package.json:26-27`).
- The SDK survives **only** as the explicit rollback engine: `gateway-legacy.mjs`
  (13 305 bytes, dated **May 16** — untouched by the migration), reached only via
  `GARRISON_GATEWAY_ENGINE=sdk`.
- **Stale docs to flag:** `CLAUDE.md` runner §6 still says "Spawn the Operative via the Anthropic
  Agent SDK **in-process** … `Query.interrupt()` is the kill switch." That is no longer the default
  path. `fittings/seed/coding-subagent/scripts/coding-subagent.mjs:13` header comment claims the
  Agent SDK, but the code imports `OperativePtySession` — the comment is wrong, the code is PTY.

### System-prompt injection & restart semantics

- **Mechanism:** a file flag, `--append-system-prompt-file <path>` (`session.mjs:83-84`,
  `buildClaudeArgs`). The header notes "interactive TUI has no string [system-prompt override]"
  (`session.mjs:13-15`), so it must be a file.
- The runner writes `<compositionDir>/.garrison/assembled-system-prompt.md` and passes its path
  as env `GARRISON_SYSTEM_PROMPT_PATH` (`runner.ts:745`), forwarded into the spawn as
  `appendSystemPromptFile`.
- **Restart semantics:** the flag is read **only at process spawn**. Editing
  `assembled-system-prompt.md` while a session is live has **no effect until the operative
  respawns** (down/up, dev-mode chokidar restart, or a dead-session re-spawn). **Changing the
  orchestrator/routing prompt requires a session restart.** This is the single most important
  constraint for a "routing section in the orchestrator prompt."

### Is a cheap headless one-shot possible today?

**Yes — but not through the `claude-pty` helper.** Two distinct routes:

1. **True headless `claude --print`** (prompt in → reply out → no kept session) already exists and
   is used in two places:
   - `runner.ts:spawnClaude` (`:813-836`): `--print --input-format stream-json
     --output-format stream-json --append-system-prompt-file …`.
   - the souls path `scripts/lib/spawn-soul.mjs` (`COMMON_FLAGS` includes `--print`).
   This is the cheap path. **It is not currently wrapped as a reusable lib/API** — the argv lives
   inline in those two callers.
2. **`oneShotTurn`** (`packages/claude-pty/src/session.mjs:265-288`, verified): spawn →
   `runTurn` → dispose. But this boots the **full interactive TUI under a PTY** and waits on a
   readiness gate (≈25 s timeout), so it is "no-kept-session" but **not cheap**.
   `buildClaudeArgs` (`session.mjs:56-90`) **does not emit `--print`** — it builds interactive
   argv (`--continue`/`--resume`/`--session-id`, `--append-system-prompt-file`,
   `--dangerously-skip-permissions`, `--model`).

**Implication for the router/simulator:** a cheap prompt-in/reply-out call is achievable with
`claude --print` today, but you would have to either (a) call the binary directly with that argv,
or (b) add a `--print` path to `buildClaudeArgs`. The existing `oneShotTurn` is the slow option.

---

## 2. ORCHESTRATOR PROMPT — **[IN FLUX]**

### Where it lives (layered, with drift risk)

- **Fitting source of truth:**
  `fittings/seed/garrison-orchestrator/.apm/prompts/garrison-orchestrator.prompt.md`.
- **Composition fallback:** `compositions/default/.garrison/prompts/orchestrator.md` (+ `soul.md`),
  used when no orchestrator-Fitting prompt is found (`runner.ts:546-549`).
- **Regenerated by** `scripts/refresh-default-prompts.ts`.
- **Multiple live copies** (drift hazard): `compositions/dogfood-orch/.garrison/prompts/orchestrator.md`,
  `fittings/seed/personal-operative/.apm/prompts/personal-operative.prompt.md`, plus generated
  `compositions/default/.garrison/assembled-system-prompt.md` and
  `compositions/*/.claude/commands/garrison-orchestrator.md`.

### How it's assembled (`runner.ts:542-575`)

1. Read orchestrator prompt (Fitting, else composition fallback).
2. Read identity/`soul.md` (comment notes "no separate soul Faculty" post-pivot).
3. Warn (not fail) if the prompt lacks `{{capabilities}}`.
4. `substituteCapabilitiesPlaceholder` replaces `{{capabilities}}` with `renderCapabilitiesBlock(entries)`
   via a **function replacement** (avoids `$`-pattern expansion, `runner.ts:577-586`); each
   provider's `for_consumers` markdown is injected under its bullet (8 KB cap per block).
5. Concatenate `[soul, "", orchestrator]` — identity first — and write `assembled-system-prompt.md`.

### `[orchestrator-active]` token — **LIVE, not vestigial** (verified)

It is asserted in four enforcement points:
- `scripts/integration-check.mjs:72` (assembled prompt must contain it) and `:150-157`
  (turn-1 `POST /chat` reply must include it, else hard fail).
- `tests/orchestrator-integration.test.ts:77,92` (same two assertions).
- Embedded in every prompt source with a "load-bearing for scripts/integration-check.mjs" comment
  (`garrison-orchestrator.prompt.md:97,106`; `compositions/default/.garrison/prompts/orchestrator.md:3,36`;
  also `src/lib/compositions.ts:17`).

It functions as a **reply-contract liveness probe** confirming the orchestrator prompt actually
reached the model. Any new routing section must preserve it.

### Append/injection code

- **Writes `assembled-system-prompt.md`:** `assembleSystemPrompt` in `runner.ts` (around `:571-572`).
- **Projects to `~/.claude/rules/garrison-orchestrator.md`:** `src/lib/orchestrator-projection.ts`.
  `projectOrchestrator()` (`:76-127`) emits an APM hybrid Fitting whose instructions deploy to
  `rules/garrison-orchestrator.md` (`ORCHESTRATOR_RULE_REL = "rules/garrison-orchestrator.md"`, `:40`),
  appends it as a global APM dep, and runs `apmInstall` so the rule ends up OWNED in `apm.lock`.
  `orchestratorAppendSystemPrompt()` (`:133-135`) returns the same text for the higher-authority
  `--append-system-prompt` lane that the RC4 hosted-session launcher would use.
- **Caveat [IN FLUX]:** the sub-agent reports **no caller invokes `projectOrchestrator`** in
  `src/app/` or the runner — it appears **lib-only / not-yet-wired** (the RC3/RC4 lane CLAUDE.md
  flags as pending). Treat the rules-projection path as implemented-but-unwired until a route is found.

---

## 3. QUARTERS — **[STABLE]**

### Where artifact types are registered

Two registries at different layers:
- **UI categories (10):** `QUARTERS_CATEGORIES` in `src/components/quarters/quartersTypes.ts:27`
  — "the single source of truth shared by the sidebar, the index, and the [type] route validator"
  (`:4-5`). Each entry: `{ slug, label, blurb, writer, kind, icon, surfaces? }` (`:17-25`).
- **Backend primitive surfaces (6):** `PrimitiveSurface` in `src/lib/primitive-state.ts:28`
  (`"skill"|"command"|"rule"|"plugin"|"hook"|"mcp"`), iterated by `SURFACES` (`:47`).

The 10 categories: `settings`, `context` (CLAUDE.md), `skills`, `hooks`, `mcps`, `plugins`,
`scripts`, `plans`, `logs`, `sessions`. `writer ∈ apm|garrison|split|readonly`;
`kind ∈ settings|document|primitives|readonly` (`quartersTypes.ts:14-15`).

### How each type's view is built

- `src/app/quarters/page.tsx` (index) and `src/app/quarters/[type]/page.tsx` (router) dispatch by
  slug/kind (`[type]/page.tsx:10-20`): `settings → SettingsPanel`, `context → ContextPanel`,
  `plans → PlansPanel`, `logs|sessions → ReadOnlyTailPanel`, any `kind==="primitives" →
  PrimitiveListPanel`.
- **`PrimitiveListPanel.tsx`** is one parameterized panel for every primitives category; it fetches
  `GET /api/quarters` and renders rows from `cat.surfaces.flatMap(s => model.bySurface[s])`
  (`:81-82`), with promote/park for `apm`/`split` writers.
- **`surfaceEditors.tsx`** exports `SURFACE_CRUD` (`:80`) keyed by surface — "the ONLY place that
  grows as each CRUD slice lands" (`:60-61`). Editors: `McpServerForm`, `FilePrimitiveForm`,
  `HookEditor`; plugins remove-only.
- Detail fetch: `GET /api/quarters/primitive?id=<surface>:<rest>` → `getPrimitiveDetail`
  (`src/lib/quarters-detail.ts:29`). Drawer shell: `QuartersDrawer.tsx` + `ConfirmDialog.tsx`.

### Exact steps to add a new (primitive-surface) artifact type

1. Add the literal to `PrimitiveSurface` and `SURFACES` (`primitive-state.ts:28,47`); emit
   `PrimitiveRecord`s in `computeStateModel` (`:62-128`). If disk-file-backed, extend
   `FileSurface`/scan in `src/lib/claude-scan.ts:14`.
2. New writer-of-record lib (pattern: `mcp-writer.ts` / `hooks-crud.ts` / `primitive-files.ts`)
   returning `{ ok, code?, error? }`.
3. Add a `case` to `getPrimitiveDetail` and a `PrimitiveDetail` union variant (`quarters-detail.ts:11,31`).
4. Add action variants + `switch` cases to `runQuartersAction` (`src/lib/quarters.ts:42-55,97-128`).
   **No new API route needed** — `POST /api/quarters` already dispatches everything (`route.ts:16-23`).
5. Add a `<Surface>Form` editor under `src/components/quarters/`, register it in `SURFACE_CRUD`
   (`surfaceEditors.tsx:80`).
6. Add the category to `QUARTERS_CATEGORIES` (`quartersTypes.ts:27`) — auto-wires sidebar, index, route.
7. (Optional) If APM-ownable, add to `EMITTABLE`/`emitFitting` (`reconcile.ts:124-153`) +
   `state-transitions.ts`.
8. Tests: writer unit test + `tests/quarters-crud.test.ts` dispatch test + `tests/e2e/quarters-crud.spec.ts`;
   write `docs/autothing/slices/<slice>/gate-status.json` (governance).

A **non-primitive** category (e.g. another `document` type) instead needs a dedicated panel
(like `PlansPanel.tsx`), a lib (`src/lib/plans.ts`), a dedicated route (`src/app/api/plans/route.ts`),
and a branch in `[type]/page.tsx`.

### Recently added type to copy

**MCPs (slice C1-mcp, commit `df6f095`)** — the cleanest full template; it "established the
reusable CRUD shell … and the surfaceEditors registry + CrudResult contract that C2–C5 inherit"
(`docs/autothing/slices/C1-mcp/gate-status.json`). Files it added: `src/lib/mcp-writer.ts`,
`src/lib/quarters-detail.ts`, `src/app/api/quarters/primitive/route.ts`,
`src/components/quarters/McpServerForm.tsx`, `surfaceEditors.tsx`, `QuartersDrawer.tsx`,
`ConfirmDialog.tsx`, category entry, `tests/mcp-writer.test.ts`, `tests/quarters-crud.test.ts`,
`tests/e2e/quarters-crud.spec.ts`. For a file-backed surface copy C2/C3 (`primitive-files.ts` +
`FilePrimitiveForm.tsx`); for a JSON-config surface copy C1.

---

## 4. FITTINGS + MANIFEST — **[STABLE]** (with one **[IN FLUX]** caveat)

### `x-garrison` block schema (current)

Authoritative validator `garrisonMetadataSchema` (`src/lib/metadata.ts:61-117`), mirrored by
`GarrisonMetadata` (`src/lib/types.ts:185-225`):

| Field | Type | Req? |
|---|---|---|
| `faculty` | enum of `facultyIds` (6 roles) | **required** |
| `cardinality_hint` | `"single"\|"multi"` | **required** |
| `component_shape` | enum of `fittingShapes` (10) | **required** |
| `platforms` | `string[]` (min 1) | **required** |
| `summary` | string | optional |
| `for_consumers` | string ≤ 8 KB (`FOR_CONSUMERS_MAX_BYTES`, `metadata.ts:50`) | optional |
| `config_schema` | `ConfigSchemaField[]` (default `[]`) | optional |
| `provides` | `{kind,name}[]` (default `[]`) | optional |
| `consumes` | `{kind,name?,cardinality?}[]` (default `[]`) | optional |
| `setup` | `{command, idempotent, timeout_ms?}` | optional |
| `verify` | `{command, expect, timeout_ms=10000}` | **required** |
| `ui` | `{views: UiView[]}` (min 1) | optional |
| `tasks` | `{source, truth_file}` | optional |
| `spawn` | `SpawnConfig` | optional |
| `own_port` | boolean | optional |
| `default_port` | positive int (informational; status file is authoritative) | optional |
| `lifecycle` | `"operative-bound"\|"detached"` (default operative-bound) | optional |

Nested: `config_schema[].type ∈ string|integer|number|boolean|select|path|secret-ref`
(`types.ts:103-110`); `consumes[].cardinality ∈ one|optional-one|any`; `ui.views[]` =
`{id, placement, entry, route, chrome?}` (`types.ts:121-130`); `spawn` =
`{preset(claude_code|none), allowed_tools?, disallowed_tools?, exclude_dynamic_sections, base_path?, mcp?}`.

> **No top-level `secrets` block.** Secrets are `config_schema` entries of `type:"secret-ref"`
> + `consumes:[{kind:vault}]` (`types.ts:105`).

`fittingShapes` (10, verified `types.ts:23-34`): `script, agent-instructions, manual-instructions,
plugin, skill, cli, hook, system-prompt, cli-skill, mcp`.

### Capability-kind enum (verified `src/lib/types.ts:48-65`) — **12 kinds**

`orchestrator, memory-store, data-source, channel, vault, artifact-store, dev-env, screen-share,
outpost, monitor, voice, view`.

- **Dropped 2026-06-07 pivot:** `soul, agent-skill, automation-runner, mcp-gateway`.
- **`data-source` dropped then re-added 2026-06-10** for trello-data-source (`types.ts:51`).
- **`terminal-session, worktree, session-view` collapsed into `dev-env`** (2026-06-11).
- **`view` is never declared in `provides`** — derived by the resolver from `ui.views[]`/`own_port`.
- Singletons (`types.ts:82-89`): `orchestrator, vault, dev-env, screen-share, monitor, voice`.

### Host enum

**There is no manifest "host enum."** Two unrelated things:
- `PlatformId = "all"|"claude-code"|"codex"|string` (`types.ts:91`) — the value type of `platforms`.
  Open `| string`, but **selection-time validation requires `all` or `claude-code`**
  (`metadata.ts:229`) — so codex/other platform fittings are effectively rejected at selection today
  (relevant to §15(c)).
- `src/lib/hosts.ts` is the SSH/"Trenches" host store (`~/.garrison/hosts.json`,
  `TrenchesHost = {name,address,user}`, `:9-17`) — unrelated to manifests.

### How a fitting declares/serves a UI view

- **Embedded:** `x-garrison.ui.views[]` with `placement: faculty-tab | sidebar-surface`; routes use a
  tiny react-router param syntax matched by `matchView` (`src/lib/fitting-views.ts:14-49`). v2
  registry is static (`src/components/fitting-views/registry.tsx`). v1 `ui:{extension}` is
  auto-rewritten to a single faculty-tab view with a warning (`metadata.ts:171-191`).
- **Own-port (rich React UI on its own port):** set `own_port: true` (+ `default_port`). The fitting
  runs its own HTTP server and **self-registers** by writing `~/.garrison/ui-fittings/<id>.json`
  with `{fittingId, port, url, pid, startedAt}`. The resolver derives one synthetic `view`
  provision (id `"main"`) per own-port fitting (`src/lib/view-instances.ts:5-8`). Lifecycle owner:
  `src/lib/own-port-lifecycle.ts` (+ spawn record `~/.garrison/ui-fittings/spawn/<id>.json`).

### Seed fitting disk layout

```
apm.yml                  # manifest with x-garrison block (source of truth)
scripts/                 # server.mjs / start.mjs / probe.mjs / setup.sh / *.py / *.mjs
ui/                      # main.tsx, index.html, styles.css, build.mjs (React source)
dist/                    # built bundle (own-port fittings)
.apm/                    # APM payload, e.g. .apm/skills/<name>/SKILL.md, .apm/prompts/*
package.json             # when the fitting has node deps
```
Runtime install location: `apm_modules/_local/<id>/`.

### Template recommendations

- **(a) Rich own-port React view → `monitor-default`.** Cleanest own-port template: single-purpose,
  read-only, no vault coupling, no PTY. Layout: `apm.yml` (`own_port:true`, `setup: node ui/build.mjs`,
  `verify: scripts/probe.mjs --probe`), `scripts/server.mjs` (self-registers at `:482-487`,
  `/health` at `:342`), `ui/{main.tsx,index.html,styles.css,build.mjs}`, `dist/`. **Avoid `dev-env`
  as a template** — it folds three former fittings (tmux/PTY/worktree/chat-pane, ~27 files).
- **(b) Automation-runner → `morning-briefing` (consumer) / `scheduler` (runner).**
  **[IN FLUX caveat]** both still declare **parked** faculty/kind names (`automation-runner`,
  `faculty: scheduler`/`automations`) that the current parser rejects — they must be updated to the
  6 roles before they parse. `morning-briefing` is the cleanest consumer (tiny; one
  `scheduler.mjs add` call in `setup.sh`); `scheduler` is the cleanest runner (stdlib-only).

---

## 5. SKILLS — **[STABLE]**

### How skills are installed/listed

Skills live in **two places**, both surfaced through Quarters over the real `~/.claude`:
1. **Standalone** `~/.claude/skills/<name>/SKILL.md` — scanned by `scanClaudeFiles`
   (`src/lib/claude-scan.ts:45-56`): lists `<home>/skills/`, accepts dirs/symlinked dirs containing
   `SKILL.md`, emits `{surface:"skill", name, relPath:"skills/<name>", …}`.
2. **Shipped inside fittings** at `.apm/skills/<name>/SKILL.md` (e.g.
   `fittings/seed/scheduler/.apm/skills/scheduler/SKILL.md`). APM deploys these as **flat files**
   into `~/.claude/skills/` (`claude-scan.ts:11-12`), after which they appear in the same scan.
   There is **no separate "fitting-shipped skill" listing** — ownership is then classified by
   whether the deployed file is in the global APM lock (`computeStateModel`, `primitive-state.ts:62-129`):
   `owned` if in the lock, else `loose`; parked skills are not surfaced.

### Data source for a "all installed skills" dropdown

**`GET /api/quarters`** (`src/app/api/quarters/route.ts`) → `getQuartersState()` → `computeStateModel()`
→ `StateModel.bySurface.skill` (an array of skill `PrimitiveRecord`s, each
`{id:"skill:<name>", surface, name, state:"loose"|"owned", path, fittingId?, driftedFromLock?}`).
Underlying disk read: `scanClaudeFiles()` over `~/.claude/skills/*/SKILL.md`. So:
**dropdown → `GET /api/quarters` → `bySurface.skill`.**

---

## 6. SCHEDULER — **[STABLE]** runtime, **[IN FLUX]** manifest

Files: `fittings/seed/scheduler/{apm.yml, scripts/setup.sh, scripts/scheduler.mjs,
.apm/skills/scheduler/SKILL.md}`. No README in the dir.

### Current API — a stdlib-only Node CLI (`scripts/scheduler.mjs`)

Commands (`:7-17`, dispatch `:185-256`): `--probe` (health), `list`, `add <id> <cron> <command...>`
(upsert by id), `remove <id>`, **`run-now <id>` (run once immediately, `:232-241`)**, `tick` (run
all due this minute), `daemon` (tick every 60 s, `TICK_INTERVAL_MS=60_000`). Cron grammar: 5 fields,
`*`, `*/N`, values, comma-lists, ranges — **no `@aliases`, no seconds**. Exec is
`spawn("/bin/sh", ["-c", job.command])` (`:120`) — same trust model as a user crontab.

### How another fitting registers a cron job

**A CLI shell-out from the consumer's `setup.sh`** — not a file drop, HTTP call, or job-def dir.
Pattern (`morning-briefing/scripts/setup.sh`):
`SCHED="$(pwd)/apm_modules/_local/scheduler/scripts/scheduler.mjs"` then
`node "$SCHED" add morning-briefing "$CRON" "$WRAPPER"`. `google-calendar/scripts/setup.sh` does the
same, guarded by `scheduler.mjs list | grep -q '"calendar-sync"'`, and **skips gracefully** if the
scheduler isn't in the composition (matching `consumes: optional-one`).

### Run-now & logs

- **Run-now exists:** `scheduler.mjs run-now <id>`.
- **Jobs persist** to `data/scheduler-jobs.json` (composition-relative; override `GARRISON_SCHEDULER_JOBS`).
- **Logs** to `data/scheduler.log` (override `GARRISON_SCHEDULER_LOG`); per-run start/end headers +
  prefixed stdout/stderr (`appendLog` `:108-111`, `runJob` `:113-144`); non-zero exits logged, loop continues.

Cross-check: `morning-briefing` and `google-calendar` register via the CLI; `vault-sync` declares the
consume but registration is in its (unread) `setup.sh`; `loop-heartbeat` ships its *own* runner
(`heartbeat.mjs`), not a scheduler consumer. `tests/morning-briefing-cron-translation.test.ts` tests
only the `briefing.py --cron` time→cron translation, not registration.

> **[IN FLUX]** `scheduler/apm.yml` declares `faculty: scheduler` + `provides:[{kind:automation-runner}]`
> — both dropped in the pivot, so the scheduler fitting is **currently unselectable under the live
> parser** until its manifest is updated (relevant to §15(d)).

---

## 7. ARTIFACT STORE + EVIDENCE BUNDLES — **[STABLE]**

### Artifact Store paths & API

Artifacts live **per-composition**, not under `~/.claude`. `resolveArtifactRoot`
(`src/lib/artifact-store.ts:18`) reads the `artifact-store` fitting's `config.storage_root`
(default `"artifacts"`, `fittings/seed/artifact-store/apm.yml:30-32`) and resolves it against
`composition.directory`. Layout: `<root>/<namespace>/<filename>` + sidecar `<filename>.meta.json`
(`fittings/seed/artifact-store/scripts/artifacts.py:6-8`). Standard namespaces: `documents/`,
`automations/`.

`src/lib/artifact-store.ts` is **read/delete only**:
- `listArtifacts(compositionId?)` (`:32`) — walks namespaces, parses sidecars, sorts by `updated??created`.
- `findArtifact(id, …)` (`:71`) → `{meta, artifactPath, sidecarPath}`.
- `deleteArtifact(id, …)` (`:102`).
- `ArtifactMeta = {id, filename, namespace, producer?, mime, title?, created?, updated?}` (`:5-14`).

**Creation is out-of-band** via the fitting's Python CLI `artifacts.py write <namespace> <filename>
[--title --mime --producer]` (stdin body). **Update of an existing document over HTTP:**
`PUT /api/fittings/documents/[id]` writes the new body and bumps `meta.updated`
(`src/app/api/fittings/documents/[id]/route.ts:35-56`). Read/list: `GET /api/fittings/documents/list`,
`…/[id]`, plus generic `…/artifact-store/list`.

### Evidence bundles (dev pipeline)

Under `docs/autothing/`: `evidence-index.json` (top rollup), `slices/<slice>/gate-status.json`
(one per slice, 20+ present), `evidence/` (screenshots/videos).

**`gate-status.json` shape** (from `docs/autothing/slices/C1-mcp/gate-status.json`):
```
{ "slice","title","updatedAt","phase":"done","status":"passed",
  "kind":"mixed|ui|automation","retries":{"limit":5,"used":0},
  "gates":{ "tests":{"cmd","exit":0,"summary"},
            "typecheck|lint|build|e2e":{"cmd","exit","summary"},
            "designAudit":{"verdict":"clean","by":[…],"at","notes"},
            "video":{"status":"verified|verified-via-consolidated|failed-but-unblocking","video","videoLink","note"} },
  "blockers":[], "notes":"…" }
```
**`evidence-index.json` shape** (`:1-60`): `{project, updatedAt, galleryUrl, slices:[{slice,title,kind,
status,video,videoLink,videoStatus,screenshot,flagged,gateStatus:"…/gate-status.json"}]}` — an
upserted one-row-per-slice index pointing at each `gate-status.json`.

Governance DoD (`.claude/skills/garrison-governance/SKILL.md:11`):
`tests=0 · typecheck=0 · lint=0 · build=0 · e2e=0 · design audit clean · verified walkthrough video ·
gate-status.json written · evidence-index.json upserted · FLOW_PLAN updated`. It also wants a
transcript line `GATE <name>: exit <code> — <summary>` per gate.
*Uncertain:* the cited `gate-status.example.json` asset was not found — the real files are the de-facto schema.

---

## 8. HOSTED AUTHORING + RECONCILE — **[IN FLUX]**

### Hosted authoring operations

**Primitive CRUD — one dispatch via `POST /api/quarters`** (`route.ts:16` → `runQuartersAction`,
`src/lib/quarters.ts:94`; actions at `:42-55`):
- State transitions (`state-transitions.ts`): `promote` (loose→owned), `park` (owned→parked),
  `unpark {target:owned|loose}`.
- MCP (`mcp-writer.ts`): `mcp.add`, `mcp.update`, `mcp.remove` over `~/.claude/mcp.json`.
- File primitives (`primitive-files.ts`; skill/command/rule): `file.create`, `file.update`,
  `file.delete` (owned-delete is refused → must Park, `quarters.ts:81-92`).
- Hooks (`hooks-crud.ts`): `hook.create/update/delete` — hand-authored `settings.json` groups only;
  `_garrison`-tagged groups refused.
- Plugins (`plugin-writer.ts`): `plugin.remove` (uninstall only).

**Document/scalar surfaces — separate dedicated routes:**
- `PUT /api/settings` → `writeSettingsPatch` (merge-managed, changed-keys-only; body `{patch, remove?}`).
- `PUT /api/claude-md` → `writeClaudeMd(scope, body, {baselineSha})` — **never-clobber, 409 on sha
  conflict** (`claude-md.ts:56`). Scopes `user|project`.
- `PUT /api/plans` → `writePlan(name, content)` (autosave, traversal-guarded).
- `PUT /api/fittings/documents/[id]` → update existing document body only.

### Scoped reconcile — **[BROKEN / not wired]**

`reconcile({trigger, claudeHome?, storeDir?, surfaces?})` (`src/lib/reconcile.ts:155`).
`ReconcileTrigger = "bootstrap"|"post-authoring"|"on-demand"` (`:26`); `surfaces` is the scope
(a `PrimitiveSurface[]` filter). **Only `EMITTABLE = ["skill","command","rule"]` are emitted**;
hook/mcp/plugin are counted as `deferred` (`:153,165-172`).

**KEY FINDING: `reconcile()` has no production caller** — grep across `src/` and `scripts/` finds it
invoked nowhere but its own definition; only helpers (`emitFitting`, `primitiveHash`,
`parseFrontmatter`, `readUntaggedHookGroups`) are reused. The "post-authoring"/"on-demand" triggers
are **aspirational at this commit** (no API route, runner hook, or watcher).

### Owned/loose/parked model

`PrimitiveState = "loose"|"owned"|"parked"` (`primitive-state.ts:27`): **owned** = file in the global
`apm.lock` `deployed_files`; **loose** = on disk under `~/.claude` but not in the lock; **parked** =
off-disk in the Seed store (not surfaced). Transitions in `state-transitions.ts`; APM is the single
package writer, Garrison only does the orphan cleanup APM won't. Paths: `~/.garrison/fittings`
(captured), `~/.garrison/parked`.

### Programmatic entry for a nightly job

**Clean HTTP entry exists for primitive CRUD + transitions + scalar surfaces; NOT for reconcile or
the orchestrator prompt.**
- Primitives/transitions: `POST http://localhost:<port>/api/quarters` with a `QuartersActionRequest`
  body, e.g. `{"action":"file.update","surface":"skill","name":"foo","content":"…"}`,
  `{"action":"mcp.add","name":"ctx7","config":{…}}`, `{"action":"promote","id":"skill:foo"}`.
  In-process: `runQuartersAction(req)`.
- Settings: `PUT /api/settings` `{patch, remove?}`. CLAUDE.md: `PUT /api/claude-md`
  `{scope, content, baselineSha?}` (handle 409). Plans: `PUT /api/plans` `{name, content}`.
  Documents (update only): `PUT /api/fittings/documents/[id]` `{content}`.

**Missing for a fully programmatic loop:** (1) **no HTTP/programmatic entry to `reconcile()`**;
(2) **no route invokes `projectOrchestrator`** — so editing the *orchestrator/routing prompt* through
a hosted path has **no clean API today** (you would write the fitting file or rules file directly, or
wire the projection lane). Both are libs-present-but-unwired, consistent with the in-flight RC3/RC4
status. **This is the central gap for a nightly improver that edits the routing section.**

---

## 9. SESSIONS + TRANSCRIPTS — **[IN FLUX / CONTRADICTORY]**

### On-disk location & format

`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (`packages/claude-pty/src/paths.mjs:5-7`),
JSONL, one event per line. `parseEvents` (`jsonl.mjs:91-163`) handles `system|user|assistant`;
assistant content parts are `text`/`thinking`/`tool_use`; transcripts also carry TUI line types
(`mode`, `permission-mode`, `last-prompt`, `ai-title`, `queue-operation`, `file-history-snapshot`, …).

> **Latent encoding bug:** `paths.mjs:30` replaces both `/` and `.` (`/[/.]/g`), while
> `jsonl-watcher.mjs:19-21` replaces only `/`. On-disk reality matches the watcher (no dotted dirs).
> A cwd containing `.` would make `paths.mjs` compute the wrong dir — flagged, currently latent.

### Read-only tailing mechanisms (several, overlapping)

- `packages/claude-pty/src/jsonl.mjs` — offset-based incremental read (`readJsonlFrom` advances to
  the last complete `\n`) + `parseTurn(jsonlPath, fromOffset)`.
- `fittings/seed/http-gateway/scripts/lib/jsonl-watcher.mjs` — idle-based watcher; tested by
  `tests/jsonl-watcher.test.ts`.
- `src/lib/claude-logs.ts` — read-only tailing of real `~/.claude` (category `sessions` =
  `sessions/*.json` + `projects/**/*.jsonl`), with realpath/path-traversal guards. This is the
  Quarters Logs/Sessions surface.
- The dev-env Fitting renders sessions via `chat-pane.tsx` (the session view folded into dev-env, 2026-06-11).

### Could a parser extract `[route: x | rule: y]` from the final reply line?

**The code's own assumption contradicts current on-disk data — this is the key obstacle.**

- `packages/claude-pty/src/screen.mjs:3-7` (verified) asserts: *"Claude 2.1.175 fires hooks reliably
  but does NOT persist conversation content to the session JSONL (only an `ai-title` line) — verified
  empirically. The headless xterm screen is therefore the source of truth."* The runtime reply path
  confirms this — `OperativePtySession.runTurn` returns `extractReply(this.handle, …)` (screen-scraped,
  `session.mjs:200`). **At runtime the operative's reply is screen-scraped, not JSONL-parsed.**
- **But live transcripts DO contain assistant text.** I verified one 12.6 MB session
  (`82ada980….jsonl`, `version 2.1.148`): **930 assistant lines → 147 `text` content parts, 561
  `tool_use` parts, 144 `ai-title` lines**. So normal Claude Code sessions on this install **do**
  persist assistant text; the screen.mjs "only an ai-title line" claim is **stale or
  spawn-shape-specific**.

**Verdict & obstacles:**
- **Via JSONL: feasible and reliable** for sessions that persist text. `parseEvents` already collects
  `assistantTexts[]` (`jsonl.mjs:135-137`); the last `text` part is the final reply, and a trailing-line
  regex extracts a token. JSONL is line-stable and offset-resumable. Obstacle: you must take the last
  `text` part of the turn, skipping interleaved `tool_use` parts.
- **Via screen scraping: fragile.** `extractReply` (`screen.mjs:125-181`) reconstructs the reply from
  the 50-row alt-screen viewport with **no scrollback** — a long reply that scrolled off is truncated,
  and a token on the *final* line sits closest to the status/input stop-markers, the most
  scrape-vulnerable position.
- **The unresolved obstacle to flag:** I could not isolate which transcripts came from
  *claude-pty-spawned operatives* (which use `--session-id`/`--continue` and may behave differently)
  vs normal CLI/IDE sessions. The honest position: **verify empirically against an actual claude-pty
  operative run before relying on JSONL.** If the operative's spawn shape really suppresses transcript
  content (as screen.mjs claims), only the screen scrape is available, and final-line token extraction
  is unreliable. **Recommendation: make the token a structured side-channel** (e.g. a hook/tool emit,
  or a dedicated artifact write) rather than parsing it out of the reply text.

---

## 10. VAULT — **[STABLE]**

Full secret-read path:
1. **Storage:** `src/lib/vault.ts` — `data/vault.json` is AES-256-GCM (`{version, kdf:"scrypt", salt,
   iv, tag, ciphertext}`, `:8-15`), file mode `0o600`. Decrypted plaintext (`{secrets:Record<string,string>,
   updatedAt}`) is cached on `globalThis`. Dev unlock: `VAULT_UNLOCKED=true` + fixed passphrase (`:40-69`).
2. **Materialize:** `materializeEnv(compositionDir)` (`:155-174`) writes every secret as a `KEY=value`
   line into `<compositionDir>/.env` (mode `0o600`, values quoted). Called by the runner during `up`
   (`runner.ts:118,414`); cleaned by `wipeMaterializedEnv` on stop (`runner.ts:218`).
3. **Script reads:** secrets reach scripts as **`process.env`**:
   - setup/verify hooks: `runShellCommand` (`runner.ts:994-1013`) calls `loadDotenvFromCwd(cwd)`
     (`:964-992`), which walks up to 5 levels from `apm_modules/_local/<id>/` to find the composition
     `.env`, parses it, and merges into the child env (`env:{...process.env, ...dotenvVars}`).
   - the gateway/operative process inherits the materialized env via the spawn chain.
   - **No runtime `dotenv` dependency in the fitting scripts** — they read `process.env.<KEY>` directly.

Examples: `slack-channel/scripts/slack-adapter.js:21-22`
(`const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || ''`), used as
`Authorization: Bearer ${SLACK_BOT_TOKEN}` (`:124`); `trello-data-source/scripts/trello.py:73-74`
(`os.environ.get("TRELLO_KEY","")`). **No fitting reads `vault.json` or `.env` directly** — the chain
is `vault.json → materializeEnv → <compositionDir>/.env → subprocess process.env → script`.

---

## 11. UI CONVENTIONS — **[STABLE]** (touch support **[IN FLUX]**)

### Framework state (from `package.json`)

- **Next.js `^14.2.35`** (App Router; dev server `127.0.0.1:7777`). **React/React-DOM `^18.2.0`**.
  **TypeScript `^5.6.3`** (`tsc --noEmit`).
- **Own-port bundler: esbuild `^0.28.0`** (devDep), used by each fitting's `ui/build.mjs`.
- **CSS hybrid:** Next surfaces use **Tailwind `^3.4.15`** + postcss/autoprefixer; own-port fittings
  use **plain hand-written CSS** (`ui/styles.css`). No CSS modules, no CSS-in-JS.
- **No external state libs** — local React + a custom `useAppShell()` context + the `useAutosave`
  hook. `clsx`, `zod`, `lucide-react`, `marked`, Monaco (`@monaco-editor/react`), xterm.
- PTY substrate: `@garrison/claude-chat`, `@garrison/claude-pty` (`file:` deps), `node-pty`.

### Component pattern (the house convention)

Documented in `.claude/skills/garrison-architecture/SKILL.md`:
`src/app/<x>/page.tsx` (server) → `src/components/<x>/<Panel>.tsx` (client, `useAppShell()`) →
`fetch /api/<x>` → `src/app/api/<x>/route.ts` (`runtime="nodejs"`, `dynamic="force-dynamic"`,
`jsonError`) → `src/lib/<x>.ts` (file IO). Add a NavLink in `src/components/chrome/Sidebar.tsx`.
IO rule: "Read-fresh → mutate → write whole document; never blind-overwrite; never clobber files
Garrison does not own." Named templates: `vault/page.tsx`, `VaultPanel.tsx`, `api/vault/secrets/route.ts`,
`src/lib/vault.ts`.

### Own-port fitting UI build/serve

esbuild bundle (`fittings/seed/dev-env/ui/build.mjs:11-23`): `bundle:true, format:"esm",
outfile:dist/<id>.bundle.js, loader:{".tsx":"tsx",".css":"css"}, jsx:"automatic"`. Post-build it
concatenates `styles.css` + the shared `@garrison/claude-chat` CSS and copies `xterm.css`. Served by
a **bare Node `http` server** (`scripts/server.mjs`, `serveStatic` with path-escape guard + SPA
fallback), which picks a free port and writes `~/.garrison/ui-fittings/<id>.json`. dev-env default
port **7086**.

### Immediate-save (no Save button)

Canonical hook: **`src/hooks/useAutosave.ts`** — debounced flush (600 ms default) **plus flush on
blur and on unmount**; returns `{status, schedule, flush}` with status `idle|saving|saved|error`.
Consumers:
- Context/CLAUDE.md: `MarkdownEditor.tsx:40` wires `useAutosave`, `:60` `onBlur={()=>void flush()}`,
  status at `data-testid="autosave-status"`.
- Settings: `SettingsPanel.tsx` has its own debounce — "No save button. Discrete controls … autosave
  immediately; text/number/JSON debounce and flush on blur" (`:25-31`); PUTs `{patch, remove}` to
  `/api/settings`; polls `/api/settings/drift` for external edits.
- Plans: `src/lib/plans.ts` "Garrison-direct-write (autosave)" + `PlansPanel.tsx`.
- Quarters editors (`surfaceEditors.tsx`) are form-submit-driven (each owns fetch/save, calls
  `onSaved`/`onClose`) — not the blur-autosave path.

### Playwright setup + template

`playwright.config.ts`: `testDir:"./tests/e2e"`, `globalSetup:"./tests/e2e/global-setup.ts"`,
`fullyParallel:false`, `workers:1` (shared dev server), `baseURL: http://127.0.0.1:${GARRISON_E2E_PORT??3401}`.
**Three viewport projects:** `desktop-chromium` (1440×900), `tablet` (1024×768), `mobile` (390×844,
iPhone iOS 17 UA). `webServer` runs `npx next dev` against a sandboxed `GARRISON_STATE_PATH` /
`GARRISON_CLAUDE_HOME` / `GARRISON_HOME` (`tests/e2e/sandbox.ts`). Video opt-in via `GARRISON_E2E_VIDEO=1`.

**Clean template to copy: `tests/e2e/memory.spec.ts`** — `page.goto("/memory")`,
`expect(page).toHaveURL(/\/quarters\/context$/)`, role+testid selectors
(`getByRole("heading",{name:"Context"})`, `getByTestId("context-editor")`), asserts no save button
(`getByTestId("claude-md-save").toHaveCount(0)`), edits with a per-project unique marker, triggers
save via `editor.blur()` then `expect(getByTestId("autosave-status")).toHaveText("saved")`, and
verifies the disk side-effect with `expect.poll(() => fs.readFileSync(userClaudeMd,…)).toBe(next)`.

### Touch / iPad — **[IN FLUX], sparse and ad-hoc**

No centralized touch layer. Present: viewport meta via Next metadata API
(`src/app/layout.tsx:50-54`, apple-touch-icon + `ServiceWorkerRegistrar`); width-based responsive
sidebar collapse (`useIsMobileViewport()`, `AppShell.tsx:77-96`); **pointer-event** drag handling +
`touch-action:none` inside own-port fittings (`dev-env/ui/styles.css:99` & `main.tsx` pointer
handlers; `browser-default/ui` canvas input forwarding; `web-channel-default/ui/styles.css:116`
`-webkit-overflow-scrolling:touch`). Core `src/` has **no** `onTouchStart`/pinch/swipe handling. The
mobile Playwright project is the only systematic mobile-verification mechanism. **"Driven from an
iPad" works only via responsive collapse + pointer-event dragging in fittings — there is no iPad-specific
code path.**

---

## 12. DYNAMIC WORKFLOWS — **[STABLE]** (read-only facts)

- **Installed Claude Code: `2.1.175`** (verified `claude --version`; binary `/Users/ggomes/.local/bin/claude`).
- **`.claude/workflows/` (repo) and `~/.claude/workflows/` do NOT exist** (verified — both `ls` fail).
  There is **no `workflows/` substrate and therefore no "workflow run records"** on this install.
- **What DOES exist under `~/.claude` (all plain readable JSON/JSONL):**
  - `jobs/<id>/{state.json, timeline.jsonl}` + `pins.json` — background-agent/job run records.
    `state.json` is rich JSON (`state, detail, tempo, inFlight, output.result, template:"bg", respawnFlags`);
    `timeline.jsonl` is one event per line (`{at, state, detail, text}`).
  - `sessions/<pid>.json` — live per-PID session records (`{pid, sessionId, cwd, startedAt, version,
    kind:"bg", entrypoint, name, jobId, status, bridgeSessionId}`).
  - `tasks/<uuid>/<n>.json` — todo/task graph (`{id, subject, status, blocks[], blockedBy[]}`).
  - `scheduled-tasks/<name>/SKILL.md` — cron/routine definitions as skill markdown.
  - `history.jsonl` (2.2 MB) — command history, one JSON line each.
  - also `todos/`, `plans/`, `teams/`, `telemetry/`, `logs/`, `debug/`, `session-env/`.
- `src/lib/claude-logs.ts` already exposes `sessions/*.json` + `projects/**/*.jsonl` read-only;
  `jobs/` and `tasks/` are **not** wired into that surface yet.

> If the router/improver is meant to ride Claude Code "workflows" as a native primitive, **that
> primitive is absent on 2.1.175** — the equivalent substrate today is `jobs/` + `tasks/` +
> `scheduled-tasks/`, all readable, plus Garrison's own `scheduler` fitting (§6).

---

## 13. WALKTHROUGH SKILL — **[STABLE]**

- **Location:** `~/.claude/skills/walkthrough` is a **symlink → `/Users/ggomes/dev/walkthrough/walkthrough`**
  (the real skill repo: `SKILL.md`, `scripts/`, `references/`). Not a plugin. The repo's
  `/Users/ggomes/dev/garrison/.walkthrough/` holds **per-project config + storyboards** (`config.json`,
  `notes.md`, `*.storyboard.json`) — inputs, not outputs.
- **Invocation:** the `walkthrough` Skill (triggers like "record a walkthrough", "show me it working").
  Pipeline: `scripts/preflight.sh` → write a `storyboard.json` → `node scripts/record.mjs <storyboard>
  [--out <runDir>]` (drives the live app with playwright-cli + ffmpeg) → `scripts/extract_frames.mjs`
  + mandatory vision self-verification → `node scripts/serve.mjs` (publish over the tailnet).
- **Output:** **`final.mp4` (H.264 MP4)**, ffmpeg-concatenated from per-beat clips (`record.mjs:76,94,
  125,173-174`). **Default run dir: `~/.walkthrough/runs/<project>/<timestamp>/`** (`record.mjs:59-60`)
  containing `final.mp4`, `manifest.json`, `storyboard.json`, `pass-record.json`, `frames/`, `work/`.
  `serve.mjs` serves `~/.walkthrough/runs` with HTTP Range/206 on **port 8099**, host = `tailscale ip -4`
  — one scrubbable Tailscale link.
- **Evidence:** committed MP4s under `docs/autothing/evidence/`
  (`quarters-crud-walkthrough.mp4`, `settings-s1b-walkthrough.mp4`, `workspaces-wave-walkthrough.mp4`, …).
  Constraint: `record.mjs` refuses storyboards containing test-runner commands ("test runs are BANNED
  from camera").

---

## 14. TIER CLASSIFIER — **[IN FLUX]** (vestigial single-stage skeleton, unwired)

### What exists today (`fittings/seed/tier-classifier/`)

`apm.yml`, `scripts/classify_tier.mjs` (137 lines), `scripts/setup.sh`, `package.json` (v0.2.0,
**zero deps**, model substrate resolved by walk-up to repo `node_modules`),
`.apm/skills/tier-classifier/SKILL.md` (9-line rubric), and `ui/ClassifierInspector.tsx` (a **6-line
static placeholder** referenced by `apm.yml ui.views[]`). No README.

### What it does

- Invocation: `echo '{"prompt":"…"}' | node classify_tier.mjs` (or `--probe`).
- Input `{prompt:string}` → Output `{tier: 1-7, reason:string}`.
- **It's an LLM call, not a heuristic:** loads `SKILL.md` as system prompt and asks a model for JSON,
  driven through **`@garrison/claude-pty` `oneShotTurn`** (`classify_tier.mjs:74-81`; "No Agent SDK",
  `:10-12`). Default model **`haiku`** (`GARRISON_TIER_MODEL`), `bypassPermissions`, 90 s timeout.
  Returned tier is clamped to `[tier_floor, 7]` (`Math.max(TIER_FLOOR, Math.min(7, …))`, `:88`).
- Config (`apm.yml:14-22`): `tier_floor` (default **3**, "minimum tier this classifier raises every
  prompt to"), `plan_threshold` (default **3**, "tier at which the operative must plan"). Rubric
  (`SKILL.md`): "T1-T2 execute directly; **T3+ plan, reclassify, then route**; raise the floor when
  ambiguous."

### Manifest drift (do not trust apm.yml)

`faculty: classifier` (legacy, not one of the 6 roles); `provides:{kind:agent-skill}` (**dropped kind**);
`for_consumers` references the `mcp-gateway` `classify_tier` MCP tool (**dropped fitting**) and claims
it is "Backed by @anthropic-ai/claude-agent-sdk" (**contradicts the script**, which uses PTY). The
**script is authoritative; the manifest is stale** and would fail the current parser.

### What a routing orchestrator subsumes/deletes

A routing orchestrator that "classify a task → pick a tier/model → route" overlaps the **entire**
fitting:
- `classify_tier.mjs:50-90` (`classify()`) + floor-clamp (`:88`) = the roadmap's **classify-1**
  (trivial-vs-non-trivial gate). Deleted/absorbed.
- `tier_floor`/`plan_threshold` config become the router's parameters.
- `SKILL.md`'s "T3+: plan, reclassify, route" is a routing rule that collapses into the router's prompt.
- `ui/ClassifierInspector.tsx` is a no-op stub — trivially absorbed by the router's view.
- **What the current fitting does *not* do:** the roadmap's **classify-2** (post-plan: read plan +
  acceptance → choose `{model, effort, max_turns}`, `GARRISON_ROADMAP.md:449-451`). A router doing
  model-selection-from-plan is *new* work — but it still **supersedes the existing single-stage
  classifier wholesale**.

### Pipeline status

`docs/GARRISON_ROADMAP.md` is the live source: Stage-2 pipeline is `classify → (plan + classify-again)
→ execute under /goal → validate → test → evidence → report` (single-responsibility runners). The
roadmap explicitly flags the shipped fitting as stale ("existing tier-classifier … predate[s] the
two-stage-classifier decision; need verification and possibly adjustment", `:882-885`).
**`docs/FLOW_PLAN.md` does not list the tier-classifier anywhere** — it is scoped entirely to the
config-plane build. **Verdict: shipped-but-stub, effectively abandoned-in-place; Stage 2 is
design-locked (2026-05-26) but unimplemented** (CLAUDE.md: "design locked … implementation pending").

> *Uncertainty:* no routing-orchestrator fitting or design doc exists in-repo; the subsumption
> analysis is against the roadmap's classifier/router intent, not an existing spec.

---

## 15. CONTRADICTIONS + RISKS

### BRIEF file

**`BRIEF_model_router_and_improver.md` does not exist anywhere in the repo.** Searched root and
recursively (`find . -iname "*BRIEF*router*"`, `*model_router*`, `*router*improver*`, excluding
`node_modules`) — **zero matches.** There are therefore **no brief-assumptions to contradict.** If the
brief lives outside the repo, it could not be evaluated here. (Adjacent docs that exist:
`docs/garrison-armory-brief (1).md`, `docs/mcp-gateway-fitting-brief.md`,
`docs/monitor-faculty-brief.md`, `docs/worktrees-and-surface-aware-brief.md` — none about a router/improver.)

### Top 5 technical risks per build item

**(a) A routing section compiled into the orchestrator prompt**
1. **Restart latency / no hot-reload.** `--append-system-prompt-file` is read **only at spawn**
   (`session.mjs:83-84`); editing the assembled prompt does nothing until the operative respawns
   (§1). A router section that changes per-task cannot take effect mid-session.
2. **Two injection lanes, one unwired.** The durable lane (`projectOrchestrator` → `~/.claude/rules/…`)
   has **no caller** (§2/§8); the higher-authority `--append-system-prompt` lane (RC4) is "not yet
   wired." It is currently ambiguous which path actually reaches the model at launch.
3. **Prompt-source fan-out / drift.** The orchestrator text exists in ≥5 places (fitting prompt,
   composition fallback, `dogfood-orch`, generated `assembled-system-prompt.md`,
   `.claude/commands/…`). A routing section added to one copy silently diverges from the others.
4. **`[orchestrator-active]` contract.** Four enforcement points (`integration-check.mjs:72,150`;
   `orchestrator-integration.test.ts:77,92`) assert the token in both the assembled prompt and the
   turn-1 reply. A new routing section must not displace it, and the reply-contract test must still pass.
5. **8 KB `for_consumers` cap + `$`-safe substitution.** The `{{capabilities}}` block caps each
   provider at 8 KB and uses a function-replacement to avoid `$&`-expansion (`runner.ts:577-586`). A
   verbose routing table risks truncation or `$`-pattern corruption if injected naively.

**(b) A three-pane config view with a simulator**
1. **No cheap reusable one-shot for the simulator.** The cheap headless path (`claude --print`) is
   inlined in `runner.ts:spawnClaude` / `spawn-soul.mjs` and not exposed as a lib/API; the available
   helper `oneShotTurn` boots the **full TUI** (~25 s readiness, §1). A "simulate this prompt's route"
   button round-tripping through `oneShotTurn` will feel slow; you likely must add a `--print` path.
2. **Static view registry.** The v2 embedded-view registry is **static**
   (`src/components/fitting-views/registry.tsx`) — a rich embedded view needs a code change, or you go
   own-port (own HTTP server + esbuild + `~/.garrison/ui-fittings/<id>.json`, the `monitor-default`
   template). Either way it is not drop-in.
3. **iPad/touch is ad-hoc.** A 3-pane resizable simulator on iPad needs pointer-event dividers
   (`touch-action:none`, the `dev-env` pattern); core `src/` has no touch system (§11). Resizable
   panes won't "just work" under touch.
4. **No external state lib for a stateful 3-pane editor.** State is local React + `useAutosave`
   (§11). A simulator with linked panes (config ↔ preview ↔ result) must hand-roll coordination;
   immediate-save semantics (flush-on-blur) must be reconciled with a "run simulation" action.
5. **Sandbox/real-`~/.claude` coupling.** The config surfaces read/write the real `~/.claude` via
   `/api/quarters`, `/api/settings`, etc.; e2e runs against a sandbox (`GARRISON_CLAUDE_HOME`). A
   simulator that mutates routing config risks touching live `~/.claude` unless it is explicitly
   sandboxed/dry-run.

**(c) Provider skills that shell out to gemini/codex CLIs**
1. **Platform-validation rejects non-claude-code.** Selection validation requires `platforms` to be
   `all` or `claude-code` (`metadata.ts:229`), even though `PlatformId` includes `"codex"`. A fitting
   declaring a codex/gemini platform may be **un-selectable** until that check is relaxed.
2. **Secrets depend on vault-unlock + materialize ordering.** API keys reach scripts only via
   `process.env` after `materializeEnv` writes the composition `.env` with the vault **unlocked**
   (§10). A provider skill that runs while the vault is locked starts keyless; the secrets-heal
   contract only re-runs on unlock/up/eager-boot — so a nightly/headless run with a locked vault
   silently has no `GEMINI_API_KEY`/etc.
3. **`bypassPermissions` blast radius.** The operative runs `--permission-mode bypassPermissions`
   (`runner.ts:817`) and the scheduler shells `/bin/sh -c` (§6); a provider skill that pipes
   attacker-influenced prompt text into a `gemini`/`codex` CLI argv is an unguarded shell-injection /
   prompt-injection surface with no permission gate.
4. **No `mcp-gateway` to host provider tools.** The dropped `mcp-gateway` kind (§4) means there is no
   existing in-repo mechanism to expose a provider CLI as an MCP tool to the operative — provider
   skills must be plain shell scripts wired through setup hooks, not MCP tools.
5. **Output capture is bespoke.** Garrison's reply-capture is built for the claude TUI screen / its
   JSONL (§9). A gemini/codex CLI's stdout has no equivalent parser; each provider needs its own
   stdout-contract and error handling, with no shared substrate.

**(d) A scheduler-triggered improver applying edits via hosted authoring**
1. **No hosted-authoring path for the orchestrator/routing prompt.** `reconcile()` has no caller and
   `projectOrchestrator` has no route (§8). The orchestrator prompt is **not** a Quarters primitive,
   so `POST /api/quarters` cannot edit it. A nightly improver editing the routing section has **no
   clean API** today — it would write the fitting/rules file directly (bypassing the owned/loose/parked
   model) or require new wiring.
2. **The scheduler fitting is currently un-selectable.** `scheduler/apm.yml` declares the dropped
   `faculty: scheduler` + `automation-runner` kind (§6), which the live parser rejects. The trigger
   mechanism itself must be repaired before it can run anything.
3. **Hosted authoring needs the Next server live.** All hosted-authoring entries are HTTP routes on
   `localhost` (§8). A cron job firing while Garrison's dev server is down has no `/api/*` to call —
   the improver must either guarantee the server is up or call the in-process libs (which a separate
   `node` process cannot do without its own bootstrapping).
4. **Never-clobber conflicts under autonomy.** `PUT /api/claude-md` enforces `baselineSha` and returns
   **409 on conflict** (`claude-md.ts:56`); settings/plans writes are merge/whole-document. An
   unattended improver must read-fresh, diff, and handle 409s/drift — otherwise concurrent user edits
   or the `/api/settings/drift` divergence will reject or silently lose its writes.
5. **APM-owned files resist programmatic edits.** Owned primitives can't be deleted via `file.delete`
   (must Park, `quarters.ts:81-92`), and "owned" means listed in `apm.lock` with APM as the sole
   package writer (§8). An improver that edits an owned skill/rule must go through promote/park/APM,
   not a raw write, or it creates drift that `driftedFromLock` will flag.

---

EXPLORATION-COMPLETE.
