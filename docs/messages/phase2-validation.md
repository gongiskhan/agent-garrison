# Phase 2: inbox and conversation

Date: 2026-09-13. Evidence owner: goncalos-macbook-pro.

Sixteen unique browser cases passed. Both profiles are covered: iPhone 390 by 844, device scale factor 3 and touch, and desktop 1440 by 900. They cover conversation grouping, provider badges, unread counts, tabs, card links, inline questions, approvals, timed revert, filters, deep links, Markdown send, swipe read, hide with undo, long press selection and a virtualized list of 1000 conversations. Warm browser first contentful paint is asserted below two seconds.

The lead viewed all 20 final screenshots in `evidence/messages/p2` and recorded their verdicts in [vision-checklist.md](../../evidence/messages/vision-checklist.md). Each of these stems has an `-iphone.png` and `-desktop.png` capture: `inbox`, `done-conversation`, `question`, `approval`, `revert`, `filters`, `chat-deep-link`, `composer-sent`, `multiselect`, `virtual-list`.

Clipped fenced code, shell scrolling and textarea shrink defects found during the journeys were corrected and recaptured. The final capture helpers assert no horizontal page overflow, zero document scroll and a phone app bar at y=0. The complete filename inventory is [ui-screenshot-inventory.json](../../evidence/messages/p8/ui-screenshot-inventory.json), and the final browser receipts are [ui-test-results.json](../../evidence/messages/p8/ui-test-results.json).

These browser cases use fixture provider responses. The actual state service and card signal integration have separate passing Phase 1 tests. Physical iOS keyboard and acoustic acceptance remain separate from browser viewport verification.
