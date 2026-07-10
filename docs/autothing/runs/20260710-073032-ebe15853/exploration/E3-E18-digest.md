# E3-E18 exploration digest (build-time essentials)

## E3 autothing family (~/.claude = claude-share checkout, HEAD d06ab10)
- model:/effort frontmatter to DELETE (D5): plan fable/xhigh; adversarial-review
  fable/xhigh; review fable/xhigh; design-audit fable/xhigh; implement opus/high;
  parallel-work opus/high; project-foundation opus/high; adversarial-test
  sonnet/high; test sonnet/high; validate sonnet/high; codex-checkpoint
  sonnet/medium; walkthrough sonnet/medium; report haiku/low. Top-level
  autothing: none.
- Hooks: goal-stop.sh (sentinel ~/.autothing/sentinels/<sid>.json; regex
  `GLOBAL GATE:.*${RUN_ID}.*videos:[0-9]+/[0-9]+`; blocks until verdict/cap),
  goal-sessionstart.sh (sweep >2d), install.sh (jq settings.json wiring),
  probe.sh. These move into the Garrison seed (D13).
- runDir contract: docs/autothing/runs/<runId>/ {FLOW_PLAN.md, evidence-index.json,
  slices/<s>/gate-status.json}; RUN_LOG.md repo root. gate-status gates{} slots;
  evidence-index globalGate{}. (D19 moves base to ~/.garrison/runs/<project>/<runId>/.)
- codex exec references live in: autothing-codex-checkpoint/{SKILL.md,references/
  codex-checkpoint.md}, autothing/{SKILL.md,references/*.md,assets/*.json}. No
  direct gemini calls anywhere. D14: all must go through codex-runtime bridge.
- Phase-skill seed candidates beyond autothing-*: frontend-design, huashu-design,
  walkthrough, playwright-cli, garrison-browser, ekoa-architecture-audit.

## E17 config home
- ~/.claude IS the claude-share checkout (origin gongiskhan/claude-share). No
  deploy step. .gitignore keeps machine-local runtime off the repo.
- Armory S2: apm install --force in ~/.garrison/global-composition/ (symlink
  .claude -> ~/.claude) writes skills into ~/.claude/skills/<name>, recorded in
  global apm.lock.yaml deployed_files (sha256). owned = path in lock.
  global-composition DOES NOT EXIST on this box yet -> S8 exercises it first
  time. Everything in ~/.claude currently "loose".
- Skill fitting shape: type: skill, includes: auto, component_shape: skill,
  payload at <fitting>/.apm/skills/<name>/ (see fittings/seed/basic-memory).

## E4 kanban-loop
- Board v2, 13 lists, seedBoard() in scripts/kanban.mjs:32-148 + on-disk
  ~/.garrison/kanban-loop/board.json. Per-list skill/taskType/tier/mode config
  = the D15 kill target. Engine already sends classification=null
  (engine.mjs:347,700; gateway-client.mjs:89); apm.yml summary/for_consumers
  stale (describe {taskType,tier} hint). ui/api.ts:139 keeps inert fields.
- Lists: backlog,todo,discuss(james),plan(autothing-plan),implement,review,
  adversarial-review,test(batched,beatCron 0 */5 * * *),adversarial-test,
  walkthrough(requiresEvidence),validate,done,needs-attention(notifyOnEntry).
  validNext edges incl loop-backs to implement.
- Dispatch: POST gateway /chat/stream {channel:"kanban",message,classification:
  null,skill,suppressContinuations,timeoutMs:25m}; transport-error -> revert
  acquire; verdict = last bare validNext token; nudge retry; requiresEvidence
  disk gate. Batched: /chat roster, parseBatchVerdicts per-card token.
- Store: cards/<ulid>/card.json {id,title,description,project,list,status,
  iterations,rev,cost,goalMode,acceptance,events(60cap),lastReply,runningSince,
  runId,runDir,sliceId,sessionIds,briefPath,videoUrl,created,updated} + CAS rev
  + O_EXCL lock; membership derived. cards/ EMPTY now (no migration burden -
  record it).
- Server 7089: /health /board /board/runtime /lists PATCH /lists/:id /projects
  /skills POST /cards GET|PATCH|DELETE /cards/:id /cards/:id/start
  /infer-project /brief /watch(SSE) /artifact GET/PUT. UI: 5s poll, button
  moves (no dnd), MoveSheet, ListConfigSheet, no locking (CAS only).
