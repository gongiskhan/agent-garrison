# FLOW_PLAN — GARRISON-CONTINUITY-V1

Run `20260714-152836-3570d9be`. Slices execute in order; each slice = build + committed tests + typecheck + review gate; commits on `main` with a `CONTINUITY-<slice>` trailer. Governor check before each slice + every 20 min; 90% pause; resume from first missing sentinel.

## WS0 — Governor reuse. Sentinel: CONTINUITY-WS0 OK
Verified live (checks 15:28/15:49, 13.8%→19.8%); fresh ledger section open; baseline green (typecheck clean, 2609 tests). Formalize with a ledger line.

## WS1 — Compaction

### S1a — Context telemetry (sentinel CONTINUITY-WS1A OK)
- `packages/claude-pty/src/jsonl.mjs` parseEvents keeps per-assistant-event `usage`; new helper `contextUsageFrom(events)` (last assistant usage sum) + `compactionsFrom(events)` (compact_boundary records {trigger, preTokens, postTokens, durationMs, at}).
- Session context tracker in claude-pty (or gateway lib): per-session peak tokens/pct (window from model metadata / statusline JSON contextPct cross-check).
- Gateway: /chat/stream `done` frame + /claude/status expose {contextPct, peakContextPct, compactions}. Engine records them per duty turn into the duty summary record (S2a dependency ordering handled: engine writes into gate-record `context` field now, folded into duty summaries in WS2).
- Delegate runtimes: agent-sdk + openai-agents include usedTokens in their bridge envelopes (additive field); garrison-call already returns usage. codex/opencode: documented degradation notes in fitting apm.yml/README (codex stateless per turn; opencode usage events dropped by adapter — note only, no behavior change this slice).
- Tests: jsonl usage parsing fixture; compact_boundary fixture; peak tracking unit.

### S1b — Compact controller + Quarters config + holds (sentinel CONTINUITY-WS1B OK)
- Config (composition v4 fitting config, per-runtime): `compact_threshold_pct` (default 60), `compact_enabled` (default on), `compact_focus_template` (D4 default text: preserve card id/title, current duty+level, decisions, open items, files touched, pending steering). Lives on the gateway fitting config (per-runtime map) — editable in Muster/Quarters autosaving config form; values in apm.yml like any fitting config.
- Controller (http-gateway lib/compact-controller.mjs): at TURN boundaries (before dequeuing the next enqueued turn) and DUTY boundaries (engine seam, below): if usage ≥ threshold && !hold && cooldown-clear → inject `/compact <rendered focus template>` with timeoutMs 300s, await transcript compact_boundary, log before/after usage. Cooldown: no re-compact until usage fell below threshold and rose again; never twice within 3 turns. Skip-cycle guard when a native auto compact_boundary already landed. Deferral logging when hold active.
- Holds: duty metadata `context_hold: true` — declared in duty fitting duties block (implement/develop default hold), surfaced through resolver → model.json → engine; hold honored absolutely until the duty boundary.
- Duty-boundary integration: engine processChain between-hop seam + processCard pre-dispatch call the gateway's compact check endpoint (POST /compact/check with card context for the focus template) — compaction happens between duty turns only, never mid-turn.
- Mechanisms per runtime (D3): claude PTY = /compact injection; agent-sdk + openai-agents = summarize-and-rebuild (same focus template → summary call → restart session context with it) at their loop boundaries; codex = documented degradation (stateless — compaction moot); opencode = documented degradation (no compact trigger exposed; adapter-side rebuild noted as future).
- Native backstop: untouched defaults (E3: fires ~83.5%/reactive-at-limit — strictly above 60%).
- Tests: controller decision unit (threshold/hold/cooldown/boundary-only); config schema; template render.

### S1c — Forced-threshold demonstration (sentinel CONTINUITY-WS1C OK)
Temporarily low threshold on a live session; drive past it; capture evidence: boundary-only trigger, deferral under a context_hold duty, compact firing at the boundary, before/after usage log, session continuing correctly. Evidence files under run dir.

