# Phase 0 exploration — E7 (Improver review queue), E14 (garrison-control), improver-probe brief

Run: GARRISON-MARATHON-V1 20260712-173530-81e1c448. Facts only, with file:line citations.

## Q1 — Improver review queue (FINDING-E7)

**Fitting:** `fittings/seed/improver/` — `apm.yml`: `faculty: observability`, `component_shape: script`, `own_port: true`, `provides: automation-runner`. Nightly cron default `30 3 * * *` (`apm.yml:38-41`). Port default is **7093** in `config_schema` (`apm.yml:44-45`) but the prose `summary` says 7088 (`apm.yml:15`) — internal manifest inconsistency.

**Queue storage (paths + format):**
- `~/.garrison/improver/review-queue.json` — single pretty-printed **JSON array** of full proposals (diff included). `QUEUE_FILE` = `scripts/improver.mjs:60`, `scripts/server.mjs:59`; `DATA_DIR` = `IMPROVER_DATA || ~/.garrison/improver` (`improver.mjs:59`). Load/save: `lib/review-queue.mjs:13-25`.
- `~/.garrison/improver/proposals/<id>.json` — each proposal also written individually (`PROPOSALS_DIR`, `improver.mjs:61`; writes at `:277,331,341,355,369,427`).
- Distinct from `~/.garrison/improver/feedback-queue.jsonl` (JSONL) — the probe *input* evidence the nightly `feedback` rule converts into review-queue proposals.

**Proposal schema** (`enqueue`, `lib/review-queue.mjs:28-45`): `id`, `rule`, `targetClass`, `claim`, `diff`, `decision`, `applyVia`, `status` (`"pending"`), `at`. Example values at `lib/feedback-rule.mjs:101-109` (`rule:"feedback"`, `targetClass:"orchestrator/policy"`, `applyVia:"PUT /routing (baselineSha, Orchestrator fitting)"`).
- apply → `markApplied`: adds `status:"applied"`, `appliedAt`, `evidence` (`review-queue.mjs:51-53`).
- reject → `markRejected`: adds `status:"rejected"`, `rejectedAt` (`review-queue.mjs:55-57`).
- reapply-failed → adds `status`, `reapplyFailureReason`, `reapplyFailedAt` (`review-queue.mjs:63-65`).

**Rejection reason: NO.** `markRejected(queue, id, at)` stamps only `status` + `rejectedAt`; no reason field. UI reject posts to `/api/proposals/:id/reject` with no body (`ui/main.tsx:101,119`). The only `*Reason` on a proposal is `reapplyFailureReason` (ecosystem-update clobber path, not a human rejection).

**Propose-then-approve flow:**
- Propose: nightly run or `POST /api/run-now`. `runNow()` `loadQueue → enqueue → saveQueue`; auto-applies only `auto`-autonomy rules; `memory-dream`, `feedback`, orchestrator-policy proposals are never auto-applied (`server.mjs:123-169`).
- API (own-port server, `server.mjs:2-13`): `GET /api/queue` → `{queue, autonomy, promotionThreshold}`; `POST /api/proposals/:id/apply` → `applyWithRetry` (never-clobber baselineSha) → reconcile → markApplied(+evidence); `POST /api/proposals/:id/reject` → markRejected, targets untouched, human reject of an auto rule demotes instantly (`server.mjs:207-223`); `GET/PUT /api/autonomy`, `POST /api/autonomy/promote`, `GET /api/ecosystem-status`.
- UI: `ui/main.tsx` proposal cards, Approve/Reject buttons (`data-testid apply-<id>`/`reject-<id>`), polls `/api/queue` + `/api/ecosystem-status`. Per-rule autonomy manual default; `PROMOTION_THRESHOLD=5`; instant demotion (`lib/improver-core.mjs`, surfaced `review-queue.mjs:82-104`).

## Q2 — garrison-control extensibility (FINDING-E14)

**MCP server = mcp-gateway Fitting:** `fittings/seed/mcp-gateway/scripts/gateway.mjs` (`@modelcontextprotocol/sdk` `Server`; stdio + streamable-HTTP). "garrison-control" = the tool subset forwarding to the http-gateway `/sessions/*` endpoints, gated on `GARRISON_HTTP_GATEWAY_BASE_URL` (`scripts/lib/tools.mjs:148-227`; `isGarrisonControlEnabled` `:187-189`).

**Tools today** (`discoverTools()` `gateway.mjs:39-180`, dispatch `:183-195`):
- Always: `record_improver_feedback` (`gateway.mjs:98-112`).
- If underlying `--probe` passes: `classify_tier` (tier-classifier), `run_tests` (testing).
- If automations own-port up: `list_automations`, `run_automation`.
- garrison-control (http-gateway base URL set): `talk_to`, `wait_for`, `list_active_sessions`, `end_session`, `list_workdirs`.

**Registration — the 3-edit pattern (E13):**
1. `scripts/lib/tools.mjs` — add/export `callXxx()`.
2. `scripts/gateway.mjs` `discoverTools()` — push `{name, description, inputSchema}` (with gating).
3. `scripts/gateway.mjs` `dispatchTool()` — `if (name === "xxx") return callXxx(input);` + import at `:22-36`.

**`record_improver_feedback(session_id, area, question, answer)` already exists** via exactly this pattern: impl `callRecordImproverFeedback` (`tools.mjs:116-134`), descriptor always-on (`gateway.mjs:98-112`), dispatch (`gateway.mjs:186`), import (`gateway.mjs:35`). Appends one D26 record to `~/.garrison/improver/feedback-queue.jsonl` (single O_APPEND); required `area,question,answer`, session_id optional; sets `provenance:"probe"`, `classification:{kind:null,tier:null,plan:null}`. Test: `tests/gateway-record-improver-feedback.test.ts`. Any further new tool touches the same three files.

