# Mac editing, dev-madrid execution

This workflow keeps the editable Garrison checkout on the Mac while treating
`dev-madrid` as the authoritative Node.js, test, build, preview, and deployment
environment. The Mac needs Git, SSH, tar, and Make; it does not need the
project's Node.js runtime or dependencies.

The active repositories are:

| purpose | path |
|---|---|
| Mac editing checkout | `/Users/ggomes/dev/garrison` |
| canonical VM checkout | `/home/ggomes/dev/garrison` |
| Git origin | `https://github.com/gongiskhan/agent-garrison.git` |

Do not use the older `agent-garrison` directories or
`/home/ggomes/dev/Archived Garrison Codex`. They are separate, stale archival
checkouts.

Project knowledge uses the same remote authority: Mac Codex connects over SSH
to Basic Memory project `main` backed by `/home/ggomes/ObsidianVault`. See
[`docs/CODEX_MEMORY_WORKFLOW.md`](./CODEX_MEMORY_WORKFLOW.md) for the selective
Claude-history migration, lifecycle hooks, note-update protocol, and explicit
Auto-thing exclusions.

## Why commands use temporary snapshots

Both `garrison-prod.service` and `garrison-dev.service` run from the canonical
VM checkout. Copying Mac files into that directory would make running services
observe an uncommitted, partly synchronized tree.

`scripts/remote-dev.sh` instead does the following:

1. Verifies the SSH target's user, hostname, GCP project, zone, instance name,
   repository path, and Git origin.
2. Creates a private temporary clone below
   `/home/ggomes/.cache/garrison-mac-remote-dev/stages`.
3. Checks out the Mac's exact base commit without creating a branch.
   Snapshot `origin` remains usable as an object/fetch source, but its push URL
   is disabled so an ordinary push cannot mutate canonical VM refs.
4. Applies tracked changes as a binary Git patch and transfers only untracked,
   non-ignored regular files in a checksummed archive. Symlinks and special
   entries are refused before transport and checked again in the final snapshot;
   a dangling Mac link must never become a live link into the canonical VM tree.
5. Runs `npm ci` for the root and every fitting-owned lockfile inside the
   snapshot, using a workflow-specific download cache. No package code or
   lifecycle script can write through to the canonical checkout.
6. Uses a temporary HOME and Garrison codex profile state. Normal home/config
   resolution therefore does not inherit `~/.garrison`, `~/.garrison-dev`, or
   `~/.claude`. Direct tests, shells, and arbitrary commands reuse the VM's
   existing Playwright executables, but browser profiles and state remain
   temporary. Snapshot dependency hooks, shells, arbitrary commands, and codex
   profile commands receive an ephemeral vault identity; Vitest retains its own
   test-only identity. This is process isolation for trusted project code, not
   an operating-system sandbox against code that deliberately opens absolute
   paths.
7. Runs the requested command under a VM-side lock and removes the snapshot
   when the command exits.

Ignored files never cross the boundary. In particular, the workflow does not
copy vaults, `.env` files, Claude configuration, dependencies, build output, or
runtime homes from either machine.

`GARRISON_REMOTE_REPO` may select a different same-origin checkout only as the
read-only object source for disposable snapshot commands. `remote-resume` and
`remote-deploy` refuse every value except `/home/ggomes/dev/garrison`, because
the production systemd unit is pinned to that literal working directory.

## One-time prerequisites

The Mac SSH config must have a working `dev-madrid` alias, normally reached
over Tailscale:

```sshconfig
Host dev-madrid
  HostName dev-madrid
  User ggomes
  IdentityFile ~/.ssh/google_compute_engine
  IdentitiesOnly yes
  ForwardAgent no
  StrictHostKeyChecking yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
  ControlMaster auto
  ControlPath ~/.ssh/control-%C
  ControlPersist 10m
  ExitOnForwardFailure yes
```

Check everything without changing either checkout:

```bash
cd /Users/ggomes/dev/garrison
make remote-doctor
make remote-prod-status
```

`remote-doctor` deliberately prints no secrets.

## Daily development

Edit files normally on the Mac, then inspect the exact snapshot boundary:

```bash
make remote-plan
```

Run validation on the VM:

```bash
make remote-typecheck
make remote-test
make remote-check       # typecheck + unit tests
make remote-build       # isolated codex-profile build
```

Run any other command without installing the project runtime locally:

```bash
./scripts/remote-dev.sh test tests/runner-setup.test.ts
```

Authenticated integration checks that require a live gateway, assembled
composition, or account credentials are intentionally outside this
credential-free snapshot workflow. Use a separately authorized isolated
integration environment; never point a temporary snapshot at prod credentials
or runtime state.

