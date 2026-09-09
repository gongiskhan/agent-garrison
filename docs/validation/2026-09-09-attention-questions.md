# Needs Attention suggested replies

One optional question in a conversation handoff supplies up to four labelled replies with optional descriptions. The existing model turn writes it; there is no extra generation call. The shared question presentation appears compactly on Needs Attention card fronts and above the normal composer in Conversations. Both keep free-form replies. Decision records without a conversation allow a first reply. Legacy credential handoffs can offer “I have added the keys to the vault”. Historical merge titles alone do not imply that destructive work remains; execution choices come from an unresolved question authored by the agent.

Answers are normal conversation messages. The existing responder moves the card to Working. A handoff coordinate rejects obsolete questions; a stable request id makes retries and double taps idempotent. A different answer after admission is refused. Ordinary composer replies also retire the old question. Frozen records offer no controls and refuse writes. No actual credential or merge decision was answered during verification.

The current morning-brief card belongs to Madrid. Before this change the Pro board read an empty Pro ledger for that card. Kanban now relays its conversation requests through the local shell's explicit mesh allow-list to the card's owning node. Browser URLs remain relative, and an unavailable owner does not create a local conversation.

## Verification

- All 265 final focused tests across 13 files passed (254 in the combined run, plus 11 existing question-control checks), covering handoff schema, HTTP admission, retry, legacy pauses, peer routing, conversation rendering and instance separation.
- The responder check runs through suggested-answer admission and verifies Running followed by settlement. Regression checks cover a historical record's first reply, spilled handoffs and writer restarts: question identity uses the immutable ledger index, not a sequence number that resets per writer.
- TypeScript passed. Tracked seed Kanban and legacy web-host JS/CSS were rebuilt.
- Chromium fixtures exercised compact phone width, expanded choices, the actual Conversations component, custom text, failed send/retry, and question removal on an ordinary reply. Screenshots are on the Pro under `output/playwright/attention-questions/`.
- Physical-phone acceptance is not claimed.

## Rollout

Implementation commits `8bee8ee3` and `86b3552c` are pushed to main and the Pro node branch. Both owner checkouts received the code through Git. Pro's final full redeploy completed successfully at 09:23 UTC with 43/43 checks; its composition is running on `86b3552c`. Madrid built the same revision and passed 43/43 checks, but startup was refused by Paymaster: the eligible-token account is at 102% of its five-hour window, and the other Anthropic account needs re-login. A fresh probe at 09:28 UTC confirmed the hold; the reported nearest reset is 09:50 UTC (10:50 Lisbon). No account pin, limit override or credential change was made. Madrid conversation replies cannot resume execution until an account is eligible and normal composition startup succeeds.

The real Madrid-owned credential card was read through the Pro HTTPS Kanban origin on port 8506. Both the card front and Discuss conversation show the Vault reply; the conversation keeps its existing composer as the free-form field. The final owner-routed endpoint returns `handoff-2072`, verifying the corrected ledger coordinate. Screenshots include `live-credential-card.png` and `live-credential-conversation-final.png`. Requests interrupted during deployment produced transient 502s; the final question GET returned 200. No live user question was answered to test the feature.

Pro's final health check found 16/17 views healthy: capture-service was CPU-bound and its health request timed out. One supported fitting restart returned success but the new process again became unresponsive; voice recovery remains unresolved and is not claimed by this release. The app and Kanban are healthy. Air/CSG are outside this scoped rollout. Mini recovery remains explicitly deferred. Roadmap c3.22 remains open for Madrid runtime recovery and final live response acceptance.
