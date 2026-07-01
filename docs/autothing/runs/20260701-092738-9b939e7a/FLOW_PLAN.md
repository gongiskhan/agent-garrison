# FLOW_PLAN — periodic ecosystem-update mechanism (run 20260701-092738-9b939e7a)

## Premise check — VERIFIED, user's suspicion confirmed

`fittings/seed/improver` (`faculty: observability`, `own_port: true` on 7088,
`provides: automation-runner/improver`) IS wired to a real, working scheduler: `scripts/setup.sh`
registers job `improver-nightly` (cron `30 3 * * *`) with the genuinely-running
`fittings/seed/scheduler` launchd daemon. `scheduler.log` proves it fired every night 2026-06-26
through 2026-07-01.

**But every single run crashes** before producing anything. Confirmed root cause, read directly
from `scripts/improver.mjs`'s `main()`: the registered nightly command sets
`IMPROVER_PROJECTS_DIR`, so `main()` always takes the `runSkills()` branch (never `runLegacy()`).
Near the top of `runSkills()`, an unguarded `await computeDream(...)` throws
`OperativePtySession: message never registered (claude did not accept input)` (a claude-pty PTY
bug), which propagates out of `runSkills()` → `main()` → the top-level `.catch()` → `exit 1`,
*before* any queue/proposal writing. Result: `~/.garrison/improver/review-queue.json` is `[]` and
`autonomy.json` is `{}` after 6+ real nightly executions. The nightly job runs; it has never once
completed useful work.

`improver` separately already contains a **complete, never-exercised reapply mechanism**:
`lib/review-queue.mjs` (queue records), `lib/apply-core.mjs` (`planApply`/`applyPlan`, sha-based
conflict detection via `baselineSha`, append-only `<!-- improver:${id} -->` marker), `lib/snapshot.mjs`
(snapshot/restore). This is the "reapply after an external update clobbers tracked content"
primitive the user described — it just has nothing driving it today.

The claude-pty PTY crash is a **pre-existing, unrelated bug** (LLM turn plumbing) — logged to
`docs/decisions.md` as a follow-up, not fixed here.

**Honesty caveat carried forward from design review:** `scripts/server.mjs`'s `targetFileFor()`
resolves every proposal's apply target to *one shared file* (`IMPROVER_TARGET` env, else
`.garrison/knowledge-memory.md`, else `applied-conventions.md`) — not per-skill `SKILL.md` files.
So in the current system, the reapply-sweep protects whatever that shared applied-content file is,
not individual skill files generally. That's still exactly the class of problem the user described
(a Garrison-tracked improvement getting silently lost under an update) — just narrower in practice
today than "any skill." State this plainly in code comments; don't oversell the guarantee.

## Architecture decision

No update-checking exists anywhere in Garrison today. The real `apm` CLI verbs, confirmed live
against the actual `~/.garrison/global-composition/`:
- `apm outdated [-v]` — **only checks remote/git-pinned deps**; every current dependency is
  `source: local`, so it correctly reports "No remote dependencies to check" and always will until
  Garrison starts consuming marketplace/git Fittings. Useful only as an informational log line
  today, NOT as a gate for whether to redeploy.
- `apm update` — self-updates the **`apm` CLI binary itself**, not project dependencies. Not the
  verb we want.
- `apm install --update --force` — the real "advance pinned deps + redeploy" verb
  (`--update`: "Update dependencies to latest Git references"; `--force` redeploys unconditionally).
  This is what `src/lib/global-composition.ts:118`'s `apmInstall()` already runs (today without
  `--update`, since nothing remote exists yet to advance).
- Never pass `-g`/`--global` — that means apm's own `~/.apm/` user store, unrelated to Garrison's
  `~/.garrison/global-composition/`.

Extend `improver` with a new deterministic, non-LLM phase pair, run in `main()` **before** the
`runSkills()`/`runLegacy()` branch (so they execute on every invocation regardless of which
downstream mode runs, and independent of the `computeDream()` crash later in `runSkills()`):
1. **ecosystem-update** — log `apm outdated -v` output (informational), then unconditionally run
   `apm install --update --force` against `globalCompositionDir()`-equivalent (the composition dir
   this Fitting's `setup.sh` already resolves), logging dep-count-before/after + stdout.
2. **reapply-sweep** — after the update step, scan `review-queue.json` for `status: "applied"`
   entries; for each, read `entry.evidence.targetFile` (NOT a nonexistent `entry.targetFile` —
   confirmed the queue schema has no top-level target path) and check for its
   `<!-- improver:${id} -->` marker; missing = clobbered, reapply via `apply-core.mjs`.

Each phase gets its own try/catch and its own durable log; a failure in one never blocks the other
or the (already broken, unrelated) dream phase after them. No changes to Garrison core
(`src/lib`/`src/app`) — everything lives inside `fittings/seed/improver/`. New tests follow this
codebase's real convention: top-level `tests/`, not co-located under the Fitting (confirmed via
`tests/improver-v1-cli.test.ts`, `tests/improver-apply.test.ts`, etc.) — new files
`tests/improver-ecosystem-update.test.ts`, `tests/improver-reapply-sweep.test.ts`.

Shell-out testing convention: mirror `src/lib/apm-exec.ts`'s injectable `ApmRunner` DI seam
(`(args, cwd, opts) => Promise<{ok, code, stdout, stderr}>`, defaulting to a real `execFileSync`/
spawn call) rather than a PATH-stubbed binary — matches how `improver.mjs` already injects
`makeRunTurn()`/`makeDreamRunTurn()` and how `tests/global-composition.test.ts` stubs `ApmRunner`.

