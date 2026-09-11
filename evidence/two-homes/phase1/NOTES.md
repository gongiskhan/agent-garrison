# Two homes — phase 1

11 September 2026. Evidence owner: dev-madrid. Phase 1 is in progress; its live restore/deploy gate is not yet green. No phase 2 changes have begun.

## Ground truth before implementation

1. `scripts/garrison-instance.sh`: only node uses `$HOME/.claude`. Dev and codex use isolated config homes, with `CLAUDE_CONFIG_DIR` set and `.claude.json` inside that directory. Preserve this proven layout for the Garrison home; the stretch module's sibling JSON layout is not the model.
2. SDK harness coding mode has `settingSources: ["user", "project"]`. The launcher's config directory controls user settings. No per-duty narrowing is proposed.
3. Gateway stretches inherit process env but currently override `CLAUDE_CONFIG_DIR` when `GARRISON_STRETCH_CLAUDE_HOME` is set. Operative paths pass `env: process.env`.
4. Only state-transitions and orchestrator-projection call the exported global manifest writer/install. Runner installs with `--force` in the composition directory. Global composition and fitting setup are the user-home write paths.
5. Live dev-madrid: no crontab. `GARRISON_HOME=/home/ggomes/.garrison node fittings/seed/scheduler/scripts/scheduler.mjs list --target all` uses the state store and has no jobs for ship-backup, mesh-evidence-backup, verify-restore or Snapshots. Without GARRISON_HOME it reads an obsolete local file, not live state. Systemd timers are active for hourly state snapshots, daily restic at 03:00 and weekly prune at Sunday 03:30. There is no cron replacement to remove.
6. Read-only inventories completed on Madrid, Mini, Air, Pro and CSG. All have hook owners `core:improver-probe` and `fitting:dev-env`; no inspected ledger records MCP ownership. Madrid/Mini/Air have 16 Garrison-named skills; Pro also has autothing (17); CSG has garrison-browser (1). User MCP registration names differ by node; absence of ledger ownership must not be treated as ownership evidence. Full fresh owner-local `homes-inventory.json` files will be captured immediately before each phase 2 deployment, and checked with the canonical owner helper. No configuration was modified by this inventory.
7. Seed routing projects carries only `profile` and `security_sensitive`; no per-project flow overrides exist.
8. Token issuer opens the DB directly. Phase 4 must add minting to the running state service and route the script through that endpoint.

## Small adaptations required by the tree

- Snapshots is an embedded static shell view (`ui/Snapshots.tsx` re-exports `src/components/fitting-views/SnapshotsView.tsx`), with existing `/api/snapshots` routes and no own-port process. The drill will stream through a new same-origin Snapshots route instead of introducing a service/port.
- Shared scheduler jobs reject shell commands at target `all`; portable `fitting-script` specs are already supported. Global jobs also have one enable bit, so systemd-versus-scheduler selection must happen locally without disabling backups on Macs. Scheduling implementation will preserve that invariant and record its exact adaptation here.
- `--dry-run` must remain a preview. The conversation pull test previews first, then runs a real local rsync to assert files land. Dry-run now also suppresses the existing evidence prune.

## Verification so far

19/19 tests passed across snapshots-backup-set, mesh-conversations-pull and snapshots-fitting, including a real temporary restic repository round trip. New tests isolate HOME, GARRISON_HOME and GARRISON_CLAUDE_HOME. Consistent state snapshots are refreshed before restic; refresh failure aborts backup. State DB/WAL are never backup roots. Conversation sink has no time prune; peer sources are unchanged.

The command/file sandbox fails at bubblewrap loopback creation before execution. Approved unsandboxed repository commands are used; patch helper has the same failure, so scoped Python edits write the files.

## Scheduling implementation and view verification

Portable `fitting-script` jobs use the existing scheduler store's CAS and enable-preservation semantics. Backup/prune keep the requested `all` target; a per-node receipt selects systemd or scheduler at execution time. On the shared store the all-node jobs remain enabled, because one global disabled bit cannot represent Linux timers and Mac scheduler jobs simultaneously. The dispatcher skips systemd nodes. Standalone file-store registrations use the requested disabled initial flag. No state-service scheduler API changed. File-store records now retain structured specs/targets while legacy shell records retain their shape.

State-host jobs are registered only on dev-madrid; one mesh-pull registration per registry peer. The empty shipping target registers disabled and prints the requested warning. Setup preserves the existing Linux timer path and registers schedules on Macs. Prune is aligned to Sunday 04:00. Per-node scheduling receipts and last-run records use existing node-scoped config records for the Snapshots status view.

The existing core Improver shell view is the durable notices UI. State notifications have no browser consumer in this tree. `--notify` writes the requested state notification and a matching core notice using the existing config API; no new notification surface or state API is introduced.

43 phase-specific/existing tests passed before the final shared-store test; the final scheduler registration suite passes 4/4, including actual Linux+Mac state-service registration/status. Restore drill tests pass 4/4 with a real temporary service. Typecheck passed. Lint exits zero with a pre-existing ListeningControl effect-cleanup warning (peer voice code, untouched here).

Snapshots E2E: 6/6 desktop/phone cases pass for never-run, ok and failed reports plus streaming button state. A separate mkdtemp-home launcher instance uses `.next-two-homes`, avoiding Archive's active `.next-e2e`. Service workers are blocked in fixtures (otherwise they bypass Playwright route handlers). Phone success and desktop failure screenshots were visually inspected; text and controls fit, with readable counts/errors. This is fixture proof, not the pending live acceptance.

Final pre-deploy checks: 34 existing state-service tests and 4 restore-drill tests pass (38/38); typecheck passes after the route/view/spec work. The restore notification's body is asserted byte-identical to `restore-drill.md`. Final scheduler registration suite passes 4/4. Fixture screenshots committed here are named `fixture-*` and do not claim live acceptance. No shell/state deployment has yet occurred.
