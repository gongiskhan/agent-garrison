# v1 Definition of Done

Each item is observable. If it cannot be pointed at, it does not count.

Status legend: `[x]` verified, `[~]` partially verified, `[ ]` open.
Per-phase evidence lives under [`phases/`](./phases/).

- [x] A single command, for example `npm start`, brings up the Garrison UI on `localhost:3000` with no auth.
- [x] Compose tab renders all 14 Faculties (Artifact Store added in Phase 3) in spec order. Cardinality rules are enforced at compose time. Fitting-shape mismatches are caught at compose time, not runtime.
- [x] Vault round-trips: secret entered in UI, page reload, secret still there. `data/vault.json` is unreadable without Garrison. No plain-text secrets on disk.
- [x] All six original seed Fittings are installed in the Fittings Registry and pickable under the correct Faculty. (Phase 1+ added: Slack channel, Soul, Personal Operative orchestrator, Documents, Artifact Store, Coding sub-agent, Google Calendar, Morning briefing, Projects index, Scheduler.)
- [x] Selecting Trello as a data source causes `Tasks` to surface as Trello-backed automatically, with no extra UI row for Tasks.
- [x] Hitting **Run** on a configured composition calls `apm install` and reports each step in the live log.
- [x] Hitting **Run** materialises `.env` from vault into the composition directory.
- [x] Hitting **Run** assembles orchestrator+soul system prompt and starts a Claude Code session with it (via the Anthropic Agent SDK in-process, not a `claude` child process — see Phase 1 verification).
- [x] Fittings that declare an `x-garrison.setup` command have it executed before verify on every **Run**; a non-zero setup exit aborts the run with the failing Fitting's stderr in the log.
- [x] Hitting **Run** executes every Fitting's `x-garrison.verify` hook and every hook passes.
- [x] Logs stream live to the Run tab.
- [x] Closing the browser tab and reopening shows the Operative still running with log scrollback.
- [x] **Stop** kills processes cleanly, wipes materialised `.env`, and reports stopped.
- [x] **Dev mode** watches a local-path Fitting; editing a file in that Fitting triggers `apm install` plus Operative restart within about 10 seconds.
- [x] At least one seed Fitting ships a UI extension that renders inside its Faculty's tab when installed.

## Capability wiring (added in v1 consolidated milestone)

- [x] Every selected Fitting's `provides` and `consumes` resolve via the
      capability resolver before Compose marks ready. Errors surface in
      the readiness panel under "Capability checks". `cardinality: any`
      is wired end-to-end and used by the Orchestrator to discover
      installed Fittings without hardcoding.
- [x] The validation pipeline (`tsx scripts/validate-fitting.ts <path>`)
      passes for every seed Fitting. Architecture and quality checks
      are real; security and prompt-injection are pattern-stub
      placeholders for the runtime SDK milestone.

## Phase 3 additions (Artifact Store + Documents + UI contract v2)

- [x] Artifact Store Faculty (`artifact-store`) ships as a seed
      Fitting; producer Fittings (Documents v1, future Automations
      videos / Voice audio) write into namespaced subdirectories.
- [x] Documents Fitting under `knowledge-base` Faculty layers on the
      Artifact Store and ships a sidebar-surface view via UI contract
      v2.
- [x] `for_consumers` field is honoured by the runner — provider-side
      usage guidance is injected under each capability in the
      Orchestrator's "tools available" block at assembly time.
- [x] `garrison://documents/<id>` and `garrison://artifacts/<id>` URLs
      resolve through the chat renderer to the right view.

## Phase 4 additions (plan-then-execute)

- [x] The Orchestrator can dispatch coding work to a sub-agent
      Fitting (Variant A: CLI-shape, same surface as every other
      Fitting) without polluting the conversational session's
      context.
- [x] Kill switch uses the SDK's `Query.interrupt()` first-class
      cancellation primitive.

## Phase 5 / Stage 1 status (own-port UI Fittings)

See [`phases/PHASE5_VERIFICATION.md`](./phases/PHASE5_VERIFICATION.md)
and [`phases/PHASE5_WORKBENCH_VERIFICATION.md`](./phases/PHASE5_WORKBENCH_VERIFICATION.md).
Workbench shell area dissolved 2026-05-17 — `terminal`,
`screen-share`, `worktree-management`, `session-view` are flat
top-level Faculties whose Fittings serve their own React UI on their
own HTTP port (Monitor pattern). Sequoias decomposition shipped under
the 5.5 follow-up; the standalone Sequoias app is pending the 3-day
daily-use validation gate before retirement.

The Browser Fitting (Stage 1 finishing work per the 2026-05-26
restructure) is still in flight.

## Roadmap restructure (2026-05-26)

Prior Phase 1–9 layout replaced by a 5-Stage layout — see
[`GARRISON_ROADMAP.md`](./GARRISON_ROADMAP.md). The "Phase N
additions" sections above are preserved verbatim as the historical
record of what shipped at each phase; the DoD items themselves
remain the v1 acceptance checklist independent of the stage
restructure.
