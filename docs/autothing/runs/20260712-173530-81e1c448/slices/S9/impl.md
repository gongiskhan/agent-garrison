# S9 — WS9 full UI/UX redesign pass (LAST workstream)

Applied the taste redesign system across every Garrison surface, then hard-cut
copy, added touch affordances, and proved the shell holds at iPhone width.

## What shipped
- **Audit** (commit 7b16238): `docs/design/UIPASS_AUDIT.md` — 190-line per-surface
  findings pass (shell nav, Compose, Quarters, dashboard/Run, Vault, per-Fitting
  routes, WS3-WS6 surfaces) against the redesign-existing-projects taste skill.
- **Copy cut** (commit 34d9899): visible-copy words 688 -> 518 (**24.7%** cut)
  measured deterministically by `scripts/measure-copy.mjs --surfaces`. Before/after
  in `docs/design/UIPASS_WORDCOUNT_{BEFORE,AFTER}.json`. Cuts landed in
  FacultyStation, StationGrid, VaultPanel, QuartersIndex, RuntimeDegradationNotice.
- **Affordances** (commit 91fb8ad): `src/app/globals.css` coarse-pointer block —
  44px min touch targets, larger tap padding on buttons/inputs at
  `(pointer: coarse)`, applied to Vault + FacultyStation controls.
- **Narrow-viewport fix** (commit 69663d2): the Vault "Where secrets live" table
  overflowed 42-58px at 390px; wrapped it in `overflow-x:auto; max-width:100%` so
  it scrolls within its own bounds. Post-fix 390px overflow = **0px on all four
  surfaces** (`slices/S9/overflow-390.json`, `narrow-viewport.json`).

## Preserved (constraints)
- UI still speaks in Fittings/Faculties; primitive-type words never became primary
  labels. Storyboard-asserted strings survive the cut (search aria-label, tier
  section testids, #composition-switcher).
- Monaco, owned/loose/parked, provenance, drift, review-queue semantics untouched.

## Evidence
- `slices/S9/overflow-390.json` — post-fix 390px overflow, all 0px.
- `slices/S9/narrow-viewport.json` — 4-surface pass with the vault fix noted.
- `slices/S9/{home,compose,quarters,vault}-390.png` + `narrow-*.png` — screenshots.
- Full suite: 2141 passed; sole failure is the documented vault-heal spawn flake
  (18/18 in isolation), logged in `docs/autothing/known-flakes.md`.

## Addendum — implementer detail (commit 6456b66)

Beyond the coarse-pointer touch block, the mobile pass also:
- reflows the Vault `SecretRow` fixed `220px 1fr auto auto auto` grid to a
  `grid-template-areas` stack below 560px (was the worst 390px break when
  unlocked) — classes `.vault-secret-row` + `.secret-*`;
- reflows the FacultyStation 4-up `Cardinality/Shapes/Selected/Verify` grid to
  2-up and stacks the config `.field` rows below 560px (`.station-cells`);
- scopes `overflow-wrap:anywhere` to `table.simple code` so the vault phase
  table's long paths wrap while short labels (PHASE, runtime) stay whole —
  cleaner than breaking every cell.

Narrow-viewport evidence was re-captured with a **fresh Playwright context per
route** (mobile + touch, 390×844) to avoid mobile-viewport zoom carryover across
routes; final `slices/S9/overflow-390.json` = **0px on /, /compose, /quarters,
/vault**, `pointer:coarse` active on every route. typecheck exit 0; eslint clean
on the 5 touched files; tour suites 42/42; full suite 247 files / 2142 tests
passed (6 files / 14 tests skipped).

## Verdict: passed — MARATHON-WS9 OK
