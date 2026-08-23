# Running the operative on the ChatGPT plan via the OpenAI Agents SDK

**Date:** 2026-08-23
**Supersedes in practice:** the short-lived all-Codex `codex` composition
(renamed to `openai`).

## The question that started it

"Can the OpenAI Agents SDK take a subscription auth token like the Anthropic
Agent SDK does?"

**Not natively, and the asymmetry is structural.**
`@anthropic-ai/claude-agent-sdk` handles `CLAUDE_CODE_OAUTH_TOKEN` first-class
because it drives the very client the Max subscription is issued for.
`@openai/agents` 0.13.2 + `openai` 6.46.0 carry no subscription mode at all: the
only non-api-key auth in the tree is workload-identity federation (k8s SA / Azure
managed identity / GCP ID token) exchanged for a PLATFORM token, and there is not
one reference to `chatgpt.com` or `backend-api` in either package. OpenAI's own
Codex auth docs say ChatGPT sign-in is for Codex CLI/IDE/desktop and that general
API access needs a Platform API key.

## What we built instead

A **`chatgpt-subscription` provider** inside `openai-agents-runtime`. It is the
first provider here that is neither key-authenticated nor chat-completions:

- **Credential**: the OAuth `auth.json` that `codex login` mints, read out of the
  **pinned Account's** config home (`CODEX_HOME`, which the Accounts layer already
  sets per account). `lib/chatgpt-auth.mjs` checks expiry, refreshes against
  `auth.openai.com/oauth/token`, and writes back atomically at 0600. The refresh
  is **single-flight**: a rotating refresh token is single-use, so two concurrent
  exchanges would persist a token the server already replaced - a self-inflicted
  logout.
- **Transport**: `lib/chatgpt-transport.mjs` resolves the bearer per REQUEST (so a
  long-lived gateway survives token expiry), stamps `chatgpt-account-id` and
  `originator`, retries once with a forced refresh on 401, and normalises the body
  to the three rules the backend demands: `store:false`, non-empty `instructions`,
  `include: ["reasoning.encrypted_content"]`.
- **Wire API**: a `wireApi` property on the provider selects `OpenAIResponsesModel`;
  the Codex backend serves only `/responses`, while every other provider here
  serves `/chat/completions`. It also **requires streaming** - a non-streamed call
  is refused with `{"detail":"Stream must be set to true"}` - so that lane runs the
  streamed loop and checks `result.error` (a streamed run reports mid-run failures
  on the result rather than by rejecting).

## Verified, not assumed

Everything below was read off the live backend before it was written down:

- The model catalog returns 200, and the tier mapping comes from its own
  descriptions: `gpt-5.6-sol` "Latest frontier agentic coding model",
  `gpt-5.6-terra` "Balanced agentic coding model for everyday work",
  `gpt-5.6-luna` "Fast and affordable agentic coding model". That is the
  Opus/Sonnet/Haiku mapping, sourced rather than guessed.
- A `/responses` call reaches a real `usage_limit_reached`, which proves auth,
  model and body all validate.
- The pinned-account path resolves end to end: `account: codex-gmail` → account
  home → `chatgpt-auth` → 200 from the backend, with an account id distinct from
  the other OpenAI account.

## Two defects this uncovered

1. **Reasoning effort was recorded but never sent.** `buildRunParams` did not
   carry it, and every provider declared `effort: false`, so nothing surfaced the
   gap. It now rides `modelSettings.reasoning`, and `effortApplied` only claims
   true when the value will really be forwarded. This matters more here than
   anywhere else: one model family at several depths IS the tier system.
2. **The OpenAI client wraps anything thrown out of its fetch** as a bare
   `APIConnectionError: Connection error.` A usage-limit refusal - the single most
   likely failure on a plan-backed runtime - arrived looking like a network fault.
   The client preserves `cause`, so the transport's diagnosis is unwrapped and
   rethrown.

## A new provider kind: `runtime-managed`

Provider entries are policy data with a base URL and a vault key. This provider
has neither: the runtime resolves its own credential from the account home, and
its endpoint is fixed by the fitting. Projecting either would be inventing it. So
`PROVIDER_KINDS` gains `runtime-managed`, and `buildPrimaryRuntimeEnv` returns
early for it with only the `GARRISON_PROVIDER` marker. The entry still exists as
policy data because a target naming an unlisted provider is a routing error, and
it is the one place an operator can see which endpoint the plan talks to.

## Honest scope

This is **not a documented OpenAI integration**. The credential is sanctioned for
Codex clients; the backend routes the gpt-5.6 family only for a recognised
`originator` (we send the Codex CLI's, because that is the client this credential
is issued for); and it rides the plan's usage limits rather than escaping them -
it buys a better harness, not more capacity. It can break whenever that private
contract moves. The metered alternative is unchanged and one config key away:
provider `openai` with a Platform API key.

## Known residue

`improver`'s `dream_model: haiku` still runs through `@garrison/claude-pty`'s
one-shot Claude path rather than the router, so that one consolidation pass is
Anthropic even in the `openai` composition. Re-plumbing it to the routing table is
separate work.
