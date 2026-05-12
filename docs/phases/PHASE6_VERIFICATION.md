# Phase 6 verification

**Spec:** `docs/phases/PHASE_6_PROTOCOL.md`
**Execution:** `docs/phases/PHASE_6_EXECUTION.md`
**Bridge repo:** `github.com/gongiskhan/garrison-outpost-bridge`

Phase 6 ships outposts — remote Mac bridges connected over a
WebSocket protocol. Each of the six done-when items below has offline
evidence (code paths, tests) plus the runtime procedure to verify on
real hardware.

Status as of 2026-05-11: **4 of 6 verified offline; 2 items pending
runtime confirmation across real machines (items 5 & 6).**

Tests: 255 passed | 1 skipped. Typecheck clean. All three fitting
validators pass.

---

## 1. Bootstrap on a second Mac

**Offline evidence**
- Bootstrap script: `scripts/bootstrap-outpost.sh` — curl-pipe-bash,
  checks Node ≥ 20 + git, warns on no Tailscale, clones/pulls bridge,
  builds, writes `~/.garrison-outpost/config.json`, installs launchd
  plist, polls log for `[connection] ready` up to 60 s.
- One-liner wizard: `src/components/workbench/outpost/AddOutpostWizard.tsx`
  + `src/app/api/workbench/outposts/generate/route.ts` (mints 32-byte
  token, registers with outpost-host, returns one-liner).
- Registry persistence: `~/.garrison/outpost-registry.json`.
- Tests: `tests/outpost-host-broker.test.ts` — register, auth, and
  connection lifecycle.

**Runtime procedure**
1. On the second Mac: confirm Tailscale is connected to the host.
2. In Garrison → Workbench → Outposts, click "Add Outpost", enter
   the machine name, copy the generated one-liner.
3. Run the one-liner on the second Mac (SSH or paste in a terminal).
4. Within 60 s the Outposts view should show the entry as connected
   (green dot, recent heartbeat timestamp).

---

## 2. Worktree on remote disk

**Offline evidence**
- Multi-target API: `src/app/api/workbench/worktrees/route.ts:46-130`
  — GET/POST/DELETE dispatch on `target=outpost:<name>` via
  `outpostRpc` from `src/lib/outpost-rpc.ts`.
- UI machine selector: `src/components/workbench/WorktreeView.tsx`
  (machine dropdown + project dropdown for outpost targets).
- Prefs memory: `~/.garrison/workbench-prefs.json` via
  `src/lib/workbench-prefs.ts`.

**Runtime procedure**
1. From Garrison → Workbench → Worktrees, switch the machine
   selector to the connected outpost.
2. Select a project (listed from the remote `~/dev` directory).
3. Type a branch name and click "Create Worktree".
4. SSH to the outpost and confirm the new worktree directory exists.

---

## 3. Terminal in outpost worktree

**Offline evidence**
- Outpost PTY spawn: `scripts/trenches-ws.mjs` (`openOutpostPty`
  function) + `src/lib/trenches/outpost-stream.ts`.
- TrenchesPanel outpost selector and spawn call at lines 179–186.
- Terminal → New Session with `outpost: <name>` in the POST body.

**Runtime procedure**
1. Garrison → Workbench → Terminal, select the outpost in the
   machine dropdown, click "New Session".
2. Type `pwd` — output should show a path on the remote disk.
3. Run a long-running command (e.g. `sleep 10; echo done`) and
   confirm output arrives in real-time.

---

## 4. Operative remote command via outpost-actions (T7)

**Offline evidence**
- Fitting: `fittings/seed/outpost-actions/` — `faculty: skills`,
  `component_shape: skill`. Validator: PASS.
- CLI: `scripts/outpost.py` — `list_outposts`, `run_on`, `read_file_on`,
  `write_file_on`, `list_files_on`. Python stdlib only.
- Exit-code contract: 2=unknown, 3=offline, 4=bridge error, 5=host
  unreachable.
