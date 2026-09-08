# Conversations usability and responsive verification

The September 6 audit follows the existing Conversations design (one durable record,
same-origin mesh navigation, pinned Zeca, native capture and independent runtime
sessions). Changes make history discoverable and keep the composer usable when the
shell consumes part of a tablet or laptop viewport.

- Search finds local and remote conversations plus sessions by name, project or node;
  it reveals matching collapsed/archived rows without rewriting organization.
- Zeca appears first. Idle sessions initially collapse, while working and selected
  sessions remain visible. Existing explicit expansion preferences are preserved.
- Conversation options are reachable with a labelled button; destructive deletion is
  inside that menu alongside rename and archive.
- The drawer follows the conversation pane width, with 44px controls, Escape, focus
  return and inert hidden navigation. The composer keeps its draft while filtering.
- Clear empty-state guidance and model-neutral composer text replace terminal jargon.
  Cream and olive colors remain consistent with Garrison.

## Verification

The detached dev-madrid candidate at `a6d7fd27` passes all 6 browser checks in
`tests/talk-responsive-browser.test.ts`: desktop navigation, filtering with draft
preservation, tablet drawer focus and Escape, and long-draft composer bounds at
320, 390 and 768px. All 7 existing rail-collapse checks also pass. The tablet
test caught an invisible scrim intercepting navigation at a 1024px viewport with
a 764px conversation pane; the candidate fixes that interception.

The combined Conversations audit at `54150815` passes 757 tests in 53 suites, plus 24 legacy
full-stack desktop/mobile parity checks. The latter do not establish normal
conversation routing or cancellation; those have a separate real-gateway gate.
Typecheck and the optimized production build passed at `818dadcf`; a final build
also passed for the deployed `c32416fb` runtime candidate on dev-madrid and the
MacBook Pro. Live HTTPS inspection at `https://dev-madrid.tail31efa.ts.net/talk`
confirms the following on the deployed UI:

- At 390×844, the document is exactly 390px wide. The composer spans x=10–380;
  its Send button is 44px high and ends at y=834, within the viewport.
- The search drawer reports no matches correctly, keeps the unsent draft,
  makes the main pane inert, and returns focus to its opener on Escape.
- At 1024px, the shell leaves a 764px conversation pane, which correctly uses
  the compact drawer. Existing QA conversation history opens in that pane.
- Zeca stays first; actual Claude and Codex sessions from multiple nodes are
  visible and searchable. Existing explicit session expansion is retained.

Live testing also found that locally hosted conversations created by another
client were absent until page reload. The `4eab555b` fix refreshes the idle rail
every ten seconds and on returning to the tab, without replacing the active
composer/stream. A real full-component browser regression verifies discovery,
composer identity and unsent draft preservation, and retention of the known
list through an HTTP 503. The isolated dev-madrid gate at `992b71a0` passes
34 tests across that regression, all six responsive checks and the existing
UI context suite. Production discovery was re-verified on the later combined runtime build below.

On the deployed `dce4dc63` build, newly created dev-madrid QA conversations
appeared without reloading the page. An Air-owned Sol test conversation opened
from the dev-madrid rail through the same-origin mesh route and displayed its
actual test reply, `gpt-5.6-sol`, applied medium effort, and the observed ChatGPT
account. Its 390px view exposed a long-path prompt-summary overflow; the small
wrapping fix and real SSE fixture pass all six responsive browser checks at
`42d7bbd2`, including bounds on long prompt summaries at 320/390/768px.

A live disposable SDK conversation (`chat-mtpo2isg-p1p7qa`) was stopped through
the actual HTTPS Stop button. Its stream settled to `cancelled`, the button
disappeared, and the page displayed "Conversation stopped" with a request for
a new message. This proves in-flight turn cancellation, not interruption of
the requested foreground sleep: the SDK's initial literal sleep was rejected
by its own guard, and its subsequent wrapped command had already returned by
settlement. The ledger and follow-up checks are recorded with the duty QA.

Real iPhone microphone, APNs and keyboard gates still require the device. Browser
viewport checks are evidence for responsive web layout, not those native gates.

## Final saved-answer and mobile delivery gate

The `16d4dd8c` optimized build is live on the MacBook Pro and dev-madrid.
The actual HTTPS Astra review (`chat-mtpojeot-i8nba8`) now displays the
complete saved response, including concurrent duplicate and crash-window
schedules, discriminating test designs, and the provider-cooperation limit.
The prior view showed only the short handoff summary. The final prose appears
exactly once. At 390×844, the document width is 390px and the composer remains
at x=10–380 with its bottom at y=785. The live screenshot confirms readable
wrapped prose, visible routing attribution and the in-viewport Send control.
The saved reply remains on its owner node; replay does not copy raw transcripts
to shared memory.

The same live browser check displays Sol validation's complete failure analysis
and proposed concurrent-admission/cancellation test (`chat-mtpojeoy-4e9yjk`).
The stopped SDK conversation subsequently displays the exact
`STOP_QA_RESUME_OK` answer (`chat-mtpo2isg-p1p7qa`), with one fresh successful
stretch after the cancelled one. No repeated sleep or follow-on work appears.
The full original runtime reply is retained when already streamed; it does not
receive a duplicate payload fallback.

A fresh normal Astra planning conversation (`chat-mtpzl1c3-2u0mga`) also renders
the live shared-memory read-back, identifying the original Codex Astra writer
and Claude SDK's exact appended verification line. Its visible settled
attribution is Codex, `gpt-6-astra`, max effort, five calls and one completed
stretch. This complements the historical saved-answer replay checks.

The final Sol report (`chat-mtpzixy0-i9of43`) displays its full sourced answer
and honest evidence limitations on the live site. It uses the actual default
report route, low effort and one completed stretch. All task-owned QA rows were
subsequently archived on the two reachable nodes, retaining their histories.
