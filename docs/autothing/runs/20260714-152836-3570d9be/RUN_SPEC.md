# RUN_SPEC — GARRISON-CONTINUITY-V1

Run `20260714-152836-3570d9be` · profile **build** · branch `main` (no new branches, no worktrees) · spec written 2026-07-14T15:55Z.

## What / why

Three capabilities, judged by live-fire evidence: (1) **Garrison-owned compaction** — the system, not the runtime, decides when a session compacts: configurable threshold in Quarters (default 60%), safe boundaries only, holds for context-hungry duties; (2) **Continuity** — a done card can be continued into a fresh card carrying a Handoff Packet (completion summary inline + fetchable evidence refs); the web channel behaves as one continuous conversation without being one running session (origins, materialized turns, per-duty summaries, steering, post-done continuation); (3) **the clarity gate** — a clear ask runs, an unclear one goes through discuss in the thread first.

Evidence: two time-lapse videos of real medium tasks + the falsifiable nonce protocol proving the continuation learned a fact only reachable through the handoff.

## Precondition note

The brief requires `GARRISON-MARATHON3 OK`; the actual terminal is `GARRISON-MARATHON3 PARTIAL` (2026-07-13T21:05Z) — implementation complete + gated (24/24 slices, suite green, security clean); the PARTIAL tail is verification exhaustiveness (live-fire sweep, walkthrough videos, voice attended). All machinery this brief builds on (duties, levels, Resolver, bridge events, evidence, Kanban duty surface, garrison-control) shipped. Proceeding with the discrepancy recorded (FINDING-E0).

## Acceptance criteria

The brief's 12 final-gate checks, each printed as a `FINDING n:` line: 1 branch unchanged/one worktree · 2 governor evidence · 3 compaction config in Quarters (default 60, values in composition) · 4 WS1c compaction behavior demo (boundary-only, honored hold + logged deferral, before/after usage, continuation, backstop non-conflict) · 5 telemetry (peak ctx% + compaction records in session evidence) · 6 handoff (packet at done; continuation carries summary inline + on-demand fetch with log; chain index resolves ancestor) · 7 origins (one thread spans task A/steering/completion/continuation with per-duty summaries; no standing conversation session; bounded materialized context; skill-origin parity) · 8 steering (classified decision + reason in routing evidence, visible re-stage, thread confirmation; post-done message → new card) · 9 clarity gate (underspecified → discuss-first with thread Q&A + brief artifact before plan; clear → straight dispatch; reasons in routing evidence) · 10 nonce twice (3 control greps + successor output + fetch log per video) · 11 both videos sha256-indexed, time-lapse with normal-speed key moments (visible Continue click; visible re-stage) · 12 regression (V3 storyboards/tours green, bridge events unbroken).

Terminal line: `GARRISON-CONTINUITY OK` only if all twelve hold, else `GARRISON-CONTINUITY PARTIAL` + blocked list.

## Hard constraints

No new branch/worktrees · compaction never mid-turn/mid-duty (holds absolute until boundary) · nonce integrity (never in code/filenames/commits/memory; control greps before continuation; leak ⇒ regenerate + rerun) · the videos are gating · vault/licenses/terminology/Honesty Test/Improver boundary/migrations-not-resets as V3 · no web-UI regressions (V3 bridge events + Muster/Kanban storyboards stay green).

## Assumptions ledger (decisions taken on Phase 0 evidence)

