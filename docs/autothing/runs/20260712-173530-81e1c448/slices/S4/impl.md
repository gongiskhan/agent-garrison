# S4 — Composition switching (WS4 / D6)

The active composition is now a **persisted pointer** (not a runtime heuristic).
The shell, an API, and a CLI switch between compositions with a clean
`resolve → down → set-pointer → up`, where the resolver runs FIRST and blocks the
switch with a readable message before any state changes. `up()` records run
evidence (composition id + apm.yml sha256) so the final gate can prove sessions
ran under two different composition ids straight off disk.

## Files

New:
- `src/lib/active-composition.ts` — the pointer store + resolver.
  `getActiveComposition()`, `setActiveComposition(idOrPath)` (atomic write via
  `writeJsonAtomic`), `resolveCompositionPointer(pointer)` → `{id, dir, manifestPath, external}`,
  `resolveActiveComposition()`. Reads/writes `~/.garrison/config.json`
  `{ active_composition }`, default `DEFAULT_COMPOSITION_ID`.
  **Naming note:** the task asked for `src/lib/garrison-config.ts`, but that file
  already exists for the unrelated `~/.garrison/config.yml` url-scheme feature
  (with its own `tests/garrison-config.test.ts`). To avoid clobbering it I used
  `active-composition.ts`.
- `src/lib/composition-switch.ts` — `switchComposition(target, deps?)` +
  `resolveTargetComposition(pointer)` + `formatResolverError`. Resolve-first,
  then `down(current)` → `setActive(pointer)` → `up(resolvedId)`. Deps (up/down/
  resolver/getActive/setActive) are injectable; the real up/down are lazy-imported
  so unit tests never load the runner.
- `src/lib/run-evidence.ts` — `appendRunEvidence({compositionDir, compositionId, manifestPath, at?})`,
  `readRunEvidence`, `sha256Hex`, `runEvidencePath`. File format: an
  **append-friendly array** of `{compositionId, apmYmlSha256, at}` at
  `<compositionDir>/.garrison/run-evidence.json`, oldest first, capped to 100.
- `src/app/api/composition/active/route.ts` — `GET` (pointer + resolved id/dir/external),
  `PUT` (set pointer, no switch).
- `src/app/api/composition/switch/route.ts` — `POST {target}` → `switchComposition`;
  200 on ok, **409** with the readable error on resolver failure.
- `scripts/garrison-up.mjs` — CLI. `--composition|-c <id-or-path>` (also `=` form),
  `--help`. Sets pointer + runs the switch; prints resolver errors and exits
  non-zero. Re-execs itself under the repo's local `tsx` so `.ts` imports resolve
  under plain `node`. Exports the pure `parseGarrisonUpArgs` for the test.
- `scripts/garrison-up.d.mts` — type decl for the CLI's arg parser (lets the TS
  test import it with `allowJs:false`).
- `tests/composition-switch.test.ts` — 23 tests (see below).

Modified:
- `src/lib/compositions.ts` — `export`ed `DEFAULT_COMPOSITION_ID` (was module-local).
- `src/lib/runner.ts` — `up()` calls `appendRunEvidence` right after reading the
  composition (before the heavy install/verify/spawn), best-effort, logged. Did
  NOT touch the gateway spawn logic.
- `src/components/chrome/AppShell.tsx` — floating `CompositionSwitcher` (native
  `<select>`, text/SVG only, no emoji), bound to the pointer via
  `GET /api/composition/active`; switching calls `POST /api/composition/switch`,
  shows `switching...` during down/up, surfaces a resolver error inline WITHOUT
  changing the selection (controlled value). `refreshAll` now picks the active
  composition by the persisted pointer, falling back to the legacy
  `running ?? first` heuristic.
- `.gitignore` — ignore `compositions/*/.garrison/run-evidence.json` (runtime state).

## Run-evidence: two composition ids on disk (final gate check #6)

Written via the same path `up()` uses (`readCompositionWithDerivedTasks` →
`appendRunEvidence`):

| composition id      | apm.yml sha256 |
|---------------------|----------------|
| `default`           | `80dc221687356ee54e4d2c130d1c14a64997cda0909bb179530f6026072a766e` |
| `secondary-minimal` | `6d1d802e3fd9c466ea999ddec7c4cd174945772834a4cc318c43cd096502e83f` |

Files: `compositions/default/.garrison/run-evidence.json`,
`compositions/secondary-minimal/.garrison/run-evidence.json` (gitignored runtime state).

## API examples

```
GET  /api/composition/active
  → { pointer:"default", id:"default", dir:".../compositions/default",
      manifestPath:".../apm.yml", external:false }

PUT  /api/composition/active   { "target": "router-v4" }
  → { pointer:"router-v4", id:"router-v4", external:false }

POST /api/composition/switch   { "target": "e2e-solo" }
  → 200 { ok:true, id:"e2e-solo" }
  → 409 { ok:false, error:"Cannot switch to \"…\" - capability resolution failed:\n  - orchestrator (missing-required): …" }
```

## CLI examples (verified)

```
node scripts/garrison-up.mjs --help                       # exit 0, prints usage
node scripts/garrison-up.mjs                              # exit 2, "--composition is required"
node scripts/garrison-up.mjs --composition <BAD apm.yml> # exit 1, resolver block, runner untouched
node scripts/garrison-up.mjs -c default                  # clean switch (down current, up default)
```

The resolver-block run printed:
`Cannot switch to "…/bad-comp/apm.yml" - capability resolution failed:` /
`  - orchestrator (missing-required): capability orchestrator is required by http-gateway but no provider is in the composition`
and left `~/.garrison/config.json` **absent** (resolve-first changed no state).

## Tests (tests/composition-switch.test.ts — 23 passed)

- active-composition pointer: defaults to `default`; round-trips via atomic write;
  preserves unrelated keys; rejects empty; falls back to default on corrupt file.
- resolveCompositionPointer: plain id under compositions/; folds an inside-compositions
  path back to its id; treats an external apm.yml path as external; blank → default.
- switchComposition: blocks on a bad target WITHOUT calling down/up/setActive;
  does not flip the real pointer when blocked; clean target runs
  `down:current → setActive:target → up:target` in order; down() failure returns a
  readable error and flips nothing.
- resolveTargetComposition (real resolver): resolves `default` to an issues array;
  throws "not found or unreadable" for a missing manifest.
- run-evidence: records id + a stable sha256; appends across launches; two
  compositions → two files with different ids + hashes.
- garrison-up CLI: parses `--composition`, `-c`, `--composition=`, absent flag,
  `--help`.

## Walls

- `npm run typecheck` → **0**.
- `eslint` on all S4 files → **0**.
- `tests/composition-switch.test.ts` → **23/23**.
- Full `npm test` → 2065 passed, 3 failed, all **outside S4**: 2 are WS3 clone
  state-pollution (`taste-copy` leftover in `data/library.json`, which S4 never
  touches), 1 is `runner-eager-lifecycle` (real-subprocess load flake — passes in
  isolation, as the vitest config comments predict).

## Commits

- `f1f5d09` feat(composition-switch): active_composition pointer, switch orchestration, run evidence, shell switcher + CLI (S4)
- `e21f4c7` test(composition-switch): S4 unit tests + typed CLI arg-parser decl (bundled with S2c matrix harness by the auto-committer)
- `43203c7` chore(gitignore): ignore composition run-evidence.json runtime state (S4)

(The first two were captured by the box's auto-committer as `goncalo.gomes`;
`git diff HEAD` is empty for all S4 source, so HEAD == the reviewed working tree.)