### Coordination upgrade boundary

The current coordination and board locks protect processes that all run the
current protocol. They cannot make an already-running, pre-upgrade
`coord-mcp`, board, or intent writer participate retroactively; older intent
writers did not take the new lock at all. Therefore a release containing these
locking changes requires a full stop/start boundary for every such writer.
Do not use a rolling or hot upgrade: stop the old composition and board-side
writers, verify they have exited, then start the new version. At the 2026-08-03
handoff, this repository work had not yet performed that production restart.

Open a shell whose current directory, HOME, dependencies, and runtime state all
belong to the temporary snapshot:

```bash
make remote-shell
```

Leaving the shell removes the remote snapshot. Files created only inside that
shell are disposable; edit durable source on the Mac. Git pushes from a
snapshot are intentionally disabled.

### Preview on the Mac

```bash
make remote-preview
```

Keep that command open and visit
`http://127.0.0.1:27777` on the Mac. SSH forwards only Mac loopback to VM
loopback. The preview runs only the Next.js portion of the codex profile; it
does not start the scheduler, operative, or fittings.

To use a different Mac-side port:

```bash
GARRISON_LOCAL_PREVIEW_PORT=37777 make remote-preview
```

The VM-side port remains the committed codex-profile port, `27777`. The
controller refuses to replace an existing listener and refuses a non-loopback
listener.

## Git synchronization

Temporary snapshots include staged changes, unstaged tracked changes, and
untracked non-ignored regular files. Repositories containing tracked or
untracked symlinks are refused. Snapshots do not alter the canonical VM
worktree.

To bring committed upstream changes to the Mac, preserve the existing checkout,
worktrees, and stashes:

```bash
git fetch origin
git merge --ff-only origin/main
```

Do not reset, reclone, or rsync either checkout. Before a production release,
commit and push the change so clean Mac `main` exactly matches a freshly
fetched `origin/main`.

## Resuming a remote Claude Code session

Claude transcripts remain in the VM user's `~/.claude` directory; they are not
copied into the repository or the Mac environment. Resume a known UUID with:

```bash
make remote-resume CLAUDE_SESSION=<uuid>
```

This is the one command that intentionally opens the canonical VM repository,
because Claude Code must continue against its original project path and
transcript store. By default, the command requires both repositories to be clean
`main` checkouts at the same commit before it starts. Do not keep uncommitted
edits on the Mac and VM at the same time. If resumed Claude changes code, commit
and push those changes on the VM, then fetch and fast-forward the Mac before
editing locally again.

During a deliberate handoff, such as the first use while this workflow itself
is still an uncommitted Mac change, an explicit confirmation can relax only the
local-clean check:

```bash
make remote-resume \
  CLAUDE_SESSION=<uuid> \
  RESUME_CONFIRM=resume-despite-local-changes
```

The Mac and canonical VM must still be on the same freshly fetched `main`
commit, and the VM must be clean. Do not edit on the Mac while that session is
open. When it ends, commit and push any VM edits, then reconcile the Mac changes
before resuming ordinary local editing. The command rechecks Git state after it
acquires the shared VM lock, immediately before Claude starts.

### Recovered Garrison handoff (2026-08-03)

The linked Claude Code work was mapped to its local VM transcripts, but the
private session identifiers remain in the authoritative Garrison memory notes
rather than in public Git history. If a historical session must be resumed,
look up its UUID there and pass it through `CLAUDE_SESSION=<uuid>` as documented
above. Once the workflow is committed and both checkouts are clean, omit
`RESUME_CONFIRM`.

The original session added the GLM provider through
`openai-agents-runtime`, a GLM-only composition, `GLM_API_KEY` account
support, and `default_fit` scaffolding. That work landed in `b3bd0748` and is
already an ancestor of the current checkout.

The current Mac continuation closes the remaining named-account launch gap:
an explicitly selected non-Anthropic primary account is now resolved and
vault-audited before its provider environment is built. A missing account,
wrong platform, unsupported credential kind, or missing credential fails
startup instead of falling through to a generic or ambient key. Native Codex
and Gemini primaries may use their isolated subscription auth-file homes;
API-shaped OpenAI/GLM endpoints remain token-only. The account picker for
`openai-agents-runtime` follows its selected provider, so GLM accounts appear
under GLM rather than OpenAI.

No GLM account/key or live model turn was verified. The endpoint answered 401,
showing that it was reachable but authenticated; it is public HTTP, so prompts,
tokens, and responses would not be transport-encrypted. The continuation's last
open diagnosis was that read-time `default_fit` additions could drift from
`dependencies.apm`, while a literal “all multi fittings” interpretation would
select nearly the whole library. Re-audit that behavior on current `main`
before enabling it; later commits may have changed adjacent write paths.

