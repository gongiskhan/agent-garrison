# Decisions

Append-only record of notable design decisions. Read alongside
[GOVERNANCE.md](./GOVERNANCE.md). Each entry: date, one-line decision,
source, status.

Status vocabulary:

- **Settled** — decided and not under active reconsideration.
- **Open** — decision pending; current direction is provisional.
- **Deferred** — out of scope for the current milestone; target
  milestone noted.
- **Out of scope** — explicitly not in v1 and not planned for the next
  milestone either; reconsider later if conditions change.
- **Reconsidering** — was Settled, now under fresh review.

---

## 2026-05-04 · Garrison v1 scope reset

Garrison v1 is scoped to "composer for agents". The
platform-for-platforms drift items (multi-host compositions, portable
ESM bundles, four-zone layout vocabulary) are closed.
**Source:** consolidated v1 plan §13. **Status:** Settled.

## 2026-05-04 · Capability vocabulary slimmed to 5 kinds

The capability vocabulary is `orchestrator`, `agent-skill`,
`memory-store`, `automation-runner`, `vault`. The earlier 15-kind
sketch is shelved.
**Source:** consolidated v1 plan §13 (capability vocabulary slimming),
[CAPABILITIES.md](./CAPABILITIES.md). **Status:** Reconsidering —
the five grew to nine across Phases 1–3 (`soul`, `data-source`,
`channel`, `artifact-store` each added on Claude-Code-justified
evidence). The "no premature 15-kind menu" intent stands; new kinds
are only added when a real Fitting needs one. Full current list in
[CAPABILITIES.md](./CAPABILITIES.md).

## 2026-05-04 · `x-garrison` manifest block name retained

