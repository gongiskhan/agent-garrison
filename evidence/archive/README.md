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

The 13 September instructions below reproduce the current recording. The
original video and judgments above remain historical acceptance evidence.

The normal suite keeps video disabled even if the recording flag is set. Only
the explicit walkthrough enables it. Do not run the two Playwright configs at
the same time. Final test counts and the scoped review are recorded in
[the decision](../../docs/decisions/2026-09-11-archive.md).

## Knowledge and navigation follow-up — 2026-09-12

The follow-up browser run passed 43 phone/desktop journeys. Three cases retained
their normal gates: two real-model ingestion cases and phone No vault (desktop
only). Compact card rows and Inbox screenshots were inspected directly; this run
did not use a model vision judge. The original accepted vision receipts above are
preserved and are not claimed as verification of the new card design.

- [Follow-up browser report](../../.walkthrough/runs/agent-garrison/archive/2026-09-12/knowledge-followup/full-report/index.html)
- [Follow-up browser log](../../.walkthrough/runs/agent-garrison/archive/2026-09-12/knowledge-followup/full-e2e.log)
- [Final verification receipt](../../.walkthrough/runs/agent-garrison/archive/2026-09-12/knowledge-followup/receipt.json)

The whole repository passed 8,629 tests across 751 suites, with 27 normal gated
cases. Typecheck, lint and the isolated production build also passed.

The native assistant regression runs the real SDK, MCP server and confined
Archive service against synthetic documents, with only the remote model
simulated. It proves discovery, search, extracted fields, source links and no
vault writes. The separate real-model certificate lookup remains pending account
authorization; an unauthenticated attempt returned “Not logged in”.


## Folder browsing follow-up — 2026-09-13

The owner's revised surface uses the same folder browser for Yours and Garrison,
with list/thumbnail views, alphabetical or recent ordering, stars and website
bookmarks. Inbox is retired; attachments upload directly into documents. Existing
on-disk document folders and deep links are compatible.

All evidence for this revision stays separately under
`.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/`.
The initial complete deterministic browser run passed 55 journeys, with three
normal platform/integration gates. Subsequent real-model verification uses the
explicitly selected account through in-memory authority delivery, with no
credential file and no real personal document in any fixture.

- [Server timing fixture](../../.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/benchmark.json)
- [Real assistant retrieval receipt](../../.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/real-agent.log)
- [Initial complete browser report](../../.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/full-report/index.html)

The real assistant test keeps a sensitive synthetic company certificate, a second
company and an unrelated tax number. It asserts the requested certificate,
excludes unrelated identifiers, requires a clickable source and both search/read
tools, and checks GET-only traffic plus a byte-identical vault afterward. Initial
model failures and the tightened tool guidance are recorded in the decision;
no assertion was weakened to pass.

Real test runs require `GARRISON_INTEGRATION=1`; screenshot judging additionally
requires `ARCHIVE_VISION=1`. An authorized launcher delivers the selected account
as `ARCHIVE_INTEGRATION_ACCOUNT` / `ARCHIVE_INTEGRATION_TOKEN` in memory and sets
the runtime's ordinary account environment. Never write a token into a command,
credential file, fixture configuration or evidence. Run only one Playwright
configuration at a time, then record with `ARCHIVE_WALKTHROUGH=1` and render the
fixture video's `narration.json` using `scripts/archive-walkthrough-render.mjs`.


The final revised browser run passed **57 journeys**, with real extraction and
**15/15 real screenshot judgments** enabled. The only exclusion is the phone copy
of the desktop-only No vault test. A separate **65.6-second narrated recording**
passed with real extraction and three more real screenshot judgments. Four live
integration cases passed: assistant certificate retrieval, image binding,
image/text-PDF/scanned-PDF extraction, and read-only Trello board discovery.

- [Final browser report](../../.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/real-report/index.html)
- [Final browser log](../../.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/real-e2e.log)
- [Screenshot judgments](../../.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/vision-receipt.json)
- [Real integration log](../../.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/integration.log)
- [Current narrated walkthrough](../../.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/phone/final.mp4)

The recording keeps sensitive extraction collapsed. Its required expansion check
runs separately without video or screenshots. No live node was restarted for
these fixture runs.


In an authorized integration environment, after the normal suite has stopped:

```sh
ARCHIVE_WALKTHROUGH=1 ARCHIVE_VISION=1 GARRISON_INTEGRATION=1 npx playwright test --config playwright.archive.config.ts walkthrough.spec.ts --project phone
```

Pass the resulting artifact directory containing `narration.json` and `video.webm`
to `node scripts/archive-walkthrough-render.mjs <artifact-directory> <output-directory>`.
Use a new output directory to retain earlier evidence.


After the final empty-folder sync correction, ten affected phone/desktop folder,
note and Trash journeys passed again. Fifty-five focused API/model/index tests
also passed, including a Git clone retaining new empty folders in both areas.
Ordinary Garrison notes named `_list.md` remain visible/searchable; only marked
folder metadata is hidden.

- [Folder correction browser report](../../.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/folder-metadata-report/index.html)
- [Folder correction unit receipt](../../.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/folder-sync.log)


The final full repository run passed 8,699 tests across 762 suites, with 29 normal
existing/integration-gated cases across 12 suites. Typecheck, lint and the
isolated production build passed.
The consolidated [verification receipt](../../.walkthrough/runs/agent-garrison/archive/2026-09-13/folder-browser/receipt.json)
records the source, test boundaries, model calls, walkthrough and rollout status.
