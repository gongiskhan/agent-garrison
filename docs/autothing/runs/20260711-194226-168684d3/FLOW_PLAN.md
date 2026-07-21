# FLOW_PLAN — GARRISON-RUNTIMES-V1 (run 20260711-194226-168684d3)

Profile: build · 8 slices (1:1 with brief phases P1–P8) · turn cap 640
Spec: RUN_SPEC.md (same dir). Findings E1–E8 printed in lead context 2026-07-11.

Slice order is dependency order: P1 → P2 → P3 → P4 are serial (each builds on the
prior's schema/seam). P5 → P6 → P7 serial within Quarters. P8 depends on P4.
Parallelism: P5 may start once P2 lands (descriptor schema is metadata-only);
otherwise serial — most slices touch `fittings/seed/orchestrator` or the gateway,
which are shared files (serialize-shared rule).

## Slices

### S1 (P1) — claude-code-runtime Fitting completion — kind: api
Status: pending
Files: fittings/seed/claude-code-runtime/apm.yml, compositions/default/apm.yml,
  src/lib/metadata.ts (only if new x-garrison keys need parser acceptance),
  tests (seeds, capabilities, library).
Work: extend the EXISTING fitting (A1) — add `provider_mechanism` block (env-based:
  ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / --model) and `quarters_descriptor`
  block (deep: claude-code) to x-garrison; select the fitting in the default
  composition's runtimes faculty; parser accepts+validates the new optional blocks
  (loud on malformed); resolver treats runtime:claude-code as provided.
Acceptance: composition resolves with claude-code-runtime selected; existing
  behavior unchanged; seeds/metadata/capabilities tests green.
Sentinel: RUNTIME-CC-FIT-OK

### S2 (P2) — providers as policy data — kind: api
Status: pending
Files: fittings/seed/orchestrator/lib/policy-core.mjs, lib/stage-b.mjs,
  config/routing.seed.json, routing.json, scripts/server.mjs (migration),
  fittings/seed/agent-sdk-runtime/lib/providers.mjs (reduce to capability
  annotations), gateway tests, routing tests.
Work: policy schema gains `providers: [{id, base_url, vault_key?, notes?, kind?}]`;
  targets reference runtime+provider+model; migration seeds anthropic-plan,
  ollama-local, deepseek, zai-glm; buildLaunchEnv(target, {providers,...}) reads
  policy providers (PROVIDERS constant deleted); MissingProviderKeyError semantics
  preserved (locked vs absent); SDK_PROVIDERS reduced to per-provider capability
  overlays keyed by id (connection data comes from policy).
Acceptance: all routing tests pass against migrated seed; unknown provider id is a
  loud error; the four seeded providers resolve byte-identically to today.
Sentinel: PROVIDERS-POLICY-OK

### S3 (P3) — primary runtime selection in composer — kind: mixed
Status: pending
Files: fittings/seed/orchestrator/lib/policy-core.mjs (primary_runtime,
  default claude-code), scripts/server.mjs (validation: primary must name an
  installed runtime fitting), ui/main.tsx (picker + per-mechanism provider/target
  editor), runtime fittings' apm.yml provider_mechanism blocks (codex, gemini,
  agent-sdk — D3).
Work: `primary_runtime` in policy file; composer picker fed by installed runtime
  fittings (from composition manifest, not the gateway); target editor adapts
  provider fields to the declared mechanism; no-mechanism runtimes still
  targetable without overrides; file-level loudness when primary names an
  uninstalled runtime.
Acceptance: E2E with gateway DOWN — set primary + edit a provider via composer UI;
  policy file updated; UI cannot pick an uninstalled runtime.
Sentinel: PRIMARY-SELECT-OK

### S4 (P4) — gateway honors the primary — kind: api
Status: pending
Files: fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs
  (createRoutedGateway pool construction), gateway spawn path in src/lib/runner.ts
  if env plumbing needed, gateway tests.
