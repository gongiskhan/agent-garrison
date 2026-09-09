# Zeca answer resourcefulness — 9 September 2026

The reported responder answered a weather question by saying no weather
connector was installed and suggesting a different app. It also appended an
unrelated update from earlier work.

## Change

- The shared Agent SDK working-tool profile includes `WebSearch` and `WebFetch`.
  Responder, dialogue, discuss and research receive these through the same
  profile. Read-only triage, explicitly pinned inventories, lean targets and
  non-SDK runtimes retain their existing restrictions.
- The generated catalogue distinguishes installed providers from native runtime
  tools. Absence of a domain connector is not evidence that a question is
  unanswerable.
- The authored execution-policy default calls for current reliable sources,
  useful alternative queries/sources/methods after failure, one essential
  clarification when needed, and honest supported partial answers. It forbids
  invented facts, citations, tool access or attempts and respects denied access.
- Responder guidance permits a bounded lookup within the reply and follows the
  latest question, including a topic change, without unrelated old work updates.
- The SDK harness describes its explicit native inventory and tells the model
  to discover deferred tools by their exact names. Denied tools and lean
  targets are not advertised. The initial live Haiku probe searched for
  `weather|forecast`, got no deferred-tool match, and incorrectly declared web
  tools absent. This follow-up addresses that observed discovery failure.

Existing authored overrides are preserved. A composition that explicitly
overrides its execution policy retains that policy; the default composition
currently overrides only routing philosophy. No connector or account was added.

## Verification

157 focused tests pass across `harness-profiles`, `agent-sdk-runtime`,
`orchestrator-sections`, `orchestrator-projection`, `stretch-launcher` and
`gateway-agent-sdk-route`. The first sandboxed run could not bind one localhost
fixture; rerunning the gateway tests with localhost binding available passed.
The profile tests cover web-tool delivery to conversational duties, shared
inventory equality, read-only intake and explicit/lean/non-SDK restrictions.

The first change was deployed on the Pro as f64eefc1 with 43/43 startup checks.
Live acceptance found the deferred-tool discovery failure described above;
two subsequent Sonnet admissions timed out waiting for MCP startup before any
prompt was sent. A standalone SDK Sonnet lookup with native WebSearch worked.
That isolation check does not establish gateway acceptance. The inventory
follow-up and its live gateway acceptance are pending.

The c5f003f5 follow-up was deployed successfully. A real Haiku responder in the
previously refusing conversation now called WebSearch and WebFetch. Search
succeeded, but it mishandled a unit conversion, linked generic home pages, and
made an invalid WebFetch call. A Sonnet failed-bookmark case used WebSearch and
returned a sourced forecast, then replaced its final reply with internal
handoff commentary. A no-location case correctly asked for the city but added
an unsolicited translation and initially used an invalid completion marker.
The final prompt refinement makes the final reply the user-facing answer after
bookkeeping, with checked source URLs, verified units, one language, and the
proper clarification completion marker. Its final live acceptance is pending.