Earlier discussion considered renaming the manifest block to
`garrison:`. The Terminology doc settled it as `x-garrison` (preserves
the apm convention of `x-` for vendor extensions). Don't relitigate.
**Source:** consolidated v1 plan §0 ("One decision the implementing
agent should not relitigate"). **Status:** Settled.

## 2026-05-04 · Faculty terminology adopted

The slot concept is named **Faculty**, not Primitive. Code symbols,
manifest fields (`faculty:`), and UI strings are renamed. The parser
accepts the deprecated `primitive:` key with a console warning for
back-compat across one minor version.
**Source:** Terminology doc (referenced in plan §0); implemented in
Phase 1 of the consolidated v1 plan. **Status:** Settled.

## 2026-05-04 · Fitting terminology adopted

The installed-component concept is named **Fitting**, not Component.
File-system path `components/seed/` moved to `fittings/seed/`; library
entries renamed. The `src/components/` React directory keeps the name
because there it means React component, not Garrison Fitting.
**Source:** Terminology doc; Phase 1 of the consolidated v1 plan.
**Status:** Settled.

## 2026-05-04 · `src/components/` directory retained intentionally

The `src/components/` directory keeps the word "component" because in
that path it refers to React components, not to Garrison Fittings.
Future "remove all `component` references" passes must NOT rename it.
**Source:** consolidated v1 plan §3.1 ("NOT where they refer to React
components — those stay `Component`"). **Status:** Settled.

## 2026-05-04 · `component_shape` YAML field name retained

The `x-garrison.component_shape` YAML field was not renamed to
`fitting_shape` even though TypeScript identifiers (`fittingShapes`,
`FittingShape`) were. Per plan §3.1, "the YAML field name itself stays
... don't churn manifest schemas for cosmetic gain." Same reasoning
applies to `cardinality_hint`.
**Source:** consolidated v1 plan §3.1. **Status:** Settled.

## 2026-05-04 · testing-framework Faculty renamed to skills, purpose broadened

The Faculty at slot 6 is renamed from `testing-framework` to `skills`
with a broader purpose: reusable capabilities the Operative can invoke,
of which test authoring is one valid shape. The parser accepts the
deprecated `testing-framework` value with a console warning.
**Source:** consolidated v1 plan Phase 4 (§6). **Status:** Settled.

## 2026-05-04 · License pending decision between MIT and Apache-2.0

The v1 release license is not formally chosen. `CONTRIBUTING.md` lists
MIT as the working default; no `LICENSE` file is committed because
adding one is the decision. Choose before the first external Fitting
submission.
**Source:** consolidated v1 plan §15 (decision points to surface).
**Status:** Open.

## 2026-05-04 · Honesty Test text is drafted from plan context

The text of the Honesty Test in [GOVERNANCE.md](./GOVERNANCE.md) §3 is
drafted from references in the consolidated v1 plan, not copied
verbatim from the canonical Governance doc (which was not available
at write-time). Replace the section verbatim when the canonical text is
recovered.
**Source:** plan §10.1 ("the Honesty Test stays exactly as written.
Verbatim"). **Status:** Open.

## 2026-05-04 · Multi-host compositions out of v1

Garrison v1 cannot host one composition across multiple host surfaces
(web + Slack + others) simultaneously. Each composition runs on one
host: Claude Code locally.
**Source:** consolidated v1 plan §13 (Permanently out of v1).
**Status:** Out of scope.

## 2026-05-04 · Portable cross-host ESM bundles out of v1

Fittings ship as APM packages with optional in-process trusted React
extensions. There is no portable ESM bundle dynamic loading model with
mount/unmount across hosts.
**Source:** consolidated v1 plan §13. **Status:** Out of scope.

## 2026-05-04 · Four-zone layout vocabulary out of v1

The four-zone layout vocabulary from earlier sketches is dropped.
Garrison composes operatives, not layouts.
**Source:** consolidated v1 plan §13. **Status:** Out of scope.

## 2026-05-04 · Full 15-kind capability vocabulary out of v1

The earlier 15-kind sketch is replaced by the 5-kind vocabulary
(decided above). The other 10 kinds are not in v1; revisit only if a
real use case demands one.
**Source:** consolidated v1 plan §13. **Status:** Out of scope.

## 2026-05-04 · Multi-user / multi-process Garrison out of v1

Garrison runs as a single-user, single-process local app. No
multi-user state, no multi-process locking, no per-user vault scoping.
**Source:** consolidated v1 plan §13. **Status:** Out of scope.

## 2026-05-04 · AI-driven validators deferred to runtime SDK milestone

The architecture and quality validators in `src/lib/validation/` are
real. The security and prompt-injection validators are placeholder
pattern scanners. The AI-driven implementations land in the runtime
SDK milestone alongside the `Runtime` interface itself.
**Source:** consolidated v1 plan §13 (Deferred). **Status:** Deferred
(target: runtime SDK milestone).

## 2026-05-04 · Runtime `consume()` / events / lifecycle deferred

The actual `Runtime` interface (`consume()`, `events.emit/on`,
`ui.show/hide`, `lifecycle.on`) and Pattern A synchronous sub-agent
invocation are deferred. Capability stubs in
[CAPABILITIES.md](./CAPABILITIES.md) are marked "TBD — runtime SDK
milestone."
**Source:** consolidated v1 plan §13. **Status:** Deferred (target:
runtime SDK milestone).

## 2026-05-16 · Monitor Faculty added; capability vocabulary grows again

A new `monitor` Faculty and `monitor` capability kind are registered
in [`src/lib/faculties.ts`](../src/lib/faculties.ts) and
[`src/lib/types.ts`](../src/lib/types.ts). The Faculty owns
read-only observability of every entity Garrison spawns (PIDs,
status, ports, network, cwd, redacted env, captured logs). The
default Fitting (`fittings/seed/monitor-default/`) serves its own
React UI on its own port and is consumed via URL link rather than
component sharing or state passing.
**Source:** [`docs/monitor-faculty-brief.md`](./monitor-faculty-brief.md);
phase-1 audit at
[`docs/phases/monitor-feasibility.md`](./phases/monitor-feasibility.md).
**Status:** Settled.

## 2026-05-16 · Shared spawn helper at `src/lib/spawn.ts`

Garrison-controlled spawn sites in `src/lib/runner.ts`
(`spawnMcpGatewayHttp`, `spawnGateway`, `spawnClaude`,
`runShellCommand`, nested `runProcess`) are wrapped by a single
`spawnTracked` helper that tees stdout/stderr to
`~/.garrison/logs/<pid>/{stdout.log,stderr.log,meta.json}`.
`meta.json` redacts env keys matching
`/(_TOKEN|_KEY|_SECRET|_PASSWORD|^TOKEN$|^SECRET$|^PASSWORD$)/i`.
`node-pty` terminal sessions are NOT wrapped (separate pipeline;
the user owns their terminal). Log retention is 24 h after PID
death; the Monitor backend handles cleanup.
**Source:** [`docs/phases/monitor-feasibility.md`](./phases/monitor-feasibility.md) §2.
**Status:** Settled.

## 2026-05-16 · UI-Fitting port convention

Each UI-bearing Fitting declares a default port in
`x-garrison.ui.port`. At start time the Fitting tries to bind that
default; if the port is taken, it falls back via `findFreePort` and
publishes the chosen port at
`~/.garrison/ui-fittings/<fitting-id>.json` for consumers to
discover. Consumers read the status file, then `GET <url>/health`
before linking. No component sharing, no state passing — link by
URL only. Monitor default port: `7077`. Documented in
[`docs/UI-FITTINGS.md`](./UI-FITTINGS.md).
**Source:** [`docs/phases/monitor-feasibility.md`](./phases/monitor-feasibility.md) §3.
**Status:** Settled.

## 2026-05-16 · Worktree port pool stays 50000–54999, exposed via config

The brief illustrated a 3000–3100 pool; the codebase chose
50000–54999 (deliberate, avoids collisions with system services and
common dev servers). The default stays; the range is now config-driven
via env vars (`GARRISON_PORT_RANGE_START`/`GARRISON_PORT_RANGE_END`,
already present) and per-project `port_pool: {start, end}` in
`~/.garrison/projects/<id>.yml`. Treat the brief's `3000–3100` as
illustrative.
**Source:** [`docs/worktrees-and-surface-aware-brief.md`](./worktrees-and-surface-aware-brief.md) §"Port allocation"; user review 2026-05-16.
**Status:** Settled.

## 2026-05-16 · `mcp-gateway --probe` stays lenient by default; `--strict` opt-in

The brief's §3 Health says `mcp-gateway --probe` must exit non-zero
if either underlying Faculty probe fails. The current implementation
exits 0 to support graceful degradation when one of
`tier-classifier` / `testing` is absent. The implementation keeps
its lenient default; a new `--probe --strict` flag exits non-zero
when either underlying probe fails. Workbench launcher can opt into
strict mode via `requireFullMcpSurface` when partial-install
ergonomics are not desired.
**Source:** [`docs/mcp-gateway-fitting-brief.md`](./mcp-gateway-fitting-brief.md) §3; user review 2026-05-16.
**Status:** Settled.

## 2026-05-16 · Tailscale URLs stay `http://` for v1

The worktree brief specified `https://<host>:<port>`. HTTPS on
MagicDNS requires per-service cert wiring the project does not
enforce; switching to `https://` without it would silently break
reachability from mobile. The locked decision is to surface
`http://<host>:<port>` URLs for v1 and revisit when a Garrison-wide
TLS termination story exists.
**Source:** [`docs/worktrees-and-surface-aware-brief.md`](./worktrees-and-surface-aware-brief.md) §"Tailscale URL resolution"; user review 2026-05-16.
**Status:** Settled.

## 2026-05-20 · Lean Garrison trim — Chat, Tools, test box, sub-agent pane removed

The built-in `/chat`, `/tools`, Operative test box, and Sub-agent pane
are deleted. Operative interaction lives in Channel Fittings (Slack
today, Web Channel Fitting planned). The sidebar Views section is the
sole surface for Fitting views. Garrison's documentation drops
consumer-specific paths (`~/.claude/memory-compiler/`,
`~/Projects/awc-gateway-slack/`, `mac-mini/gateway/heartbeat/trello.py`)
and consumer-feature naming. A new
[GOVERNANCE.md §3.1 "Downstream consumers"](./GOVERNANCE.md#31-downstream-consumers)
codifies the rule.
**Source:** [`docs/decisions/2026-05-20-lean-garrison-trim.md`](./decisions/2026-05-20-lean-garrison-trim.md).
**Status:** Settled.

## 2026-06-07 · Quarters pivot — Faculties 24 → 6 roles; Operative folds into real Claude Code

Garrison is reframed from "spawns its own Operative" into a transparent
**control plane over the user's real `~/.claude`**. APM becomes the single
writer for the package surface; the composed Operative is no longer a
separately-spawned SDK agent but the user's real Claude Code session.

- **Faculties 24 → 6 roles:** `orchestrator`, `channels`, `gateway`, `memory`,
  `observability`, `sessions`. The former flat list collapsed; Skills/Hooks/MCPs/
  Plugins/Scripts/Settings/Context/Plans become Quarters **platform primitives**,
  not Faculties. Own-port residue (dev-env, screen-share, outposts, monitor,
  web-channel, browser, voice) survives under the roles via the metadata
  `own_port` flag.
- **Capability kinds shrank:** dropped `soul`, `agent-skill`, `mcp-gateway`
  (re-added data-source and automation-runner later on real-Fitting evidence; see
  2026-06-10 and 2026-06-13 entries).
- **Global composition:** symlink-confined at `~/.garrison/global-composition/`
  with `.claude` → `~/.claude`. `apm install` writes through. State model:
  owned / loose / parked. APM is non-destructive to loose primitives.
- **Orchestrator projection:** soul + orchestrator + `{{capabilities}}` fold
  projected to `~/.claude/rules/garrison-orchestrator.md` (reversible; higher-
  authority `--append-system-prompt` fallback per-launch).
- **No Save buttons:** Quarters autosaves; drift is surfaced via
  `/api/settings/drift`.
- **RC4 deferred:** hosted-session launcher not yet wired; `up()` still spawns
  via `spawnGateway`/`spawnClaude` until it lands.

**Source:** [`docs/decisions/2026-06-07-faculties-as-roles-operative-folded.md`](./decisions/2026-06-07-faculties-as-roles-operative-folded.md).
**Status:** Largely settled (RC4 open).

## 2026-06-10 · `data-source` kind re-added; trello-data-source revived under `memory`; own-port secrets-heal contract

Three linked changes. (1) The `data-source` capability kind returns to
`capabilityKinds` in [`src/lib/types.ts`](../src/lib/types.ts),
reversing part of the 2026-06-07 Quarters-pivot drop, on the standing
real-Fitting justification: trello-data-source cannot be expressed
without it, and kinds are only added (or kept) when a real Fitting
needs one. The other dropped kinds (`soul`, `agent-skill`,
`automation-runner`, `mcp-gateway`) stay dropped. (2)
trello-data-source is revived under the `memory` role — external data
the Operative recalls and manipulates, with its Trello-backed derived
Tasks truth file — and rejoins `data/library.json` and
`compositions/default/apm.yml`; `memory` becomes a multi-cardinality
role accepting the `cli` shape, and `data-sources` is a deprecation
alias for it. (3) Own-port spawns now write a Garrison-side record at
`~/.garrison/ui-fittings/spawn/<id>.json` tracking `secretsDelivered`;
`startOwnPortFitting` heals a running keyless vault consumer by
restarting it with the secrets once they are available, and vault
unlock, runner `up`, and eager boot all heal through that one seam
(fixing the eager-boot keyless start — eager boot runs in a detached
child that cannot read the in-process unlocked vault).
A same-day truth pass restored the `{{capabilities}}` placeholder to
the orchestrator Fitting's prompt — the Quarters-pivot rewrite had
shipped without it, silently severing every provider's `for_consumers`
from the Operative (the locality principle) — and the runner now logs
a loud warning when an orchestrator prompt lacks it. The heal path was
also hardened: per-fitting start/stop locks plus the orphan-sweep memo
moved to `globalThis` (hot-reload-safe), the sweep never reaps
fittings of a composition whose runner record is running, heal
failures surface in `failed[]` with a warn, and the fitting servers
and spike drivers became `GARRISON_HOME`-aware so spikes cannot
clobber real status files.
**Source:** [`docs/VOICE_TRELLO_HANDOFF.md`](./VOICE_TRELLO_HANDOFF.md)
(status header, §4, §7); [`docs/UI-FITTINGS.md`](./UI-FITTINGS.md)
§"Runner lifecycle".
**Status:** Settled.

## 2026-06-13 · Model Router + Improver wave (MR) kickoff

The routing-orchestrator + nightly-improver build per BRIEF v2. The brief was
written against `7836f85`, but the PTY-everywhere commits (`1fdd49f`/`c562ac9`)
already shipped the warm-pool class, the `gateway-legacy.mjs` deletion, and the
`spawnClaude`/`spawn-soul.mjs` PTY migration — so P0 **wires and finishes** the
substrate rather than rebuilding it. Two-stage routing (gateway pre-route →
act), Profile-based policy, a compiled `{{routing}}` section in the orchestrator
prompt, an own-port view + simulator, three provider skills, a nightly Improver,
and a Workflows Quarters category.
**Source:** `~/.claude/plans/brief-v2-model-swift-neumann.md` (brief §2/§3
verbatim + substrate-delta adaptations); `EXPLORATION_REPORT_router_improver.md`.
**Status:** Settled (build in progress).

## 2026-06-13 · `automation-runner` capability kind re-added

`automation-runner` was dropped in the 2026-06-07 Quarters pivot but the
scheduler, the new Improver, and four other fittings (`morning-briefing`,
`google-calendar`, `vault-sync`, `loop-heartbeat`, `personal-operative`) cannot
be expressed without it. Re-added on the same Claude-Code-justified, add-a-kind-
only-when-a-real-Fitting-needs-one rule that re-added `data-source` on
2026-06-10. **Source:** brief §2 (Improver); slice MR0b. **Status:** Settled.

## 2026-06-13 · Model Router fills the singleton `orchestrator` Faculty (FLAGGED)

The brief says the Model Router "fills the Orchestrator Faculty (singleton)".
Since `garrison-orchestrator` already holds that slot, the router **supersedes**
it: the router carries the existing orchestrator behavior forward verbatim —
preserving the `[orchestrator-active]` reply contract (4 enforcement points) and
the `{{capabilities}}` placeholder — and adds a compiled `{{routing}}` section;
`garrison-orchestrator` and `tier-classifier` are parked. This is an
*interpretation* of the brief, not an instruction, so it is flagged. It is
reversible (park) and gated by P1 `assembly-ok` (the assembled prompt must still
contain the routing section AND `[orchestrator-active]`, and `integration-check`
must pass). If the intent was a separate routing-contributor fitting leaving
`garrison-orchestrator` in place, flip the assembly approach.
**Source:** brief §0/§2; plan "Locked decisions #3". **Status:** Open
(proceeding; gated).

## 2026-06-13 · Programmatic-path purge finished (slice MR0a)

Deleted `scripts/spike/*` (22 disconnected POC files, zero production imports)
and the vestigial `compositions/dogfood-orch/.../gateway-legacy.mjs` install
artifact; tidied three stale comments that named `@anthropic-ai`/`--print`
(`coding-subagent.mjs`, `orchestrator-projection.ts`, `legacy-voice.tsx`).
Committed `tests/programmatic-purge.test.ts` as the regression guard: it scans
tracked production source (`src`/`packages`/`fittings`/`scripts`) for
`--print`, headless `stream-json`, `@anthropic-ai/`, and `api.anthropic.com`
and fails on any reappearance. **Source:** brief §1; user decision 2026-06-13.
**Status:** Settled.

## 2026-06-13 · MR0e empirical verdicts: slash-inject WORKS, JSONL ABSENT

Two live-`claude` probes (committed at `scripts/probe-slash-inject.mjs` and
`scripts/probe-jsonl.mjs`) settled the brief's P0 empirical forks:

- **`slash-inject-verdict: works`.** Injecting `/model haiku` (raw `writeKeys`)
  into a live operative session moved the status-line model
  `Sonnet 4.6@high → Haiku 4.5`. The status line also surfaces effort (`@high`).
  **Consequence:** Stage B (MR1d) and the warm pool (MR0d) switch model/effort by
  PTY-injecting `/model` + `/effort` at checkout (~1s) on ONE generic pool — not
  per-`{model,effort}` respawn. (Effort applies only where the model supports it:
  haiku reported "auto mode unavailable for this model".)
- **`jsonl-verdict: absent`.** A claude-pty operative turn scraped its reply from
  the screen ("PONG") but claude 2.1.175 wrote no conversation transcript — the
  project dir was created (holds only `memory/`) with no `<sessionId>.jsonl`. This
  confirms `screen.mjs`'s claim for this spawn shape. **Consequence:** route
  telemetry stays script-call-primary (gateway writes `decisions.jsonl` at
  resolution time; the reply `[route:]` token is read from the screen scrape,
  never transcript-parsed).

**Source:** brief §3 (P0); slice MR0e. **Status:** Settled.

## 2026-06-24 · Kanban Loop V1b — build decisions (run 20260624-162055-152350bb)

Autothing build of Kanban Loop V1b. Key calls recorded for the record:

- **Pre-existing test baseline (NOT this run's regressions).** At build start the
  suite had **7 failing tests** across 6 files (`seed.test.ts` ×3,
  `validation.test.ts`, `claude-install.test.ts`, `gemini-runtime.test.ts`,
  `orchestrator-placement.test.ts`, `fitting-files-api.test.ts`) — all about a
  `memory`→`basic-memory` seed-fitting rename and gemini/placement WIP from a
  concurrent session (the working tree already had `apm.lock.yaml` modified).
  Confirmed pre-existing by stashing this run's tracked changes and re-running:
  the failures persist. This run must not touch that other session's WIP, so it
  treats those 7 as a **documented external baseline**; the global gate measures
  "no NEW failures vs baseline," not a fully-green suite.
- **Evidence policy.** UI slices (`kanban-board-ui`, `web-channel-generic-context`,
  `discuss-james-brief`) get real vision-verified **browser** walkthrough videos.
  CLI/lib/docs slices get **asciinema** captures of their committed re-runnable
  test/CLI demo running green — the committed vitest IS the durable correctness
  gate; the asciinema is the evidence artifact (autothing accepts asciinema for
  CLI/TUI).
- **`gateway-souls-hint` (slice D) hardening (from the Codex cross-model review).**
  souls-route honors ONLY the documented `{taskType,tier}` contract and
  deliberately drops a caller-supplied `matchedException` (which `resolveRole`
  would otherwise honor — a caller could force exception routing); and
  `resolveSoulsHint` wraps `resolveRoute` in try/catch so a malformed routing
  config can never turn a valid `/chat` into a request-time 500. PTY mode is
  untouched (it already honors the hint).
- **`autothing-validate` (slice B) fails closed (from the Codex review).** A
  missing/invalid `kind` → Implement; `codexPwTest:"n/a"` is rejected for
  `kind:"ui"` (a UI slice always has an app); and a failed `validated`-marker
  write downgrades the verdict to Implement (the durable record is part of the DoD).
- **`docs/architecture.md` accuracy (from the Codex review).** `runtime="nodejs"`
  is the only universal route flag (44/44); `dynamic="force-dynamic"` is a
  precaution applied to 36/44 (several live-state routes omit it), not an
  invariant. `vault.ts` and `reconcile.ts` are NOT atomic-write exemplars
  (`vault.ts` is the surface-wiring template; `reconcile.ts` uses `fsp.cp`/
  `writeYamlFile`).

**Source:** BRIEF/kanban-loop-v1b-build-brief.md; run FLOW_PLAN at
docs/autothing/runs/20260624-162055-152350bb/. **Status:** in progress.

## 2026-06-24 · Kanban Loop V1b — garrison-* parity confirmed + shims retired (FINDING 15)

**Parity confirmed (A/B probe).** Two read-only Plan agents were given the SAME task
(add a new "Labels" host-config surface) — one handed ONLY `docs/architecture.md`, the
other ONLY `.claude/skills/garrison-architecture/SKILL.md`. Both extracted equivalent,
conventions-correct plans: the surface-wiring path (page→component→/api→lib→Sidebar), the
route flags (`runtime="nodejs"` mandatory / `dynamic="force-dynamic"` situational — the
docs probe even captured the Codex-added nuance), the host-config IO discipline
(read-fresh→mutate→write-whole, the atomic-write helper, base-path injection,
never-clobber), and the test pattern. The doc conveys the doctrine **as well as** the
area skill → `autothing-implement` reading docs alone has parity.

**Shims retired** (gated on the above). Deleted the 5 area shims
`.claude/skills/garrison-{architecture,planning,testing,design-audit,governance}` (tracked
in git → recoverable). Kept `run-garrison` (it is the app launcher / `/run` analogue, not
a doctrine/verb shim). `fittings/seed/testing` (APM `name: garrison-testing`, the
`run_tests` MCP tool) is a SEPARATE fitting, untouched. Rewired the one functional
consumer — the model-router discipline→skill map (`routing-core.mjs` `disciplineSkill` +
`.apm/prompts/model-router.prompt.md` + `tests/discipline-skills.test.ts`) — to the
`autothing-*` family: testing→`autothing-test`, design-audit→`autothing-design-audit`,
distribution→`autothing-validate`, and evidence:video→`autothing-walkthrough` (correcting
the prior `run-garrison` mapping — run-garrison is only a launcher, the walkthrough video
is recorded by `autothing-walkthrough`). No dangling code references remain (only the
input BRIEF docs still mention garrison-* as historical design context).

**Source:** brief decision 1 + Verify-first. **Status:** done.

## 2026-06-24 · Kanban Loop V1b — post-ship fix: board would not start + "(V1a)" menu label

Two real bugs the initial build missed (it tested the board server standalone against a
demo dir, not THROUGH the runner in the live Garrison):

1. **Board never started under Garrison.** The runner (`src/lib/own-port-lifecycle.ts`
   `startOwnPortFitting`) boots an operative-bound own-port Fitting by spawning
   `<fittingDir>/scripts/start.mjs` — the convention every other own-port fitting follows
   (a one-liner that imports `startServer` from `server.mjs`). kanban-loop shipped
   `server.mjs` but **no `scripts/start.mjs`**, so the runner errored "no start script"
   and the board never booted (`node scripts/server.mjs` worked standalone, masking it).
   Fix: added `fittings/seed/kanban-loop/scripts/start.mjs`. Verified live: POST
   `/api/fittings/kanban-loop/start` → `{ok:true}`, status file written, the board
   appears in `/api/fittings/views` (the menu) and serves the 13-list V1b pipeline on
   :7089; `apm install` materialized it into the composition `apm_modules/_local` and the
   verify hook returns `KANBAN-OK`.
2. **Menu showed "Kanban Loop (V1a)".** `data/library.json`'s curated registry entry
   still said `"name":"Kanban Loop (V1a)"`. Fixed to `"Kanban Loop"` with a V1b summary;
   `/api/library` now serves the new name.

**Regression guard added:** `tests/own-port-start.test.ts` asserts every seed Fitting with
`x-garrison.own_port: true` and `lifecycle !== "detached"` ships `scripts/start.mjs` — so
this class of "starts standalone but not under the runner" bug cannot recur silently.

**Lesson:** an own-port fitting must be verified THROUGH the runner's start path (start.mjs
+ /api/fittings/<id>/start + the Views surfacing), not just by running its server.mjs.

**Status:** fixed + verified in the live app.

## 2026-07-01 · improver-nightly cron has never once completed real work

The `improver` Fitting's nightly scheduler job (`improver-nightly`, cron `30 3 * * *`) is
genuinely registered with the real launchd-backed `scheduler` daemon and has fired every
night since at least 2026-06-26. Every run crashes with `OperativePtySession: message
never registered (claude did not accept input)` (a claude-pty PTY bug) inside
`runSkills()`'s `computeDream()` call, before any proposal/queue writing -
`review-queue.json` has stayed `[]` for 6+ real nightly executions. Discovered while
building the ecosystem-update mechanism (run `20260701-092738-9b939e7a`); the new
ecosystem-update + reapply-sweep phases are wired to run *before* this crash point in
`main()` so they are unaffected, but the underlying claude-pty bug itself is untouched.
**Source:** autothing run `docs/autothing/runs/20260701-092738-9b939e7a/`. **Status:**
Deferred - needs its own investigation/fix pass into `packages/claude-pty/src/session.mjs`'s
`OperativePtySession`/`runTurn`/`oneShotTurn`.

## 2026-07-01 · duplicate `improver-nightly` scheduler job id across two Fittings

`fittings/seed/improver/scripts/setup.sh` registers a scheduler job named
`improver-nightly`. A second, wholly separate Fitting, `fittings/seed/improver-nightly/`
(`faculty: sessions`, its own CLI + `tests/improver-nightly.test.ts`), also registers a
scheduler job named `improver-nightly` in its own `setup.sh`. If both Fittings were ever
installed into the same composition, the second `register`/`add` would silently overwrite
the first's job entry (last-write-wins, confirmed via `scheduler.mjs`'s `add`/`register`
semantics). Not observed to be currently co-installed in `compositions/default`, so not an
active bug, but worth a cleanup pass to rename one or consolidate the two Fittings.
**Source:** autothing run `docs/autothing/runs/20260701-092738-9b939e7a/`. **Status:** Open.

## 2026-07-01 · GARRISON_COMPOSITION_DIR is dead code on every real Fitting-process spawn path

`server.mjs`'s `targetFileFor()` and the new `resolveCompositionDir()` (both in the
`improver` Fitting) prefer `process.env.GARRISON_COMPOSITION_DIR`, falling back to a
fixed-depth walk up from the Fitting's own script location. Traced through the actual
spawn paths: `src/lib/runner.ts`'s `spawnGateway()` sets this var for the ONE gateway
subprocess, but `runShellCommand()` (setup/verify hooks), `startOwnPortFitting()`
(own-port servers like improver's `server.mjs`), and the `scheduler` Fitting's
`spawn('/bin/sh', ['-c', ...])` (the nightly cron's actual invocation path) never set
it. So every Fitting that reads this var today is silently falling through to its own
ad-hoc directory-depth guess. The fixed-depth walk also assumes the `_local/<fitting>`
nesting depth, which `global-composition.ts`'s `depName()` shows does not hold for
non-local (remote/git-pinned) dependencies - a shape Garrison doesn't have yet but is
explicitly headed toward. **Source:** autothing run
`docs/autothing/runs/20260701-092738-9b939e7a/` code review (angle: altitude). **Status:**
Open - recommend `runner.ts` stamp `GARRISON_COMPOSITION_DIR` onto every Fitting-launched
process (setup/verify hooks, own-port spawns, and whatever the scheduler daemon execs),
so Fittings stop reinventing this derivation independently.

## 2026-07-01 · review-queue.json has no locking between server.mjs and cron-fired improver.mjs

`fittings/seed/improver/lib/review-queue.mjs`'s `loadQueue`/`saveQueue` do a plain
full-file read then full-file rewrite, no locking or compare-and-swap. `review-queue.json`
is shared across two independent OS processes: the always-on `server.mjs` (port 7088,
handling UI apply/reject/run-now) and the cron-fired `improver.mjs run-now` (fired by the
standalone `scheduler` daemon, unrelated process tree). Pre-existing before this session's
work; the new reapply-sweep phase adds a third writer into the same unguarded file. A
UI action landing mid-cron-run (or vice versa) can silently lose whichever write finishes
second. **Source:** autothing run `docs/autothing/runs/20260701-092738-9b939e7a/` code
review (angle: cross-file tracer). **Status:** Open - a proper fix needs a lock file or
compare-and-swap around `review-queue.json`, affecting `review-queue.mjs`, `server.mjs`,
and `improver.mjs` together; out of scope for a single-slice fix.
