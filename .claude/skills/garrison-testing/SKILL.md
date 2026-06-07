---
name: garrison-testing
description: Explore-first, then write and run the COMMITTED correctness gate for an Agent Garrison slice — vitest unit specs under tests/*.test.ts (the dominant gate; backend libs live in src/lib) plus a playwright e2e/exploration pass for UI surfaces — and report the objective gate exit codes (tests/typecheck/lint/build/e2e). Use when implementing or verifying any slice in docs/FLOW_PLAN.md. Do NOT use for visual judgement (that is garrison-design-audit) or for writing gate-status.json (that is garrison-governance).
---

# garrison-testing

Owns the objective correctness gate for a slice. Verbs here; conventions live in `docs/GOVERNANCE.md`, patterns in `tests/`.

## Commands (real, from package.json)
- Unit: `npm test` (vitest run); single file: `npm test -- tests/<name>.test.ts`
- Typecheck: `npm run typecheck` (tsc --noEmit)
- Lint: `npm run lint` (next lint)
- Build: `npm run build` (next build)
- E2E: `npm run test:e2e` (playwright; config `playwright.config.ts`, specs under `tests/e2e/`)
- Dev for exploration: `npm start` → http://127.0.0.1:7777 (next + outpost). Throwaway port: `next dev -H 127.0.0.1 -p <port>`.

## Loop
1. Explore vision-first with `playwright-cli` against the running app (real browser); fold findings back into the implementation.
2. Write the COMMITTED, re-runnable assertion:
   - Backend libs (the majority of this feature): a vitest spec in `tests/<lib>.test.ts`, using the **injected-path tmpdir pattern** from `tests/claude-hooks.test.ts` (inject `claudeHome`/`lockPath`/`settingsPath` so tests NEVER touch the real `~/.claude`). Assert behaviour AND safety.
   - UI surfaces: a `tests/e2e/<slice>.spec.ts` playwright spec driving the route, asserting zero console errors + the key element. A runner ships, so a spec file IS the committed driver — never leave only ephemeral `.playwright-cli/` logs.
3. Run each gate; capture exit codes verbatim. Print `GATE <name>: exit <code> — <summary>`.

## Safety invariants every backend test must prove (this feature)
- never-clobber: a hand-authored/unowned target is refused, write nothing.
- round-trip: a Garrison-owned file installs/uninstalls cleanly with recorded sha256.
- drift: an externally-edited owned file is left intact on uninstall.
- passthrough: unknown settings keys round-trip byte-for-byte.
