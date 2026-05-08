# Agent Garrison Fitting · Artifact Store

A filesystem-backed storage layer for files the Operative or its
Fittings produce. Other Fittings (Documents, Automations recordings,
Voice synthesis) layer their own schemas on top of this one shared
backing store; nothing else needs to know how files are persisted.

## What it does

- Stores files under `<composition>/artifacts/<namespace>/<filename>`
  with a sidecar `<filename>.meta.json` carrying id, MIME type, title,
  namespace, producer, and timestamps.
- Surfaces them in the left sidebar at
  `/fitting/artifact-store` for browsing and download.
- Exposes a small Python CLI (`scripts/artifacts.py`) that producer
  Fittings call to write/read/list/delete artifacts.

## Configuration

| Key | Default | Description |
|---|---|---|
| `storage_root` | `artifacts` | Storage root, relative to the composition directory. Override at runtime via `GARRISON_ARTIFACTS_ROOT`. |

## Out of scope (v1)

- Retention policies. Nothing is ever pruned.
- Search across the corpus. List + filter is enough for v1.
- Multi-user / shared artifacts.
- Versioning beyond what filesystem + git would give.
- Encryption at rest. Vault handles secrets; artifacts are user-content
  files.

## Verify

`scripts/verify.sh` runs `artifacts.py --probe`, which resolves the
storage root and checks that it is writable.