## Q3 — the "improver-probe brief"

**No standalone "improver-probe brief" / "IMPROVER-PROBE" document exists** anywhere — not repo, `docs/`, `docs/briefs/` (absent), `~/.garrison/`, or `~/ObsidianVault`. Only hits: `tests/improver-probe.test.ts` and `~/.garrison/snapshots/claude-settings.before-improver-probe.json`. The phrase "improver-probe brief" appears on no file. The marathon referencing it is THIS session (`~/.garrison/marathon/ledger.md` = run 20260712-173530-81e1c448, matches session id); the ledger is otherwise empty — the brief is in-context only, not persisted.

**Authoritative on-disk source = shipped slice S8 of GARRISON-FLOW-V2** (`docs/autothing/runs/20260710-171608-7bf26feb/`), decisions D22-D28, merged (commits `777abc6`, `f063136`, `909c1f4`, `e987666`, `fbf5d09`). Mapping to the described brief (`FLOW_PLAN.md:37`, `RUN_SPEC.md:25-27`) + code:
- Sentinel/token: `IMPROVER_PROBE_OK`. Goal sentinels honored: `~/.garrison/sentinels/<sid>.json`, `~/.autothing/sentinels/<sid>.json` (`lib/probe-store.mjs:86-94`).
- Acceptance checks: **FIVE** for the probe, items (17)-(21) (`FLOW_PLAN.md:37`). "Six" likely conflates the SKILLS-rule `FINDING 1..6 + IMPROVER-V1 OK` (`improver.mjs`, `apm.yml:113-115`), a different feature.
- Mute: per-day flag `~/.garrison/improver/probe-mute-YYYY-MM-DD` (`probe-store.mjs:52-54`, `isMutedToday :157`).
- Gating (fail-closed A10): fires only when NOT muted-today AND not-already-probed-this-turn AND attended (`isAttended` dev-env tag, `lib/probe-core.mjs:53-62`) AND real task completed (`taskLooksComplete :69`) AND no goal sentinel (`hasGoalSentinel :44`).
- Schema (D26): `~/.garrison/improver/feedback-queue.jsonl`, atomic O_APPEND; record `{session_id?, area, question, answer, timestamp, provenance}` + probe/retrospective add `options[]`, `classification{kind,tier,plan}`, `card_id` (`buildFeedbackRecord probe-core.mjs:312-328`); `provenance ∈ probe|retrospective|override`; dismissed = `"dismissed"`.
- iPad/iPhone: tappable AskUserQuestion buttons via gateway-pty `/chat/stream` (jsonl parseEvents → tool SSE → ChatEvent tool variant → ClaudeChat buttons); raw JSON never shown (`FLOW_PLAN.md:37`, E14).
- Capture path (A9, `RUN_SPEC.md:25`): PostToolUse AskUserQuestion hook PRIMARY (E12 confirmed); garrison-control `record_improver_feedback` FALLBACK for surfaces without the hook (+ session-JSONL watcher). Same D26 schema/queue either way.

**LIVE-STATE FINDING — Probe is code-complete but currently DEAD.** Live `~/.garrison/orchestrator/policy.json` has NO `probe-question` row (matrix keys: adversarial-review, adversarial-test, code, codex-checkpoint, image, implement, ops, other, plan, report, research, review, test, ux-qa, validate, video, walkthrough, writing; `probe-question` = null). `resolveProbeTarget` throws; `~/.garrison/improver/probe-skip.log` shows repeated 2026-07-12 skips: "policy.matrix has no 'probe-question' row — the probe-question task type is not compiled into the live policy". The S9 fast-target seed (`agent-sdk-haiku-fast`, RUN_SPEC A11) pointing probe-question at it is NOT in the live policy.

## Bonus — non-Anthropic model path

Two surfaces:
1. agent-sdk-runtime provider table (`fittings/seed/agent-sdk-runtime/lib/providers.mjs` `SDK_PROVIDERS`): `anthropic` (baseUrl null, subscription/OAuth), **`ollama-local`** (baseUrl `http://localhost:11434`, dummyToken `"ollama"`, authMode local, `ANTHROPIC_API_KEY=""`), `zai-glm` (`https://api.z.ai/api/anthropic`, api-key), `deepseek` (`https://api.deepseek.com/anthropic`, api-key, text+tools only), `minimax` (`https://api.minimax.io/anthropic`), configurable proxy (baseUrl null → requires explicit `target.baseUrl` else throws, `providers.mjs:124-126`). `providerLaunch` sets `ANTHROPIC_BASE_URL` + token (dummy local / vault key). UI: `src/components/quarters/AgentSDKPanel.tsx`.
2. Legacy souls router (`src/lib/model-router.ts`): `targetTypes` includes `"ollama"` (`:21`) but `honored = enabled!==false && type!=="ollama"` (`:277`) — ollama target NOT honored (mismatch fallback). Surfaces disagree.

Base-URL fence/default-deny removed by S9 (`RUNTIME_FREEDOM_OK`, `FLOW_PLAN.md:14,31`); `claude -p` excluded by choice. Provider base-url swap threaded into orchestrator env (`runner.ts:243`, logged `:306`). `provider_mechanism` schema `base_url_env`/`auth_env`/`model_arg`/`model_env` (`metadata.ts:106-143`).

**Ollama configured/reachable?** Defined/supported (`ollama-local` at `localhost:11434`) but no evidence it is selected in the live composition; legacy souls router does not honor ollama; localhost:11434 not probed for a live daemon. Net: supported, not confirmed configured or reachable.
