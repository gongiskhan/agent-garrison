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

The live acceptance and remaining environment limits are recorded below.

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

## Accepted release — 2026-09-10 09:03 UTC

Runtime release `697f214f20e25e844fbff91aebb7005365f2d6d6` is on main.
Pro, Air, Mini and CSG have healthy deployment receipts for that revision.
Pro/Air/Mini each report 41 successful verify hooks and 16 healthy views; CSG
uses its smaller composition. Madrid has the same source revision and the
preceding `a8e0d428` runtime. Its separate active Capture task has uncommitted
work: a non-overlapping fast-forward preserved that work, and no app/gateway
restart was forced. The main catch-up worker will deploy when safe.

The real previous-day run `nightly-mesh-2026-09-09` completed at
09:02:42 UTC with all five owner reviews complete and seven proposals recorded
across those reviews. Its existing occurrence `01M24GQCFA8H522TDTM6K6NP8M`
recovered from Needs Attention to Done. The original template
`0137DBYSVP4W6XSQSG8FQRMR7D` is Nightly Sync, autonomous, scheduled at 03:00
Europe/Lisbon; its next occurrence is 2026-09-11 02:00 UTC. Retries join completed
owner/day reviews rather than rerunning their models or rotating Zeca twice.

The configured review model is Claude Opus 5. The final Pro review returned three
valid, source-cited proposals with no dropped findings or operational errors.
Per-request output schemas now constrain citations to that owner's collected
evidence IDs. Pending findings remain decisions, not automatically verified facts
or user approvals. Legacy findings retain their provenance; demonstration autonomy
was not imported. All five tracks require review until the user promotes them;
five consecutive verified, user-kept outcomes recommend promotion but do not grant
it. Creating an implementation task never counts as keeping an improvement.

Desktop and 390px browser layouts were inspected on published HTTPS origins. The
core page is a permanent Command entry, with shared Decisions, Daily reviews and
Autonomy surfaces. Real authoring saved and read back the explicitly requested
Nightly/main decision through Basic Memory; the owned note's verified SHA-256 is
`0c247a5ab0cb4f626988ff84a822c83be7ace4c0ca17f321d9dcd5ab39cf83e8`.
Native notices have successful companion-push provider receipts for one registered
device, including the live review outcomes. This does not prove physical display.

The final core suite passes 26 tests, including owner-specific citation enums,
claim/CAS recovery, idempotent task retry, outcome/autonomy handling, vault receipt
matching and push-delivery races. The 79 shell/schedule/Zeca/tick regressions,
35 gateway/authentication checks and seven deployment-guard tests passed; production
builds and type checking passed. Owner test evidence includes
`/tmp/garrison-core-improver-citation-tests.log`,
`/tmp/garrison-core-improver-operational-tests.log`, and the earlier logs above.
All standing Zeca threads were empty during live acceptance, so their nightly
phase correctly did not rotate them. Non-empty review, concurrent-input and
failure-preservation behavior is tested, not claimed as a non-empty live run.

## Operational recovery and limits

Automatic quarter-hour vault sync was verified through shared scheduler receipts
on all four configured primary nodes. CSG intentionally has no vault fitting;
Nightly distinguishes unconfigured sync from missing, disabled, failed or stale
configured sync. Optional missing git telemetry no longer causes a false branch
alarm; observed non-main branches still do.

Madrid rebooted during rollout (previous boot ended 08:33 UTC, new boot began
08:39 UTC); its cause was not established. No host reboot was issued by this work.
After recovery its composition was idle while a separate Capture task was active.
Only its existing remote-shell fitting was started to restore CSG's relay; the
Capture edits and app/gateway were preserved. The existing tunnel/tether repair
APIs restored both forward legs and the reverse state leg without restarting CSG.
Earlier stale forwarding-only SSH children were identified by exact listener
ownership before targeted termination. CSG now has a validated SSH drop-in with
ClientAliveInterval 30 and ClientAliveCountMax 3 to reclaim vanished relay clients;
the listener was reloaded without terminating active child sessions.

Air's final startup exposed missing Claude command links while its installed
2.1.214 native binary remained executable. Restoring the absent links recovered
41/41 verification and 16/16 views without changing that binary or interrupting
its existing Claude process.

Cortex defaults to `https://staging.ekoa.io`, as requested. Its new integration
endpoint is reachable, but the current saved credential returns HTTP 401 and needs
a staging-valid key entered through Connectors. Google consent and physical-phone
acceptance remain user steps from the earlier connector/Capture release; this
release does not claim them. State authority still depends on Madrid being online.
