# v1 Definition of Done

Each item is observable. If it cannot be pointed at, it does not count.

- [ ] A single command, for example `npm start`, brings up the Garrison UI on `localhost:3000` with no auth.
- [ ] Compose tab renders all 13 primitives in spec order. Cardinality rules are enforced at compose time. Component-shape mismatches are caught at compose time, not runtime.
- [ ] Vault round-trips: secret entered in UI, page reload, secret still there. `data/vault.json` is unreadable without Garrison. No plain-text secrets on disk.
- [ ] All six seed components are installed in the curated library and pickable under the correct primitive.
- [ ] Selecting Trello as a data source causes `Tasks` to surface as Trello-backed automatically, with no extra UI row for Tasks.
- [ ] Hitting **Run** on a configured composition calls `apm install` and reports each step in the live log.
- [ ] Hitting **Run** materialises `.env` from vault into the composition directory.
- [ ] Hitting **Run** assembles orchestrator+soul system prompt and starts a Claude Code session with it.
- [ ] Hitting **Run** executes every component's `x-garrison.verify` hook and every hook passes.
- [ ] Logs stream live to the Run tab.
- [ ] Closing the browser tab and reopening shows the operative still running with log scrollback.
- [ ] **Stop** kills processes cleanly, wipes materialised `.env`, and reports stopped.
- [ ] **Dev mode** watches a local-path component; editing a file in that component triggers `apm install` plus operative restart within about 10 seconds.
- [ ] At least one seed component ships a UI extension that renders inside its primitive's tab when installed.