1. **Native backstop stays at native defaults.** E3: native proactive trigger ≈ window−13k (~83.5% on 200k) or reactive-at-limit on "auto"-window 1M models. Garrison's 60% boundary-only controller stays below it; we do NOT set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=60` (that would make native compact mid-turn at 60%, violating D1/D5 boundary-only + holds). Race guard: watcher skips the Garrison compact for a cycle when a native `compact_boundary` (trigger:auto) lands first.
2. **Context % source of record**: transcript usage parsing (E2: assistant events carry `usage`; jsonl.mjs must stop dropping it) with the statusline screen-scrape `contextPct` as the live cross-check; denominator = the model context window (statusline used_percentage semantics), not the auto-compact window.
3. **/compact through the PTY needs a long timeout**: observed compactions 106–143s vs 45s command default — controller passes timeoutMs ≥ 300s and confirms completion via the transcript `compact_boundary` line.
4. **Steering/handoff writes ride OUTSIDE the card rev**: sidecar files under `cards/<id>/` (steering.md, handoff.json) mirroring the brief.md pattern — mid-run PATCH would fight D16 engine-owned locks and CAS (E8).
5. **Handoff generator hooks at the saveCardCAS choke point** (board.mjs, beside notifyOriginTransition) so every done path (engine, in-session, PATCH, quick) is covered; the engine's landedTerminal branches enrich with run context (E5).
6. **origin_id = generalized originChannel**: extend the existing `originChannel {channel, threadId}` into origin records `{origin_id, transport, address, thread}` persisted under the board root, keeping backward compat; the board itself is an origin with a no-op transport (D8).
7. **Clarity is a Dispatcher output field**, not a duty pick: optional `clarity: clear|needs-discuss` in dispatchSchema (E13 gives exact touch points), consumed at the gateway carding step by flipping targetList plan→discuss; the duty/level/sequence stays on the card.
8. **Discuss-in-thread = duty session + needs-input events**: the kanban gateway-client today drops `tool` SSE events (E6 gap); WS3 wires duty-session questions to the origin (thread messages / card rendering) and replies back through the existing /chat/answer path. The Discuss list stays interactive (never auto-advanced by the tick); the discuss duty session is driven by the origin round-trip, and advance-to-plan is pass-through with notice by default, gate flag for explicit go.
9. **The five lifecycle events close S1c**: created / needs-input / blocked / failed / finished (E6: only created+finished+needs-attention shipped; needs-attention conflates blocked/failed) — emitted from the engine/board seams to the origin router.
10. **Materialized turns replace the shared rolling session for thread turns**: E7 found ONE rolling operative session per gateway shared by all threads (cross-thread bleed by design). Web-channel turns become materialized: Dispatcher + bounded deterministic context assembly (recent thread window, active-card summaries, done one-liners, fetch-on-demand); plain answers run one-shot with assembled context; nothing holds context between messages. The rolling session remains for real working sessions (duty dispatches), where the D1 controller applies.
11. **Evidence task pairs (E12)**: Video 1 (Kanban continuity) = Pair 1: A "dashboard Board panel" → B "self-surfacing needs-attention badge (no clicks)". Video 2 (web channel origin) = Pair 2: A "Improver proposal → Send to board" → B "auto-enqueue for auto-mode rules on the nightly run". Both real backlog (main-app board blindness confirmed; 6 genuinely pending improver proposals), each half 10–15 min, B a strict no-clicks automation of A.
12. **WS4 is augmentation, not a rebuild**: the walkthrough machinery already has per-segment speed (setpts), normal-speed segments, in-page caption overlays, click highlighting, uncapped total length (E10). WS4 adds timestamp-bearing captions, long-horizon knob presets, and a board-event-driven capture helper; proven on a dry run.

## Non-goals

Context-window downsizing (telemetry only) · cross-composition/machine continuity · continuing from mid-states · memory-ingestion changes (E9 documents; protocol works around) · new branches/worktrees/autonomy toggles/validator/vault-crypto work.

## Nonce protocol guardrails (constraint 3)

Nonce format `WORD-4HEX`, generated at WS5 start, never echoed into: repo files, filenames, commit messages, ledger, memory tiers, thread titles. Planted ONLY as an internal decision inside task A's plan evidence. Control greps (repo, ~/ObsidianVault + basic-memory, predecessor evidence) run before task B and captured. E9 risk: the SessionEnd/PreCompact hook captures the LAST ~12 messages (400 chars each) of every session into the vault — the nonce must not appear in the final messages of any session; keep it deep in plan evidence, not in session-final summaries. Off-box vault sync is currently broken (stays local) and distillation is review-gated.
