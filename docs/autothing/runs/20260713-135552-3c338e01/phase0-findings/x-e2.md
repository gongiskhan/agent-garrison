I've sent the full findings to team-lead. Summary of what I found:

**FINDING-E2** (composition file structure): `compositions/default/apm.yml` has no schema-version marker; everything Garrison-specific sits under `x-garrison.composition` (`global_config`, `selections` keyed by the 9 role Faculties + `connectors`, `prompt_sources`). Fitting config values live inline as `selections[].config` - confirmed live (not decorative) via `runner.ts:559-564`. Found 10+ distinct readers/writers of `apm.yml` across `compositions.ts`, `metadata.ts`, `global-composition.ts`, `reconcile.ts`, `runner.ts`, `active-composition.ts`, `composition-switch.ts`, `quarters-runtimes.ts`, plus several that read a *Fitting's own* apm.yml (different file, easy to conflate). The only composition-schema migration code is `migrateSelectionsByFaculty` at `compositions.ts:278,364-378` (moves stale role-key selections on read).

**FINDING-E18** (dispatch config outside routing.json/policy.json): Found two real violations worth flagging:
1. `global_config.primary_runtime` in apm.yml - a deprecated fallback that duplicates the policy file's primary-runtime choice (already warned-about in `runner.ts:269-297`, should be deleted outright rather than kept as a silent-unless-conflicting fallback).
2. A genuine split-brain the code itself calls out (`runner.ts:585-589`): the composition-scoped `.garrison/routing.json` vs the global `~/.garrison/orchestrator/routing.json`/`policy.json` fallback - and on this machine right now those two routing.json copies have already diverged (15441 vs 16961 bytes, different mtimes).

Everything else checked (guardrails, permissions_mode, modes' default_mode, runtimes' provider/model config) is correctly owned by apm.yml already and shouldn't move.
