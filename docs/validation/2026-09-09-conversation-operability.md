# Conversation operability — 9 September 2026

The reported MacBook Pro conversation was interrupted twice by its own commands.
Triage edited the UI and killed Garrison processes before handing off; the later
ops stretch committed the change and invoked a redeploy beneath its own gateway.
The original request never became the ledger objective. Continuing briefs omitted
most of the previous handoff's remaining steps and evidence. The UI screenshot
also showed a tool header extending beyond its expanded content.

## Changes

- Default triage uses Sonnet at low effort, with at most eight SDK turns and a
  two-minute deadline. It can read/search context and record findings; project
  edits, shell execution and delegation belong to the next duty. A fenced JSON
  handoff is accepted without requiring Write permission.
- Every subsequent brief retains the original request, remaining handoff items,
  failed approaches, evidence references and project scope. Long original requests
  have an explicit pointer to their complete owner copy.
- Fresh native runtime sessions, duty ladders, provider changes, effort controls,
  sticky escalation floors and owner findings/ledger storage remain intact.
- Gateway startup resumes recent interrupted work from owner checkpoints,
  including a saved handoff whose next stretch had not started. A live marker
  cannot be stolen. Repeated interruptions pause visibly instead of looping.
- Hosted reload/redeploy queues an independent launchd/systemd job, waits for the
  handoff and resumes for verification. Stop can cancel a queued deployment or
  prevent continuation after an already-running deployment. Failures retain the
  real cause and log path. The SDK rejects commands that kill the hosting service.
- Runtime failure keeps partial output. Formatting repair is tool-free, bounded
  and cancellable; it never reopens a terminated native session without context.
  Native stretches bypass the legacy generated-file rewrite mode.
- Completion checks include the current handoff's proof, require verification
  even from the test duty, and cannot convert an outstanding review into success
  because its budget ran out. Review budgets and evidence apply to the current
  work cycle. Hitting the stretch cap leaves a durable pause.
- Tool calls remain collapsed during execution unless the reader opens them.
  Manual expansion survives settlement; thinking retains its existing automatic
  display. Header/body edges align in the shared Conversations/Kanban renderer.

## Verification

- Type checking passed. The focused launcher, handoff, routing, SDK, continuity,
  ownership, cancellation and instance checks passed (239 checks in the broad
  focused run, followed by 132 checks after the final native-routing regression).
- Real Chromium phone-width renderer and Kanban conversation checks passed:
  33 checks, including tool expansion, aligned edges, no horizontal overflow,
  keyboard focus and existing shell reconnect behavior.
- A real native run completed in three stretches: Sonnet low-effort triage
  (14 seconds), Sonnet medium-effort implementation (60 seconds), and Codex Sol
  medium-effort independent review (145 seconds). Seven acceptance cases passed;
  the reviewer checked additional edge cases and committed a verified Done
  handoff. All three handoffs passed without a formatting repair. The original
  request, including the negative-number constraint, survived both transitions.
  Owner result: `/private/tmp/garrison-operability-live-final/result.json`.
- The first real run exposed the legacy generated-file mode rewriting a native
  handoff as application code. The native bypass now has a regression covering
  unchanged reply text, terminal-event delivery and absence of an implicit file
  write. A final 83-check regression run passed after that correction.
- Mesh rollout is checked after publication. Browser evidence does not
  substitute for physical iPhone acceptance.

Owner evidence stays on the MacBook Pro under
`/private/tmp/garrison-operability-*`; raw conversations and credentials are not
copied into shared memory.
