# basic-memory — operator notes

Things about this Fitting that are true, load-bearing, and not obvious from the
config form. The manifest (`apm.yml`) documents each key; this file documents the
sharp edges.

## Two backends, two skill sources

`backend` (default `local`) picks where operative memory lives, and with it which
version of the `garrison-memory` skill the operative gets:

| backend | MCP server registered | skill the operative reads | editable source |
|---|---|---|---|
| `local` (default) | yes, with Claude/Codex/Gemini | MCP tools (`search_notes`, `read_note`, …) | `.apm/skills/garrison-memory/SKILL.md` |
| `cortex` | **no** | the `cortex memory` CLI verbs | `skill-variants/cortex/SKILL.md` |

Both sources are listed in this Fitting's **Skill view** — edit the one matching
the backend you are on. The variant is deliberately NOT under `.apm/skills/`,
because APM deploys every skill directory it finds there and the session would
end up with two conflicting memory skills.

## APM owns the deployed copy — edits there are not durable

`<composition>/.claude/skills/garrison-memory/SKILL.md` is **APM's file, not
ours**. `apm install --force` runs immediately before every setup hook (both
`up()` and `verify()` in `src/lib/runner.ts`) and unconditionally re-deploys that
path from `.apm/skills/`, ignoring the recorded `deployed_file_hashes`.

So: **anything you write directly into the deployed copy is discarded on the next
install**, whether or not this Fitting is involved and whichever backend you are
on. Edit the sources in the table above instead.

setup.sh's flip-back restore exists only for an out-of-band `setup.sh` run
(APM would have restored the file anyway on the next install). It keys on a
sidecar this Fitting writes — `<composition>/.garrison/basic-memory-skill-backend`
— never on the *content* of the deployed file, so a skill that merely quotes the
variant's marker comment is not mistaken for one we installed.

If you edit the LOCAL skill source while on `backend: cortex`, setup prints a
warning on its next run naming the file that is actually in effect. The edit is
still not applied — the warning exists so the discard is loud rather than silent.

## Known gap: deselecting the Fitting leaves its hook and its job behind

`basic-memory` is **not** in `COORD_OWNERS` (`src/lib/coord-wiring.ts`), so
removing it from a composition does **not** strip:

- the `SessionEnd` / `PreCompact` capture hook in `~/.claude/settings.json`, or
- the `basic-memory-spool-flush` scheduler job, when spooling was on.

The hook half is long-standing and harmless (a local-only vault write). The job
half matters more now that a remote backend turns spooling on by default: a
deselect can leave a **scheduled job that keeps shipping local captures to a
remote vault**.

Before unequipping this Fitting from a composition that used a remote backend:

1. set `backend` back to `local` (or `spool_enabled: never`),
2. re-run `up` so setup retires the job and un-stages the drain script,
3. then remove the Fitting.

To undo it by hand afterwards:

```bash
node <composition>/apm_modules/_local/scheduler/scripts/scheduler.mjs remove basic-memory-spool-flush
rm -f ~/.claude/basic-memory/flush-spool.mjs
```

and delete the `capture-session.py` hook entries from `~/.claude/settings.json`.

## The spool precedence, in one line

`spool_enabled` explicit (`always` / `never`) **beats** `backend: cortex` or
`shadow_write` **beats** off. A legacy boolean `true`/`false` still resolves
correctly as `always`/`never`, but matches no `select` option, so the config form
renders it blank — re-pick the value to make your choice visible.

## One note, one identity

A note's identity on the remote store is its **permalink**, and all three halves
of the migration derive it the same way, from the note's path relative to the
vault root:

```
<vault>/Memory/2026/Session Notes.md   ->   <remote_folder>/memory-2026-session-notes
```

- `scripts/import-vault.mjs` writes each existing note under that permalink.
- The capture hook spools each new capture with an identity sidecar,
  `<key>.permalink`, holding the same value, and `scripts/flush-spool.mjs` ships
  it under that permalink rather than under the spool's queue key.
- `scripts/compare-backends.mjs` lists that one folder and diffs it against the
  same mapping.

This is what makes parity **reachable**: a shadow that shipped notes under a
queue key while the comparator looked for path-derived permalinks would report a
constant, unchanging difference whether it was working perfectly or not working
at all — and a signal that never changes is not a signal. A capture spooled
before this existed still drains, under its queue key; the drain logs a line
saying so, and such notes are outside every folder the comparator can list.

## Credentials

This Fitting never reads, stores, echoes or bakes a provider key. The drain
invokes `<remote_cli_bin> memory write …` and that CLI reads `CORTEX_BASE_URL`
and `CORTEX_API_KEY` from its own environment. A missing binary or a missing env
var is a safe no-op: the capture stays spooled and the next scheduled run retries.
