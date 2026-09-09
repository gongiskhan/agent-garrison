# Zeca answer resourcefulness — 9 September 2026

The reported responder declined a weather question because no weather connector
was installed and appended an unrelated update from earlier work.

## Changes

- Shared Agent SDK working duties now receive WebSearch and WebFetch. Explicit
  operator inventories, denied tools, lean targets and read-only triage retain
  their restrictions.
- The provider catalogue distinguishes installed fittings from native tools.
  The SDK advertises its actual explicit inventory and explains exact-name
  discovery for deferred tools. A missing domain connector is not a prerequisite
  for answering public-information questions.
- Zeca should seek current sources, try useful alternative queries or methods,
  ask for essential missing details, and offer supported partial answers without
  inventing facts, tool access or attempts. Responder follows the latest topic,
  links checked sources, checks units and finishes with the answer in the user's
  language after its internal bookkeeping.
- Clarification uses a completed responder stretch with a work/needs-input
  handoff. Asking for a missing detail is not a fabricated failed approach.
- SDK message assembly preserves every content block when one API message
  arrives as multiple settled envelopes. Previously only thinking survived a
  later shard: a forecast was visible during streaming and then overwritten by
  handoff commentary. Stream indices, tool identities and replay deduplication
  are preserved. This delivery fix is awaiting final deployment/acceptance.

Existing authored execution-policy overrides are preserved. No connector,
account, default model or MCP startup policy changed. The rollout is on the Pro;
other mesh nodes have not been deployed by this task.

## Verification

283 unique focused tests pass across the runtime/harness, orchestrator assembly,
conversation loop, SDK event normalizer and conversation transport/UI-context
suites. Localhost fixtures require execution outside the shell sandbox.
The new regression reproduces an answer followed by text and tool shards, and
checks partial completion, settled-only messages and duplicate-free replay.
A local-only replay of this task's synthetic Porto SDK response confirms the
previously lost answer and source links survive in the final event revision.

The Pro production build 8543e184 started at 20:24:20 UTC with 43/43 startup
checks and 17/17 healthy views. Source and installed runtime files matched.
The final message-delivery refinement is pending deployment.

Live synthetic Conversations already demonstrate real web lookup by both
Sonnet and Haiku, a fresh lookup after changing Lisbon to Porto, and alternate
forecast sources when the supplied bookmark is invalid. Sonnet returned a
Portuguese forecast with specific source links. Missing-location prompts asked
for a city instead of assuming the server location. The initial tool-discovery
refusal and two MCP admission timeouts are recorded in the owner evidence; the
MCP timeouts did not recur after normal redeployment.

These probes do not certify forecast accuracy: Haiku still produced an invalid
WebFetch argument, inconsistent source citation/language, and an earlier unit
conversion error. An earlier clarification also failed its handoff schema;
explicit clarification guidance was refined. The broader model-quality issue
is not claimed solved. Browser inspection timed out, so there is no new
screenshot or real-phone acceptance claim.

Owner evidence is under output/verification/zeca-resourcefulness/ on the Pro:
final-health.json, followup-*.json, local-replay.json and the bounded probe scripts.
Raw session evidence stays on its producing node and is not copied to memory.
