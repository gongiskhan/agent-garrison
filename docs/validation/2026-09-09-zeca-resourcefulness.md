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

Deployment and live model acceptance are pending. The live check must use a
fresh responder stretch, observe real lookup calls and assess its final answer;
a tool list or prompt inspection alone is insufficient evidence.
