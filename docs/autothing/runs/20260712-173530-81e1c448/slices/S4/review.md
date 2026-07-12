# S4 — Composition switching — fresh-context adversarial review

**Verdict: ACCEPT** (1 low-severity, non-blocking finding)

Commits: f1f5d09, e21f4c7 (+ 43203c7 gitignore, 9eb424d report)

## Evidence I ran myself
- `npm run typecheck` → exit 0
- `npm test -- tests/clone.test.ts tests/composition-switch.test.ts` → 33 passed (switch: 23)
- `npm test` (full) → **239 files passed / 6 skipped; 2068 tests passed / 14 skipped; exit 0**
- `git status`: no S4 pollution; `run-evidence.json` gitignored (`compositions/*/.garrison/run-evidence.json`) and none tracked.

## Acceptance criteria — all met
- **active_composition pointer persisted in ~/.garrison/config.json (id OR apm.yml path)**: `src/lib/active-composition.ts`. `readActiveConfig` defaults a missing/blank/corrupt file to `default` and never throws; `setActiveComposition` atomic-writes and preserves unrelated keys. `resolveCompositionPointer` maps a plain id under `compositions/` and folds a path landing on a direct child back to its id; an external apm.yml is flagged `external:true`. Tests `composition-switch.test.ts:39-102`.
- **switchComposition RESOLVES first and blocks on resolver error WITHOUT touching running state or the pointer; else down→set-pointer→up**: `src/lib/composition-switch.ts:75-125`. Resolve-first at step 1; issues/throw → early `{ok:false}` with no dep calls. Order proven by `composition-switch.test.ts:104-186` (bad target → `order === []`; clean → `["down:current","setActive:target","up:target"]`; down-failure → no pointer flip; real getActive/setActive shows pointer stays `default` when blocked).
- **runner writes run-evidence {compositionId, apmYmlSha256, at}**: `src/lib/run-evidence.ts` + wired in `src/lib/runner.ts:140-157` (written EARLY, best-effort, a failed write never aborts launch; dir/id/manifestPath all come from one resolved composition object so they're consistent).
- **AppShell composition switcher surfacing resolver errors inline**: `src/components/chrome/AppShell.tsx:331-357,418-426` — `switchTo` POSTs `/api/composition/switch`; a 409 sets `switchError` shown inline without changing selection.
- **scripts/garrison-up.mjs --composition**: pure `parseGarrisonUpArgs` (space/=/`-c`/`--help`), tsx re-exec guard, resolve-first via `switchComposition`. Arg-parser unit-tested (`composition-switch.test.ts:249-272`).

## Adversarial checks
- **Can a resolver error leave the pointer changed or the old comp down?** No. Resolve is step 1; on error nothing else runs (`composition-switch.ts:86-94`; tests assert `order===[]` and real pointer unchanged). On `down()` failure the pointer is NOT flipped (`:99-108`, test `:173-185`). **Resolve-first ordering is correct.**
- **Path-traversal pointer escaping compositions/?** `resolveCompositionPointer` intentionally allows an external apm.yml path (D6 "point at a different apm.yml"), flagged `external:true`. A nonsense path (e.g. `/etc/passwd`) resolves lexically, then `resolveTargetComposition` fails to read a manifest and the switch is blocked — no escape, no crash. Not a sandbox escape on a single-user box. (See Finding for the external-run mismatch.)
- **apmYmlSha256 stable + actually the file's hash?** Yes. `sha256Hex(fs.readFile(manifestPath))` — pure over the manifest bytes; test asserts equality with an independent `crypto.createHash("sha256")` over the same bytes and against `sha256Hex` (`composition-switch.test.ts:209-223`). **Correct + deterministic.**
- **Append for TWO different composition ids?** Storage is one array file PER composition dir. Two compositions → two files, each self-contained with its own `compositionId`/hash. Test `:235-246` proves different ids + different hashes and correct per-file attribution. The final gate reads each composition's file. **Correct.**
- **Any secret logged in the switch path?** No. `composition-switch.ts` logs nothing; `formatResolverError` emits only capability-issue fields (kind/name/code/message); the CLI logs the pointer + resolved id (not a secret); run-evidence hashes `apm.yml` (secrets live in the Vault, materialized to env separately — the runner logs the env-file PATH, not values). **No leakage.**

## Finding (non-blocking)

**F1 (LOW) — external-pointer resolve/run mismatch.** When the pointer is an external apm.yml (`external:true`), `switchComposition` resolves/validates that external manifest but then calls `up(resolution.resolved.id)` where `id = path.basename(dir)`, and the runner resolves compositions BY ID under `compositions/`. Two cases: (a) basename matches no `compositions/` child → `up()` fails, switch returns `{ok:false}` — external compositions effectively can't be run (already acknowledged in the code comment at `active-composition.ts:78-82`); (b) basename collides with a `compositions/` child (pointer `/tmp/x/default/apm.yml`) → the resolver validates the EXTERNAL manifest but `up("default")` runs `compositions/default`, and run-evidence records the in-repo hash — a silent bait-and-switch between what was validated and what runs. Unreachable via the UI switcher (a `<select>` of known in-repo compositions, never an external path); only reachable via CLI/API with a hand-crafted external path, and it fails safe toward the in-repo composition. Recommend: either reject `external` pointers in `switchComposition`/`up` with a clear "external compositions are not yet runnable" error, or thread the resolved dir/manifestPath into `up()` instead of re-deriving by id.

## Observation (per-spec, not a defect)
If `up()` fails AFTER `setActive`, the pointer has already moved and the old composition is down — the D6 order is explicitly down→set→up, and the failure is surfaced (`switched the pointer … but starting it failed: …`). This is the specified ordering, not a regression.
