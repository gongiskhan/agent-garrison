# AGENTS.md

See [CLAUDE.md](./CLAUDE.md) for the project entry point. The original
bootstrap spec is preserved verbatim at
[docs/SPEC.md](./docs/SPEC.md); the live roadmap is at
[docs/GARRISON_ROADMAP.md](./docs/GARRISON_ROADMAP.md).

## Codex on macOS

When this checkout is edited on the Mac, the Mac is an editing and Git client
only. The authoritative checkout, project runtime, tests, services, and
deployment environment are on `dev-madrid`. Follow
[docs/REMOTE_MAC_WORKFLOW.md](./docs/REMOTE_MAC_WORKFLOW.md); never install or
run the Garrison Node.js runtime locally, and never sync an uncommitted snapshot
into the live VM checkout.

Before meaningful work, check for `PRD.md`, `PLANING.md`, and `TASKS.md` and use
them when present. Search the authoritative Basic Memory project `main` on
`dev-madrid` before re-asking historical Garrison decisions, then verify memory
against the repository and live VM. After a meaningful decision or non-obvious
operational discovery, update a stable Garrison topic note without secrets or
raw transcript material. See
[docs/CODEX_MEMORY_WORKFLOW.md](./docs/CODEX_MEMORY_WORKFLOW.md).

Claude's existing and future Garrison-native memory notes are mirrored into
`Projects/Garrison/Memory/Claude Native` in that same vault before its scheduled
Git sync. Use the curated topic notes first and the generated native mirror for
detailed historical context; never edit the generated copies or copy raw
Claude sessions into the vault.

The Codex workflow is intentionally selective. Do not import Claude settings,
hooks, transcripts, Auto-thing or phase skills, Improver probes, the old
`run-garrison` skill, or the archived `garrison-codex` profile. Durable required
behavior belongs here or in `CLAUDE.md`; generated agent memory is supporting
context, never authority.

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
