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

Pending execution against the committed candidate on dev-madrid:
`tests/talk-responsive-browser.test.ts` covers desktop navigation, filtering,
tablet drawer focus, long drafts and composer bounds at 320, 390 and 768px.
Existing Conversations runtime, input, voice and mesh suites must also pass.
Final live checks use the HTTPS tailnet origin, including phone and tablet layouts.
Real iPhone microphone, APNs and keyboard gates still require the device.
