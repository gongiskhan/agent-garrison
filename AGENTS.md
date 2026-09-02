# AGENTS.md

See [CLAUDE.md](./CLAUDE.md) for the project entry point. The original
bootstrap spec is preserved verbatim at [docs/SPEC.md](./docs/SPEC.md).

## Roadmap

The plan of record is [`roadmap.json`](./roadmap.json) at the repo root, edited through the Roadmaps view and the roadmap CLI. Agents are the main authors and maintain it as work lands; notes hold decisions. See [docs/GARRISON_ROADMAP.md](./docs/GARRISON_ROADMAP.md) for the decision log and history.

## The mesh, in one paragraph

Garrison is installed as a **full node on every machine** (dev-madrid, Mac
Pro, Mac mini, MacBook Air), all live, no main/dev asymmetry. Safety comes
from a strict state split, and every agent working in this repo must know it:
**shared state** lives in exactly one place - the state service on dev-madrid
(SQLite behind an authenticated, tailnet-only HTTP API at
`services/state/`; no process ever opens the DB file directly); **code**
moves only through git (one clone per node, each on its permanent
`node/<id>` branch); **session artifacts** (plans, evidence, logs,
transcripts) stay on the node that produced them, with a nightly one-way
plans/evidence backup to dev-madrid and 7-day retention; **memory** moves
through git via the vault-git-sync fitting (15-minute cadence on every node,
session-start pull, session-end push, staggered nightly backstop). Nothing
is ever synchronized by ad-hoc file copy.

A node is enrolled by `~/.garrison/state.json` (url + bearer token + node
name, minted on dev-madrid by `services/state/scripts/issue-node-token.mjs`)
and identified by `~/.garrison/node.json` (permanent name + closed-palette
accent). Sessions are pinned to their home node; viewing, steering,
answering and stopping route through `/api/mesh/nodes/<node>/...` from
anywhere. Cards are pure state: created anywhere, run on the card's
placement target.

## Availability property (accepted deliberately)

**When dev-madrid is down, no node can bring a composition or project up** -
`up()` and project bootstrap render secrets from the state service's secret
authority, and there is no offline mode, no cache, and no write queue by
design. A running session keeps running; new work blocks with a clear error.
The same authority serves the per-fitting scoped delivery: an own-port
fitting's `secret_scope` is resolved through `POST /v1/secrets/resolve`
(`scopedSecretsViaAuthority` in `src/lib/composition-sync.ts`), never from the
node's local vault, which the mesh leaves empty. A fitting started while the
authority is unreachable or refuses the grant runs keyless with a spawn record
that says so (`secretsDelivered: false`), and the next `up()` heals it.
This is consistent with Garrison's online-only positioning: a fork of shared
state is worse than a clear stop. The state DB itself is snapshotted hourly
(VACUUM INTO) and the newest daily snapshot ships off-box to a Mac -
durability never has a single home even when state does.

## Merge policy (aggressive, two rails, one revert command)

Merges run **fully autonomously**. Merge whenever there is a reason -
breakage, schema mismatch, an explicit request, the nightly convergence card
- not on every push. Two mandatory rails on every non-trivial merge:

1. **Preserve the pre-merge ref**: tag
   `garrison/premerge/<project>/<node>/<stamp>` before resolving anything.
   Reverting a bad merge is one command:
   `node scripts/garrison-converge.mjs revert <project> <tag>`.
2. **File a decision card** recording what was decided and why, so morning
   review is a skim. Trivial fast-forwards file nothing.

Never `git merge -X ours` / `-X theirs` (how a day's work vanishes
politely). Lockfiles (`package-lock.json`, `apm.lock.yaml`) are
**regenerated, never merged**. Binaries are refused and escalated. Conflicts
are resolved file-by-file with both sides read in full, and the result must
parse. The merge duty lives in `fittings/seed/merge-agent/`; the doctrine is
its `garrison-merge` skill.

The nightly convergence card (03:00, systemKey `mesh-convergence`) converges
the Garrison codebase and every dev project: clean nodes only ("clean" =
empty tree AND nothing unpushed AND no merge in progress AND **no running
session with the repo as cwd**), dirty nodes are skipped with a
notification, and a 3-night skip streak escalates to needs-attention naming
the drift. Per-node redeploys are delegated to the converge one-shot
(`scripts/garrison-converge.mjs`) and POLLED through a convergence intent -
the card never owns the process that kills it.

## Branch discipline

Every node works on its permanent `node/<id>` branch, dev-madrid included;
`main` is updated by the nightly card (or an on-demand converge). The
no-new-branches hard rule stands: node branches are created ONCE by
`scripts/install-node.sh`, never by an agent.

## The web channel exception

Garrison's rule is that it ships no chat surface: talking to the operative is
Channel-Fitting work. Since 2026-09-01 there is one bounded exception. The
conversation surface (the former `web-channel-default` UI and API) is served by
the shell at `/talk` as "Conversations", from the `@garrison/talk` package
mounted by the app's `/api` catch-all. The reason is the Garrison iOS app: a
webview needs one origin for the shell, the conversation and web push, and a
channel on its own port breaks that (a second origin, a second service worker,
mixed-content over the tailnet). What did NOT move: the gateway still owns the
turn, the thread store stays at `<GARRISON_HOME>/web-channel/threads/`, and
Slack, WhatsApp, Omi and email stay Fittings. The legacy own-port host is kept
in `fittings/seed/web-channel-default`, unstationed by default, until the
operator triggers its removal (`docs/decisions/2026-09-garrison-app.md`, D2,
D16, I12). Servers reach Conversations through `GARRISON_APP_URL`; browsers
through the relative `/talk` routes (docs/UI-FITTINGS.md "Conversations is a
shell route").

## Codex on macOS

Every machine in the mesh runs its own full Garrison node, so a Mac is no
longer an editing-only client: it builds, tests and serves locally. Two
rules from the retired remote workflow still hold and are enforced by
`scripts/install-node.sh` - refuse to adopt a checkout reached through a
symlink, and never sync a working tree into a checkout a service is
executing from. Code moves between nodes through git and nothing else. See
[docs/INSTANCES.md](./docs/INSTANCES.md).

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

One rule worth repeating here because it shapes every UI decision: a Garrison
node runs on its machine but is **used from other machines and mobile over the
HTTPS tailnet address** - never hand the browser a machine-local absolute URL
(see "Instances, ports, and deploying" in CLAUDE.md for the full rule and the
loopback + tailnet URL-pair pattern).
