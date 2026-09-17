# E1/E2 findings (exp-router, 2026-07-10)

## Load-bearing surprises
1. TWO routing schemas. LIVE v4: `fittings/seed/model-router/config/routing.seed.json`
   compiled by `lib/routing-core.mjs` (matrix/exceptions -> ROLE
   [expert|standard|fast|image|video|review]; profile = roleMap role->target +
   disciplineOverrides). LEGACY: fitting-root `routing.json` +
   `src/lib/model-router.ts` (profiles ARRAY, matrix -> targetId directly, pool
   block) still consumed by `src/app/api/automations/plan/route.ts`,
   `src/app/api/automations/vision/route.ts`, `scripts/check-routing.mjs`.
   NOT interchangeable. Live editable config: `<composition>/.garrison/routing.json`
   (server PUT writes; runner reads; seeded from routing.seed.json), all v4.
2. NO `~/.garrison/parked/` dir. "Parked" = in-repo under fittings/seed/,
   de-listed from data/library.json (soul-* already de-listed;
   garrison-orchestrator still listed at library.json:165 - S2 must de-list it).

## E1 essentials
- v4 top keys: version, activeProfile, roles, taskTypes
  [code review research image video writing ops other], tiers [T0/T1/T2],
  tierDefinitions, exceptions[{id,when,role}] (ordered first-match),
  matrix {defaults, columns{tier:role}, rows{taskType:{default,cells{tier:role}}}}
  (cell > row-default > column-default > global-default),
  discipline per-tier {review,testing,evidence,distribution}, continuations,
  targets[{id,type:runtime-target|secondary|workflow,runtime,provider,model,effort,pinned?}]
  (cc-opus-high, sec-gemini, sec-codex, pinned classifier haiku),
  profiles{balanced,economy,premium:{preRoute:"on",roleMap,disciplineOverrides}}.
- Compiler: routing-core.mjs compileRouting(config,profile) -> byte-stable md,
  marker `<!-- garrison:routing v1 profile=<name> -->`; discipline lines annotate
  autothing verb-skills. Pure; dynamic-imported by runner (never bundled).
- Runner: assembleSystemPrompt (runner.ts:746) = [soul.md identity, "",
  orchestratorRouted] -> `.garrison/assembled-system-prompt.md`;
  subs {{capabilities}} (8KB cap) then {{routing}} (:825);
  resolveRoutingSection (:835): comp-scoped .garrison/routing.json else seed;
  merges auto-derived runtime targets (:860). souls.ts:85 re-injects per soul.
  Gateway handoff: env GARRISON_SYSTEM_PROMPT_PATH -> gateway-pty.mjs:43
  --append-system-prompt-file; souls mode -> GARRISON_SOULS_CONFIG.
- Server: scripts/server.mjs, port 7087, GET/PUT /routing (PUT ?baseline=sha,
  409 conflict, 422 invalid, whole-doc write), POST /simulate (manual pure /
  prompt live haiku via @garrison/claude-pty pool), GET /telemetry
  (decisions.jsonl last50). configPath: MODEL_ROUTER_CONFIG ->
  $GARRISON_COMPOSITION_DIR/.garrison/routing.json -> ~/.garrison/model-router/.
  UI ui/main.tsx: tabs Policy/Simulator/Compiled/Telemetry.
- Ports (defaults, no existing collisions; 7078/7080/7081 free): monitor 7077,
  screen-share 7079, outpost-tailscale-host UI 7082, web-channel 7083,
  browser 7084 (+CDP 9222), voice 7085, dev-env 7086, model-router 7087,
  improver 7088, kanban-loop 7089, automations 7090, file-browser 7091,
  coord-agentmail 8765, gateway 4777. NEW briefed defaults: Ports 7088 and
  Power 7090 collide with improver/automations; Outposts reuses 7082 (D26).
  findFreePort walks preferred..+50. Status file ~/.garrison/ui-fittings/<id>.json
  {fittingId,port,url,pid,startedAt}; spawn records ui-fittings/spawn/<id>.json.

## E2 essentials
- garrison-orchestrator prompt (fittings/seed/garrison-orchestrator/.apm/prompts/
  garrison-orchestrator.prompt.md): delegating orchestrator; Souls list
  (engineer/architect/assistant/researcher/companion); route via talk_to
  (fire-and-acknowledge; wait_for only when dependent); tone "-> engineer";
  surface awareness: turn prefix `[origin: ui-tab|channel, channel: main]`,
  spawn mode by origin (ui-tab->interactive TUI, channel->headless stream-JSON);
  worktrees: list_worktrees->reuse else create_worktree->talk_to(worktree_id);
  close_worktree merge->gh pr create (no auto-merge); classify_tier before
  project work -> tier_hint; reply contract ONLY [orchestrator-active].
  MCP tools: talk_to, wait_for, list_active_sessions, end_session, list_workdirs,
  list_worktrees, create_worktree, close_worktree, classify_tier.
- model-router prompt: gateway pre-picks model ("do not pick your own model");
  {{routing}}; discipline->autothing verb-skill map; secondary:<runtime> ->
  delegate bridge tool; reply contract BOTH tokens:
  `[route: <target-id> | rule: <rule-id> | profile: <name>]` + `[orchestrator-active]`.
- modes fitting modes.json: defaultMode gary; modes gary/joe/james
  {soulRef,label,faculties,runtime,routingBias}; channelDefaults
  {dev-env:joe, slack:gary, web:gary, default:gary}; switching
  {byNameAtStart,sticky,autoInfer:"shy",switchLog:.garrison/switch-log.jsonl};
  routingBias {standard-toward-fast:{floor:fast,prefer:fast}, expert:{floor:
  expert,prefer:expert}, expert-then-standard:{floor:standard,prefer:expert}}
  applied via biasRole/modeBiasFor AFTER resolveRole (never image/video/review).
  Shared voice voice/shared-voice.md: conversational prose, no bullets in
  conversation, no em dashes, no flattery openers; souls add stance.
- soul.prompt.md: persona "Verity"; runner's actual identity read from
  compositions/<id>/.garrison/prompts/soul.md (runner.ts:757).
- soul-* fittings (architect/engineer/assistant/researcher/companion + soul):
  faculty:skills (parser-rejected), de-listed (grep soul- library.json = 0);
  predate modes. Remain parked by convention.
- Turn header builder: fittings/seed/http-gateway/scripts/lib/orchestrator-prefix.mjs
  buildOrchestratorTurn: `[origin:…, channel:…, mode:…]` + optional
  `[gateway-route (honored hint) — task:…, tier:…, role:…, target:…, model:…]`
  + sub-session summaries + message. preRoute: gateway.mjs:520 resolveSoulsHint
  -> pure resolveRoute.
- RC3 projectOrchestrator -> ~/.claude/rules/garrison-orchestrator.md exists,
  NOT called by up() (dormant).
