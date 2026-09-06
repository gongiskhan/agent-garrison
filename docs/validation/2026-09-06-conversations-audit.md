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
- Desktop and mobile browser baseline runs are in progress through
  `playwright.web-channel.config.ts`. That harness starts its own shell and
  fake gateway and verifies restart/replay behavior without calling a model.
- Validation of the new regression cases awaits the git transport commit.
  This document does not claim a deployment or a live model quality result.

Test logs are node-local session artifacts at
`/tmp/garrison-conversations-baseline.log` and
`/tmp/garrison-conversations-browser-baseline.log` on dev-madrid.
