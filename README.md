# Agent Garrison

Agent Garrison is an open-source distribution and composition platform
for Claude Code. It lets you station APM-packaged Fittings into Faculty
slots, inspect the manifest, run the operative locally, and stream
every runner step.

## Start

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

The app has no auth and only talks to localhost. v1 targets Claude Code
and shells out to Microsoft APM for install, audit, and lockfile
behavior. If `apm` is not installed, the Run tab shows a preflight
error instead of pretending the operative started.

## Repo Shape

Specs and design docs:

- `AGENTS.md` — the source-of-truth bootstrap spec.
- `METADATA.md` — `x-garrison` schema reference.
- `FACULTIES.md` — long-form per-Faculty notes.
- `FITTINGS.md` — per-seed Fitting catalogue.
- `CAPABILITIES.md` — the five capability kinds.
- `V1_DOD.md` — observable Definition of Done checklist.

Governance:

- `GOVERNANCE.md` — positioning, the Honesty Test, contribution model,
  validation pipeline, license posture.
- `CONTRIBUTING.md` — how to submit a Fitting or contribute to the
  platform.
- `DECISIONS.md` — append-only log of design decisions.

Source layout:

- `compositions/<id>/apm.yml` — source of truth for each composition.
- `fittings/seed/` — local APM seed Fittings used during bootstrap.
  See `fittings/seed/README.md` for the orchestrator gap notice.
- `data/vault.json` — encrypted secrets, file mode `0600`.

## Validating a Fitting

```bash
tsx scripts/validate-fitting.ts fittings/seed/memory
```

Runs the four-check validation pipeline against any Fitting directory.
See [GOVERNANCE.md §4.3](./GOVERNANCE.md) for what each check does.
