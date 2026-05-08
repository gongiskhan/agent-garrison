---
name: artifact-store
description: Filesystem-backed storage for files the Operative or other Fittings produce. Use it whenever you generate something the user may want to view later — documents, recordings, audio.
---

# artifact-store

You can persist files the user may want to view, browse, or download
through this Faculty. Files live under `<composition>/artifacts/` (or
the path set via `GARRISON_ARTIFACTS_ROOT`). Each file has a sidecar
`<filename>.meta.json` carrying an id, MIME type, title, namespace, and
timestamps. The sidebar browser at `/fitting/artifact-store` reads
those sidecars directly — no further registration step is needed.

## Calling the CLI

All operations go through `python3 apm_modules/_local/artifact-store/scripts/artifacts.py` from the composition directory.

### Write a new artifact

```bash
echo "## Feature spec\n\n..." | python3 apm_modules/_local/artifact-store/scripts/artifacts.py write documents feature-spec.md \
  --title "Feature spec" \
  --producer documents
```

The command prints the artifact id on stdout. Save it and include
`garrison://artifacts/<id>` in your reply so the user can click
through. Re-running `write` with the same namespace+filename overwrites
in place and preserves the id.

### Read an artifact

```bash
python3 apm_modules/_local/artifact-store/scripts/artifacts.py read <id>
```

Bytes go to stdout. For markdown you can pipe straight into `cat`.

### List artifacts

```bash
python3 apm_modules/_local/artifact-store/scripts/artifacts.py list \
  [--namespace documents] [--producer ...] [--since 2026-05-01T00:00:00Z]
```

Returns a JSON array of metadata sorted by `updated` descending.

### Delete

```bash
python3 apm_modules/_local/artifact-store/scripts/artifacts.py delete <id>
```

Removes the file and its sidecar. Use sparingly — deletion is
permanent.

## Namespaces

Standard namespaces:

- `documents/` — user-facing markdown produced by the Documents
  Faculty or in PM/Architect hat.
- `automations/` — screen recordings, Playwright videos, browser
  trace exports.
- `voice/` — synthesized speech audio.

If your Fitting introduces a new artifact category, just pass the new
namespace name to `write` and the directory is created on demand.

## What NOT to put here

- Ephemeral or scratchpad state — that belongs in Memory.
- Configuration or operational data — that belongs alongside the
  Fitting that owns it.
- Anything the user did not produce or ask for.
