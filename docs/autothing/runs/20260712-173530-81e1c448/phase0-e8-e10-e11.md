# Phase 0 exploration — FINDING-E8 / E10 / E11

Repo: `/home/ggomes/dev/garrison`. Facts with `file:line` citations. Verified against live disk state on 2026-07-12.

---

## Q1 (FINDING-E8) — Fitting-owned Quarters skills, end to end

**Key correction:** for the **skill** surface, "owned" is **not** the `_garrison: "fitting:<id>"` tag. That tag is the ownership mechanism for **hooks** (in `settings.json`). Skills/commands/rules are file surfaces whose ownership = presence in the **global APM lockfile's `deployed_files`**. `src/lib/primitive-state.ts:22-26` states all three mechanisms: "file surfaces diff disk-vs-lock; hooks read the settings.json `_garrison` ownership tag; mcp reads mcp.json". A fitting like `garrison-skills` ships **both** (skills owned via the lock; goal-loop hooks owned via the `_garrison` tag).

**Reference example: `garrison-skills`** — `fittings/seed/garrison-skills/apm.yml` (`type: skill`, `includes: auto`, `x-garrison.faculty: building`, `component_shape: skill`). Ships 16 skill dirs under `fittings/seed/garrison-skills/.apm/skills/<name>/`. Library entry `data/library.json:431-444`.

**Full path:**

1. **Declare** — skill lives at `.apm/skills/<name>/SKILL.md`; APM deploy mapping `.apm/skills/X` -> `.claude/skills/X`. Reverse mapping encoded in `src/lib/reconcile.ts:118-124`. Fitting's `verify` references `apm_modules/_local/garrison-skills/.apm/skills/garrison/SKILL.md`.

2. **Materialize** — single writer is the **global composition**: `~/.garrison/global-composition/` = `apm.yml` + `apm_modules/` + `.claude` symlink -> real `~/.claude` (`src/lib/global-composition.ts:14-20`). `ensureClaudeSymlink` creates/repoints the link (`global-composition.ts:52-79`); `apmInstall` runs `apm install --force`, deploying through the link into `~/.claude` (`global-composition.ts:123-133`). Deps authored by `writeGlobalApmManifest` (`global-composition.ts:106-120`).

3. **Provenance tag** — `src/lib/provenance.ts`. NOT the ownership authority for files. Ledger at `~/.garrison/global-composition/garrison-provenance.json` (`provenance.ts:15`); entries hold `lastWrittenHash` (echo suppression) + optional `fittingId`/`surface` (`provenance.ts:19-25`). `recordWritten`/`recordWrittenBatch` (`provenance.ts:46-67`). For skills, ownership is the lock, not the ledger.

4. **Classify owned** — `computeStateModel` (`src/lib/primitive-state.ts:73`). File surfaces: `owned = lock.allDeployedFiles.has(f.relPath)` (`:86`); `ownerDep` = lock dep whose `deployedFiles` includes the path (`:87`); record gets `state: owned|loose` (`:99`), `fittingId: ownerDep.name` (`:101`), `managedBy: "apm"` (`:103`). Hooks branch (`:124-139`): `state = marker !== undefined ? "owned" : "loose"` where `marker = group._garrison`, `fittingId = hookOwner(marker)` — the `_garrison: "fitting:<id>"` path. MCP always loose (`:162`).

5. **reconcile / state-transitions** — `reconcile()` (`reconcile.ts:159-207`) imports loose skills into captured fittings, hash-comparing against ledger `lastWrittenHash` to suppress echoes (`:195-199`); `emitFitting` reverses the `.apm/skills` mapping (`:110-150`). `src/lib/state-transitions.ts`: `promote` loose->owned (`:44-91`: emit, add dep, `writeGlobalApmManifest`, `apmInstall`, `recordWritten`); `park` owned->parked (`:95-142`: drop dep, reinstall, Garrison deletes orphan files + `forgetEntry`); `unpark` (`:145-179`).

6. **Drift** — `primitive-state.ts:88-94`: `driftedFromLock = hashFile(absPath) !== ownerDep.deployedHashes[relPath]`. Expected hash from lock `deployed_file_hashes`, parsed in `readGlobalLock` (`global-composition.ts:172-181`).

**Live-state caveat (verified):** `~/.garrison/global-composition/` is **absent**, no global lock, and `~/.garrison/claude-install.lock.json` is **absent** — yet all 16 `garrison-*` skill dirs exist under `~/.claude/skills`. So right now they classify **loose**, not owned. Machinery is implemented but not activated on this box (global composition never installed).

---

## Q2 (FINDING-E10) — active composition selection

**No "active composition" config file.** No `~/.garrison/config.json`; nothing persists a selected id. The id is a path segment / function argument.

