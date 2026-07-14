# WS1c forced-threshold demonstration — evidence notes

Setup: compact_threshold_pct temporarily 3 (default 60) on the http-gateway
config in compositions/default/apm.yml; live down/up; operative = Sonnet 5
PTY (routed target cc-sonnet via classification test/T1-standard, which the
resolved model routes to the claude-code operative).

Phase A — hold honored at turn boundaries (compact-log-phaseAB.jsonl):
- 17:15:32Z kind=deferred boundary=turn dutyKey=ws1c-demo:implement beforePct=11
- 17:15:54Z kind=deferred boundary=turn dutyKey=ws1c-demo:implement beforePct=13
Two consecutive held turns over threshold; no compaction fired mid-duty.

Phase B — duty boundary discharges the hold (same log):
- 17:16:12Z boundary=duty beforePct=13 afterPct=0 durationMs=19736,
  focusDigest shows the D4 template rendered with card id/title/duty/level.
- Screen ground truth: statusline ctx 13% -> 0% (rich-stream hello captured);
  session prompt healthy after.
- Logged kind was "compact-unconfirmed": transcript confirmation can never
  fire for PTY operatives (claude 2.1.209 PTY/TUI sessions persist NO
  transcript; the S1a "verified" transcripts were agent-sdk-written).
  Fix slice S1b-fix1: screen-first confirmation + pct-drop native detection.

Phase C — session continues correctly (phaseC-continuity-reply.txt):
- Post-compact sanity turn answers "Lisbon" on the same session
  (session_id 4738f2aa unchanged), ctx 8%, peak 13.
- Bonus live proof: controller logged kind=skipped-cooldown for this turn
  (8% >= 3% but within the 3-turn window after the compact) — cooldown rule
  observed live.

Phase D (turn-boundary auto-compact, no hold) runs after S1b-fix1 + re-up.
Native backstop: no CLAUDE_AUTOCOMPACT_* env set anywhere; native fires at
~window-13k (E3) far above the demo threshold; no native event observed.

Phase D — turn-boundary auto-compact, no hold (compact-log-full.jsonl):
- 17:42:57Z first attempt: injection executed but claude REFUSED ("Not enough
  messages to compact." — very young session, one exchange; screen capture in
  this note's history). Honestly logged compact-unconfirmed at the time; this
  surfaced a real robustness gap: the refusal consumed the cooldown, locking
  the controller out (context only grows). Fixed: refusal now logs
  kind=compact-rejected reason=too-few-messages and does NOT disarm
  (committed unit tests cover retry-at-next-boundary).
- 17:51:56Z the real thing: after a no-hold heavy turn, the turn-boundary
  check fired and SCREEN-CONFIRMED kind=compacted beforePct=13 afterPct=0
  (boundary=turn) — D1's automatic boundary-only trigger, live.
- 17:52:35Z next turn: kind=skipped-cooldown at 10% — the 3-turn rule
  protecting against thrash, live.

Restoration:
- compact_threshold_pct restored to 60 in compositions/default/apm.yml;
  final down/up; /claude/status shows {enabled:true, thresholdPct:60}
  (final-status-restored.json); model.json holds={"implement":true}
  (final-holds.txt) — the composition-inline context_hold flows end to end
  (required a schema fix: compositions.ts dutySpecSchema was silently
  stripping the key; committed with test).

Boundary-only guarantee: every record in the log carries boundary turn|duty;
no compaction ever fired mid-turn (the serialized inflight chain makes it
structurally impossible — see S1b review).
