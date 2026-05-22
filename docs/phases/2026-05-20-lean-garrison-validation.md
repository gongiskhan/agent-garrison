# Lean Garrison — Playwright validation findings

**Date:** 2026-05-20
**Validator:** playwright-cli 0.1.6 against a fresh `next dev` on `127.0.0.1:7778`, dogfood composition (`compositions/default/apm.yml`) — 18 of 21 Faculties stationed.
**Decision under test:** [`docs/decisions/2026-05-20-lean-garrison-trim.md`](../decisions/2026-05-20-lean-garrison-trim.md).
**Outcome:** Pass. Every assertion below was driven through a real Chromium tab; the underlying API calls were also probed with curl.

---

## 1. Nav shell — Chat and Tools gone, Views auto-populates

`playwright-cli snapshot` of the sidebar on `/run` (rendered against the live composition):

```
- navigation:
  - link "Garrison" → /
  - link "Compose 18/21" → /compose
  - link "Armory 30" → /armory
  - link "Run" → /run
  - link "Vault" → /vault
  - Views:
    - link "Artifact store" → /fitting/artifact-store
    - link "Documents" → /fitting/documents
    - link "Monitor (default)" → http://127.0.0.1:7084
    - link "Screen share" → http://127.0.0.1:7079
    - link "Session view" → http://127.0.0.1:7081
    - link "Terminal" → http://127.0.0.1:7078
    - link "Worktrees" → http://127.0.0.1:7080
```

**Asserted:**

- No "Chat" nav link.
- No "Tools" nav link.
- The Views group is auto-populated: 2 embedded views (Artifact store, Documents → `/fitting/<id>`) and 5 own-port live links (each pointing at its registered `~/.garrison/ui-fittings/<id>.json` URL).
- All own-port URLs match their declared default port from `src/lib/faculties.ts`'s `OWN_PORT_DEFAULTS` table (terminal 7078, screen-share 7079, worktree-management 7080, session-view 7081) plus the Monitor on its own port (7084 here — the user's running instance happened to fall back from the 7077 default).
- Compose `18/21` and Faculty count `21 stations` confirm `faculties.length` is now the dynamic source of truth (no hardcoded `13`).

---

## 2. Deleted routes — every Chat/Tools surface returns 404

`playwright-cli goto` results:

| Route | Browser status | Page title |
|---|---|---|
| `/chat` | 404 | `404: This page could not be found.` |
| `/tools` | 404 | `404: This page could not be found.` |

The browser console logged a single `Failed to load resource: 404` per attempt — that is the deletion succeeding, not a regression. No other warnings or errors on the trip.

Direct API probes:

| Endpoint | HTTP | Expected |
|---|---|---|
| `POST /api/runner/default/chat` | 404 | deleted |
| `POST /api/runner/default/test` | 404 | deleted |
| `GET /api/runner/default/subagent-logs` | 404 | deleted |
| `POST /api/runner/default/subagent-kill` | 404 | deleted |
| `GET /api/tools/discover` | 404 | deleted |
| `GET /api/monitor/discover` | 404 | deleted |

Retained gateway-facing routes still resolve (e.g. `/api/runner/<id>/state` returns 405 for POST — proving the route exists with a GET handler, not a 404).

---

## 3. The new view-status route is healthy

`GET /api/fittings/views` (the renamed `useFittingViewStatus` backend) returned a real payload with the new `views` field (was `tools`) and live health flags:

```json
{
  "views": [
    { "fittingId": "monitor-default",             "port": 7084, "healthy": true, ... },
    { "fittingId": "screen-share-default",        "port": 7079, "healthy": true, ... },
    { "fittingId": "session-view-sequoias",       "port": 7081, "healthy": true, ... },
    { "fittingId": "terminal-armory-default",     "port": 7078, "healthy": true, ... },
    { "fittingId": "worktree-management-sequoias","port": 7080, "healthy": true, ... }
  ]
}
```

Every entry has `healthy: true`, confirming the server-side `/health` probe (1.5s timeout, defined in `src/app/api/fittings/views/route.ts`) reaches each own-port Fitting and the status files are valid.

---

## 4. Run page — no test box, no sub-agent pane

`playwright-cli` snapshot of `/run` main column:

```
- heading "Run"
- "Start, stop, verify, watch. Operative interaction happens through Channel Fittings,
   not through Garrison."
- Dispatch:
  - button "▶ Run"
  - button "□ Stop" [disabled]
  - button "✓ Verify"
  - button "⚙ Dev mode"
  - Status / PID / Dev / Verify cells
- Verify hooks: "not run" / "Press Verify to run all installed Fitting hooks."
- Runtime log · live stream · ring buffer 5 000 lines · 0 lines
```

**Asserted absent:**

- No `Operative test box` section, no textarea, no "Send test" button.
- No `Sub-agent` collapsible section.
- No `Stop` button for sub-agent kills.

The descriptive copy under the page heading matches the post-refactor wording from `src/components/run/RunPanel.tsx`: *"Operative interaction happens through Channel Fittings, not through Garrison."*

---

## 5. Home page — no chat CTAs

Snapshot of `/` after composition load:

- Hero CTA: a single `▶ Run panel` link → `/run`. No "Open chat" button.
- Quick actions panel: `Tune the composition · 21 stations` (dynamic count) / `Browse the Armory` / `Vault`. No "Talk to the operative" row.
- Composition readiness panel: `Faculties stationed: 18 / 21`. The hardcoded `/ 13` is gone.
- Tasks panel (only renders when a data source declares one): title `Tasks · derived from Trello`, body *"The stationed data source declares the truth file; the derived Tasks Faculty follows it automatically."* — the body wording is the new consumer-neutral version; the title legitimately names whichever source the user stationed (Trello here because the dogfood composition has `trello-data-source` stationed).

---

## 6. Compose page — no "Load seed stack" preset

Grep over the rendered `/compose` snapshot for `load seed`, `seed stack`, `test box`, `operative test`, `sub-agent`:

- Only match: the literal Fitting tile labelled `06 · Skills • Coding sub-agent`. That is a real Fitting in the library, not the deleted Run-page pane.
- No "Load seed stack" button.

---

## 7. Static checks (re-confirmed before validation)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 358 passed, 1 skipped, 0 failed |
| `grep -rwn 'Trello\|Ekus\|EKOA\|memory-compiler\|awc-gateway\|trello\|ekus\|ekoa\|Cortex\|cortex' src/` | 0 matches |
| `grep -rn 'useToolDiscovery\|sendTestMessage\|ChatPanel\|ChatProvider\|ChatContext\|SubAgentPane\|/api/tools/\|/api/monitor/' src/` | 0 matches |

---

## Screenshots

- `docs/lean-garrison-home.png` — home page, no chat CTA
- `docs/lean-garrison-run.png` — Run page, no test box / sub-agent pane

---

## Verdict

The lean trim landed cleanly. The shell's visible surfaces are now exactly the five lifecycle/observability pages (`Garrison`, `Compose`, `Armory`, `Run`, `Vault`) plus the auto-populated `Views` sidebar group. Every removed surface is gone from both UI and HTTP. The renamed view-status route is live and producing real data. No console errors beyond the expected 404s on the deleted paths.

Honesty Test self-check ([GOVERNANCE.md §3.1](../GOVERNANCE.md#31-downstream-consumers)): the shell makes no reference to any specific downstream consumer's workflow. The Tasks panel title still echoes the stationed data source's name (`Trello`), which is honest reporting of what is stationed, not Garrison taking a position on which source matters.