Work: pool warms the adapter named by policy primary_runtime as the `operative`
  entry; claude-code default path byte-for-byte current behavior; non-claude
  primary warms via its RuntimeAdapter (dynamic import from the fitting dir, like
  agent-sdk today); missing fitting / failed probe at warm = loud startup error
  naming the fix; secondary delegation unaffected.
Acceptance: gateway tests (stubbed adapters) for all primaries; claude-code
  default regression-identical; loud-error test for uninstalled primary.
Sentinel: PRIMARY-WIRED-OK

### S5 (P5) — Quarters descriptor mechanism + generic tier — kind: mixed
Status: pending
Files: src/lib/metadata.ts (descriptor schema), new src/lib/quarters-runtimes.ts
  (descriptor resolver from composition), src/app/quarters/* (runtime dimension
  routing), new generic-tier components (Monaco settings editor w/ json+toml
  validation, context file w/ provenance, mcp config, logs tail),
  src/app/api/quarters/* (generic file read/write endpoints, path-confined to the
  descriptor's declared home dir), claude-code descriptor registration mapping to
  the EXISTING deep implementation (routes/components untouched).
Work: descriptor schema in x-garrison (`quarters_descriptor`: home_dir,
  settings_files[{path,format}], context_file, mcp_config?, log_paths?,
  categories); shell renders generic tier from descriptor alone; nonexistent home
  dir = explicit warning banner, never silent; claude-code maps to deep impl as-is.
Acceptance: existing Quarters e2e/tests untouched and green; generic tier renders
  for a fixture descriptor; TOML/JSON validation works; ZERO claude-code loss.
Sentinel: QUARTERS-DESCRIPTOR-OK

### S6 (P6) — codex + gemini descriptors — kind: api
Status: pending
Files: fittings/seed/codex-runtime/apm.yml, fittings/seed/gemini-runtime/apm.yml.
Work: descriptors per E6 ground truth — codex: home ~/.codex, settings
  config.toml (toml), context AGENTS.md, mcp in config.toml (mcp_servers), logs
  ~/.codex/log; gemini: home ~/.gemini, settings settings.json (json), context
  GEMINI.md, mcpServers in settings.json, logs ~/.gemini/tmp. Honest labels for
  what each surface is.
Acceptance: generic tier renders both against the REAL installed files; verify
  probes still green.
Sentinel: QUARTERS-CODEX-GEMINI-OK

### S7 (P7) — composition-driven sections + collapse — kind: ui
Status: pending
Files: Quarters shell/sidebar components, local-storage expand state.
Work: one section per runtime selected in the composition; single runtime =
  expanded, current look preserved; >1 runtime = all sections collapsible, ALL
  start collapsed; expand state persisted locally (localStorage).
Acceptance: E2E both states (single-runtime unchanged vs multi-runtime
  all-collapsed); screenshots as evidence.
Sentinel: QUARTERS-SECTIONS-OK

### S8 (P8) — orchestrator projection per primary — kind: api
Status: pending
Files: src/lib/orchestrator-projection.ts (per-primary projection — E7 delta:
  this IS the single writer; no Knowledge path exists), src/lib/runner.ts (call
  at up()), gateway warm path warning print, tests.
Work: claude-code primary — existing rules projection path unchanged;
  codex/gemini primary — assembled orchestrator prompt projected to the runtime's
  native context convention (AGENTS.md / GEMINI.md) with provenance header +
  printed authority warning; agent-sdk primary — SDK system prompt mechanism
  (already supported by AgentSdkAdapter spawnArgs). Assert a marker/capability
  line in a switched-primary session (live smoke where CLIs allow).
Acceptance: switched primary demonstrably carries orchestrator behavior (marker
  asserted, not vibes); claude-code path byte-identical.
Sentinel: PROJECTION-PRIMARY-OK

## Run-level gates (after all slices)
deliberate-red · mutation · built-in security-review · codex checkpoint ·
walkthrough gallery · report. Final: GARRISON-RUNTIMES-V1 OK (last stdout line).