# Conversations audit — 6 September 2026

The audit follows Claude's `garrison-conversations-valiant-karp.md` plan on
dev-madrid (26 August), its UI design companion, the current
`docs/decisions/2026-09-garrison-app.md`, and the shared Basic Memory `main`
notes `web-channel-run-context` and `host-aware-urls-and-rich-transcript`.
The repository and live behavior take precedence over the older notes.

## History can stop before the most recent reply

The conversation SSE reader fetched at most 2,000 ledger records on connect
and 500 per subsequent poll. It remembered the byte size of the entire log
after that bounded read. If no further write occurred, its unchanged-size
shortcut skipped every later poll even when unread records remained. A long
conversation could therefore hide its newest replies indefinitely. A burst
larger than 500 records had the same problem while already connected.

The reader now tracks whether its cursor has caught up with the ledger and
drains remaining pages without requiring another write. It records the byte
size before a read so a concurrent append remains observable, and advances
the size only after a successful read so a failed read can be retried.
Existing page limits and the append-only event/revision contract are retained.

Two regression cases in `tests/conversation-store-read.test.ts` require every
event exactly once and in order: an existing history of 2,105 records and a
1,205-record live burst after the initial frame. Both use an HTTP SSE client
against the real router and a throwaway store, with no subsequent write to
unblock the reader.

## Conversation pins must reach the responder

The normal conversation transport discarded context, project/model/duty pins
and native effort while presenting and saving those controls. Its comment
still described an older three-field message gate, although the real HTTP
router now accepts context and routing. The wrapper now forwards those fields,
combining saved host defaults with per-send overrides. Opaque context becomes
bounded text; chat-only fields remain outside the conversation contract.
Unit coverage verifies defaults, overrides, explicit clearing, native effort,
Discuss kickoff and an unchanged unpinned message body. The host also supplies
its saved thread context and pins when creating this wrapper.

The audit then traced those fields through actual stretch selection. Cardless
Talk conversations previously ignored the project, duty, level and effort;
target/model pins only worked when they named a rung of the current duty's
ladder. They now use the gateway's existing override resolver for configured
targets, models, accounts, effort and project paths, with duty/level validation.
The resolved cwd is passed to the runtime. Unknown settings write a visible
refusal note and start no model. Cards retain their own run configuration and
flow. Tests inspect the runtime invocation, not only routing badges.

Normal conversations also have a same-origin Stop door, forwarded to the
gateway's conversation AbortController. The client uses that door for stretch
work; it does not fabricate a chat generation. Failure stays visible and can
be retried; an explicit already-settled response is harmless.

The deeper Stop gate also found that the launcher performed exit-gate model
repair after a cancellation. It now records a local cancelled handoff and
preserves partial output without launching another model call. Stop received
during runtime startup is delivered when the cancellation primitive becomes
available. The regression requires exactly one runtime call, including all
repair paths, and a durable cancelled ending.

The full-stack parity fixtures intentionally exercise the older chat/FIFO lane
with underscore-prefixed thread ids. Their permission and Stop results prove
that lane; they do not establish controls for the ordinary conversation stretch
lane. Normal-lane model quality and control verification must use the
`/api/conversation/:id/message` door and inspect the resulting ledger.

## Retried messages are one admission

The normal gateway message route discarded `clientRequestId`, so retrying after
a lost HTTP acknowledgement could append and execute the same ask twice. The
gateway now retains the id in the durable user-message record and returns the
original admission on retry without starting or steering another stretch.
Reusing an id for different text returns a conflict. Tests reopen the store
after 550 later messages to verify deduplication survives process-local state
and a short recent-history window. Callers without ids retain their behavior.

Admission receipts now always use the client request id. A store's diagnostic
`seq` is local to its writer and can restart at zero on the next HTTP request;
it cannot safely identify two distinct browser submissions.

## Validation status

- Live dev-madrid shell `/api/health` returned `ok: true`; its gateway reported
  `pty_status: ready`. The canonical checkout was `6d48f66b` with the existing
  `compositions/default/apm.lock.yaml` modification preserved.
- Tests run in a detached git clone at
  `/tmp/garrison-conversations-audit-S96J2n` on dev-madrid. Test homes, mock
  gateways, loopback ports and Next output are isolated from the live node.
