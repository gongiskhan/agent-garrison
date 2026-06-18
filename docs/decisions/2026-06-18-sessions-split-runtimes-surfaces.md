# 2026-06-18 — Split the overloaded `sessions` role into sessions / runtimes / surfaces

## Context

The 2026-06-07 Quarters pivot collapsed the flat 24-Faculty list into **6
roles**. In practice the `sessions` role then accreted everything with a
runtime footprint: the Dev Env surface, the standalone browser, screen-share,
the Tailscale Outpost bridge, the artifact store, **and** all three alternative
execution runtimes (Agent SDK, Codex, Gemini). In the Compose UI this read as
one role with ~7 fittings while every other role had one or two — the role had
stopped describing a single concern.

## Decision

Split `sessions` into three roles (total: **8 roles**):

- **`sessions`** keeps the primary working surface: `dev-env` + `artifact-store`
  (and session records).
- **`runtimes`** (new, order 4) holds the alternative execution engines:
  `agent-sdk-runtime`, `codex-runtime`, `gemini-runtime`. These are an execution
  concern — peers to `gateway` — behind the uniform runtime-bridge `delegate()`
  contract, not session surfaces.
- **`surfaces`** (new, order 8) holds the auxiliary own-port live viewers:
  `screen-share-default`, `browser-default`, `outpost-tailscale-host` — the ways
  to *see/reach* the machine, linked from the sidebar Views group.

The `runtime` / `screen-share` / `outpost` capability kinds already existed, so
no capability-kind vocabulary change was needed — only the role grouping moved.

## Mechanics

- `facultyIds` (src/lib/types.ts) and `faculties` (src/lib/faculties.ts) gain the
  two roles; orders renumber to 1..8.
- The six moved fittings' `apm.yml` `x-garrison.faculty` flips to `runtimes` /
  `surfaces`. `data/library.json` needs no change — faculty is resolved from each
  manifest at load time.
- `FACULTY_ALIASES` (src/lib/metadata.ts): `screen-share`, `browser`, and
  `outposts` now fold to `surfaces` (were `sessions`), preserving backward
  compatibility for any older manifest.

## Why this is allowed (Honesty Test)

Each new role names a concern a real Fitting occupies and that the UI must group
distinctly; this is not speculative role inflation. It reverses part of the
6-role collapse, but only where the collapse had over-merged genuinely different
concerns. Recorded here so the role count's history stays legible.

## Follow-ups

UI work in the same change set depends on this: the Composition faculty cards
show per-faculty fitting counts, so the split makes the counts meaningful.
