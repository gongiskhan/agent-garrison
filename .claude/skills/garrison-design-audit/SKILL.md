---
name: garrison-design-audit
description: Drive the running Agent Garrison app and judge a slice's UI against the existing shell's visual language (the Chrome sidebar + Vault/Armory surfaces are the design source of truth — Garrison ships no separate token file), using frontend-design / polish-ui, and record a clean|issues verdict. Use after a UI slice's objective gates pass. Do NOT use for backend-only slices, and do NOT use to run tests (that is garrison-testing).
---

# garrison-design-audit

Verbs: drive, judge, record verdict. Garrison has **no design-token file**; the design source of truth is the **existing shell** — `src/components/chrome/*` and the Vault/Armory panels. New surfaces must match their spacing, typography, dark theme, list/card idioms, and `useAppShell()` busy/error chrome.

## Method
1. Run the app (`npm start`, http://127.0.0.1:7777); navigate the new surface with `playwright-cli`.
2. Compare against `/vault` and `/armory` — same lucide-icon usage, same card/list spacing, same NavLink placement.
3. Use `frontend-design`/`polish-ui` to flag and fix divergences (counts toward the slice retry ceiling).
4. Record `designAudit: {verdict: clean|issues, by, at, notes}` into gate-status.json.

## Hard rules
No emoji in UI code — text labels / SVG / lucide icons only (repo rule). Never introduce a new visual language; match the existing dark surface.
