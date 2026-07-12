# S3 — Clone + edit Fittings — fresh-context adversarial review

**Verdict: ACCEPT** (2 low-severity, non-blocking findings)

Commits: 3a15eea, 00b3d0a, 60f8ed1, d06e8f5, e61730a, c9563d7 (+ 6a52c42 demo artifact)

## Evidence I ran myself
- `npm run typecheck` → exit 0
- `npm test -- tests/clone.test.ts tests/composition-switch.test.ts` → 33 passed (clone: 10, switch: 23)
- `npm test` (full) → **239 files passed / 6 skipped; 2068 tests passed / 14 skipped; exit 0**
- Live resolution of the demo clone via tsx: `taste-copy` resolves (faculty=design, cloned_from=taste@0.1.0, 8 baseline files), provenance well-formed, drift = `["garrison-notes.md"]` (see note below).
- `git status` clean of S3 artifacts; `git ls-files fittings/local/taste-copy` = 10 tracked files incl. clone.json.

## Acceptance criteria — all met
- **cloneFitting copies seed → fittings/local/<id> with clone.json provenance** (`cloned_from` + per-file sha256 baseline): `src/lib/clone.ts:140-210`. `fs.cp` deep byte copy; manifest re-keyed (`name` + `_local/<old>`→`_local/<new>` via `repointLocalRefs`); baseline snapshot taken AFTER re-key so the clone starts clean. Confirmed by `tests/clone.test.ts:42-94`.
- **Appends a resolvable library entry**: `appendRawLibraryEntry` (`src/lib/library.ts:46-53`) is idempotent-by-id (dupe id throws), entry re-resolves through `resolveLibraryEntry`. Verified live.
- **createFile adds NEW files (409 on existing, path-guarded, blocked-segment-guarded)**: `src/lib/fitting-files.ts:181-214`. Path-escape guard `safeResolve` (400), blocked segments `.git/.apm/node_modules/apm_modules` (400), existing→409. Route wires POST=create / PUT=overwrite (`src/app/api/fittings/[id]/file/route.ts:46-63`). Tests cover 409, `../escape.md`, `.git/config`, `.apm/...` (`tests/clone.test.ts:141-185`).
- **cloneDrift reports clone-vs-upstream, edits = drift (expected)**: `src/lib/clone.ts:236-261`. Edit/new-file/delete all read as drift. GET clone-status is read-only, 404s non-clones (`src/app/api/fittings/[id]/clone-status/route.ts`).
- **Clone action in compose fitting browser**: `src/components/compose/FacultyStation.tsx:128-133,515-660` — POST to `/api/fittings/<id>/clone`, inline `cloneError`, `cloned_from` badge.
- **Demo clone taste-copy on disk + in library.json + resolves**: confirmed (10 tracked files, `data/library.json:502`).

## Adversarial checks
- **Path traversal in newId**: `CLONE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/` (`clone.ts:39`) forbids `/`, `\`, and a leading dot → `..` and `a/b` rejected. Destination is `path.join(ROOT_DIR, "fittings/local", newId)`; no separator can be injected. **Safe.**
- **Path traversal in createFile userPath**: `../escape.md` → `path.resolve` lands outside root → prefix guard throws 400 (test asserts the file is NOT created). **Safe against lexical traversal.**
- **node_modules/.git leak in the copy**: `COPY_SKIP` + `fs.cp` basename filter skips whole subtrees; demo tree contains none. **Safe.**
- **Upstream edit mutating a clone**: `fs.cp` byte copy on independent inodes; nothing writes back to source; `cloneDrift` reads only the clone dir. Proven by `tests/clone.test.ts:187-204` (mutate source after clone → clone byte-identical, no drift). **Safe.**
- **Library append corruption under concurrency**: `writeRawLibrary` IS atomic — temp file on the symlink-resolved same-device dir, `fsync`, `rename(2)` (`src/lib/atomic-write.ts:40-109`). A concurrent reader never catches a torn/partial file. **No corruption.** (See Finding 2 for the separate lost-update nuance.)
- **Demo committed without polluting tests**: `tests/clone.test.ts` snapshots `data/library.json` in `beforeAll`, restores it in `afterEach`, and deletes temp clone dirs; the id-derivation test deliberately uses `basic-memory` (not `taste`) so it never collides with the committed `taste-copy` `-copy` slot (`clone.test.ts:96-110`). **Clean.**

## Findings (non-blocking)

**F1 (LOW) — path guards are lexical, not realpath-based; a symlink inside a Fitting can redirect a write outside the Fitting root.** `safeResolve` (`fitting-files.ts:54-61`) validates with `path.resolve` string-prefix only. Because `fs.cp` copies symlinks verbatim (`dereference` defaults false) and `COPY_SKIP` filters only by basename, a Fitting that ships a symlink (e.g. `link -> /etc`) would carry it into the clone; then `createFile(id, "link/evil.txt", …)` does `fs.mkdir(dirname)` + `fs.writeFile` THROUGH the symlink, writing outside the root. Reachable only with an attacker-authored Fitting containing an absolute symlink plus a user-chosen write path, on a single-user bypassPermissions box, so severity is low — but it is a genuine containment gap. Recommend an `lstat`-per-segment or `realpath`-containment check (reject when the resolved real path escapes the real fitting root). Same applies to `writeFile`.

**F2 (LOW) — library append has a lost-update window (no CAS).** `appendRawLibraryEntry` is a read-modify-write with no serialization; two concurrent clones both read the same base array and the second `writeRawLibrary` wins, dropping the first entry. No file corruption (rename is atomic), only a lost entry. `writeFileAtomic` already supports a `cas: { priorContent }` option that would close this at near-zero cost; it isn't used here. Fine for the current one-clone-at-a-time UI flow; worth wiring the CAS guard for robustness.

## Note (not a defect)
The committed `taste-copy` reports drift on `garrison-notes.md` because that file is on disk but absent from the clone.json baseline — i.e. a post-clone addition. This is the CORRECT "new file reads as drift" behavior and reads as a deliberate demonstration of a diverged clone, not a bug.
