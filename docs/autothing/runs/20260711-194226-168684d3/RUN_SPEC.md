# RUN_SPEC — GARRISON-RUNTIMES-V1 (run 20260711-194226-168684d3)

## What / why

Runtime agnosticism for Garrison: Claude Code stops being the implicit substrate and
becomes a first-class Runtime Fitting; the hardcoded provider registry becomes policy
data editable in the composer; the Orchestrator's primary runtime becomes selectable
(no operative running required); Quarters becomes a per-runtime configuration surface
driven by descriptors that runtime Fittings ship — with the existing Claude Code deep
Quarters implementation registered as-is (ZERO functionality loss).

Builds on GARRISON-UNIFY-V1 (implemented): Orchestrator Fitting owns the policy file
and composer UI; all surfaces route through the Orchestrator; run evidence in
`~/.garrison/runs/`.

## Acceptance criteria (from the brief)

1. Full test suite, typecheck, lint, build green.
2. E2E: composer sets `primary_runtime` + a provider with the gateway DOWN.
3. E2E: Quarters renders single-runtime expanded; multi-runtime all-collapsed
   (collapse state persisted locally).
4. Claude-code Quarters deep surfaces unchanged against existing e2e specs.
5. Live smoke (CLIs installed): codex target with provider override launches with the
   right native config; switching primary to a non-claude runtime produces a working
   operative session carrying orchestrator behavior (assert a marker/capability line);
   switching back to claude-code restores exact current behavior.
6. Phase sentinels printed once each (RUNTIME-CC-FIT-OK, PROVIDERS-POLICY-OK,
   PRIMARY-SELECT-OK, PRIMARY-WIRED-OK, QUARTERS-DESCRIPTOR-OK,
   QUARTERS-CODEX-GEMINI-OK, QUARTERS-SECTIONS-OK, PROJECTION-PRIMARY-OK), then
   `GARRISON-RUNTIMES-V1 OK` as the final acceptance sentinel.

## Non-goals (out of scope, from the brief)

- Relocating claude-code deep Quarters catalog code into the Fitting package.
- Deep-tier Quarters parity for Codex/Gemini (generic tier only).
- Quarters-to-pooled-session settings match guarantee.
- Multi-tenant / Ekoa concerns. Removing the `claude -p` exclusion.

## Hard constraints (enforced at every gate)

- ZERO functionality loss in Claude Code Quarters (same libs/components, routing +
  registration change only).
- Composer works with gateway down (policy file read/write only).
- Single source of truth per config layer (policy targets / config_schema / native
  files); no mirrors.
- Loud errors: missing runtime Fitting, missing vault key (locked vs absent
  distinguished), unknown provider mechanism, descriptor pointing at nonexistent home.
- Knowledge-projected context files (AGENTS.md/GEMINI.md) ownership-respected in
  Quarters.
- No new branches, no worktrees. Nothing Ekoa-specific.

## Assumptions ledger (decisions made on the operator's behalf)

| # | Assumption / decision | Chosen | Alternative |
|---|---|---|---|
| A1 | `fittings/seed/claude-code-runtime` already exists (apm.yml, probe.mjs, README) from prior work. P1 = extend it (D3 mechanism block + D5 descriptor + seed composition selection + tests), not author from scratch. | Extend in place | Rewrite from scratch (needless churn) |
| A2 | coord-mcp planning gate is NOT connected this session; only coord-agentmail. Coordination runs the agent-mail-only path (identity CyanCreek, reservations + messages); no begin_planning/coord_digest. | Degrade gracefully per skill contract | Hard-block (forbidden) |
| A3 | E6 ground truth: `~/.codex/config.toml` exists (model, personality, mcp_servers, projects trust; NO model_providers section yet); `~/.gemini/settings.json` exists (mcpServers only). No AGENTS.md/GEMINI.md projections at `~` today. Descriptors will be validated against these real shapes. | Real-file-driven descriptors | Doc-driven (brief forbids) |
| A4 | Slices = the brief's P1–P8, in order, each ending with its sentinel. Kinds: P1 api, P2 api, P3 mixed, P4 api, P5 mixed, P6 api, P7 ui, P8 api. | 8 slices mapping 1:1 to phases | Re-slicing (loses sentinel mapping) |
| A5 | Profile: build (all gates, deliberate-red + mutation ON, codexSliceReview every slice, run-level security review + codex checkpoint). | build | feature (too small for 8 phases) |
| A6 | E2E on this machine runs Playwright-over-CDP (extension absent) per machine memory; garrison lifecycle via its API, never raw kill. | Respect machine constraints | — |

(Ledger grows as findings land; deltas from FINDING-E* recorded below as they print.)

## Finding deltas

- FINDING-E6 (captured pre-plan): codex/gemini native surfaces as listed in A3.
- FINDING-E7 DELTA (invalidates D7 as written): NO AGENTS.md/GEMINI.md projection
  code exists anywhere in the repo — there is no Knowledge-Fitting projection path
  to ride. Adaptation (intent preserved: one writer, native conventions):
  `src/lib/orchestrator-projection.ts` — already the assembled-prompt owner — gains
  the per-primary projection (AGENTS.md for a codex primary, GEMINI.md for a gemini
  primary), written at up()/warm time with provenance headers and the printed
  authority warning. Recorded as A7 in the assumptions ledger.
- (pending E1–E5, E8 consolidation from Explore agents; E1/E2/E3/E4 partially
  confirmed first-hand: PROVIDERS+buildLaunchEnv at
  fittings/seed/orchestrator/lib/stage-b.mjs:16-67 with locked-vs-absent already
  loud; gateway seam at http-gateway gateway-routing.mjs:721-766
  (hardcoded ClaudeCodeAdapter in MultiRuntimePool, operativeRuntimeId checkout);
  policy compiled to ~/.garrison/orchestrator/policy.json by policy-core.mjs;
  QUARTERS_CATEGORIES canonical list in src/components/quarters/quartersTypes.ts
  with a 6-line panel dispatch in src/app/quarters/[type]/page.tsx.)