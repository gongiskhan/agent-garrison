# Agent Garrison

Agent Garrison is an open-source distribution and composition platform
for Claude Code. It lets you station APM-packaged **Fittings** into
**Faculty** slots, inspect the manifest, run the **Operative** locally,
and stream every runner step.

Source-of-truth project overview for tooling agents:
[../CLAUDE.md](../CLAUDE.md). The full v1 bootstrap spec is preserved
at [SPEC.md](./SPEC.md).

## Start

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

The app has no auth and only talks to localhost. v1 targets Claude Code
and shells out to Microsoft APM for install, audit, and lockfile
behavior. If `apm` is not installed, the Run tab shows a preflight
error instead of pretending the Operative started.

## Repo Shape

Spec and design docs (all under `docs/`):

- `SPEC.md` — the source-of-truth bootstrap spec (the former
  `AGENTS.md`).
- `METADATA.md` — `x-garrison` schema reference, including the
  `setup`, `for_consumers`, and UI contract v2 fields.
- `FACULTIES.md` — long-form per-Faculty notes (14 Faculties + derived
  Tasks).
- `FITTINGS.md` — seed Fitting catalogue.
- `CAPABILITIES.md` — capability kinds (`orchestrator`, `soul`,
  `agent-skill`, `memory-store`, `automation-runner`, `data-source`,
  `channel`, `artifact-store`, `vault`).
- `V1_DOD.md` — observable Definition of Done checklist.
- `GARRISON_ROADMAP.md` — live phased roadmap. Phases 1, 3, 4 done;
  Phase 5 (Armory) in progress.

Governance:

- `GOVERNANCE.md` — positioning, the Honesty Test, contribution model,
  validation pipeline, license posture.
- `CONTRIBUTING.md` — how to submit a Fitting or contribute to the
  platform.
- `DECISIONS.md` — append-only log of design decisions.

Phase records (`docs/phases/`):

- `PHASE1_VERIFICATION.md` … `PHASE5_VERIFICATION.md` — per-phase
  done-when evidence.
- `PHASE_5_ANALYSIS.md`, `PHASE_5_EXECUTION.md` — Phase 5 planning
  artifacts (kept for traceability while Phase 5 lands).

Source layout:

- `compositions/<id>/apm.yml` — source of truth for each composition.
- `fittings/seed/` — local APM seed Fittings used during bootstrap.
  See `fittings/seed/README.md` for the orchestrator gap notice.
- `data/vault.json` — encrypted secrets, file mode `0600`.
- `src/` — Next.js 14 app (Compose / Run / Vault / Chat / Trenches /
  Armory / per-Fitting sidebar surfaces) plus `src/lib/` runtime
  modules (`runner.ts`, `capabilities.ts`, `vault.ts`,
  `metadata.ts`, `artifact-store.ts`, `fitting-views.ts`, …).

## Validating a Fitting

```bash
tsx scripts/validate-fitting.ts fittings/seed/memory
```

Runs the four-check validation pipeline against any Fitting directory.
See [GOVERNANCE.md §4.3](./GOVERNANCE.md) for what each check does.

## Tests and typecheck

```bash
npm run typecheck
npm test
```

Integration smoke (live SDK + composition wiring):

```bash
npm run check:integration
```