- Tick external: scheduler jobs kanban-tick */2min --tick; kanban-test-beat
  0 */5h --tick-list test. Gateway-down -> skip (wait, not park).

## E15 improver
- Live fitting = improver (port 7088). Proposals: files ~/.garrison/improver/
  proposals/<id>.json + review-queue.json; shape {id,rule,targetClass,claim,
  evidence,diff,decision,applyVia,at}. UI/API: POST /api/run-now, GET
  /api/queue, POST /api/proposals/:id/apply|reject, autonomy state machine
  (manual->promotion-suggested after 5 accepts; never auto by default).
- FRICTION LOG NOT READ TODAY (no reader exists) - D38 adds it. Signals today:
  skill-telemetry (transcript scan), MEMORY.md, vault dream.
- Nightly: scheduler job improver-nightly 30 3 * * * -> improver.mjs run-now.

## E5 runtimes
- RuntimeAdapter (packages/claude-pty/src/runtime-adapter.mjs): duck-typed
  [spawn,awaitReady,sendTurn,awaitResponse,setModel,setEffort,resume,teardown].
- Delegate bridge: ONE tool delegate(task_spec)->{summary,artifacts}; core
  packages/claude-pty/src/runtime-bridge.mjs; per-runtime scripts/bridge.mjs
  CLI (stdin task_spec, --probe); gateway in-process runSecondaryTurn/
  runAgentSdkTurn (http-gateway/scripts/lib/gateway-routing.mjs:273,395).
- codex-runtime: codex exec [-c model=..] --cd .. --skip-git-repo-check - ;
  stdin prompt; ChatGPT OAuth ambient (~/.codex/auth.json) or OPENAI_API_KEY;
  NOTE gateway path can't override model on ChatGPT account. OAuth
  SERIALIZATION NOT ENFORCED ANYWHERE today -> D14 builds it into the fitting
  (file lock). gemini-runtime: --approval-mode yolo --skip-trust, artifacts
  scraped. agent-sdk FENCE: lib/fence.mjs default-deny Anthropic base URL -
  DO NOT TOUCH. claude-code-runtime: provides {kind:runtime,name:claude-code},
  adapter = ClaudeCodeAdapter in claude-pty.
- mcp-gateway garrison-control tools: classify_tier,run_tests,list_automations,
  run_automation,talk_to,wait_for,list_active_sessions,end_session,
  list_workdirs,list_worktrees,create_worktree,get_worktree,close_worktree
  (stdio mcp.json <composition>/.garrison/mcp.json).

## E6 gateway/surfaces
- preRoute: gateway-routing.mjs RoutedGateway.preRoute:482 (classify:454 -
  keyword shortcut else warm haiku classifier GARRISON_CLASSIFIER_MODEL;
  explicit {taskType,tier} hint honored only if valid). Output {taskType,tier,
  matchedException}. Decision log .garrison/decisions.jsonl. Stage B:
  agent-sdk|secondary|applySwitch(slash-inject or respawn-resume).
- Modes: gateway.mjs modeByChannel map:509 + lib/mode-resolver.mjs:33
  (leading-name explicit sticky; session-start channel default dev-env->joe,
  slack/web->gary); switch-log JSONL. Souls respawn via stage-b.mjs:83.
- Origin: X-Garrison-Origin header (ui-tab|channel; default channel);
  prefix text built by lib/orchestrator-prefix.mjs:29
  `[origin: .., channel: ..[, mode: ..]]` + optional [gateway-route ...] hint.
- web-channel server.mjs: proxy to gateway; POST /api/chat ->
  /chat/stream {message,channel:"web",context,mode,classification verbatim}.
- dev-env spawn: scripts/ptys.mjs claudeCommand:163 + ensurePty:403;
  orchestrated path server.mjs handleCreateSession:582 ->
  placeViaOrchestrator:544 -> Next /api/orchestrator/place ->
  placeOrchestratedSession -> {mode,promptPath,model,effort}; orchestrated
  spawn = claude --permission-mode auto [--model X] --append-system-prompt-file
  <mode prompt> --append-system-prompt-file <browser-pane.md>. Raw default =
  same minus mode prompt/model. D22 flips default to orchestrated.

