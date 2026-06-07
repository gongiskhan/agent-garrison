# autothing build decisions & blockers

Build-time decisions and blockers for the config-plane build. Kept separate from the project's canonical `docs/DECISIONS.md` (which collides case-insensitively with `docs/decisions.md` on macOS — so autothing uses this path instead).

## 2026-06-07 — baseline

- **Pre-existing flaky test (NOT mine, NOT a regression):** `tests/orchestrator-integration.test.ts > operative recalls in-session memory across turns` fails on the branch baseline — a LIVE Claude-Code SDK test (spawns a real operative, ~51s) asserting the model recalls the word "teal" across turns. It failed on live-model non-determinism ("I don't have memory of that…"), unrelated to config-plane code. **Per-slice `tests` gate excludes this file**; the global gate runs the full suite and reports it honestly as a pre-existing non-blocking flake.
- **Sandbox for automated runs:** the build's exploration/e2e/walkthrough drive the *real running app*, whose API routes default to the user's live `~/.claude/`. To avoid mutating the daily-use install, new host-config libs read a `GARRISON_CLAUDE_HOME` / `GARRISON_HOME` env seam (default = real paths); the e2e/video dev-server points them at a seeded sandbox under `~/.garrison-test/`.
- **Port 7777 is occupied** by the user's live `next dev`; automated runs use the playwright `webServer` on port 3401.

## 2026-06-07 — S5 importer scope

- **Hook-fitting emission deferred (honest partial):** the seed importer fully emits + validates SKILL fittings (the dominant case; an emitted fitting passes `validate-fitting`). It REPORTS untagged hook groups in settings.json but does not yet emit installable hook fittings — that requires wiring the source resolver to produce `hook-group` artifacts from a fitting definition (hooks install via a manifest's `hookGroups`, which the importer would author and the resolver would read). Scoped as a follow-up; not a regression.

## 2026-06-07 — sequencing

- **Objective-gates-first, evidence pass second:** per advisor guidance for an unattended multi-slice build, all five slices were taken to code-complete + committed-test-green + typecheck/lint/build green and committed BEFORE the walkthrough/e2e evidence pass. The committed vitest specs (33 across the feature) are the correctness gate; the walkthrough videos are the evidence layer. This deviates from autothing's strict per-slice-video-before-next-slice; recorded in friction-log.
