# Every Fitting has a view; fittings share the operative's lifecycle

**Date:** 2026-07-29
**Status:** Shipped

## Context

A Fitting could ship with or without a UI. Simple fittings (skills, MCPs,
hooks, prompts) had none, so the product surface was inconsistent: some
equipped fittings appeared in the sidebar "Fittings Views" group, others were
invisible and only reachable through the `/fitting/<id>` overview page — a
read-mostly metadata/config page. Own-port fittings additionally carried two
lifecycle escape hatches: a per-fitting **eager** toggle (boot with the
Garrison server, survive `down` and the orphan sweep; prefs in
`eager-boot.json`, boot via `src/instrumentation.ts` + a detached tsx child)
and a manifest-level **`lifecycle: detached`** opt-out (never auto-managed).
Three lifecycles for one concept, and a sidebar that showed only part of the
composition.

## Decision

1. **Every Fitting has a view.** Non-negotiable, enforced by the validation
   pipeline's architecture check and a seed-wide vitest gate: a manifest
   declares at least one `x-garrison.ui.views[]` entry or `own_port: true`.
   Five host-provided **shared views** cover the common shapes with zero
   fitting-side code, selected by pointing the view's `entry` at
   `garrison:skill` / `garrison:prompt` / `garrison:runtime` /
   `garrison:connector` / `garrison:manage`. Shared views have real function
   (frontmatter/body editing autosaved to the seed files through the confined
   fitting-file API — `.apm/skills/**` and `.apm/prompts/**` became writable
   payload; config editing through the standing-config API; a live runtime
   Test probe). All 40+ viewless seed fittings gained a declaration.
2. **The sidebar group is "Fittings" and lists every equipped fitting.**
   Embedded views open at `/fitting/<id>` where **the view IS the page** (slim
   header; the old overview/config page is gone — capability wiring lives on
   /compose, files in the Muster editor). Own-port fittings keep their live
   `/embed/<id>` links; `/fitting/<id>` for them is a status/controls strip.
3. **Fittings share the operative's lifecycle, always.** `up` starts every
   own-port fitting (heal-on-env-drift preserved), `down` stops every one, the
   orphan sweep reaps anything not protected by a running composition. The
   eager machinery is deleted (`eager-boot.ts`, `/api/eager-boot`,
   `instrumentation.ts`, `scripts/run-eager-boot.ts`, the Run-panel toggles);
   `lifecycle:` is parsed-and-ignored with a deprecation warning.
   `activeCompositionEnvForFitting` moved to `src/lib/composition-env.ts` for
   the recovery start/restart routes.

## Consequences

- `coord-agentmail` and `power-default` (the two `detached` fittings) now stop
  at `down`. For power-default this means the idle self-suspend watcher only
  runs while an operative is up — accepted for lifecycle consistency (on the
  current box the suspend call lacked a working service-account token anyway).
  Standing-across-`down` behaviour, if ever needed again, should be a real
  daemon (systemd unit), not a runner exception.
- A server crash-restart no longer leaves formerly-eager fittings serving a
  stale bundle: the first sweep reaps them, and the next `up` brings
  everything back on current code.
- The improver's imported-fitting emitter (`scripts/import-claude-install.ts`)
  emits view declarations, keeping generated fittings valid under the new
  rule.
- Editing a vendored fitting's skill through the view (e.g. `taste`) is drift
  its pinned-hash test will flag — intended: vendored fittings track drift
  explicitly.
