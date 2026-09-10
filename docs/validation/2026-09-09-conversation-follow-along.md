# Conversation follow-along UI — 9 September 2026

The reported conversation retained its full handoff summaries and durable findings,
but the adapter omitted findings and the renderer collapsed handoffs into generic
rows containing raw JSON. Completed stretches also hoisted the final response and
thinking above earlier activity, changing the reading order after settlement.

The shared Conversations/Kanban renderer now:

- Shows saved findings, decisions and handoff summaries as readable Markdown.
- Keeps next steps, evidence, constraints and failed approaches in a secondary
  disclosure; the original owner ledger and handoff files remain unchanged.
- Preserves chronological stretch history and manual disclosure choices when work
  finishes. Tool calls start collapsed; readable provider thinking stays visible.
- Keeps current duty, model and elapsed time above the scroller. Stretch headers
  emphasize the duty and next step; identifiers and call/token counts move into
  Run details. Provider/model/effort/account attribution remains visible.
- Preserves an in-progress thinking indicator even before readable text arrives.
  An empty completed marker does not invent a summary. Run details explain when
  the provider supplied no readable thinking for the stretch.
- Includes the completed peer change replacing the Usage emoji with an SVG button
  matching the composer controls, without changing the usage disclosure.

The reported September 9 Pro run emitted thinking markers with empty text. There
is no missing readable text in those recorded events to reconstruct. This change
does not request private reasoning or manufacture an explanation on the provider's
behalf. Existing recorded text and summaries are displayed as supplied.

## Verification

TypeScript passed. The focused suites passed 122 distinct cases: conversation
store/read/stream 48, block contract/sanitizer 9, Chromium UI 23, activity derivation
18, journal 20, and usage 4. The browser regression verifies safe Markdown,
chronological ordering, readable summaries and thinking, initially collapsed
tools, retained manual disclosure choices on settlement, and no overflow at320px.

Production HTTPS desktop/mobile and embedded-view checks are performed after the
commit's external deployment; their owner artifacts and final node results are
recorded in the shared Garrison Node Operations note. Browser checks do not imply
physical iPhone acceptance. Mini restart/recovery is deferred by the user until
tomorrow; do not claim this release has reached that unavailable node.

## Production browser acceptance

The actual reported Pro conversation on HTTPS served1ae4cf3a with eight readable
ledger entries, all eight open,51 initially collapsed tools and four duty headers.
Desktop Chromium and mobile WebKit both expanded next steps/evidence correctly,
showed the absent-thinking notice in Run details, and measured zero pixel mismatch
between expanded tool headers and bodies, with no page overflow.

The live Madrid Kanban card01M1KMRMW123GKJT6J6K80BMWH showed13 readable ledger
entries and117 initially collapsed tools after rebuilding its served bundle.
Kanban runs from the seed fitting here; its tracked dist assets must be rebuilt
when the shared claude-chat package changes. Rebuilding only apm_modules does not
update the served seed bundle, and an unchanged fitting fingerprint can skip its
setup hook. Both seed and installed bundles were regenerated on Pro, Madrid and
Air. The rebuilt tracked seed assets are included in this follow-up commit.

Owner screenshots and interaction results are under
output/playwright/conversation-follow-along/. Production node results and CSG
tether recovery are recorded in shared Garrison Node Operations. These browser
checks are not physical iPhone acceptance.

A final mobile check caught a long card title occupying roughly a third of the
viewport. On the Conversation tab only, the card title now uses at most two lines;
the Card tab retains the full title and editing control. This is a shared board
CSS change, shipped in the tracked Kanban stylesheet as well as its source.
