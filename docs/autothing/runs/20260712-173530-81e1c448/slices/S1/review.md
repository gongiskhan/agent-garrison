# S1 "taste Fitting" — fresh-context adversarial review

**Commit:** d1379a6603eb22e4536e4f7e26266febc9b8f6ec
**Reviewer:** review-s1 (fresh context, own evidence)
**Verdict: approve**

## Evidence I gathered myself

| Check | Command | Result |
|---|---|---|
| Slice tests | `npm test -- tests/taste-fitting.test.ts tests/seed.test.ts` | exit **0** — 15 passed (taste-fitting 5, seed 10) |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | exit **0** |
| Drift checker | `node fittings/seed/taste/scripts/check-upstream.mjs --offline` | exit **0** — both skills `clean` |
| Independent sha256 | `sha256sum` on both vendored SKILL.md | match upstream.json exactly |
| Library load | `readLibrary()` / `getLibraryEntry("taste")` via tsx | OK — 33 entries, taste has `localPath: fittings/seed/taste`, `platforms: [all]` |
| Composition load | `readCompositionWithDerivedTasks("default")` via tsx | OK — `design` selection `[{id:taste,config:{}}]` present |

## Acceptance criteria — all met

1. **Vendored skills + pin.** Two skills (`design-taste-frontend`, `redesign-existing-projects`) vendored under `fittings/seed/taste/.apm/skills/`. `upstream.json:3` pins the full 40-char SHA `b17742737e796305d829b3ad39eda3add0d79060` (matches the acceptance SHA exactly), per-file sha256s recorded and independently verified. `scripts/check-upstream.mjs` runs clean (exit 0). Each skill dir carries a genuine MIT `LICENSE` (`Copyright (c) 2026 Leonxlnx`), plus a root `LICENSE`.
2. **Strict parser + registration.** Manifest parses under `parseGarrisonMetadata` with `faculty: design`, `component_shape: skill`; the `verify` hook (`apm.yml:24`) checks both SKILL.md paths, and those paths exist at the install location `compositions/default/apm_modules/_local/taste/.apm/skills/<name>/SKILL.md` (same `apm_modules/_local/<name>/` convention as trello/basic-memory). Registered in `data/library.json` with `localPath` (readLibrary loads all 33 entries without throwing). Present in `compositions/default/apm.yml` as both a dependency (`:29`) and a `design:` selection (`:83-85`).
3. **Tests non-vacuous.** `tests/taste-fitting.test.ts` — 5 tests each make real assertions (recomputes sha256 and compares, 40-char SHA regex, LICENSE content, library localPath/platforms). `tests/seed.test.ts` adds `taste` to `seedIds`, and its parse loop asserts taste parses with array `provides`/`consumes`.
4. **Hard constraints honored.** No `src/` or `package.json` changes (no new npm deps, no functionality rewritten, UI terminology untouched). Commit is on `main` — no branch created.

## On-disk activation (part of the slice) — confirmed

- `~/.garrison/global-composition/apm.lock.yaml` lists `taste` with `deployed_files` under `.claude/skills/design-taste-frontend` and `.claude/skills/redesign-existing-projects` (+ hashes).
- `~/.claude/skills/design-taste-frontend/{SKILL.md,LICENSE}` and `~/.claude/skills/redesign-existing-projects/{SKILL.md,LICENSE}` exist on disk. Both are already surfaced as available skills in this session (Claude Code discovered them), and their SKILL.md `name:` frontmatter matches the directory names.

## Non-blocking observations (no concrete failure scenario — not gating)

- `data/library.json` was rewritten as a full-file reorder (472→486 lines) instead of a minimal single-entry insert. I verified every non-taste entry is byte-identical as a JSON object and only `taste` was added, so no data changed — but the churn inflates the diff and will complicate future review/merge. Consider keeping the file in a stable order.
- `docs/autothing/known-flakes.md` was added as an empty (0-byte) file — stray artifact.
- `upstream.json` has no trailing newline.
- `check-upstream.mjs` online mode compares the pin against the repo's default-branch HEAD (`commits?per_page=1`); if the pin ever lives on a non-default branch this could report a spurious "moved ahead". Fine for the current MIT-vendoring use.

None of these change the verdict.
