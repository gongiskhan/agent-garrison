# FLOW_PLAN — GARRISON-MARATHON-V1 (run 20260712-173530-81e1c448)

Derived from RUN_SPEC.md. Profile **build** · 19 slices · turn cap **1520**
(max(300, 80×19)) · deliberateRed ON · mutation ON · gates all-true.
Workstreams run IN ORDER (brief rule); slices within a workstream may
parallelize only when their files are disjoint. Before every slice: governor
`check` (WS0 pacing rule; ≥90% → pause until reset). Every slice ends with a
commit + its sentinel printed and appended to `~/.garrison/marathon/ledger.md`.

## Slices

| id | title | kind | route/area | group | status |
|---|---|---|---|---|---|
| S0 | WS0 governor: ccusage check/wait-if-needed + banner watcher | api | ~/.garrison/marathon/governor.mjs (uncommitted tooling) + proof | g0 | passed |
| S1 | WS1 taste Fitting: vendor 2 MIT skills, activate global composition, owned+drift in Quarters | mixed | fittings/seed/taste + global-composition + /quarters | g1 | passed |
| S2a1 | WS2a classifier+resume abstraction: classifier via primary-agnostic adapter path; resume via adapter.resume | api | http-gateway gateway-routing/stage-b + claude-pty runtime adapters | g2 | passed |
| S2a2 | WS2a Stage-B moves via adapter (setModel/setEffort) + non-Claude primary boot/serve smoke | api | http-gateway + agent-sdk-runtime; committed smoke test | g2 | passed |
| S2b | WS2b opencode-runtime Fitting: serve-based bridge, delegate(), primary-capable, descriptor, status surface; installs ollama+qwen | mixed | fittings/seed/opencode-runtime + library.json + quarters | g2 | passed |
| S2c | WS2c matrix harness + full run: every composition Fitting × {claude-code, codex, opencode}; fix agnosticism bugs | api | scripts/matrix-harness + docs matrix doc | g2 | passed |
| S2d | WS2d degradations doc + UI surfacing on non-Claude primaries | mixed | docs/RUNTIME_DEGRADATIONS.md + compose/run UI badge | g2 | passed |
| S3 | WS3 clone+edit: Armory Clone action → fittings/local/ copy, cloned_from provenance, drift vs pinned upstream, Monaco create-file, composer+run round trip | mixed | library.ts/fitting-files.ts/compose UI | g3 | passed |
| S4 | WS4 composition switching: active_composition pointer, shell switcher (down/re-resolve/up, error-blocked), CLI flag, evidence id+hash | mixed | src/lib/compositions+runner, AppShell, scripts CLI | g4 | passed |
| S5a | WS5 assistant Fitting + Answer mode (docs+fitting index, 3 grounded answers w/ sources) | mixed | fittings/seed/garrison-assistant | g5 | passed |
| S5b | WS5 Guide (launch tours by name) + Build/interview → ≥1 skill + ≥1 automation proposal, provenance `assistant`, approvable in Improver UI | mixed | garrison-assistant + improver queue | g5 | passed |
| S6a | WS6 tour engine: ui.tours metadata block + in-app DOM executor (same storyboard schema) + Demo player w/ highlights + captions | ui | src/lib/metadata + src/components/tours | g6 | pending |
| S6b | WS6 Guided player (spotlight/wait/assert/advance) + a tour per seed Fitting + Escape exit + Assistant Guide launch | ui | tours descriptors per fitting + engine | g6 | pending |
| S7 | WS7 probe revival: probe-question policy row (S9 fast-target seed), local-model question generation via ollama-local, acceptance checks → IMPROVER-PROBE OK | mixed | improver + orchestrator policy + agent-sdk provider | g7 | passed |
| S8a | WS8 shadcn/improve findings doc + evidence discipline (file:line + confidence) + vet pass (planted false positive dropped) | api | fittings/seed/improver | g8 | pending |
| S8b | WS8 rejection ledger (reason + suppression across runs) + reconcile mode (verify/refresh/retire) demonstrated | mixed | improver + its UI reject flow | g8 | pending |
| S9a | WS9 audit: redesign-skill audit across all surfaces, before word-counts, audit doc committed | ui | docs/design/UIPASS audit | g9 | pending |
| S9b | WS9 apply: shell nav, Compose, Quarters, dashboard/Run, Vault, per-Fitting routes | ui | src/components + src/app | g9 | pending |
| S9c | WS9 apply: own-port fitting views + WS3–WS6 surfaces; narrow-viewport check; re-run all storyboards+tours green; after word-counts | ui | fitting UIs + .walkthrough | g9 | pending |

