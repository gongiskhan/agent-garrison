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
and live HTTPS checks remain pending the final backend candidate.

Real iPhone microphone, APNs and keyboard gates still require the device. Browser
viewport checks are evidence for responsive web layout, not those native gates.