### Recovered Omi and personal-assistant handoff (2026-08-03)

There was no separate recent “PMI” workstream; the relevant work is the Omi
channel plus the default composition's personal-assistant heartbeat flow. The
useful implementation, setup/debugging, scheduling/Trello, and heartbeat
diagnosis transcripts remain indexed by private UUID in the authoritative
Garrison memory notes.

All useful Omi implementation commits are already ancestors of current
`main`. Production had ingress, triage, wake, notification, and chat enabled;
backfeed and tips remained off. The tailnet funnel mounted only `/omi` on port
8443 and the Omi service was healthy when this handoff was recovered.

The open personal-assistant failure was coordination, not missing Omi code. A
morning-briefing card parked in `needs-attention` remained a live stability
blocker, leaving later heartbeat jobs waiting, while identical scheduler
deliveries accumulated as duplicate cards. The current Mac continuation:

- treats `needs-attention` as terminal for autonomous coordination and releases
  cards waiting on a blocker that has parked there;
- serializes board, intent, lease, and lifecycle updates with generation-safe
  locks and compare-and-set checks, and retries post-commit cleanup from a
  durable sidecar guarded by the card's coordination generation;
- deduplicates `/jobs` in both gateway modes from the canonical full payload,
  with cross-process durable receipts and bounded active capacity; and
- returns HTTP 202 only after the job has entered the operative queue. A
  duplicate whose original generation is still active, dispatching, or being
  repaired returns retryable HTTP 503 until the outcome is durably retained.
  After admission, an uncertain failure is retained rather than replayed,
  preserving at-most-once external side effects.

The focused GLM, Omi, Personal Assistant, runner, and remote-workflow regression
set passed 383 tests in 25 files in an isolated VM snapshot on 2026-08-03.
Repository-wide typecheck and the production build also passed. The full test
run completed with 4,543 passing and 49 skipped tests; seven tests and two suite
setups failed across five files. An isolated rerun passed all 18 Deepgram voice
and Drill plan-progress tests, confirming that three of those failures were
full-suite load interference. A serial rerun confined the reproducible remainder
to three unchanged Drill end-to-end files: eight passed, 13 skipped, five failed,
and two suite setups failed because of existing evidence-directory, live-replay,
strict-locator, and missing-asset assumptions. At the 2026-08-03 handoff, none
of these changes had been deployed and no live card had been mutated. A release
must use the guarded production deployment described below and perform the full
stop/start boundary required by the coordination protocol change.

Do not copy the VM user's `.claude` directory to the Mac. An Omi bearer was
found in Claude configuration and historical transcript material; rotate that
credential before treating it as private again.

## Production deployment

Deployment is intentionally separate from normal snapshot commands. It:

1. Requires clean local `main` to equal freshly fetched `origin/main`.
2. Runs typecheck, unit tests, and a codex-profile build in a temporary VM
   snapshot.
3. Rechecks that the canonical VM checkout is clean and on `main`.
4. Fetches and fast-forwards the VM checkout to that exact verified commit.
5. Runs `npm ci` for the root and every fitting-owned lockfile so deployed
   dependencies exactly match the verified commit.
6. Runs the repository's sanctioned `npm run prod:redeploy` workflow and checks
   the service and loopback health endpoint.

The deploy kills and recreates the production operative and fittings. Run it
only when losing the live operative session is acceptable:

```bash
make remote-deploy CONFIRM_DEPLOY=deploy-garrison-prod
```

The confirmation prevents an ordinary test/build command from becoming a
production mutation. A changed VM worktree, changed upstream commit, unexpected
GCP identity, or active snapshot command aborts the deployment.

## Troubleshooting

- **Identity check failed:** inspect `ssh dev-madrid` and the Host block in
  `~/.ssh/config`. Do not weaken the identity checks to make an unknown VM pass.
- **Another snapshot command is active:** stop the existing preview or shell,
  then retry. Commands are serialized to protect the codex port and VM
  resources.
- **Abandoned snapshot directory:** `make remote-doctor` reports the count.
  Normal exits clean their own exact temporary directory; investigate before
  removing leftovers manually.
- **Dependency installation appears on every command:** this is intentional.
  Installs are isolated from live dependencies and reuse only a dedicated npm
  download cache below the workflow cache directory.
- **Production deploy refused:** resolve local/remote Git status or upstream
  drift first. Never bypass the clean-tree and exact-commit checks.
