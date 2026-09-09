# Cards from conversations

Scope: the Pro node, web Conversations and Kanban Loop. No mesh rollout or native iOS feature was added.

## Implementation

- Work conversations create one Running card on the first user message, with the same card/conversation identity. Empty conversations, Zeca and shell conversations are excluded. Title inference uses the existing conversation title with no additional model call; manual card rename locks it. The original first message is preserved, including messages longer than the ledger preview. Runtime exit, cancellation, crash and archive finish the card; continuing reopens it. Manual Done leaves the runtime alive.
- Zeca's web header offers an editable card draft from ten messages, widening by ten to fifty. The latest card's message boundary applies only to the default window. Tool and operational records are excluded, assistant revisions are merged, and attachments use filename markers.
- Inference uses the cheapest configured Anthropic ladder target through the existing logging proxy, 800 output tokens, a20-second deadline and one retry. Haiku4.5 has no effort API parameter, so its existing low-cost behavior uses disabled thinking; models supporting effort receive low. Failed inference produces the editable verbatim transcript. The API returns the created To do card with a warning when starting or scheduling fails.
- The UI reuses the board sheet, date/time picker and conversation toast. Source and card links work in both directions, including assistant-message coordinates and unavailable sources. Both creation event shapes are recorded in the conversation ledger.

## Verification

The automated harness starts real local HTTP servers for shared state, the board, Conversations and the gateway, with an isolated home. Its runtime adapter launches real child processes under fixture control. Inference responses are controlled for reproducible error and topic-window checks; these checks alone do not prove provider inference quality.

All sixteen card browser tests pass, covering the eleven requested journeys plus Retry/edit retention, field validation, deleted sources, empty/native-host exclusion and assistant-message jumps. Forced child termination and manual Done without stopping the child are also covered. Service and endpoint tests cover window sizes, boundaries, JSON validation/retry, timeout fallback, long messages, error codes, all actions and ledger fields. TypeScript and both fitting browser bundles pass.

The full-suite run exposed stale expectations for the collapsed native list and shell-control endpoint, plus fixtures that did not inline the extracted shared stylesheet. These have scoped fixture corrections. A Send-button CSS specificity bug at tablet width was fixed while preserving the existing44px minimum.

Owner evidence: `evidence/cards-from-conversations/` on the Pro checkout. Screenshots include board, chip and card at1280px; completed and resumed states; Zeca modal, toast and card; scheduled card; and overflow, fullscreen modal and toast at390px. The screenshots were visually inspected.

Final full-suite result, deployed provider inference and HTTPS acceptance are pending at this checkpoint.