## Slices

### Slice 1 — ecosystem-update phase
New `fittings/seed/improver/lib/ecosystem-update.mjs`: exports `runEcosystemUpdate({ runApm, compositionDir, stateDir })` with an injectable `runApm` seam (default = real `execFileSync`/spawn,
no `-g`). Runs `apm outdated -v` (log only, never gates), then `apm install --update --force`
unconditionally, appending a run record (`{at, outdatedLog, installResult: {ok, code, depCountBefore, depCountAfter}}`) to `~/.garrison/improver/ecosystem-update-log.json` (load/save mirrors
`lib/review-queue.mjs`'s tolerant-read pattern — absent file = empty array, malformed = safe
default, never throws). Wire as a new phase inside `main()`, immediately after the `run-now` arg
check and before the `runSkills()`/`runLegacy()` branch, in its own try/catch.
- **Acceptance:** `node scripts/improver.mjs run-now` with a stubbed `runApm` produces a new entry
  in `ecosystem-update-log.json`, and the phase completing does not depend on (and is unaffected
  by) whether `runSkills()`'s dream phase later throws.
- **Critical files:** `fittings/seed/improver/scripts/improver.mjs` (`main()`'s real branch
  structure), `src/lib/apm-exec.ts` (the `ApmRunner` DI pattern to mirror),
  `fittings/seed/improver/lib/review-queue.mjs` (tolerant load/save pattern to follow).

### Slice 2 — reapply sweep
New `fittings/seed/improver/lib/reapply-sweep.mjs`: after Slice 1 completes, load `review-queue.json`, filter `status === "applied"`, and for each entry read `entry.evidence.targetFile`
(populated by `apply-core.mjs`'s `applyPlan()` return via `markApplied`). If the file is missing its
`<!-- improver:${id} -->` marker, reapply using the entry's stored `diff`/snapshot via the existing
`planApply`/`applyPlan`/`applyWithRetry` contract. On a real conflict (content drifted too far for a
clean reapply), set `status: "reapply-failed"` with a reason — never crash, never silently drop.
Append a run summary to a new `~/.garrison/improver/reapply-sweep-log.json`. Wire immediately after
Slice 1's phase in `main()`, same try/catch discipline.
- **Acceptance:** a `review-queue.json` fixture with an `applied` entry whose
  `evidence.targetFile` has had its marker stripped (simulating a clobber) gets the marker restored
  after running the sweep; a fixture with a genuinely conflicting rewrite ends in
  `reapply-failed` + reason, not a crash or a silent no-op.
- **Critical files:** `fittings/seed/improver/lib/apply-core.mjs` (`applyPlan`/`applyWithRetry`
  contract + `evidence` shape), `fittings/seed/improver/lib/review-queue.mjs` (`markApplied`/queue
  schema — no top-level `targetFile`), `fittings/seed/improver/lib/snapshot.mjs`.

### Slice 3 — observability + verify
Extend the existing own-port improver review UI (`ui/main.tsx` + `scripts/server.mjs`, live on
:7088) with a small read-only panel showing the last ecosystem-update + reapply-sweep run: timestamp, install result, marker-restored / reapply-failed counts. Update `apm.yml`'s `verify`
probe (`improver.mjs --probe`) to also read `ecosystem-update-log.json`/`reapply-sweep-log.json`
with the same tolerant-read idiom used elsewhere in this file (`existsSync` guard + try/catch —
**absent file must pass** since `verify` runs right after `setup`, hours before the first `30 3 * * *`
firing; only a present-but-malformed file fails). Do NOT have this probe introspect the `scheduler`
Fitting's job state — `scheduler` already owns its own `--probe`; keep ownership separate.
- **Acceptance:** `/verify` passes on a fresh install (no log files yet) and after a real run
  (log files present); loading `http://127.0.0.1:7088/` shows the new panel with real data after a
  manual `run-now`.
- **Critical files:** `fittings/seed/improver/ui/main.tsx`, `fittings/seed/improver/scripts/server.mjs`
  (`targetFileFor()` context + the `/api/run-now` handler this panel polls alongside),
  `fittings/seed/improver/apm.yml` (verify command).

## Call-outs (logged to `docs/decisions.md`, not fixed here)
- The claude-pty `OperativePtySession: message never registered` crash breaks the dream phase on
  every nightly run — pre-existing, unrelated bug, needs its own fix pass.
- A second, distinct `fittings/seed/improver-nightly/` Fitting (`faculty: sessions`, its own CLI,
  its own test file `tests/improver-nightly.test.ts`, artifact-store-based) also exists — confirmed
  wholly separate from `fittings/seed/improver`, not touched by this build.
- `targetFileFor()` resolves to one shared applied-content file today, not per-skill files —
  Slice 2 protects that file; making apply per-proposal-aware (writing to individual
  `~/.claude/skills/<name>/SKILL.md` files) is future work, out of scope here.

## Verification
- Unit tests (`tests/improver-ecosystem-update.test.ts`, `tests/improver-reapply-sweep.test.ts`)
  with an injected stub `runApm` — no real network/binary calls, matching the codebase's existing
  DI-seam convention.
- `node scripts/improver.mjs run-now` end-to-end against fixtures, asserting both new phases
  complete and the (real, unfixed) dream-phase crash later in `runSkills()` does not block them.
- `/verify` on the improver Fitting (both fresh-install and post-run cases); browser walkthrough of
  the new UI panel on :7088.