- **Storage:** `compositions/<id>/apm.yml` = source of truth; filesystem authoritative. `DEFAULT_COMPOSITION_ID = "default"` (`src/lib/compositions.ts:14`); `getCompositionDirectory` (`:186`); `ensureDefaultComposition` seeds `default` (`:203`). `listCompositions` reads every dir under `COMPOSITIONS_DIR`, sorts by `name.localeCompare` (`compositions.ts:127-144`).
- **On disk now: 5 compositions** — `default`, `dogfood-orch`, `e2e-solo`, `router-v4`, `secondary-minimal`. Only `default` + `dogfood-orch` are installed (have `apm_modules/` + `apm.lock.yaml` + `logs/` + `artifacts/`); the other 3 have only `apm.yml`. Installed layout: `apm.yml`, `apm.lock.yaml`, `apm_modules/`, `artifacts/`, `briefs/`, `data/`, `logs/`, `profile.md`.
- **`up()`/`down()`:** `up(compositionId, opts)` (`src/lib/runner.ts:117`) takes the id as arg, calls `readCompositionWithDerivedTasks(compositionId)` (`runner.ts:134`); all downstream work scoped to that id. Runner assumes NO default — caller supplies it.
- **Route:** `POST /api/runner/[id]/up` -> `up(params.id)` (`src/app/api/runner/[id]/up/route.ts:9`). Id = URL segment.
- **UI selection:** `AppShell.refreshAll` (`src/components/chrome/AppShell.tsx:134`) fetches `/api/compositions` (all), fetches each `/api/runner/<id>/state`, then `next = running ?? allCompositions[0]` (`AppShell.tsx:~159-163`; `running` = first with status running/starting). That composition's id drives every later up/down/state call (`AppShell.tsx:187, 215, 242`). "Active" = running one, else first by sorted name — a runtime heuristic, not stored config.

---

## Q3 (FINDING-E11) — Armory / registry local copies

- **Armory route:** `/armory` -> `redirect("/compose")` (`src/app/armory/page.tsx:6`). Discovery = cross-faculty search box on `/compose`.
- **Registry = local copies today.** `data/library.json` array; each entry has `repo` (e.g. `"local:fittings/seed/http-gateway"`) + `localPath` (e.g. `"fittings/seed/http-gateway"`). `readLibrary` (`src/lib/library.ts:22-27`) -> `resolveLibraryEntry` (`:34-50`) reads `<ROOT_DIR>/<localPath>/apm.yml` x-garrison via `parseGarrisonMetadata`. v1 "bootstrap mode": missing `localPath` **throws** (`library.ts:38-40`). So every registry entry is currently a local copy under `fittings/seed/`.
- **No `_local` Garrison UI namespace**, but `_local/` is APM's internal convention for local-path deps: `depName` strips `_local/` prefix from `repo_url` (`global-composition.ts:157`); local deps materialize under `<composition>/apm_modules/_local/<name>/` (`souls.ts:246-250`; garrison-skills verify path). APM layout, not a Garrison namespace.
- **Composer resolves local vs registry** in `writeComposition` -> `authorApmDependencies`: `entry.localPath ? { absPath: path.join(ROOT_DIR, entry.localPath) } : { repo: entry.repo }` (`compositions.ts:156-160`). Local -> absPath dep; non-local -> repo. `selectedLibraryEntries` filters library by selection ids (`compositions.ts:297-305`).
- **Monaco editor (per-Fitting file editing):** `src/components/FittingEditor.tsx` loads `@monaco-editor/react` via dynamic import (`:17`), used by `AppShell`. Lists tree from `GET /api/fittings/[id]/files` (`FittingEditor.tsx:81` -> `listDirectory`); reads via `GET`, **saves via `PUT /api/fittings/[id]/file`** (`src/app/api/fittings/[id]/file/route.ts` GET+PUT -> `readFile`/`writeFile`). Backend `src/lib/fitting-files.ts`: `resolveLocalFitting` requires `entry.localPath` (`:43-52`); `safeResolve` path-escape guard (`:56-63`); blocked segments `node_modules/apm_modules/.git/.apm` (`:6, 68-77`); 1 MiB read cap (`:6`); **`writeFile` overwrite-only, refuses to create new files** (`:184-190`). Net: the per-Fitting editor edits the local seed fitting source in place under `fittings/seed/<localPath>/`.

**Cross-cutting:** because every library entry is a local `fittings/seed/` copy edited in place, and the global-composition install is dormant on this box, the "Fitting owns skills" story is wired but inert here — `garrison-skills` exists and is correctly modeled, but its 16 skills are live on disk as loose, unmanaged by any lock.