## WS2 — Summaries and handoff (sentinel CONTINUITY-WS2 OK)
- Duty summary standard: at every genuine advance the ENGINE writes `<runDir>/duty-summary.<phase>.json` {phase, duty, level, at, summary (from reply), decisions, outputs, context: {peakPct, compactions}} + card event. sessionIds writer fixed (E4 dead field). advanceCardPhase parity.
- Handoff Packet at done: generator at saveCardCAS choke point (edge predicate reuse) composing `cards/<id>/handoff.json` {completionSummary, keyDecisions, filesTouched (from fences/touch-set/git), evidenceManifest [{ref, oneLiner}] (resolveCardLinks vocabulary), chainIndex [{cardId, title, oneLiner}]}. Generated for every card at done.
- `continues: <card_id>` card field; creation: Continue button on done card (kanban UI), POST /cards accepts continues, `create_continuation` tool. Successor starting context: predecessor completionSummary inline + evidenceManifest injected into buildCardPrompt; deeper artifacts pull via `fetch_evidence`.
- mcp-gateway tools `fetch_evidence(card_id, artifact_id)` + `create_continuation(card_id, ...)` (E11 three-touch pattern; board GET /cards/:id/artifact?ref= exists). Fetch logging: board logs artifact fetches per card (the WS5 fetch-log evidence).
- Chain index transitive; fetch reaches ancestors. Document vocabulary vs orchestrator "continuations".
- Tests: packet composition, continues creation paths, fetch tool, chain resolution, prompt injection.

## WS3 — Origins and steering

### S3a — Origin records + event router (sentinel CONTINUITY-WS3A OK)
Origin store (board root `origins/<origin_id>.json` {origin_id, transport, address, thread, createdAt}); cards carry origin_id (originChannel kept in sync for compat); five lifecycle events created/needs-input/blocked/failed/finished emitted at engine/board seams → per-transport router (web=thread message via /api/threads/:id/messages; skill/terminal=tool-message delivery file+garrison-control poll; board=no-op). Per-duty summaries (WS2 artifacts) posted to origin as duty completion messages.

### S3b — Materialized turns + post-done continuation (sentinel CONTINUITY-WS3B OK)
Thread messages stop running on the shared rolling session: a materialized turn = Dispatcher + bounded deterministic context assembly (recent thread window N, active-card summaries, done one-liners, fetch-on-demand) → decides steering / new card / plain answer (quick-question invariant); plain answers one-shot with assembled context; assembly telemetry recorded (bounded proof). Post-done follow-up asking more work → continuation card (continues: auto-set) on the board; thread carries on. Session-table evidence: no standing per-conversation session.

### S3c — Steering (sentinel CONTINUITY-WS3C OK)
Mid-run thread message → Dispatcher classifies absorb/revisit/acknowledge (explicit phrasing short-circuits); steering sidecar `cards/<id>/steering.md` + engine-header re-stage for revisit (card visibly moves back, steering badge); loop checks steering at duty boundaries (processChain between-hop reload + processCard pre-dispatch + advanceCardPhase parity); absorb folds into current duty prompt; classification + reason → routing evidence + short thread confirmation.

### S3d — Clarity gate + discuss-in-thread (sentinel CONTINUITY-WS3D OK)
Dispatcher `clarity` field (editable rubric in its skill); unclear → card created, enters discuss first (targetList discuss); discuss runs as duty session on the card; questions → needs-input events → thread messages (1–3 focused Qs per message) / board card rendering; replies route back (needs-input reply path); brief in house format → card artifact + thread post; advance to plan pass-through with "proceeding, reply to adjust" (gate flag flips to explicit go); phrasing overrides both directions. Kanban gateway-client forwards `tool` events (E6 gap closed).

### S3e — Skill/terminal origin parity (sentinel CONTINUITY-WS3E OK)
A garrison-skill-origin task receives the same lifecycle events + per-duty summaries via tool-message delivery; parity check evidence.

## WS4 — Time-lapse machinery (sentinel CONTINUITY-WS4 OK)
Walkthrough augmentation: timestamp caption overlays (wall-clock in the caption HUD + title cards), long-horizon preset (runTimeoutMs/waitBefore/holdUntil raised; segmented continue-recording pattern), normal-speed windows around flagged moments (existing per-segment speed). Short dry run proves capture+render before WS5.

## WS5 — Live-fire evidence (sentinel CONTINUITY-WS5 OK)
- Nonce 1 + Video 1 (D11, Pair 1): task A "dashboard Board panel" runs through duties on the board (time-lapse 10–20x, normal-speed keys); visible Continue click at done; continuation task B "self-surfacing needs-attention badge"; nonce lands in B's changelog output via fetch; final frame shows chain. Control greps before B.
- Nonce 2 + Video 2 (D12, Pair 2): underspecified thread ask → clarity gate → discuss Q&A in thread → brief → plan; thread/board toggling with per-duty summaries; mid-run steering visibly re-stages; completion; deliberately clear follow-up skips discuss → continuation card; nonce check; post-done new message starts a NEW card.
- Both videos sha256 in evidence-index.json with control-grep transcripts beside them.

## Final gate
Re-print all sentinels; run acceptance checks 1–12 as FINDING n lines; regression (V3 storyboards/tours, bridge events); terminal GARRISON-CONTINUITY OK/PARTIAL.
