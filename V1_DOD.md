# v1 Definition of Done

Each item is observable. If it cannot be pointed at, it does not count.

- [ ] A single command, for example `npm start`, brings up the Garrison UI on `localhost:3000` with no auth.
- [ ] Compose tab renders all 13 Faculties in spec order. Cardinality rules are enforced at compose time. Fitting-shape mismatches are caught at compose time, not runtime.
- [ ] Vault round-trips: secret entered in UI, page reload, secret still there. `data/vault.json` is unreadable without Garrison. No plain-text secrets on disk.
- [ ] All six seed Fittings are installed in the Fittings Registry and pickable under the correct Faculty.
- [ ] Selecting Trello as a data source causes `Tasks` to surface as Trello-backed automatically, with no extra UI row for Tasks.
- [ ] Hitting **Run** on a configured composition calls `apm install` and reports each step in the live log.
- [ ] Hitting **Run** materialises `.env` from vault into the composition directory.
- [ ] Hitting **Run** assembles orchestrator+soul system prompt and starts a Claude Code session with it.
- [ ] Fittings that declare an `x-garrison.setup` command have it executed before verify on every **Run**; a non-zero setup exit aborts the run with the failing Fitting's stderr in the log.
- [ ] Hitting **Run** executes every Fitting's `x-garrison.verify` hook and every hook passes.
- [ ] Logs stream live to the Run tab.
- [ ] Closing the browser tab and reopening shows the operative still running with log scrollback.
- [ ] **Stop** kills processes cleanly, wipes materialised `.env`, and reports stopped.
- [ ] **Dev mode** watches a local-path Fitting; editing a file in that Fitting triggers `apm install` plus operative restart within about 10 seconds.
- [ ] At least one seed Fitting ships a UI extension that renders inside its Faculty's tab when installed.

## Capability wiring (added in v1 consolidated milestone)

- [ ] Every selected Fitting's `provides` and `consumes` resolve via the
      capability resolver before Compose marks ready. Errors surface in
      the readiness panel under "Capability checks".
- [ ] The validation pipeline (`tsx scripts/validate-fitting.ts <path>`)
      passes for every seed Fitting. Architecture and quality checks
      are real; security and prompt-injection are pattern-stub
      placeholders for the runtime SDK milestone.
