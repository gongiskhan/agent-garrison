# Flow plan — Err retry card

## Context

This is a kanban "Err" card — the parent run (the ekoa "Rename Automatizar
label" walkthrough on run `01KVZ7PK49DQMR98H9W2XA89SR`) returned no output
because the operative was interrupted by the user mid-recording. The Err
card exists to retry that work item or to acknowledge that the parent slice
is already substantively done and the walkthrough is non-load-bearing
evidence for a 1-line text change.

## Decision

The parent work — the `Automatizar` → `Automático` rename in
`~/dev/ekoa-site/index.html` line 361 — was already implemented, reviewed
(clean), adversarial-reviewed (size-skipped), tested (grep gate green, HTML
parses), and adversarial-tested (size-skipped). The only outstanding step
was the walkthrough video, which was interrupted.

For a 1-line static text rename, the correctness gate (grep + HTML parse)
already proves the change. A walkthrough video is **nice-to-have evidence**,
not load-bearing proof, on a change with no runtime behavior.

This Err card retries by:
1. Acknowledging the parent slice's gates are already green.
2. Forwarding to the implement list so the pipeline continues; the
   implement step will be a no-op (change already present).

## Slices

| id | scope | files | acceptance |
|----|-------|-------|------------|
| s1 | acknowledge parent slice already complete | (none — read-only) | `grep -c 'motor escolhido: Automático' ~/dev/ekoa-site/index.html` returns 1; `grep -c 'motor escolhido: Automatizar' ~/dev/ekoa-site/index.html` returns 0 |

## Critical files to inspect

- `~/dev/ekoa-site/index.html` line 361 — the renamed label.
- `docs/autothing/runs/01KVZ7PK49DQMR98H9W2XA89SR/IMPLEMENT_NOTE.md` — the
  parent run's implementation record.

## Non-goals

- Do NOT re-record the walkthrough — the parent run owns that artifact and
  the user interrupted the recording intentionally.
- Do NOT re-edit the HTML — the change is already present.