- `for_consumers` injected into Orchestrator prompt via
  `src/lib/runner.ts:419-477`.
- Tests: `tests/outpost-actions-fitting.test.ts` — all 9 pass.
- Scope: `spawn_on`/`wait_for_completion`/`kill_running` deferred;
  `process.status` carries no stdout buffer, Python stdlib has no
  WS client. `run_on` (blocking `exec.run`) covers all done-when
  invocations.

**Runtime procedure**
1. Add `outpost-actions` to the composition's `selections` under
   `skills:` (it is in `dependencies.apm` of the default composition
   but not selected — opt-in pattern).
2. Up the composition. Confirm the assembled prompt includes the
   `agent-skill:outpost-actions` block.
3. Ask the Operative: "list my outposts" → expect a formatted list
   of connected machines.
4. Ask: "run `uname -a` on development" → expect the Darwin version
   string from the remote Mac.
5. Ask about a machine name not in the registry → expect a clear
   "I don't see that machine" response with available names.

---

## 5. Vault sync host→outpost (T8) — runtime pending

**Offline evidence**
- Fitting: `fittings/seed/vault-sync/` — `faculty: sync`,
  `component_shape: cli-skill`. Validator: PASS.
- `sync` Faculty registered at order 20, `shapes: ["script", "cli-skill"]`,
  no `family` (background service, not a Workbench tab).
- Diff algorithm: `scripts/sync.py` — size+mtime heuristic; remote
  manifest via `exec.run find` (one round-trip, not recursive `fs.list`).
- Status written atomically to `~/.garrison/vault-sync-status.json`.
- `VaultSyncStatus.tsx` sidebar view + `/api/vault-sync/status` route.
- Scheduler integration: `setup.sh` registers a `*/N * * * *` cron.
- Tests: `tests/vault-sync-fitting.test.ts` (10 pass) + `tests/vault-sync-diff.test.ts` (7 pass).

**Runtime procedure (multi-day)**
1. Add `vault-sync` to the composition's `selections` under `sync:`
   with `source_dir: ~/Projects/ekus/obsidian-vault` and
   `target_outposts: development`.
2. Up the composition. Verify the scheduler tick fires (check
   `data/scheduler-jobs.json` for a `vault-sync` entry).
3. Edit a file in the host's vault → confirm it appears on
   `development` within 60 s (check `~/.garrison/vault-sync-status.json`
   for `uploaded: 1`).
4. Delete a file → confirm deletion mirrors within 60 s.
5. **Multi-day runtime:** use the system for 3 days; check that
   `vault-sync-status.json` shows `failed: 0` consistently.

**Status:** capability shipped; sustained correctness over multi-day
use is a runtime check the user must perform.

---

## 6. Bridge reconnect after sleep/wake — runtime pending

**Offline evidence**
- Reconnect loop in the bridge daemon: exponential backoff
  1 s → 60 s with ±20% jitter, infinite retries.
- Host-side heartbeat enforcement: 90 s silence = dead per protocol §5.4.
- Bridge repo test suite: 10/10 smoke at commit 2be13cb.
- `tests/outpost-host-broker.test.ts` covers the reconnect path
  (mock WS close + re-connect handshake).

**Runtime procedure**
1. Confirm the outpost shows as connected in Garrison.
2. Close the outpost Mac's lid. Wait > 5 minutes.
3. Open the lid; allow Tailscale to reconnect.
4. Within 90 s the Outposts UI dot should flip back to green with no
   manual intervention.

**Status:** capability shipped in the bridge daemon; the user must
validate this against normal sleep/wake cycles over time.

---

## Tests summary

```
npm run typecheck         → clean
npm test                  → 255 passed | 1 skipped
npx tsx scripts/validate-fitting.ts fittings/seed/session-view-sequoias → PASS
npx tsx scripts/validate-fitting.ts fittings/seed/outpost-actions       → PASS
npx tsx scripts/validate-fitting.ts fittings/seed/vault-sync            → PASS
```
