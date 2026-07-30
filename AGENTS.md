# AGENTS.md

See [CLAUDE.md](./CLAUDE.md) for the project entry point. The original
bootstrap spec is preserved verbatim at
[docs/SPEC.md](./docs/SPEC.md); the live roadmap is at
[docs/GARRISON_ROADMAP.md](./docs/GARRISON_ROADMAP.md).

A Fitting that wraps a **remote capability provider** follows the consumer rules in
[docs/CAPABILITY_CONTRACT.md](./docs/CAPABILITY_CONTRACT.md): public contract only (generated
client/CLI, never provider internals), never ask a provider to special-case Garrison, every call
carries a user-scoped key delivered through `secret_scope`, no tenancy machinery in this repo, a
local or null backend as the shipped default with the remote one opt-in, and no bridge code here.

One rule worth repeating here because it shapes every UI decision: Garrison
runs on one machine but is **used from other machines and mobile over the
HTTPS tailnet address** — never hand the browser a machine-local absolute URL
(see "Instances, ports, and deploying" in CLAUDE.md for the full rule and the
loopback + tailnet URL-pair pattern).
