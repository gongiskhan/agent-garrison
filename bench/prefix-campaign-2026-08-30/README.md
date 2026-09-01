# Prefix benchmark campaign — 2026-08-30

Eight builds of one spec against one seed repo, four through a Garrison
conversation (Arm A) and four through a plain `claude -p` session (Arm B),
measured to answer whether three runs per arm can detect a 20% difference.

Reports:

- [`docs/reports/2026-08-30-prefix-benchmark-campaign.md`](../../docs/reports/2026-08-30-prefix-benchmark-campaign.md)
  — every run's measurements, per-arm median and spread, and the detectability
  statement.
- [`docs/reports/2026-08-30-prefix-benchmark-reanalysis.md`](../../docs/reports/2026-08-30-prefix-benchmark-reanalysis.md)
  — per-model split, every Arm A stretch, the extra cycles with their triggering
  handoffs quoted, cold-start and decomposition tables.

What is here:

- `TASK.md` — the spec, byte-identical for every run, md5 `252f37f2bcdf6bd460dce95a1eb306f3`.
- `seed/` — the seed repo at tag `seed-v1`, source only. Four planted libraries
  (`store.js`, `identity.js`, `settings.js`, `audit.js`) and the conventions in
  its `AGENTS.md` are what a run is expected to discover and reuse.
- `runs/` — per run: the measurement record, the filled checklist, the driver's
  own JSON, and for Arm B the proxy capture (one line per API exchange) and the
  CLI's result envelope.
- `evidence/` — the raw evidence behind each checklist row.
- `harness/` — the runners, the measurement proxy, the collectors, the report
  generators and the blind-review server.
- `reanalysis.json`, `analysis.json`, `campaign.json` — the computed data the
  two reports render.

What is deliberately absent: `KEY.md` and `mapping.json`, the label-to-run map
for the blind review, which stay out of version control while that review is
open; the eight built apps and their `node_modules`; and `verdicts.md`, which is
the reviewer's to write.

A caveat on the blindness: the run data here includes each app's source through
the checklists and evidence, so someone comparing a served page against this
directory could work out which label is which. The key being absent is what
keeps the review honest, not the impossibility of defeating it.
