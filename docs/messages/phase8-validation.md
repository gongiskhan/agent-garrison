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

## Acceptance entries still to close

- Full repository test suite: pending the lead's final consolidated result.
- Production build and deployment: pending the lead's build receipt and guarded rollout.
- Gmail live self-only smoke: pending the required mail consent.
- Slack text and voice live self-only smokes: pending the user grant.
- WhatsApp image and voice live self-only smokes: pending deployment and execution against the paired account.
- Final process-boundary review receipt and any resulting checks: recorded by the lead in the separate final review document.

This record does not claim that the build, deployment, live smokes or final acceptance sentinel have completed. The lead will update those entries from their receipts.
