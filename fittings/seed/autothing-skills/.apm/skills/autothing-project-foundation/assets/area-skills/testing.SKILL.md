---
name: {{PROJECT}}-testing
description: Validate a slice of {{PROJECT}} by exploring the REAL running app first, then writing and running Playwright + unit tests as the correctness gate. Use for EVERY slice before it can advance — UI flows (routes, forms, navigation, auth) and automations (webhooks, listeners, scheduled/agent runs). Owns vision-first exploration, test authoring AFTER exploration, the no-console-errors rule, bounded fix-retries, and emitting pass/fail exit codes. Do NOT use for visual design judgement (that is {{PROJECT}}-design-audit) or for recording evidence video (that is the walkthrough skill).
---

# {{PROJECT}}-testing

<!-- REFERENCE EXEMPLAR authored for a Next.js workspaces + vitest + @playwright/test stack. autothing-project-foundation adapts: the frontmatter name, the commands below, and the paths — to the target project's detected stack. Procedure (verbs) lives here; bars (nouns) live in docs/governance.md, referenced by path, never duplicated. -->

Definition of done for the bars this skill gates: `docs/governance.md`.

## Order is mandatory: explore → write tests → run. Never write tests before exploring.

### 1. Explore the real running app (vision-first; no tests yet)
- Ensure the dev server is up (background, never block the terminal, unique port):
  `npm run dev` — port resolves from `../app.port` if present, else the detected default. Confirm the base URL responds before driving it.
  For auth'd flows, use a **stored session** (never type credentials on camera or into logs): drive login once with `playwright-cli`, then `playwright-cli state-save .walkthrough/auth.json`; reuse it.
- Drive the actual slice with the `/verify` and `/run` skills + `playwright-cli`: click through the flow, capture screenshots at each meaningful state.
- Evaluate what you see against `docs/product-overview.md` (intended flow) and the design source of truth. **Fold anything unanticipated back into the implementation now** — fix the app, do not paper over it with a lenient test.

### 2. Write a COMMITTED, re-runnable test from the confirmed outcome (the gate)
The correctness gate must be a durable artifact checked into the repo — NOT ephemeral `.playwright-cli/` logs, NOT the walkthrough video. Pick the form that fits the stack:
- **Runner available** (Next.js app, etc.): add `@playwright/test` specs under `e2e/` covering the slice's routes + critical flow. Scaffold the runner if missing (`@playwright/test`, a `playwright.config.ts` at the dev base URL, a `test:e2e` script).
- **No runner ships** (e.g. a Cortex/artifact bundle): commit a re-runnable playwright-cli driver (e.g. `e2e/<slice>.mjs`) that drives the flow and asserts the result + exit code. This keeps the `e2e-testing` skill's "drive with playwright-cli" approach while leaving a durable assertion.
- Either way: assert the real behaviour you confirmed, AND assert **no console errors** (fail on any `console.error`/`pageerror`). Add/extend unit tests (`vitest run`) for non-UI logic.
- **Commit it.** A later slice must be able to re-run every prior slice's gate to catch regressions.

### 3. Automations (non-UI) get behavioural tests, not screenshots
- Trigger the automation the way production does, with synthetic input: `POST` the webhook/Graph change-notification payload to its local endpoint (Playwright `request` context or curl).
- Assert the **side effect**: the run row/record created, the outbound action taken (mock external calls), the surfaced result in the UI or store. Assert no server error logs.
- SSO/connection-gated automations: reuse the stored session/connection; never inline tenant secrets.

### 4. Run the gates and report exit codes
Run each and capture its exit code (the build orchestrator records these into `gate-status.json`):
```
npx playwright test e2e/<slice>.spec.ts   # e2e + console-error assertions
npm run test -w <workspace>               # vitest unit
npm run typecheck --workspaces --if-present
npm run lint -w <workspace>
npm run build --workspaces --if-present
```
Print a one-line summary per gate: `GATE <name>: exit <code> — <summary>`.

### 5. On failure: fix forward, bounded
- Diagnose, fix the app (or the test if the test was wrong), re-explore the changed path, re-run. **Up to 5 attempts** on the slice.
- Keep build/typecheck/lint green throughout — a green test with a broken build is not done.
- If still failing after the ceiling: log a blocker to `docs/decisions.md`, mark the slice `blocked` in `gate-status.json`, and let the build continue. Never loop forever; never weaken an assertion to force green.

The committed, re-runnable, passing assertions — not vibes, not the screenshots, not the video — are the correctness gate.
