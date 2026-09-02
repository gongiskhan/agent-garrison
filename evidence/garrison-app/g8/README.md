# G8 - close (2026-09-02)

The run's last gate: docs, roadmap, the operator-triggered removal patch, the
handoff, and the final suites. Decisions D1-D44 and the per-gate "As shipped"
lists are in `docs/decisions/2026-09-garrison-app.md`.

## What shipped in this gate

- `roadmap.json`: c8.1-c8.5 done (Conversations at `/talk`, D11 override of
  c8.4's preconditions recorded in the item text); c7.1, c7.3, c7.8 annotated
  with what G4-G7 changed. `updatedAt` bumped.
- `AGENTS.md` "The Garrison iOS app"; `CLAUDE.md` pointer paragraph;
  `docs/GARRISON_ROADMAP.md` decision-log line; `docs/DECISIONS.md` entry
  "One Garrison app, one voice layer, the phone as the criterion".
- `remove-web-channel-default.patch`: `git format-patch` output that deletes
  `fittings/seed/web-channel-default/` and `fittings/seed/deepgram-voice/`
  and their two `data/library.json` entries (27 files). Built in a detached,
  shared scratch clone; no branch was created. `git apply --check` passes on
  `57129034`. NOT applied (invariant I12): the operator triggers it, and the
  handoff lists the three test/artifact adjustments that go with it.
  `playwright.web-channel.config.ts` stays: it tests the shell's `/talk`,
  not the legacy host, so it is not redundant.
- `HANDOFF-garrison-app.md` at the repo root.

## Final suites

- `typecheck.txt`: `tsc --noEmit` clean.
- `vitest.txt`: 607 files passed, 7 skipped; 7026 tests passed, 23 skipped.
- `xctest.txt`: 99 tests, 0 failures, `TEST SUCCEEDED` on the mini's iPhone
  17 Pro simulator (17 suites, `PendantPluginMockTests` among them).
- `playwright-web-channel.txt`: `playwright.web-channel.config.ts`, 36 passed
  on desktop-chromium, tablet and mobile.
- `playwright-desktop-chromium.txt`, `playwright-tablet.txt`,
  `playwright-mobile.txt`: the base config, run one project at a time. 76
  passed per project; 14 failed per project (15 on mobile). Every spec this
  run touched is green (`capture-page`, `embed-in-app`, `shell-overhaul`,
  `muster-transfer`, `dev-env-*`). The failures are the same set on all three
  projects and are pre-existing stale specs, not this run's:
  - `landing.spec.ts` (4): the site copy changed on 2026-08-30 (`05de0ada`);
    the spec still expects "Três fittings de referência", two screenshots (12
    exist), the old gloss terms, and the page has em dashes in an SVG label
    and the Kanban caption.
  - `quarters-crud.spec.ts` (4), `settings.spec.ts` (2): the created
    primitive never appears / autosave reports "save failed" in the sandbox
    `GARRISON_CLAUDE_HOME`.
  - `muster.spec.ts` (2), `muster-standing.spec.ts` (1),
    `coordination.spec.ts` (1): missing `standing-slot-gateway` /
    `duty-toggle-code` test ids, hero verdict "unknown" where "degraded" is
    expected.
  - mobile only: `web-channel-chat.spec.ts` "Copied" never shows because the
    base config grants no clipboard permission; the same test passes under
    its own config (above), which is the config that owns those two specs.
  Not triaged further in this run (usage budget, operator's call); listed in
  the handoff under debt.
- A first attempt at one full run over all three projects was poisoned
  midway by a `next dev` manifest race in `.next-e2e` ("Failed to generate
  static paths for /api/runner/[id]/state: Unexpected end of JSON input"),
  after which every page timed out. Killed, `.next-e2e` wiped, rerun per
  project with a fresh dev server each; the 14 failures are identical across
  the aborted run and the three clean ones, which is what makes them stale
  specs rather than flakes.
- `testflight.txt`: the final beta build.
