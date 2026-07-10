# FLOW_PLAN — GARRISON-UNIFY-V1 (run 20260710-073032-ebe15853)

Profile: **build** (16 slices). gatesConfig: all true. Spec: `RUN_SPEC.md`.
Exploration digests: `exploration/E1-E2-router-prompts.md`, `exploration/E3-E18-digest.md`.
Brief decisions D1–D39 are binding; acceptance items 1–18 verbatim from the brief.

Dependency order (D39): S1 → {S2, S3, S4, S8} → S5(S1,S4,S8) → S6(S4,S5) → S7(S2);
S9–S14 disjoint fittings, buildable after exploration; S15, S16 late.
Gate runs serialize (one dev-serve / build / recorder; codex calls serial run-wide).

| id | title | kind | group | status |
|----|-------|------|-------|--------|
| S1 | Policy core | api | A | passed |
| S8 | Config home (claude-share import + garrison config) | api | B | passed |
| S2 | Brain merge (orchestrator fitting absorbs model-router) | api | B | passed |
| S4 | Run engine (kanban engine = THE run engine) | mixed | B | passed |
| S3 | Composer view | ui | C | pending |
| S5 | Thin doorway (autothing rewrite) | api | C | pending |
| S6 | Evidence home (~/.garrison/runs/) | api | C | pending |
| S7 | Surfaces (dev-env orchestrated default; web-channel toggle) | mixed | C | pending |
| S9 | Outposts (UI, heartbeat, log, pairing, provisioning, affinity) | mixed | D | pending |
| S10 | Monitor vitals panel | ui | D | pending |
| S11 | Ports fitting | mixed | D | pending |
| S12 | Snapshots fitting | mixed | D | pending |
| S13 | Power core | mixed | D | pending |
| S14 | Power guards (presence heartbeats, SSH/load signals) | mixed | D | pending |
| S15 | Improver policy proposals + ghost edits | mixed | E | pending |
| S16 | Headless-gap fixes | api | E | pending |

## S1 — Policy core (api)
Extend the LIVE v4 routing path (fittings/seed/model-router/lib/routing-core.mjs
+ config/routing.seed.json + composition-scoped .garrison/routing.json):
- taskTypes += plan, implement, adversarial-review, test, adversarial-test,
  design-audit, walkthrough, validate, codex-checkpoint, report (review exists;
  general kinds code/research/writing/image/video/ops/other stay).
- New policy sections: `phases[]` (pipeline order), `phasePlans{}` (ordered
  subset, per-phase on/off, evidence kind video|logs|text|none), `workKinds{}`
  (docs-change: implement only/text; api-change: implement+test/logs;
  video-edit: implement/logs; full-feature: every phase — default),
  `phaseSkills{}` registry (phase → skill, per-kind overrides), matrix cells
  for every new taskType × tier (seeds: implement×T2=opus-high native;
  test,walkthrough=sonnet-medium; report=haiku-low; adversarial gates=
  high-effort native (fable-tier where the vocabulary allows); codex-checkpoint
  = codex runtime target gpt-5.5 high), `computeLadder` (ordered target ids
  fast→expert) so modes routingBias {floor,prefer} behavior survives the
  role-layer collapse (behavior-preserving reimplementation, logged).
- compilePolicy(config) → `~/.garrison/orchestrator/policy.json` (atomic write
  via existing helper pattern, byte-stable key ordering) on every PUT and at
  composition start (runner up hook). No HTTP in the hot path.
- Bindable-skill contract doc (one short md, D3).
- Vocabulary extensible from the view: adding a work kind or task type = config
  only, no code change.
Acceptance: policy.json compiles atomically + byte-stable; contract doc exists;
seeded defaults mirror today's effective behavior; vitest covers compile,
validation, extensibility, ladder bias. Print ORCHESTRATOR_POLICY_OK.

## S8 — Config home (api)
- Import ~/.claude tracked content (verbatim first): autothing family →
  fittings/seed/autothing-skills/ (skill-shape fitting, .apm/skills/<name>/
  payloads); goal-loop hooks + settings fragments + commands + agents +
  templates + mcp.json → fittings/seed/claude-config/ (or owning fitting).
