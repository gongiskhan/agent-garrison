# Capability Contract (consumer side)

How a Fitting talks to a **remote capability provider** - any service that implements the capability contract
described here. Garrison ships no such service and depends on none. This document exists because a Fitting that
wraps a remote API is a recurring shape (a memory store, an automation runner, a knowledge index), and the shape
needs one set of rules so those Fittings stay swappable, honest, and safe to run on a personal machine.

The rules below are justified on their own merits for a local-first agent workstation. They are provider-agnostic
by construction: a Fitting may consume **any** provider implementing the contract. Ekoa's Cortex happens to
implement it and serves as the reference implementation, which is where the mirrored provider-side text lives
(`docs/CAPABILITY_CONTRACT.md` in that repo). Nothing here is required by, or for, a particular consumer or
provider - see the Honesty Test in [GOVERNANCE.md](./GOVERNANCE.md) section 3.

## The pattern

A capability is implemented once, by the provider, and exposed as a public, versioned, OpenAPI-documented API.
The consumer is an ordinary API client: the Fitting becomes a view over the contract, hooks call the API, and an
in-session agent reaches the capability through a thin CLI generated from the same spec. Every call carries a
user-scoped API key, so tenancy and authorization stay where they are already implemented and tested, on the
provider side. The two sides stay decoupled; the only coupling is the contract.

## About "talks only to `localhost`"

[CLAUDE.md](../CLAUDE.md) positions Garrison as open-source, local-first, single-user, no auth, talks only to
`localhost`. That line describes **Garrison's own shell**: the app server, its APIs, and its UI are local. Local here
means *runs on one machine*, not *reachable only from it*: prod publishes its views to the tailnet via
`tailscale serve` and is normally driven from another device (the HARD RULE in [CLAUDE.md](../CLAUDE.md),
"the user's browser is almost never on the Garrison machine"), so the line is about who owns and runs the
server, not about which sockets it listens on. It has
always coexisted with outbound network calls made by Fittings the user explicitly equips and keys:
`fittings/seed/deepgram-voice/` reaches `https://api.deepgram.com` with a vault-held `DEEPGRAM_API_KEY`, and the
model runtimes reach whichever provider the composition selects (`fittings/seed/agent-sdk-runtime/lib/providers.mjs`
carries `https://api.z.ai/...`, `https://api.deepseek.com/...`, `https://api.minimax.io/...`;
`fittings/seed/claude-code-runtime/apm.yml` swaps `ANTHROPIC_BASE_URL` per provider).

An opt-in, key-scoped API client for a capability is **the same shape as those**, not a new category: user-chosen,
user-keyed, secret-scoped, off by default, and removable by unequipping the Fitting. Stating this plainly is the
point - the positioning line is about the platform, and a Fitting that egresses does so with the user's explicit
key and consent.

## The rules (consumer form)

**Rule 2 - consume only the public contract.** A Fitting calls the provider through the generated client (or the
generated CLI), against documented public endpoints. Never a private endpoint, never provider internals, never a
second hand-written HTTP path for a capability that already has a client. *Why it stands alone:* a hand-rolled
path drifts the moment the provider changes, and a Fitting that reaches into internals cannot be pointed at a
different provider - which is the whole reason to have a contract.

**Rule 3 - never ask a provider to special-case Garrison.** If a Fitting needs something the contract does not
offer, the contract changes for every client; a provider-side branch keyed on "this consumer" is not an option.
An origin/client header is diagnostics only, never behaviour. *Why it stands alone:* a capability that behaves
differently for one client is untestable from here and unswappable in practice.

**Rule 4 - every call identifies a user.** A remote capability call carries a user-scoped API key the user minted
themselves, held in the Vault and delivered only to Fittings that declare it. No shared credential, no ambient
identity, no anonymous capability endpoint. *Why it stands alone:* the Vault is already the single place a secret
lives on this machine (`src/lib/vault.ts`: AES-256-GCM at `data/vault.json`, mode `0600`, the per-file key
HKDF-SHA256-derived from an OS-keychain master key), and per-Fitting `secret_scope` delivery is already
fail-closed (`src/lib/own-port-lifecycle.ts`: a Fitting that consumes `vault` but declares no
`x-garrison.secret_scope` receives no secrets, with an audited denial). A keyed API client needs no new
machinery.

**Rule 5 - no tenancy machinery in this repo.** Scoping, isolation, and per-tenant storage are the provider's
job, verified by the provider's own isolation tests. A Fitting stores no tenant ids, builds no per-tenant paths,
and implements no isolation logic. *Why it stands alone:* Garrison's trust boundary is one machine, one user,
one account (GOVERNANCE section 2, "Local trust boundary"). Inventing tenancy here would add an unenforceable
security surface to a single-user app.

**Rule 6 - local defaults, always; a remote provider is opt-in.** Every Fitting that wraps a capability ships a
local or null backend as the **default**. The remote backend is configuration: a base URL in `config_schema`
(projected as `<FITTING_ID>_<KEY>` by `setupConfigEnv` in `src/lib/runner.ts`) plus a key under `secret_scope`.
No provider key, no provider URL, and no provider dependency in the shipped defaults. *Why it stands alone:* a
fresh clone with an empty vault must compose and run. If a Fitting only works once you hold an account
somewhere, it is not a Garrison Fitting; it is that service's client.

**Rule 9 - no bridge code here.** If a remote provider needs to reach back into this machine, that path is the
provider's bridge, implemented and secured on the provider side. This repo ships no counterpart daemon, no
inbound listener for a remote capability, and no delegation endpoint. *Why it stands alone:* an inbound path
into the user's machine is exactly the thing a local-first, no-auth app must not grow.

## Building a capability Fitting

1. **Default backend first.** Implement (or stub) the local/null path and make the Fitting useful with it. That
   is the shipped default.
2. **Add the remote backend as configuration.** A `backend` (or equivalent) config key selecting local vs remote,
   a `base_url` key, and `consumes: vault` with an explicit `secret_scope` for the key. Unset config means local.
3. **Call through the generated client or CLI only** (rule 2). Wrap it thinly; the Fitting's value is the view
   and the wiring, not a second protocol implementation.
4. **Declare the view.** Every Fitting has at least one `ui.views[]` entry or `own_port: true` - see
   [UI-FITTINGS.md](./UI-FITTINGS.md).
5. **Verify both paths.** The `verify` hook must pass with no key set (local default) as well as configured, or
   the Fitting is not done.

## See also

- [GOVERNANCE.md](./GOVERNANCE.md) - the Honesty Test, positioning principles, and the consumer-leakage rules
  this document is written to satisfy.
- [FITTINGS.md](./FITTINGS.md), [METADATA.md](./METADATA.md) - the manifest contract, `config_schema`,
  `secret_scope`, `provides`/`consumes`.
- [CAPABILITIES.md](./CAPABILITIES.md) - the capability kinds a Fitting may provide or consume.
