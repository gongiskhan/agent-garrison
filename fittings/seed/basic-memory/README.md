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

A note's identity on the remote store is its **permalink**, derived from the
note's path relative to the vault root:

```
<vault>/Memory/2026/Session Notes.md   ->   <remote_folder>/memory-2026-session-notes
```

That derivation exists **once**, in `scripts/lib/memory-vault.mjs`
(`permalinkForRelPath`), and all three writers call it:

- `scripts/import-vault.mjs` writes each existing note under that permalink.
- The capture hook spools each capture with a sidecar, `<key>.notepath`, holding
  the note's **vault-relative path** — not a permalink. `scripts/flush-spool.mjs`
  reads that path and derives the permalink through the shared module.
- `scripts/compare-backends.mjs` lists that one folder and diffs it against the
  same mapping.

The `<remote_folder>` half is resolved at **drain** time from
`BASIC_MEMORY_REMOTE_FOLDER`. Every shipped path bakes that variable in (the
capture hook's command, the scheduled drain job, the comparison job), so it only
matters if you run the drain **by hand**: `node ~/.claude/basic-memory/flush-spool.mjs`
with the variable unset silently defaults to `vault`, which lands those captures
outside a non-default configured folder, where the comparator will not find them.
Export it, or let the scheduler run the job.

The sidecar carries the path rather than the permalink deliberately. The hook is
Python and the rest is Node, so stamping a permalink in the hook meant
implementing the mapping twice — and two implementations of one mapping is one
mapping with two answers. It was exactly that for a while: the two agreed on
every case anyone pinned, and diverged on codepoints whose folding depends on
the machine's Python-vs-Node Unicode versions, which no fixed test corpus can
catch because the diverging set changes with the interpreters installed.

This is what makes parity **reachable**: a shadow that shipped notes under the
spool's queue key while the comparator looked for path-derived permalinks would
report a constant, unchanging difference whether it was working perfectly or not
at all — and a signal that never changes is not a signal. A capture spooled
before this existed still drains, under its queue key; the drain logs a line
saying so, and such notes are outside every folder the comparator can list.

### Accepted risk: the sidecar is not bound to its capture

Nothing structurally ties a `.notepath` sidecar to the capture beside it. A
sidecar that is well-formed but **wrong** — naming `Memory/some-other-note.md` —
makes the drain overwrite that note's remote copy with an unrelated capture, and
the remote store has no way to tell.

This is accepted rather than fixed. The spool lives in the user's own directory
(`~/.garrison/memory-spool` by default), inside Garrison's single-machine,
single-user trust boundary ([GOVERNANCE](../../../docs/GOVERNANCE.md) §2), so
anything able to write a sidecar can already rewrite the capture itself, edit the
vault, or call the CLI directly: there is no privilege to escalate. The
mitigation is a **trail**, not a guarantee — `flush-spool.mjs` logs
`<capture file> -> <permalink>` on **every** flush, not only the odd ones, so
where each capture went stays recoverable from the scheduler log. If the spool
ever moves outside that boundary this stops being acceptable, and the sidecar
would need to be derived from, or checked against, the capture's own content.

## Credentials

This Fitting never reads, stores, echoes or bakes a provider key. The drain
invokes `<remote_cli_bin> memory write …` and that CLI reads `CORTEX_BASE_URL`
and `CORTEX_API_KEY` from its own environment. A missing binary or a missing env
var is a safe no-op: the capture stays spooled and the next scheduled run retries.
