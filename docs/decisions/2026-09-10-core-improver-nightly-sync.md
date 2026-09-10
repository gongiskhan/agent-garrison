# Core Improver and Nightly Sync

The operator asked on 2026-09-10 to make continuous improvement a core Garrison
responsibility, with particular attention to orchestration, duty levels, skills,
Garrison defects, daily session learning and useful autonomy decisions. This
supersedes the older rule that the Improver must remain an optional fitting.

## Audit

The old nightly CLI is partly an acceptance demonstration: its skill pass applies
and restores a candidate and sets a rule to auto as a demo. Its Run Now server
uses a different subset of rules. Several proposal classes fall through to a
markdown append instead of changing their intended target. Review queues and
autonomy differ per node. The four primary nodes all claim memory-primary and
their latest dream passes fail at the Claude TUI login/setup screen. These are
functional gaps, not reasons to discard the existing evidence collectors.

The shared scheduler ledger confirms successful quarter-hour vault sync on all
four primary nodes; old local scheduler files are stale materialisations. The
existing Nightly mesh convergence card still instructs node-branch merging and
destructive rollback even though main catch-up is now automatic.

## Implementation contract

- `/improver` is a permanent Command surface, with a shared decision queue,
  per-track autonomy and a run history. Legacy fitting links lead there.
- One production review pipeline serves manual and scheduled runs. It reviews
  bounded evidence on each owner node; raw sessions remain there. Shared records
  contain findings, source references, exact proposed changes and outcome receipts.
- Separate collecting, reviewing, applying and verifying. Empty evidence is a
  successful empty review; unavailable inputs and model failures are visible.
  Never count creating a task or appending a note as applying a code/policy change.
- Mechanical edits require an exact baseline, an allowlisted authoring path and
  verification. Larger changes become actionable tasks with acceptance criteria.
  Rejections and failed/reverted changes teach the matching track. Only the user
  can promote a track to automatic; recommendations use verified kept outcomes.
- Preserve legacy findings and decisions with provenance, without importing demo
  auto settings as user consent. Superseded jobs cannot continue running the old
  demonstration pipeline after the core migration.
- Nightly Sync keeps the existing scheduled card identity and history. It checks
  code/deployment and vault-sync health, reviews Zeca on its owner, runs daily
  improvement and proposes durable memory learnings, and records a concise outcome. It
  does not merge branches, restart active Conversations, or duplicate quarter-hour
  sync. Failures and human decisions link to the Improver page and its push notices.
- Scheduled occurrences inherit the template's autonomous setting. Enabling
  autonomy on a scheduled card also selects automatic scheduled execution.
- `/clear` is an explicit local-command completion only; quiet tool calls and
  normal prompts keep their existing activity semantics.

## Verification

Pre-release validation on MacBook Pro: isolated production build passed;
TypeScript passed; 179 of 180 broad regressions initially passed, with two UI
wording violations subsequently corrected. The final affected core/state,
gateway, Zeca, tick and vocabulary suite passes 54 tests. The 66 narrow
session/scheduling tests and Cortex fixture suite pass. Test records are in
/tmp/garrison-core-improver-final-tests.log and
/tmp/garrison-improver-regressions.log on the owner.

Migration removes only the two legacy fittings, preserves unrelated composition
settings, imports old findings without demo autonomy, and retires their known
scheduler jobs. Manual review and nightly Zeca phases have distinct daily claims.
Core recovery handles expired workers and interrupted authoring; task creation
uses a stable identity, while a failed revert retries the revert.

Deployment and live review/UI/notification acceptance are in progress.

## Live rollout findings

The first Air review caught a missing installed core dependency and an unavailable
interactive Claude login. Redeploy now installs the committed dependency graph;
core review inference can use existing sealed Anthropic accounts after an
authentication failure, while preserving explicit account pins. A real Air review
then completed inference with valid source citations and an empty proposal list.

Native push is verified from provider receipts rather than HTTP status: a release
notice returned companion-push success for 1/1 registered devices. Zero-recipient
web responses remain pending and are retried, including through another mesh
node's native provider. Physical iPhone display was not observed.

Vault jobs are stored with node suffixes but executed and recorded under their
local base ID. Nightly checks match both IDs and the owner; recent successful
quarter-hour receipts exist on all four primary nodes. The staging Ekoa endpoint
is reachable, but the current Cortex credential returns HTTP 401 there.

Deployment regenerates APM installation receipts and the compiled Kanban bundle.
These are now ignored runtime outputs; their sources remain tracked, and setup
rebuilds the bundle. Existing node outputs were compared and preserved in Git
stashes before catch-up. YAML formatting was normalized without changing values.
A verified build can be reused when a concurrent mesh restart defers deployment;
source changes during a build refuse publication and require a fresh build.
