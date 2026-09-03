# Preflight — the composition doctor

One page (own port, default 8076) + CLI that answers **"why won't my
composition come up, and what is silently broken?"** — before `up()` runs,
instead of one failure at a time across repeated failed launches.

## The seven checks, and the incident behind each

| # | Check | The incident it prevents |
|---|-------|--------------------------|
| 1 | **Verify results** — every fitting's verify outcome, from the last up and (on demand) a live sweep | `up()` throws on the FIRST failing verify, alphabetically, so the UI only ever names one fitting; days were lost fixing `vault-git-sync` only to discover `basic-memory` failing behind it |
| 2 | **Library registration** — `fittings/seed/*` ↔ `data/library.json`, both directions | A fitting missing from the library is silently dropped by the resolver, which then blames whatever consumed its capability |
| 3 | **Ports, both axes** — canonical (default_port + config_schema port-like defaults + composition pins) and serve (`8400 + port % 1000`) vs live listeners | `improver` hid a claim on 8093 in a config_schema default; 8098 and the retired 7098 collide on the serve axis at 8498 |
| 4 | **Tailscale serve coverage** — every running own-port view must have a serve mapping | A view with `tailnetUrl: null` makes the UI fall back to `127.0.0.1` — the *viewer's* machine — and renders blank, looking like a slow host |
| 5 | **Orphan processes** — status files + spawn ledger vs live pids (report-only) | `local-voice` leaked `server.py` processes on an 8 GB machine; count orphans before blaming any model |
| 6 | **Composition drift** — last-up staleness, apm.yml vs git HEAD, and **unfitted re-station** detection | A fitting removed from selections without an `unfitted` record re-adds itself on the next read; `vault-git-sync` re-stationed itself 16 minutes after being deliberately dropped |
| 7 | **Capability kinds** — no retired kinds (`agent-skill`, `soul`) anywhere | One retired kind 500s `/api/compositions` and takes the whole Muster UI down |

Every failing row carries a **`fix`** hint naming the concrete remedy.

## Degraded mode

The doctor works with the Garrison app (8777) **down** — which is exactly when
you need it. Filesystem-first: every check has a direct implementation; the
app's API only enriches (health probes, tailnetUrl). App-down is reported as a
`warn` chip, never a crash.

## Read-only, with one explicit exception

Preflight never kills processes, never edits compositions, never registers
serve mappings. The single mutating action is the **verify sweep**
(button / `--sweep`), and it only proxies the app's own
`POST /api/runner/<id>/verify` — the same code path `up()` runs, so results
can never drift from what `up()` would see. It is heavy (flips runner status,
may run `apm install`, runs setup hooks) and therefore never runs on a timer.

## CLI

```bash
node scripts/cli.mjs                        # human report; exit 1 iff any fail
node scripts/cli.mjs --json                 # same, JSON
node scripts/cli.mjs --checks drift,orphans # subset
node scripts/cli.mjs --sweep --composition default-2   # heavy live sweep
```

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
