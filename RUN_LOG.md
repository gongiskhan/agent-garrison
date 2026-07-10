
## RUN-START 2026-07-10T07:32:07Z
- runId: 20260710-073032-ebe15853
- brief: GARRISON-UNIFY-V1 — collapse routing/orchestration into one Orchestrator fitting; run engine unification; autothing thin doorway; evidence home ~/.garrison/runs/; folded REMOTE-OPS-V1 + POWER-FIT-V1 (Outposts, Monitor vitals, Ports, Snapshots, Power); claude-share decommission.
- session: claude-fable-5, effort=session-inherited, host=dev-madrid
- gatesConfig: all true (no operator flags); askQuestions=false; profile=pending-sizing (expect build, 16 slices)
- preflight: asciinema 2.4.0, agg 1.9.0, codex-cli 0.143.0, gitleaks 8.30.1, semgrep 1.168.0, ffmpeg OK, node v20.19.4, ss OK, systemctl 255, gh 2.96.0, jq 1.7. MISSING: restic (self-unblock at S12).
- E13 pre-check: metadata token lacks compute scope (ACCESS_TOKEN_SCOPE_INSUFFICIENT on instances.get + testIamPermissions; scopes granted: devstorage.read_only, logging.write, monitoring.write, pubsub, service.management.readonly, servicecontrol, trace.append). instances.suspend unverifiable → D37 applies to S13/S14 unless scope is fixed externally.
- coord stack: not connected (no coord-mcp/agent-mail tools) → disjoint-files discipline.

## DECISION 2026-07-10T07:42:33Z
- Baseline before any change: typecheck clean; vitest 4 failed / 1409 passed across 3 files, ALL pre-existing:
  1. tests/autothing-validate.test.ts (3×) — tests the installed skill ~/.claude/skills/autothing-validate/scripts/validate.mjs, whose gate shapes drifted ahead of the repo fixtures (claude-share 2026-07-07 "evidence-driven per-slice codex review"). In scope: S5/S8 rework this family; fixtures updated then.
  2. tests/z1-end-to-end.test.ts (1×) — pipeline record 'failed' vs 'completed'; working tree carries 8-day-old uncommitted automations scratch (fittings/seed/automations/{lib/discuss.mjs,scripts/server.mjs}); will re-diagnose after slices land; not caused by this run.
  3. tests/browser-observe.test.ts — collection-time hook timeout (10s) — environment-dependent (needs browser fitting runtime); will classify infra vs code during the run.
- Port collisions noted: new defaults 7088/7089/7090 (Ports/Outposts/Power) collide with live improver/kanban-loop/automations registrations; findFreePort fallback governs (brief pre-decision). model-router owns 7087 → Orchestrator inherits.
- Vault usable on this box (fresh vault.json + ~/.garrison/vault-master.key, Jul 9); sealed-under-mac-key backup is the parked old vault.

## DECISION 2026-07-10T07:53:34Z
- Phase 1 complete: FLOW_PLAN.md + RUN_SPEC.md written (16 slices, profile=build). Sentinel turnCap resized 250 → 1280 (max(300, 80×16)). deliberateRed + mutation ON (≥3 slices).
- E1-E18 exploration complete (7 agents + lead E13); digests at <runDir>/exploration/. Load-bearing: live v4 routing path (routing-core.mjs + routing.seed.json + comp-scoped .garrison/routing.json) is what S1 extends; legacy src/lib/model-router.ts still feeds automations plan/vision + check-routing (migrate in S2); "parked" = de-listed in-repo (no ~/.garrison/parked); kanban cards/ EMPTY (no card migration burden); codex OAuth serialization enforced NOWHERE today (D14 builds it into codex-runtime); vault decrypts but EMPTY; global-composition never materialized on this box (S8 exercises first); no pairing mint/invocation log/checkout registry (build in S9); installer bootstrap-outpost.sh EXISTS (reuse); @dnd-kit chosen (E18); Improver does NOT read friction log today (D38/S15 adds reader).
- AMBIGUITY resolved: v4 role layer vs D1/D10 target-per-cell matrix — new policy maps taskType×tier→target directly; modes routingBias behavior preserved via explicit computeLadder (ordered fast→expert target ids) honoring {floor,prefer}; logged as behavior-preserving reimplementation (A11 in RUN_SPEC ledger).