## Per-slice acceptance (summary)

- **S0**: `governor.mjs check` prints real percent+reset (computed as active
  block totalTokens / max historical block); `wait-if-needed` blocks at ≥90%;
  banner watcher module exports a matcher for the PTY status-row limit text;
  proof = one real check + one simulated `MARATHON-PAUSED resets <t>` /
  `MARATHON-RESUMED` pair (threshold lowered). Sentinel `MARATHON-WS0 OK`.
- **S1**: taste Fitting installs in the default composition AND the activated
  global composition; `design-taste-frontend` + `redesign-existing-projects`
  appear in /quarters as OWNED with provenance pin b177427 + drift status;
  a live operative invocation loads the skill. Sentinel `MARATHON-WS1 OK`.
- **S2a1**: classifier no longer requires a claude-code PTY (adapter-resolved;
  haiku-on-claude-code kept when available, loud documented fallback
  otherwise); resume path routes through adapter.resume; existing claude-code
  behavior byte-identical (tests). No sentinel (half-slice).
- **S2a2**: Stage-B model/effort moves call adapter methods (slash-inject kept
  as the ClaudeCodeAdapter implementation); committed smoke proves an
  agent-sdk primary boots, serves a session turn, and a routed model change
  lands without `route-switch-skipped`. Sentinel `MARATHON-WS2A OK`.
- **S2b**: opencode-runtime installs/verifies; delegate() round-trips a task
  through `opencode serve` (session create → prompt → wait → summary+artifacts);
  primary-capable via adapter; Quarters descriptor renders; runtime status
  surface shows serve health; ollama + small model installed and used as its
  default provider. Sentinel `MARATHON-WS2B OK`.
- **S2c**: committed harness drives health + one representative action for
  every composition Fitting under each primary; matrix doc committed with zero
  unexplained failures (fix or documented degradation). Sentinel
  `MARATHON-WS2C OK`.
- **S2d**: degradations list committed (each behavior + one-line why); UI
  badge/notice wherever a degraded Fitting shows on a non-Claude primary.
  Sentinel `MARATHON-WS2D OK`.
- **S3**: from the UI: Clone a seed Fitting → `fittings/local/<id>` +
  library entry (namespace `_local`), provenance `cloned_from: <id>@<version>`
  + upstream pin; edit a file in Monaco (including CREATING a new file); drift
  shows clone-vs-upstream; clone selectable in composer and runs in a
  composition. Upstream updates never touch the clone. Sentinel
  `MARATHON-WS3 OK`.
- **S4**: `active_composition` pointer (new ~/.garrison/config.json); shell
  switcher lists compositions/ + user paths; switch = down → re-resolve → up
  with resolver errors blocking pre-switch; `garrison up --composition <path>`
  CLI; run evidence records composition id + apm.yml sha256. Two compositions
  demonstrated. Sentinel `MARATHON-WS4 OK`.
