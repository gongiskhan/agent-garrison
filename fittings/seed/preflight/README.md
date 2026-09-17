# Preflight — the composition doctor

One page (own port, default 8076) + CLI that answers **"why won't my
composition come up, and what is silently broken?"** — before `up()` runs,
instead of one failure at a time across repeated failed launches.

## The nine checks, and the incident behind each

| # | Check | The incident it prevents |
|---|-------|--------------------------|
| 1 | **Verify results** — every fitting's verify outcome, from the last up and (on demand) a live sweep | `verify()` runs every fitting, but `up()` throws naming only the FIRST failure, so the error and the UI name one fitting; days were lost fixing `vault-git-sync` only to discover `basic-memory` failing behind it |
| 2 | **Library registration** — `fittings/seed/*` ↔ `data/library.json`, both directions | A fitting missing from the library is silently dropped by the resolver, which then blames whatever consumed its capability |
| 3 | **Ports, both axes** — canonical (default_port + config_schema port-like defaults + composition pins) and serve (`8400 + port % 1000`) vs live listeners | `improver` hid a claim on 8093 in a config_schema default; 8098 and the retired 7098 collide on the serve axis at 8498 |
| 4 | **Tailscale serve coverage** — every running own-port view must have a serve mapping | A view with `tailnetUrl: null` makes the UI fall back to `127.0.0.1` — the *viewer's* machine — and renders blank, looking like a slow host |
| 5 | **Orphan processes** — status files + spawn ledger vs live pids (report-only) | `local-voice` leaked `server.py` processes on an 8 GB machine; count orphans before blaming any model |
| 6 | **Composition drift** — last-up staleness, apm.yml vs git HEAD, and **unfitted re-station** detection | A fitting removed from selections without an `unfitted` record re-adds itself on the next read; `vault-git-sync` re-stationed itself 16 minutes after being deliberately dropped |
| 7 | **Capability kinds** — every declared kind still in `capabilityKinds` | One unknown kind 500s `/api/compositions` and takes the whole Muster UI down |
| 9 | **Config projection** — the env name a fitting reads vs the one the runner projects | The runner uses TWO manglings — `GARRISON_<ID with separators REMOVED>_<KEY>` at runtime, bare `<ID>_<KEY>` for hooks — so a name that keeps the separators is absent forever and the declared default silently wins |
| 8 | **Hook cwd asymmetry** — paths a setup and verify script each derive from their own location | Setup runs from the seed dir and verify from the composition dir, so `basic-memory` tears down a file in setup that verify then demands — the reason `default-2` could not come up |

Every failing row carries a **`fix`** hint naming the concrete remedy.

### What `hook-cwd` can and cannot see

It compares the paths each script *derives*, and recognises a guard only when
the script declares a named predicate testing the base variable — an inline
`basename "$X"` guards one branch and is deliberately not read as cover for
anything else, because basic-memory always had one and treating it as cover
would have hidden the bug this check was written for.

The limitation is the other direction: a script that gates a block on a
predicate testing one root still gets reported for divergent paths derived from
a *different* root. That is an over-report, which is the safe failure mode here
and the reason `hook-cwd` stays out of the `--gate` blocking set.

## What changed since the last run

Not a snapshot diff: a report carries `generatedAt`, live pids and counts, so
comparing two of them says "changed" every single time. What is stable is a
finding's identity, `check:id`, so a ledger under `~/.garrison/preflight/`
records one row per finding and derives **new** / **ongoing** / **regressed** /
**resolved** from that. A corrupt ledger is reported and refused, never read as
empty — reading it as empty would announce the whole board as new and
everything remembered as resolved. `GARRISON_PREFLIGHT_DATA_DIR` relocates it;
the legacy flat `~/.garrison/preflight-fixes.jsonl` is still read so repair
history survived the move.

## Four bands, and the ranking

`fail` · `warn` · `pass` · **`info`** — "true, checked, and nothing to do about
it". `info` exists because a doctor that reports FAIL every day for things
nobody can act on trains you to stop reading it, which is the one failure mode
this fitting cannot afford. `info` is counted but never decides the verdict.

Findings are ranked against the **active composition**, read straight from
`~/.garrison/config.json` (`active_composition`) so it still works with the app
down. Two rules make this a signal mechanism rather than a mute button:

- **Demotion is never suppression.** A demoted row keeps its place and its text,
  and gains the reason it was demoted. `demote()` refuses to touch anything that
  is not a `warn`, so no caller can quiet a failure.
- **Only readiness-class findings may be demoted** — "never brought up", a stale
  last-up, an uncommitted manifest. Correctness-class findings keep full
  severity in *every* composition: a failing verify, a silent re-station, a port
  collision, a retired kind, a registry gap.