- Materialize ~/.garrison/global-composition/ (first exercise on this box);
  apm install through the .claude symlink → ~/.claude/skills under lockfile
  ownership.
- `garrison config` CLI (status | pull | commit) + small shell-UI affordance;
  breadcrumb README in ~/.claude naming the command.
- Decommission claude-share: pointer README pushed, `gh repo archive`.
Acceptance: item 11 (archived push fails; drift status/commit works).
Print CONFIG_HOME_OK.

## S2 — Brain merge (api)
- Rename fittings/seed/model-router → fittings/seed/orchestrator (display name
  Orchestrator); keep faculty singleton, preRoute, policy store, compile,
  injection, own-port server on 7087. One-shot migration of config/state paths
  (~/.garrison/model-router → ~/.garrison/orchestrator, ui-fittings status file
  id, library.json entry, composition selections, decisions.jsonl location);
  update legacy consumers (src/lib/model-router.ts findRoutingConfigPath,
  automations plan/vision routes, scripts/check-routing.mjs).
- Merged prompt (D7): model-router prompt (routing duties + both reply tokens)
  + garrison-orchestrator worktree flow/surface awareness/delegation tone +
  autothing doctrine as "Autonomous work" section + memory/PA/Improver duties
  preserved. Exactly one prompt body holds orchestration doctrine.
- preRoute autonomy axis (D8): {taskType, tier, execution:interactive|
  autonomous}. Deterministic first (channel kanban/scheduler → autonomous;
  explicit marker → autonomous; multi-step cross-app automation shape →
  autonomous), else classifier; Gary-mode conversation floors interactive.
  Autonomous+significant → create card in Plan via board API, reply card link.
  Autonomous automation → automation-runner + card for visibility.
- Park garrison-orchestrator (de-list from library.json); soul-* stay parked.
Acceptance: items 9 (partial), 10. Print ORCHESTRATOR_MERGED_OK.

## S4 — Run engine (mixed)
- kanban-loop lib/engine.mjs generalized to a library callable by the board
  tick AND in-process by a session (D13). A run is a card.
- Phase progression = list transition + REQUIRES the phase's gate-status entry
  in the runDir (missing evidence → park needs-attention).
- Per-list skill/taskType/tier/effort/mode config REMOVED (seedBoard, board.json
  migration, PATCH /lists, UI); a list maps to a phase name only; resolution
  from compiled policy. Delete the dead drift (stale apm.yml wording, inert
  ui/api.ts fields). Test batching preserved as list mechanics (batched prop).
- Locked autonomous lists (Plan onward): UI + API reject manual moves/edits;
  needs-attention is the human touchpoint (edit, resolve, re-enter).
