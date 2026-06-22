# FLOW_PLAN — Orchestrator as front door (modes · Dev Env · autothing-discipline · Kanban)

Run: 20260622-143110-e93ec4b5 · Repo: agent-garrison · Source design:
`~/.claude/plans/you-are-in-exploration-misty-rabbit.md` (approved).

## Decisions (autonomous, encoded — reversible)
- Full arc incl. **Kanban Loop V1a**. Dev Env = orchestrator **places at birth** then hands off.
- Front door = **model-router + http-gateway** (the default composition already selects both).
- Pool-collapse = **assume current reality** (pool already monolithic; `/model`+`/effort` HOT;
  mode/identity switch by **respawn-resume**). No `/config` spike — record the gap honestly.
- New capability kinds **`modes`** + **`automation-runner`** (Honesty-Test-justified).
- switch-log → `<comp>/.garrison/switch-log.jsonl`; kanban board → `~/.garrison/kanban-loop/`.
- mode→bias = pure `applyModeBias()` in routing-core, called gateway-side (router stays pure).
- model-router stays the default orchestrator (already true in `compositions/default/apm.yml`).
- Kanban §9 (1–5) accepted; each agent-list maps to an explicit `{taskType,tier}`.
- Adversarial = cross-model **Codex** (`sec-codex`) at high effort, no new skills.

## Objective gates (every slice)
Committed **vitest** spec under `tests/*.test.ts` (the dominant gate) and/or the fitting's
`x-garrison.verify` hook, plus `npm run typecheck` + `npm test` clean. New fittings also pass
`tsx scripts/validate-fitting.ts fittings/seed/<id>`. Only `s3c` is a UI slice (design-audit +
walkthrough apply); the rest are `mixed` (evidence = the committed test / CLI capture).

## Slices

