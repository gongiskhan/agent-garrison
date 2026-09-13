# Messages inbox validation

Date: 2026-09-13. Evidence owner: goncalos-macbook-pro.

Sixteen Playwright journeys passed across the iPhone 390 by 844 profile with scale factor 3 and touch, and desktop 1440 by 900. They cover conversation grouping, provider badges, unread counts, tabs, card links, inline questions, approvals, timed revert, filters, deep links, Markdown send, swipe read, hide with undo, long press selection and a virtualized list of 1000 conversations. Warm first paint is asserted below two seconds.

The lead viewed all 20 final screenshots in evidence/messages/p2 and recorded each verdict in evidence/messages/vision-checklist.md. Clipped fenced code, shell scrolling and textarea shrink defects found during the journeys were corrected and recaptured. No horizontal page overflow remains in the tested screens.

These browser tests exercise fixture provider responses. The actual state service and card signal integration have separate passing tests in Phase 1. Physical iOS keyboard and acoustic acceptance remain separate from browser viewport verification.