- Per-card `phases` override at creation (UI + API), merged over work kind.
- Goal-loop hooks land in the seed (with S8's claude-config import).
- Board store: no live cards exist (cards/ empty) — migration note recorded.
Acceptance: items 4 (shape), 5, 6 foundations. Print RUN_ENGINE_OK.

## S3 — Composer view (ui)
- Rebuild orchestrator fitting UI: targets tray (draggable target cards with
  effort dial), matrix board (task types × tiers; drop on cell/row/col header),
  work-kind rails (phase chips: reorder, tap-toggle off — dimmed never hidden,
  inspector bottom-sheet for skill swap/override/evidence kind), try-it strip
  (dry-run resolution chain: kind, tier, execution, full rail with per-chip
  skill/model/effort/runtime).
- @dnd-kit (MIT; PointerSensor+TouchSensor) — the one new dnd dep (E18).
- Persistence: whole-document PUT + baselineSha (409 conflict) → recompile
  policy.json. Genuinely usable on iPhone over tailnet.
Acceptance: items 1, 2 (view side). Print COMPOSER_VIEW_OK.

## S5 — Thin doorway (api)
- Rewrite imported autothing SKILL.md as doorway: read policy (D5 exact error:
  "Garrison Orchestrator policy not found at ~/.garrison/orchestrator/policy.json.
  Start Garrison; autothing does not run standalone."), register card in Plan
  via board API (brief + phase toggles from flags), drive run in-session via
  the engine library, card updated as gates pass. Doctrine text removed (lives
  in merged prompt).
- Verb skills: delete model: frontmatter, add policy-read preamble; keep
  recipes; they seed the phase-skill registry.
- codex-checkpoint through codex-runtime delegate bridge (task spec via stdin);
  target from policy codex-checkpoint cell; serialization (run-wide one-at-a-
  time file lock) built INTO codex-runtime; bridge absent → named blocker, no
  CLI fallback. All direct codex exec / gemini invocations removed from skills.
- Deploy edited fitting → ~/.claude/skills via the S8 Armory path.
Acceptance: items 3, 7. Print AUTOTHING_THIN_OK.

## S6 — Evidence home (api)
- runDir → ~/.garrison/runs/<project>/<runId>/ in: engine minting, phase
  skills, report gathering. Repo keeps only work products + committed tests.
- Serve ~/.garrison/runs/ over tailnet via autothing-report's serve.mjs
  mechanism (port 8091 root extension or sibling); cards + final report link
  URLs; prune keeps videos/logs for newest 20 runs/project or 30 days
  (whichever retains more), JSON kept indefinitely; report gathers every
  evidence link incl. phases off and why.
Acceptance: item 8. Print EVIDENCE_HOME_OK.

## S7 — Surfaces (mixed)
- dev-env default spawn = orchestrated path; plain session behind one labeled
  action ("plain claude, for debugging Garrison itself"), logged when used.
- web-channel composer Autonomous toggle → explicit autonomous marker (D8);
  reply carries card link.
Acceptance: items 4 (web start), 9 (dev-env default). Print SURFACES_OK.

## S9 — Outposts (mixed)
- Extend outpost-tailscale-host UI (port 7082): per-outpost card (name, tailnet
  host, online via 15s heartbeat + latency, agent version, last seen, verbs,
  last 20 log entries, active runs); actions ping now / run command inline /
  remove. Host daemon: invocation log ~/.garrison/outposts/log/<day>.jsonl
  (atomic appends: verb, outpost, caller, ts, result); pairing-token mint +
  one-line installer endpoint (BUILD — E7 shows none; FILES-FIT-V2 rule
  satisfied by building once here, reusing existing bootstrap-outpost.sh);
  SSH provisioning flow (tailnet host + user → idempotent install, steps
  streamed to UI); checkout-registry feature-detect (absent → hidden).
- Card outpost affinity (D27): card.outpost at creation; engine dispatches
  phase sessions there via the outpost protocol; offline → needs-attention
  with reason; outpost card lists active runs.
Acceptance: item 12 (Mac-dependent parts blocked honestly if no Mac reachable).
Print OUTPOSTS_UI_OK.

## S10 — Monitor vitals (ui)
- Vitals in the existing 1Hz snapshot loop / SSE payload (5s refresh cadence
  client-side): CPU load, memory, per-mount disk (warn 85% / crit 95%),
  network throughput, garrison-* systemd user units (Linux only). Uses
  systeminformation (MIT, root dep). Strictly display-only.
Acceptance: item 13. Print MONITOR_VITALS_OK.

## S11 — Ports fitting (mixed)
- New fittings/seed/ports-default, own-port default 7088 (collides with
  improver live — findFreePort governs per brief). ss -tlnpH scan 5s + on
  demand; labels: worktree registry (50000–54999 pool → names) →
  ui-fittings/*.json → pid+cmdline. Loopback badge. Row actions: open tailnet
  URL (hidden for loopback), open in Browser pane (browser-default
  POST /tabs/:id/nav via status file), copy URL, kill (SIGTERM confirm →
  explicit SIGKILL).
Acceptance: item 14. Print PORTS_OK.

## S12 — Snapshots fitting (mixed)
- New fittings/seed/snapshots-default; restic external binary (verify in
  setup; print install cmd if missing — self-unblock apt/brew once); GCS
  backend gs:<bucket>:/garrison; secrets via Vault (secret_scope) with 0600
  ~/.garrison/snapshots/env fallback + FOLLOWUP (timer context). Backup set
  ~/.garrison, ~/.claude, projects_root; excludes node_modules, apm_modules,
  .cache, Files trash. systemd user timer garrison-snapshots.timer daily
  03:00 + weekly forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6
  --prune. Embedded sidebar-surface view (registry): last snapshot, size,
  result, restic snapshots --json list, Snapshot now + Verify buttons,
  printed restore command (no in-UI restore).
- GCS claim check (operator identity) — no credentials → GCS acceptance
  blocked with exact failed command; fitting proven against local repo.
Acceptance: item 15 (GCS parts conditional). Print SNAPSHOTS_OK.

## S13 — Power core (mixed)
- New fittings/seed/power-default, own-port default 7090 (collides with
  automations live — findFreePort governs). Server hosts idle watcher +
  mobile-first UI: state, live countdown, Suspend Now, Keep Awake (1/4/8h),
  per-signal live values, awake-hours today + 7d from log, settings (idle
  threshold, load threshold), optional power_page_url display (never logged).
- Busy signals (D33): dev-env badge working; in-flight card lanes; presence
  heartbeat within window; SSH tty active (w -h; idle attached ≠ busy); 1-min
  load > threshold (1.0); Keep Awake. Eval error = busy. Suspend only after
  idle_minutes (30) continuous clear.
- Self-suspend: REST instances.suspend with metadata token (E13: BLOCKED —
  scope missing; watcher + log + warning + sync built and demonstrated up to
  the call; the call itself and lived suspend acceptance end blocked per D37).
- State: ~/.garrison/power/log.jsonl (atomic appends), keep-awake.json
  (atomic); resume detection wall-vs-monotonic >2min → resume event + health
  probe of every ui-fittings URL with failures logged.
Acceptance: item 16 (suspend-dependent parts per D37). Print POWER_CORE_OK.

## S14 — Power guards (mixed)
- Presence heartbeat POSTs in Garrison shell (AppShell.tsx), dev-env UI
  (main.tsx App), web-channel UI (main.tsx App): every 60s, only visible +
  input within 5min; composition by URL (read power status file), no shared
  components. SSH + load signals wired; each signal demonstrated blocking in
  isolation.
Acceptance: item 16 signal demos (suspend call per D37). Print POWER_GUARDS_OK.

## S15 — Improver policy proposals (mixed)
- New improver rule(s): read docs/autothing/friction-log.md (reader does not
  exist today) + run outcomes under ~/.garrison/runs (misrouted kinds, phases
  finding nothing, effort vs gate pass rates) → emit orchestrator-policy
  proposals (new work kind / phase-plan edit / matrix cell / skill binding)
  into the existing queue (applyVia PUT /routing with baselineSha). Composer
  renders queue proposals as ghost edits (overlay accept/dismiss). Never
  auto-applied.
Acceptance: item 17. Print IMPROVER_POLICY_OK.

## S16 — Headless-gap fixes (api)
- (b) src/app/api/library/open/route.ts xdg-open switch; spike-script /Users/
  paths; screen-share apm.yml stale wording. (c) tmux pbcopy → FOLLOWUP.
  bootstrap-outpost launchd → reclassified not-a-gap (runs on Mac outposts by
  design), noted. All FINDING-GAP classified per D30.
Acceptance: item 18. Print HEADLESS_GAPS_OK.

## Cross-cutting
- Baseline test failures (pre-existing): autothing-validate ×3 (S5 fixtures),
  z1-end-to-end, browser-observe (diagnose; fix or classify infra with
  evidence). Global gate needs green suite.
- Deliberate-red (once, early): plant a fake secret for gitleaks + a
  policy-validation violation; show red; revert.
- PTY-everywhere: no claude -p, no Agent SDK vs Anthropic endpoint; FENCE
  untouched. New deps: systeminformation + @dnd-kit only. Atomic writes
  everywhere; JSONL atomic appends. No new git branches. No changes outside
  agent-garrison except claude-share README/archive + ~/.claude + ~/.garrison.