With no usable active-composition pointer, nothing is demoted at all.

## Degraded mode

The doctor works with the Garrison app (8777) **down** — which is exactly when
you need it. Filesystem-first: every check has a direct implementation; the
app's API only enriches (health probes, tailnetUrl). App-down is reported as a
`warn` chip, never a crash.

## Explicit repairs

Reports are passive. A verify sweep runs only for an **idle or failed**
composition, checked immediately before dispatch through both HTTP and CLI.
It proxies `POST /api/runner/<id>/verify`, which can install dependencies and
run setup hooks. Stop a running composition first; sweeps never run on a timer.

The confirmed repair buttons recheck their finding before acting. View mapping
uses the supported node publisher with its profile, enrollment, collision and
tether safeguards. Unstationing uses Garrison's composition API, preserving
comments, explicit opt-outs and authority revision checks. Registry repairs
exclude deliberately retired seeds and recheck missing entries/directories.

Repairs are serialized and recorded in a bounded-read journal. The UI displays
the full library diff before offering a file-scoped commit. A fingerprint of
HEAD, the diff and staged changes must still match; other staged files stay
staged and nothing is pushed. Reports never commit automatically. No action
kills processes or changes fitting code. Authority errors surface even if the
local manifest was already saved; refresh before retrying.

## The verify probe

The probe checks the port the fitting will actually bind, not an ephemeral one:
the manifest promises the server exits rather than shifting, so a probe that
binds port 0 passes at exactly the moment startup is about to fail. Because
verify also runs while this fitting is already listening (any restart), a taken
port is only a failure when the holder is not us — proven by `/health` returning
a pid that matches `~/.garrison/ui-fittings/preflight.json`. A health responder
whose pid does not match the record is refused rather than assumed.

## Filing a finding as a card (off by default)

Set the `file_cards` config key to offer a **File as card** button on failures
that carry no mechanical repair, so it never competes with a "Fix it" that
would actually solve the problem. Off by default on purpose: a doctor whose
value is working when everything else is down must not acquire a mandatory
dependency on another fitting.

Cards go to `backlog` — the only active manual list the board accepts direct
creation into — keyed `preflight:<check>:<id>` so the same finding is filed
once. The dedupe probe **throws** rather than reading a transient failure as
"no card exists", because that would file a duplicate on every report.

## CLI

```bash
node scripts/cli.mjs --gate                 # BEFORE up(): blockers only, for the active composition
node scripts/cli.mjs --gate --composition default-2 --json
node scripts/cli.mjs                        # human report; exit 1 iff any fail
node scripts/cli.mjs --json                 # same, JSON
node scripts/cli.mjs --checks drift,orphans # subset
node scripts/cli.mjs --sweep --composition default     # stopped composition only
```

### The gate

`--gate` answers one question — *is there anything that will stop this
composition coming up?* — and answers it before a failed launch teaches you the
same thing more slowly. Exit `0` clear, `1` blocked, `2` **could not assess**:
a gate that reports "clear" when it could not look is worse than no gate, so it
fails closed on a missing repo root or an unreadable manifest.

Blocking checks are deliberately narrow: failing verifies, registry gaps,
unknown capability kinds and port collisions — conditions under which `up()`
either cannot succeed or takes the Muster UI down with it. `hook-cwd` and the
informational bands stay out until they have proven themselves, because a gate
that cries wolf gets switched off. Chain it yourself:

```bash
node fittings/seed/preflight/scripts/cli.mjs --gate && <your up command>
```

Nothing in the runner calls this; wiring it into `up()` is a separate decision.

## Stationing

Not stationed anywhere by default. To station into a composition, select it
under **observability** via Muster, or PUT the composition with `preflight`
added to `selections.observability` (editing `apm.yml` by hand does not stick —
the runner re-authors the file).

## Layout

- `lib/preflight-core.mjs` — every check as a pure function (unit-tested in
  `tests/preflight-fitting.test.ts`); includes the line-based manifest and
  composition parsers.
- `lib/collect.mjs` — all I/O: fs, `lsof`/`ss`, `git`, `tailscale`, repo-root
  walk-up. Degrades to "could not check" rather than throwing.
- `lib/app-client.mjs` — the Garrison app client (`GARRISON_APP_URL`).
- `lib/report.mjs` — assembles collectors + checks into one report, shared by
  server and CLI.
- `scripts/server.mjs` — HTTP: `/health`, `/api/report`, `POST
  /api/verify-sweep`, static `dist/`. Exits on EADDRINUSE rather than
  shifting; writes/clears `~/.garrison/ui-fittings/preflight.json`.
- `ui/` → committed `dist/` (esbuild, react from the root node_modules).
