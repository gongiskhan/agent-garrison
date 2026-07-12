# S3 — Clone and edit Fittings (WS3) — impl record

**Goal (D5):** full round trip from the UI — clone a seed Fitting into a local
`_local`-namespace copy with `cloned_from` provenance + an upstream pin, edit a
file in Monaco INCLUDING creating a new file, drift status reflects
clone-vs-upstream, the clone is composer-selectable and runs in a composition,
and upstream updates never touch the clone.

Status: **implemented, tested, demonstrated end-to-end against the live server.**

## Demo clone artifact (left in place, as required)

- **id:** `taste-copy` — a real clone of the `taste` seed Fitting.
- **on disk:** `fittings/local/taste-copy/` (committed), incl. `clone.json`
  (provenance/baseline) and `garrison-notes.md` (the file created via the
  create endpoint, which persistently reads as drift).
- **registry:** appended to `data/library.json` with
  `cloned_from: "taste@0.1.0"`, `repo: local:fittings/local/taste-copy`,
  `localPath: fittings/local/taste-copy`.
- Resolves in `/api/library` with `faculty: design` → it appears in, and is
  selectable from, the Design station exactly like any Fitting.

## Files

New:
- `src/lib/clone.ts` — `cloneFitting`, `cloneDrift`, `readCloneProvenance`,
  `CloneError`, `CloneProvenance`.
- `src/app/api/fittings/[id]/clone/route.ts` — `POST` → `cloneFitting`.
- `src/app/api/fittings/[id]/clone-status/route.ts` — `GET` → provenance + drift.
- `tests/clone.test.ts`.

Changed:
- `src/lib/library.ts` — exported `RawLibraryEntry`; added `readRawLibrary`,
  `writeRawLibrary` (atomic, byte-identical style: 1-space indent, `\uXXXX`
  escapes, no trailing newline), `appendRawLibraryEntry`; `cloned_from`
  passthrough in `resolveLibraryEntry`.
- `src/lib/types.ts` — `LibraryEntry.cloned_from?: string`.
- `src/lib/fitting-files.ts` — added `createFile(id, path, content)`
  (create-only counterpart to overwrite-only `writeFile`; same escape +
  blocked-segment guards; mkdir -p parent; 409 if exists).
- `src/app/api/fittings/[id]/file/route.ts` — added `POST` (create) alongside
  the unchanged `PUT` (overwrite).
- `src/components/compose/FacultyStation.tsx` — a "Clone" control on every local
  library card (text label, no emoji) + a "clone" provenance badge on cloned
  cards; posts the clone route and refreshes the registry so the clone appears
  in the same Faculty.
- `src/components/chrome/AppShell.tsx` — added `refreshLibrary()` (lightweight
  registry-only refetch; does not re-select the active composition).
- `tests/model-docs-parity.test.ts` — resolve each entry's manifest via
  `entry.localPath` (seed under `fittings/seed/<id>`, clones under
  `fittings/local/<id>`) instead of assuming the seed dir.

## Design notes / divergences from the brief

- **`.apm/` is copied, NOT skipped.** The brief's skip-list named
  `node_modules/apm_modules/.git/.apm`, but for skill/hook Fittings the authored
  primitive content lives under `.apm/` (taste ships its SKILL.md files at
  `.apm/skills/<name>/SKILL.md`). Skipping it would produce a broken clone whose
  verify hook fails. Skip-list is `node_modules`, `apm_modules`, `.git`,
  `.DS_Store` only.
- **Clone is re-keyed as an independent APM package.** The copied `apm.yml`
  `name` is set to the new id and any `_local/<oldName>` reference (the verify
  path, which APM materialises at `apm_modules/_local/<name>/`) is repointed to
  `_local/<newId>`, so it installs/verifies standalone with no collision with
  upstream. Verified live: `taste-copy` verify command reads
  `_local/taste-copy/...`.
- **Drift baseline** is captured AFTER the re-key writes, so the clone starts
  clean; a later user edit, a newly-created file, or a deleted file all read as
  drift — the correct, expected "clone diverges from upstream" signal. Upstream
  is pinned in `clone.json` and never auto-updated.
- **Atomic registry write** — `writeRawLibrary` uses `writeFileAtomic`
  (temp + rename) so a concurrent reader never catches a torn file.

## API examples (verified live on 127.0.0.1:7777)

```
POST /api/fittings/taste/clone
  -> 201 { entry: { id: "taste-copy", faculty: "design",
                    cloned_from: "taste@0.1.0", localPath: "fittings/local/taste-copy", ... } }
  (default id increments: a second call with taste-copy taken -> "taste-copy-2")

POST /api/fittings/taste-copy/file  { "path": "garrison-notes.md", "content": "..." }
  -> 201 { ok: true, path: "garrison-notes.md", size: 67 }
POST (same path again)              -> 409 { ok: false, error: "File already exists ..." }

GET  /api/fittings/taste-copy/clone-status
  -> 200 { cloned_from: "taste@0.1.0",
           drifted: ["garrison-notes.md"],
           clean: [".apm/skills/.../SKILL.md", "LICENSE", "apm.yml", "upstream.json", ...] }
GET  /api/fittings/taste/clone-status  (non-clone)  -> 404
```

## Tests

`tests/clone.test.ts` (10 tests, stable across repeat runs):
- `cloneFitting > copies the source tree, writes provenance, and appends a resolvable library entry`
- `cloneFitting > defaults the new id to <source>-copy, then increments, and refuses a duplicate`
- `cloneFitting > rejects an unknown source`
- `cloneDrift > is clean for an untouched clone and drifts on a local edit`
- `cloneDrift > 404s (throws CloneError) for a Fitting that is not a clone`
- `createFile > creates a new file (mkdir -p parent) and it reads back as drift`
- `createFile > refuses to overwrite an existing file`
- `createFile > rejects a path that escapes the fitting directory`
- `createFile > rejects a blocked path segment`
- `copy independence > an edit to the upstream source never changes the clone`

Test hygiene: clone.test.ts is the only test that writes `data/library.json`.
It snapshots the registry once and, after each test, restores the snapshot and
deletes any temp clone dirs — so a failed assertion or a parallel test file
never sees a leftover clone, and the committed `taste-copy` demo entry is
preserved.

## Walls

- `npx tsc --noEmit` — 0 errors.
- `npx eslint` (all changed files) — clean.
- `npx vitest run` (full suite) — **2068 passed, 14 skipped, 0 failed** on a
  clean run. One test file, `tests/runner-eager-lifecycle.test.ts`, flakes
  intermittently under full-parallel forks + the live dev server on this box
  (it spawns real subprocesses and races the server's status-file JSON writes;
  a different test within it fails each run, "Unterminated string in JSON at
  position 16384"). It passes 6/6 reliably in isolation and is unrelated to S3
  — this is the flake class documented in `vitest.config.ts`.

## Commits

- `3a15eea` feat(clone): cloneFitting + _local namespace + provenance/drift baseline (S3)
- `00b3d0a` feat(fitting-files): createFile + POST route for new files (S3)
- `60f8ed1` feat(compose): Clone action in the fitting browser (S3)
- `d06e8f5` refactor(library): atomic writeRawLibrary (torn-read-safe registry writes, S3)
- `e61730a` test(clone): cloneFitting/createFile/drift/copy-independence round trip (S3)
- `6a52c42` test(clone): namespace-aware manifest resolution + demo taste-copy clone artifact (S3)