- The first baseline at `6d48f66b` passed 46 suites and 662 tests, with four
  skips. Two remaining suites exposed test-checkout dependency setup problems:
  the state service's dependency directory was absent and workspace-package
  links resolved back into the canonical checkout. Those disposable links
  were corrected. The rerun reported all 48 suites and all 667 tests passing.
- Desktop and mobile browser baseline runs finished through
  `playwright.web-channel.config.ts`. That harness starts its own shell and
  fake gateway and verifies restart/replay behavior without calling a model.
  Twenty-two tests passed. Both viewport failures were the same stale fixture
  assumption: the page now lazily creates
  its standing Zeca thread in addition to the requested new conversation.
  The fresh-conversation test now initializes Zeca before measuring the action,
  preserving the exact-one-new-thread and no-duplicate-on-reload assertions.
- At `d9694559`, both new backlog regression cases failed against the old
  implementation and passed with the fix. All 48 selected suites and 671
  tests then passed.
- At `a6d7fd27`, all 51 selected suites and 721 tests passed, including all six
  responsive Conversations browser fixtures. The full-stack browser gate also
  passed all 24 desktop/mobile tests, covering streaming, tool results,
  permissions across reload, Stop, queue delivery, restart replay and composer
  reachability. These parity tests use the legacy lane as described above.
- A separate real gateway process gate exercises the normal `/conversation`
  HTTP doors with a hermetic Codex adapter: concurrent retry admission,
  persistence across gateway restart, cancellation and resumption, requested
  Astra/effort/project invocation, and visible invalid-pin refusals before any
  runtime side effects. At `54150815`, all six real-process HTTP cases passed;
  the selected cancellation, launcher and Basic Memory setup/verify regressions
  also passed: four suites, 75 tests total. Twenty simultaneous retry POSTs
  resulted in exactly one message, one stretch and one runtime call. A gateway
  restart preserved that admission. Stop reached the adapter, a retry remained
  stopped, and a subsequent new message completed.
- The final affected regression run at `54150815` passed all 53 suites and
  757 tests, including the responsive browser fixtures and the normal HTTP
  gateway gate. Two additional focused Stop-admission tests passed locally:
  an already-aborted stretch starts no runtime, and a Stop arriving before an
  adapter registers its control is delivered at registration.
- At `96ff22b5`, the production Codex adapter's pre-child cancellation semantics
  received an additional gate. A Stop while waiting for the machine-wide Codex
  lock is checked after acquisition and before input admission; no `sendTurn`
  occurs after that Stop. The real adapter's early `cancel()` returns false
  because no exec child exists, and the gateway now handles that case explicitly.
  All five affected suites and 75 tests passed, including seven real gateway
  HTTP cases. The lock test held a real lock, cancelled the waiting request,
  released the lock and observed zero runtime calls.
  This document does not claim a deployment or a live model quality result.

Working stretches now share the same continuity bridge regardless of runtime.
The gateway reads only the local cached startup/peer context on the turn path
(500 ms cap), and queues metadata-only start, checkpoint, heartbeat and end
events after actual runtime admission. A Stop before Codex lock admission
creates no shared session. Stateless routing classifiers retain their explicit
tool-free prompt. Working SDK duties receive the configured Basic Memory
transport through their explicit MCP assembly, so they can read and write the
same authority even when native settings and hooks are disabled.

Enrolled-project instructions are read from the canonical checkout, with local
override precedence, canonical-file deduplication and a disclosed 65,536-byte
aggregate cap. Checkout symlinks are resolved before enrollment checks; file
symlinks must remain inside that project and resolve to an instruction filename.
Instructions and prompts are never sent to the metadata bridge or shared roster.
The new runtime-neutral gate passed seven tests against the actual Python
bridge and detached worker with an isolated authority leaf; its Python metadata
suite passed all 16 tests. A final combined remote regression run is pending.
The real HTTP lock-Stop case also now follows the cancelled request with a fresh
message and checks that cancelled input is absent from its runtime brief.

Test logs are node-local session artifacts at
`/tmp/garrison-conversations-baseline.log` and
`/tmp/garrison-conversations-browser-baseline.log` on dev-madrid.
The final gates are `/tmp/garrison-conversations-normal-gate.log`,
`/tmp/garrison-conversations-final.log`, and
`/tmp/garrison-conversations-browser-current.log` on that node.