## E7 outposts
- Protocol daemon scripts/outpost-host.mjs port 3702 (running, pid file
  ~/.garrison/outpost-host.pid). HTTP: /health /outposts POST /registry/register
  DELETE /registry/:name POST /outposts/:name/rpc {type,payload} (blocking,
  10s). RPC verbs: exec.run fs.read fs.write fs.list fs.delete process.spawn/
  send_input/resize/kill. WS reverse-dial ws://host:3702/bridge (Mac dials in);
  auth = shared bearer token + machine_name match; registry
  ~/.garrison/outpost-registry.json 0600 {outposts:[{name,token,registeredAt}]}
  - ABSENT on this box (0 outposts). Heartbeat in-memory only (lastHeartbeat);
  event ring 50 in-memory; NO invocation log (build); NO pairing mint (build);
  installer EXISTS scripts/bootstrap-outpost.sh (env GARRISON_HOST+TOKEN,
  clones garrison-outpost-bridge, launchd agent io.garrison.outpost - correct
  for Mac targets); NO checkout registry (feature-detect stays false).
- Consumers: outpost-actions/scripts/outpost.py, vault-sync/scripts/sync.py,
  src/lib/outpost-rpc.ts, outpost-tailscale-host UI (7082, register form,
  5s poll; not currently running).

## E8 monitor: SSE /api/entities/stream 1Hz server-side snapshot broadcast
  (MONITOR_POLL_MS); vitals = add fields to snapshot payload or /api/vitals in
  same poll loop; UI App() ui/main.tsx:311 header+grid+drilldown.

## E9 browser: POST /tabs {url} -> {tabId}; POST /tabs/:id/nav {url}; tabId =
  CDP targetId; status file has cdp endpoints; port 7084.

## E10 vault: materializeEnv(compositionDir) -> <dir>/.env 0600 (runner up step
  2); scopedSecrets via x-garrison.secret_scope; audit ~/.garrison/
  vault-audit.jsonl. THIS BOX: keyfile ~/.garrison/vault-master.key (no
  secret-tool); data/vault.json decrypts but EMPTY (0 secrets); Mac-sealed
  backup UNRECOVERABLE here.

## E11 headless gaps
- (b) src/app/api/library/open/route.ts:25 spawn("open") no platform branch ->
  xdg-open switch (mirror browser-default server.mjs:142-151).
- (c) dev-env scripts/tmux.garrison.conf:50-64 pbcopy bindings -> FOLLOWUP
  (OSC 52 design call).
- (a/not-gap) scripts/bootstrap-outpost.sh launchd: runs ON Mac outposts by
  design (outposts are Macs) - correct as-is; S9 reuses.
- (b, low) scripts/spike/codex-review-batch.sh:6 + scripts/
  test-screen-share-close.mjs:6 hardcoded /Users/ dev-only paths.
- (b, doc) screen-share-default/apm.yml:15,51 stale "macOS only" wording.
- Clean: keychain.ts, browser-default open, screen-share capture, scheduler
  launchers, no osascript anywhere.

## E12 sessions state: ~/.garrison/sessions/state.json {version,projects{path:
  {sessions{sid:{lastStatus working|waiting|idle|starting|errored|dead|stale,
  lastStatusAt,lastHookEvent}}}}; hooks UserPromptSubmit/PostToolUse->working,
  Stop->idle, Notification->waiting via curl POST 127.0.0.1:7086/_hook;
  60s working->idle fallback. BUSY = lastStatus=="working".

## E14 heartbeat spots: src/components/chrome/AppShell.tsx (always-mounted,
  "use client"); dev-env ui/main.tsx App():881 (poll pattern at 941); web-
  channel ui/main.tsx App():672 (mount sibling <Heartbeat/> or first useEffect).

## E16 report serving: ~/.claude/skills/autothing-report/scripts/serve.mjs -
  port 8091, root ~/.autothing/report (symlinks per run), binds 0.0.0.0,
  self-daemonizing, status ~/.autothing/report-serve.json. NOT running on this
  box. Tailscale IP 100.88.165.46. Walkthrough gallery separate: walkthrough/
  scripts/serve.mjs port 8099.

## E18 dnd: none in tree. Adopt @dnd-kit/core + @dnd-kit/sortable (MIT,
  PointerSensor/TouchSensor, ~30-40KB for a board).

## E13 (from lead): metadata SA token lacks compute scope
  (ACCESS_TOKEN_SCOPE_INSUFFICIENT on instances.get AND testIamPermissions).
  Instance dev-madrid, zone europe-southwest1-a, project spatial-tempo-488909-s5.
  D37 -> S13/S14 suspend acceptance blocked externally.
