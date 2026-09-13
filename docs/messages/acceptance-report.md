# Messages acceptance

Accepted with Google and Slack consent pending. Every available-provider live check, required fixture journey, build and scoped review gate has passed. The final status is MESSAGES-ACCEPTED-PARTIAL.

## Delivered scope

Messages is a core shell area at `/messages`, with one relational store, discovered providers, system notifications and inline answers, Gmail and Slack adapters, the existing WhatsApp connection, structured outbox, shared composer, attachments and searchable audio transcripts, saved views, deterministic rules, retention and offline actions.

Findings: [phase0-findings.md](phase0-findings.md). Model and provider guide, including a worked registration example: [README.md](README.md). The restricted final review and its corrections are recorded in [final-review.md](final-review.md).

## Test counts

Phase batches overlap. The unique totals below count each runner test and browser case once.

| Phase | Passing verification | Evidence |
| --- | --- | --- |
| 0 | 14 exploration findings; read-only runtime checks | `docs/messages/phase0-findings.md` |
| 1 | 78 foundation tests; 2 real store browser/API journeys | `evidence/messages/p1/` |
| 2 | 16 inbox and conversation browser cases | `evidence/messages/p2/` |
| 3 | 21 final Gmail adapter tests; 10 browser cases | `evidence/messages/p3/` |
| 4 | 27 final Slack adapter tests; 4 browser cases | `evidence/messages/p4/` |
| 5 | 22 final WhatsApp adapter tests; 2 browser cases | `evidence/messages/p5/` |
| 6 | 41 final media-boundary tests, 9 Drive tests and 77 shared-composer regression tests; 8 browser cases | `evidence/messages/p6/`, `evidence/messages/p8/media-boundary.log` |
| 7 | 20 store/rules/views tests and 3 registry tests; 8 browser cases | `evidence/messages/p7/` |
| 8 | 8 browser cases; full runner, production builds and focused rollout regressions | `evidence/messages/p8/` |

Unique coverage is **8,981 passing runner tests**, including **247 Messages unit tests**, plus **58 Messages browser cases**. There are 46 existing opt-in integration or platform skips; no Messages fixture test is skipped. The initial Archive latency gate failed under unrelated local host load and passed unchanged on Madrid. Both results remain in the receipt. New action-receipt, startup-migration and binary-proxy tests pass; their focused reruns are not added twice. Type checking and the mandatory pretest pass.

Every browser journey covers iPhone 390 by 844 with scale factor 3 and touch, and desktop 1440 by 900. The lead viewed the final fixture screenshots and all three deployed empty-search screens. The complete verdicts are in `evidence/messages/vision-checklist.md`. These are browser profiles and do not claim physical-phone or acoustic acceptance.

At 1000 conversations, only 15 rows are mounted. Redraw measured 14.8 ms on the phone profile and 14.5 ms on desktop. The 95th percentile frame interval was 10.1 ms and 18.0 ms respectively. Warm first contentful paint is asserted below two seconds.

Consolidated receipts: `evidence/messages/p8/test-receipt.json`, `ui-test-results.json` and `ui-screenshot-inventory.json`.

## Live provider results

| Provider | Result |
| --- | --- |
| Gmail | Pending Google consent for `gmail.modify`. Drive read scope already exists. No live mail sent. |
| Slack | Pending a user grant with the required history, read, write and file scopes. No live Slack message sent. |
| WhatsApp | Passed the repeated final self-only smoke on the deployed revision: image receive and full decode, read receipts, reply, voice receive and full AAC decode, transcript search and own-message delete. Browser playback at 1.5x passed on both profiles. |

The first live download exposed binary corruption in the existing cross-node proxy. Its text buffering was replaced with byte buffering and 77 proxy tests pass. The initial failed media-decode receipt is retained, so HTTP success is not mistaken for usable playback. After repair, the real M4A decoded and played at 1.5x on both profiles, and the lead viewed all four live images. The final smoke then passed all seven checks in one run, with three exact-revision provider receipts and full PNG/AAC decoding. No ambiguous send was automatically retried.

Live receipts: `evidence/messages/live/whatsapp-final/report-20260913T215657613Z.json`, `provider-action-receipts.json`, `media-decode-receipts.json`, `evidence/messages/live/madrid-live-media-proof.json` and `evidence/messages/live/readiness-final/report-20260913T215652821Z.json`.

## Deployment and pending consent

Product revision: `bef8f7e7aafebeb2f3a5a067f8d48d82923f5354`. Source was committed on the existing Pro node branch and converged through main. No new branch or force push was used. Nontrivial convergence preserved a premerge tag and decision card `01M2E8G7QXSJA09NZC6JME8FD5`.

State release `messages-state-receipts-20260913-fdb39494` is live at schema 3, with schema-2 compatibility and a fresh sanctioned snapshot. Air, Pro and Madrid completed their final guarded reloads with 40/40 runner checks, 15/15 views, successful supervisors and matching deployment receipts. Each previous node was proven healthy before the next restart. Reload provenance is recorded through the supervisor's pinned revision, successful build log, BUILD_ID and deployment receipt; `node:reload` does not recreate the separate `garrison-build-head` file.

The shared manifest's retired gateway flag was removed through revision-checked normal migration. Owner-local generated files were backed up and compared semantically before cleanup. Startup on all three nodes no longer regenerates the tracked difference. Mini's concurrent work is preserved and its rollout is deferred. CSG is unavailable and is not claimed deployed.

Pending actions for Gonçalo:

- Reconnect Google with mail read scope in Connectors.
- Reinstall Slack with user scopes.

Both exact setup notices are persisted as system messages with stable identities. Consent-pending providers retain fixture coverage and visible setup status.

## Repository findings that adjusted the brief

- The repository uses main for mesh convergence. The brief explicitly selected the existing node branch for commits, so that branch was advanced and used without creating another branch.
- AGENTS.md was a symlink to tracked CLAUDE.md. It is now the canonical tracked file; tracked CLAUDE.md and .claude content were removed while local private configuration was preserved.
- Google originally held one grant. Account-keyed grants were added while retaining the existing default account.
- Slack used token setup rather than OAuth installation. Its additive user-token setup links to Slack Apps; read markers also require four write scopes beyond the brief's initial list.
- WhatsApp lacked a complete durable stream and reconciliation cursor. Bounded event, media and action callbacks were added around the existing socket and outbox. Pairing, protocol, library and the 60-second agent hold remain.
- Deepgram is provided by the active Capture service. Retired Omi cloud behavior was not restored. Messages uses its own fixed transcription options without changing Capture defaults.
- The Capacitor shell exists but has no Camera plugin. Runtime detection and the specified file-input fallback are used.
- No Attention queue store exists. `/api/messages/needs-me` exposes its future query; no duplicate store was added.
- The icon set is lucide-react, resolved through a bounded descriptor glyph mapping. The model has additive starred filtering, immutable action targets and cancel-send support for the specified controls.
- ffmpeg was already available on Madrid. No installation was needed.

Owner-local runtime evidence stays under `evidence/messages/live/`; receipts link remote supervisor logs and backups to their owner nodes. No real account content or binary evidence is committed to Git.
