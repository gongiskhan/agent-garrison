# Phase 8: ship validation

## Browser verification

The complete Messages browser run passed 56 of 56 cases in 7.8 minutes. The final focused run passed 12 of 12 cases in 2.3 minutes, including two additional recording cases, for 58 unique passing cases. Both profiles are covered: iPhone 390 by 844, device scale factor 3 and touch, and desktop 1440 by 900. `npx tsc --noEmit` passed after the final UI changes.

| Phase | Unique browser cases |
| --- | ---: |
| 1: real store API journey | 2 |
| 2: inbox and conversation | 16 |
| 3: Gmail | 10 |
| 4: Slack and account setup | 4 |
| 5: WhatsApp group-photo journey | 2 |
| 6: media and recording | 8 |
| 7: views, rules and provider settings | 8 |
| 8: offline, performance, keyboard and failed send | 8 |
| Total | 58 |

The focused checks prove pending action controls remain unobstructed, successful replay clears stale queue copy, the shell app bar stays at y=0, the rule matching row stays above its sticky footer, and recording supports touch hold, release and left-slide cancellation. The lead viewed the final phone and desktop evidence. These are browser device profiles, not physical-phone or acoustic acceptance.

## Measured performance

The list contains 1000 synthetic conversations. Only 15 rows are mounted in each measured viewport. Redraw remains below the 200 ms threshold, and the measured 95th percentile frame interval remains below 34 ms while scrolling.

| Profile | Redraw | Frame interval, 95th percentile | Mounted rows |
| --- | ---: | ---: | ---: |
| iPhone browser profile | 14.8 ms | 10.1 ms | 15 |
| Desktop browser profile | 14.5 ms | 18.0 ms | 15 |

Raw measurements: [performance-iphone.json](../../evidence/messages/p8/performance-iphone.json) and [performance-desktop.json](../../evidence/messages/p8/performance-desktop.json). Warm first contentful paint is separately asserted below two seconds in the Phase 2 journey.

## Evidence inventory

Phases 2 through 8 contain 88 distinct captures: 20, 8, 8, 8, 12, 22 and 10 respectively. Phase 8 also contains `performance-list-iphone-verified.png`, an identical copy of the final phone performance image under a fresh filename for the lead's image viewer. It is a second filename for the same capture, making 89 PNG files in the inventory.

The Phase 8 stems `offline-pending`, `offline-replayed`, `performance-list`, `keyboard-composer` and `failed-send` each have an `-iphone.png` and `-desktop.png` capture. The complete filename inventory is [ui-screenshot-inventory.json](../../evidence/messages/p8/ui-screenshot-inventory.json), and the final browser receipts are [ui-test-results.json](../../evidence/messages/p8/ui-test-results.json).

## Final verification status

- Full repository unit project: 8,666 passed and 45 skipped across 754 passing files and 13 skipped files. The serial browser fixture project initially passed 302 tests, with one existing Archive latency failure under local machine load. The unchanged Archive timing group passed all eight tests on Madrid, closing that failure. One browser fixture is opt-in and skipped. Local gateway continuity also passed all eight tests. Receipts preserve the initial failure and the successful isolated result. The baseline covers 8,969 unique passing runner tests. Five new action-receipt tests, four manifest migration/scanner regressions and three binary-proxy regressions bring final unique coverage to 8,981 passing tests, including 247 Messages unit tests. The 46 existing opt-in or platform skips are retained; no Messages fixture is skipped. Focused reruns are not counted twice. The consolidated receipt is evidence/messages/p8/test-receipt.json.
- Production build: passed compilation, type checking and static generation under the isolated codex profile. Receipt: `evidence/messages/p8/build.log`. Pinned state schema 3 is deployed with a fresh snapshot. Guarded app rollout completed sequentially on Air, Pro and Madrid at bef8f7e7. All three have matching deployment receipts, successful supervisors, 40/40 runner checks and 15/15 healthy views on local and public origins. Mini is deferred for concurrent work; CSG is unavailable.
- Gmail live self-only smoke: pending the required mail consent.
- Slack text and voice live self-only smokes: pending the user grant.
- WhatsApp image and voice live self-only smokes: passed on the final deployed revision. Seven checks passed, with three exact-revision provider completion receipts and complete PNG/AAC decoding. The real cross-node audio also played at 1.5x on both browser profiles, and the lead viewed its player and transcript plus decoded images. Receipts: evidence/messages/live/whatsapp-final/ and evidence/messages/live/madrid-live-media-proof.json.
- Final process-boundary review receipt and any resulting checks: recorded by the lead in the separate final review document.

All non-consent acceptance gates are complete. Google and Slack remain explicit consent-pending providers, so the final acceptance is partial. The complete result and repository adjustments are in [acceptance-report.md](acceptance-report.md).

## Deployment migration correction

The first app rollouts showed that the shared authority still held a retired gateway flag. The normal `up()` materialization restored it into the local manifest and caused the mandatory pretest guard to fail. The composition sync now removes only that obsolete field through the existing revision-checked update, preserves concurrent edits and unrelated settings, and also refreshes a first-contact local manifest. The scanner allows only the exact deletion statement, while assignment or the same statement in another source file still fails. All 14 focused composition-sync and scanner tests pass with the mandatory pretest clean, and type checking passes. Generated-only manifest differences are backed up on their owner and compared semantically before cleanup. Receipt: `evidence/messages/p8/composition-sync-rollout.log`.

## Live media transport correction

The first self-only WhatsApp run confirmed image arrival, reply, read and delete acknowledgments, voice transcription and transcript search. Actual playback validation found that the existing mesh proxy decoded non-streaming responses as text, corrupting cross-node image and audio bytes. The proxy now buffers an ArrayBuffer and preserves the existing status, MIME, error and streaming behavior. Two exact-byte regressions fail on the previous implementation and pass with the fix; a third covers an unreadable upstream body. All 77 proxy tests pass, as do the mandatory pretest and type checking. Receipt: `evidence/messages/p8/binary-proxy-regression.log`. After the guarded reload, the existing voice note decoded and played at 1.5x in both profiles, and the real image decoded correctly. The repeated final self-only smoke also passed full byte decoding and provider acknowledgments.