| Slice | Title | Kind | Route | Group | Status |
|---|---|---|---|---|---|
| s0-truthup | Truth-up: CLAUDE.md projection drift + ensure `{{routing}}`+discipline reach the model-router prompt | mixed | — | A | passed |
| s1a-modes-fitting | New `modes` fitting: souls Gary/Joe/James + shared-voice + modes.json + brief-template + setup/verify | mixed | — | A | passed |
| s1b-modes-capkind | `modes` capability kind + `modes` faculty (automation-runner already existed); register in data/library.json; model-router consumes modes optional-one | mixed | — | — | passed |
| s1c-souls-assembly | `src/lib/souls.ts` assembleSouls + runner.up() builds `GARRISON_SOULS_CONFIG` via spawnGateway extraEnv (gated on mcp-gateway present) | mixed | — | — | passed |
| s1d-mode-resolver | Gateway mode-resolver (name/sticky/channel-default) + switch-log + actionable `[mode:]` delegation (orchestrator `talk_to`). Per-mode model/effort = s1e; full classifier-preRoute-in-orchestrator-mode tracked as a separate follow-up | mixed | — | — | passed |
| s1e-mode-bias | Pure `biasRole`/`modeBiasFor` in routing-core; live in `assembleSouls` → per-mode tier in the orchestrator prompt (Joe expert, James/Gary standard). Programmatic talk_to→model enforcement = the orchestrator-mode↔routing unification follow-up | mixed | — | — | passed (codex override r3) |
| s2-mode-respawn | Mode-switch respawn-resume (shared memory preserved) + assert single generic warm pool; record /config gap | mixed | — | — | pending |
| s3a-sessions-place | Garrison API `POST /api/orchestrator/place` + `orchestrator-placement.ts` (LIVE front door: channel→mode→composed prompt + model). Reframed from gateway `/sessions/place` to a Garrison API to avoid the dormant orchestrator-mode dependency; built ahead of s2 (deliverable #3 priority) | mixed | /api/orchestrator/place | — | passed |
| s3b-devenv-orchestrated | Dev-env orchestrated create + `claudeCommand` parameterization (append mode prompt + browser-pane.md, `--model`) | mixed | — | — | pending |
| s3c-devenv-ui | Dev-env UI "Start orchestrated session" + mode dropdown (default Joe) | ui | dev-env 7086 | — | pending |
| s4-discipline-skills | Discipline→verb-skill mapping in routing-core + orchestrator prompt; ensure garrison-* skills present | mixed | — | — | pending |
| s6a-workflows-launchable | Gateway `runWorkflowTurn` executor so `workflow` targets actually run | mixed | — | B | pending |
| s6b-improver-routed | Improver dream pass routed via preRoute (oneShotTurn fallback retained) | mixed | — | B | pending |
| s5-kanban-v1a | Kanban Loop V1a engine fitting (`automation-runner`): board/cards/ULID/atomic, agent-list runs combined prompt via preRoute, exact-match next-list or needs-attention, goal-mode `/goal`, §9 applied (UI → V1b) | mixed | — | — | pending |

Groups: **A** = {s0, s1a} disjoint (CLAUDE.md + model-router prompt vs new `modes/` dir) →
parallelizable. **B** = {s6a, s6b} disjoint (gateway-routing vs improver) once the seam is solid.
Everything else serializes on shared files (runner.ts / gateway scripts / routing-core.mjs).

## Acceptance (checkable, per slice)
- **s0-truthup** — CLAUDE.md no longer asserts *runtime* projection to `~/.claude/rules/...`
  (states it implemented-but-dormant); `model-router.prompt.md` contains `{{routing}}` +
  `{{capabilities}}`; vitest asserts the assembled prompt for `default` includes a "Routing
  policy" + discipline section; typecheck clean.
- **s1a-modes-fitting** — `validate-fitting fittings/seed/modes` passes 4 checks; `apm.yml` has
  `faculty`, `provides:[{kind:modes}]`, `setup` (mkdir briefs_path), `verify`; files
  `souls/{gary,joe,james}.md`, `voice/shared-voice.md`, `modes.json`, `references/brief-template.md`
  exist; vitest validates `modes.json` (per-mode facultyMap, routingBias, channelDefaults).
- **s1b-modes-capkind** — `capabilityKinds` includes `modes`,`automation-runner`; `modes` in
  `singletonCapabilityKinds`; `data/library.json` has a `modes` entry; resolver test: selecting
  modes resolves a `modes` provider at `optional-one`; `npm test` green.
- **s1c-souls-assembly** — `assembleSouls()` writes `.garrison/souls/{gary,joe,james}.md` each =
  shared-voice + soul + folded `{{capabilities}}` + `{{routing}}`; returns `GARRISON_SOULS_CONFIG`
  matching `gateway.mjs:loadSoulsConfig` shape (`{orchestrator,souls:{"soul-gary",…}}`); `up()`
  passes it via `spawnGateway` extraEnv when a modes provider is present; vitest on shape + shared
  voice present exactly once per soul.
- **s1d-mode-resolver** — `resolveMode({message,channel,currentMode,soulsConfig})` →
  `{mode,trigger,switched}`: name-at-start (sticky), channel default (dev-env→joe, slack→gary),
  shy auto-infer; appends structured entry to `.garrison/switch-log.jsonl`
  (timestamp,channel,prior_mode,chosen_mode,trigger,corrected_from,signals); orchestrator-mode turn
  runs preRoute then routes to the mode's soul session; vitest: explicit_name, sticky across 2
  messages, channel default, switch-log shape.
- **s1e-mode-bias** — `applyModeBias(route,mode,modesConfig)` nudges role (joe→expert floor,
  gary→fast lean, james→expert|standard) without mutating config; gateway calls it post-resolveRoute
  pre-switch; vitest maps each mode→expected role from a baseline route; router config untouched.
- **s2-mode-respawn** — `shouldRespawnForMode` added; respawn `--resume`s the same conversation id
  (or `buildContextCarryover`) so memory persists; vitest: soul change ⇒ respawn-with-resume, no
  change ⇒ none; a test asserts one generic operative pool definition; README records the
  no-`/config`-spike HOT gap (permission/tools/MCP not hot-swapped).
- **s3a-sessions-place** — `POST /sessions/place {channel,cwd,worktreeId,mode?,message?}` resolves
  mode (default joe for dev-env), returns `{soul,promptPath,model,effort,sessionId}`, registers the
  session; unit/integration asserts response shape + default mode=joe for channel=dev-env.
- **s3b-devenv-orchestrated** — `claudeCommand({appendPromptFiles[],model,effort,permissionMode})`
  appends BOTH the mode prompt AND browser-pane.md + passes `--model`; server create path
  (`orchestrated:true`/`mode`) calls `/sessions/place` then spawns the PTY with returned prompt+model
  and stores the gateway sessionId on the record; graceful fallback to bare when no gateway; vitest
  on claudeCommand output (two append files + `--model`) + a fallback test.
- **s3c-devenv-ui** — StartSessionDialog gains an "orchestrated" toggle + mode dropdown default Joe;
  posts `{path,mode,orchestrated:true}`; playwright/component test asserts the POST body; walkthrough
  video shows starting an orchestrated session that comes up in Joe.
- **s4-discipline-skills** — `renderDiscipline` annotates each value with its verb-skill
  (testing→garrison-testing, review→code-review+garrison-design-audit, evidence→run-garrison,
  record→garrison-governance, plan→garrison-planning); orchestrator prompt has a "satisfy discipline"
  section referencing the skills + `/goal`; garrison-* skills present in the composition; vitest: the
  compiled routing section names the skills at the right tiers.
- **s6a-workflows-launchable** — a resolved `workflow` target executes via `runWorkflowTurn`
  (analogous to `runSecondaryTurn`), not a no-op; vitest/integration: a workflow target yields a turn
  result.
- **s6b-improver-routed** — memory-dream gains a routed option through the front door; oneShotTurn
  retained as fallback; vitest covers routed-path selection.
- **s5-kanban-v1a** — `fittings/seed/kanban-loop` with `board.json` + `cards/<ulid>/{card.json,
  log-N.md}`, ULID, atomic writes (reuse `atomic-write.ts`); engine: card→agent-list loads skill,
  sends combined execute+router prompt via preRoute, parses output against the explicit valid-next-list
  set (exact match or needs-attention), moves card; immediate/heartbeat/manual triggers + concurrency
  cap; goal-mode prepends `/goal` + injects FLOW_PLAN acceptance; §9 applied (no per-list effort/model,
  skill explicit, suppress router continuations, no Infer column, adversarial=effort); each agent-list
  → explicit `{taskType,tier}`; `validate-fitting` passes; vitest drives a card Plan→…→Done with a
  mocked router + asserts needs-attention on no-match + iteration-cap breach. UI deferred to V1b.

## Build sequence
s0 ∥ s1a → s1b → s1c → s1d → s1e → s2 → s3a → s3b → s3c → s4 → (s6a ∥ s6b) → s5.
Resume from this file + `slices/<slice>/gate-status.json` + `evidence-index.json` each turn.
