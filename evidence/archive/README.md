# Archive verification

Evidence belongs to dev-madrid. Every Archive browser/server test uses a scratch
`GARRISON_HOME` and a vault copied from `tests/fixtures/archive/vault`. No personal
document body or image is included. Screenshots are explicit checkpoints only;
sensitive extracted text is never expanded in a recorded context.

The narrated phone walkthrough covers search and sensitive-card handling,
Inbox → new card with a derived title, real model extraction and number search,
and the nine-card Trello JSON fixture import:

- [Narrated video](../../.walkthrough/runs/agent-garrison/archive/2026-09-12/phone/final.mp4)
- [Home](../../.walkthrough/runs/agent-garrison/archive/2026-09-12/phone/walkthrough-home-phone.png)
- [Sensitive card, collapsed](../../.walkthrough/runs/agent-garrison/archive/2026-09-12/phone/walkthrough-sensitive-collapsed-phone.png)
- [Processed attachment](../../.walkthrough/runs/agent-garrison/archive/2026-09-12/phone/walkthrough-processed-phone.png)
- [Import completion](../../.walkthrough/runs/agent-garrison/archive/2026-09-12/phone/walkthrough-import-done-phone.png)

The 63.2-second video has seven narration beats, an audio stream, and no recorded
sensitive expansion. That expansion is asserted in a separate browser context
without recording or screenshots. Real vision judgments accompany checkpoints.
Large binary evidence stays in the ignored walkthrough run directory; this
record and the tests are committed.

The final phone/desktop run and its real model judgments are preserved separately:

- [Browser report](../../.walkthrough/runs/agent-garrison/archive/2026-09-12/final-e2e/report/index.html)
- [Test receipt](../../.walkthrough/runs/agent-garrison/archive/2026-09-12/final-e2e/receipt.json)

Reproduce the recording after the normal Archive suite has stopped:

```sh
ARCHIVE_WALKTHROUGH=1 ARCHIVE_VISION=1 GARRISON_INTEGRATION=1 npx playwright test tests/e2e/archive/walkthrough.spec.ts --config playwright.archive.config.ts --project=phone
node scripts/archive-walkthrough-render.mjs test-results/archive-artifacts/walkthrough-narrated-fixtu-be460--extraction-and-JSON-import-phone .walkthrough/runs/agent-garrison/archive/2026-09-12/phone
```

The normal suite keeps video disabled even if the recording flag is set. Only
the explicit walkthrough enables it. Do not run the two Playwright configs at
the same time. Final test counts and the scoped review are recorded in
[the decision](../../docs/decisions/2026-09-11-archive.md).