- **S5a**: assistant answers 3 grounded questions (a Faculty, a specific
  Fitting's usage, a Garrison workflow) citing sources; index built at setup
  from docs/ + installed Fittings' SKILL/instructions; re-index on composition
  change. No sentinel (half-slice).
- **S5b**: Guide launches a WS6 tour by name; interview loop asks ≥4 adaptive
  questions one-at-a-time via the channel UI; files ≥1 skill + ≥1 automation
  proposal with provenance `assistant`, visible/approvable in Improver UI;
  assistant never edits artifacts. Sentinel `MARATHON-WS5 OK`.
- **S6a**: `ui.tours` parses (metadata.ts); in-app engine executes storyboard
  steps against the live DOM; Demo player performs actions itself with visible
  highlight overlays + captions on one Fitting. No sentinel (half-slice).
- **S6b**: Guided player spotlights, waits for the user act, validates via
  step assert, advances; every seed Fitting ships ≥1 tour; Escape exits
  cleanly; Assistant Guide launches by name; Demo on one Fitting + Guided on a
  different one demonstrated. Sentinel `MARATHON-WS6 OK`.
- **S7**: `probe-question` row compiled into live policy (fast local target);
  probe fires on an attended session end (gating/mute per shipped S8);
  questions generated by the local model via ollama-local (request log proves
  base_url localhost, never Anthropic); PostToolUse capture lands D26 records;
  the S8 acceptance checks re-run printing `FINDING n:` lines. Sentinel
  `IMPROVER-PROBE OK`.
- **S8a**: findings doc mapping shadcn/improve patterns onto the Improver
  committed; proposals carry file:line citations + confidence grade; vet pass
  re-reads citations pre-enqueue and drops a deliberately planted false
  positive (log line shown). No sentinel (half-slice).
- **S8b**: reject stores a reason (UI + API); rejected findings suppressed on
  later runs (two runs shown); reconcile mode verifies applied proposals,
  refreshes drifted, retires stale pending (one real run printed). Sentinel
  `MARATHON-WS8 OK`.
- **S9a**: audit doc committed: per-surface findings + before visible-copy
  word counts (script-measured). No sentinel (half-slice).
- **S9b**: core surfaces redesigned per taste system (copy cut, affordances,
  hierarchy); typecheck/lint/tests green. No sentinel (half-slice).
- **S9c**: fitting views + WS3–WS6 surfaces swept; iPad/iPhone narrow-viewport
  checks pass on main surfaces; ALL storyboards + tours pass on the redesigned
  UI; after word-counts committed showing clear reduction. Sentinel
  `MARATHON-WS9 OK`.

## Sizing (100-point scale)

S0:4 · S1:6 · S2a1:7 · S2a2:7 · S2b:8 · S2c:7 · S2d:4 · S3:7 · S4:6 · S5a:7 ·
S5b:7 · S6a:8 · S6b:7 · S7:7 · S8a:6 · S8b:6 · S9a:5 · S9b:8 · S9c:8.
None exceed 8 (5.8 rule satisfied). Total ≈ 125 points — a genuine marathon;
the governor + ledger make it resumable across windows.

## Critical files (recurring)

`fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs`,
`fittings/seed/orchestrator/lib/stage-b.mjs`,
`packages/claude-pty/src/{runtime-bridge,runtime-adapter,multi-runtime-pool}.mjs`,
`src/lib/{metadata,library,compositions,runner,fitting-files,primitive-state,
global-composition,provenance,quarters*}.ts`, `src/components/{AppShell,compose/*,
quarters/*,FittingEditor}.tsx`, `fittings/seed/improver/{improver.mjs,server.mjs,
lib/*,ui/*}`, `fittings/seed/mcp-gateway/scripts/{gateway,tools}.mjs`,
`data/library.json`, `.walkthrough/*`, `docs/autothing/runs/<runId>/*`.

## Verification per slice (standing)

Deterministic wall (typecheck/lint/greps + gitleaks/semgrep/dep-audit) →
committed test (e2e-through-UI for ui/mixed; committed driver otherwise) →
fresh-context review → codex slice pass (build profile: every slice; isolated
CODEX_HOME, serialized) → independent adversarial test (ui/mixed) → design
audit (ui/mixed) → walkthrough evidence (ui/mixed; asciinema for api) →
gate-status.json + evidence-index upsert → commit + sentinel + ledger append.
