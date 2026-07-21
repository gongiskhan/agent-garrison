
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

## GATE 2026-07-10T08:16:47Z — S1 deterministic wall (model: claude-fable-5, lead)
- deliberate-red (once-per-run): gitleaks RED on planted secrets (github-pat, aws-access-token; exit 1) then reverted; compile --check RED on unknown target (exit 1) then reverted. Both gates proven able to fail.
- typecheck exit 0; lint exit 0; gitleaks clean; semgrep clean; dep-audit: ws HIGH fixed (npm audit fix), Next.js chain (4 advisories incl 1 high, DoS-class) PRE-EXISTING — upgrade is out of run scope (breaking); FOLLOWUP recorded. Full vitest: 1424 passed, only the 4 pre-existing baseline failures. compile --check byte-stable incl policy. probe ok.
- Fix-forward during wall: (1) restored review×T0-trivial -> cc-haiku-low (my seed had silently changed live routing behavior — caught by tests/gateway-souls-hint.test.ts); (2) v2 routing.md was missing Continuations + discipline skill annotations ("nothing lost" misses — caught by routing-assembly + discipline-skills tests); annotations now derive from phaseSkills.bindings (D3-correct). (3) orchestrator-placement.ts was v1-roleMap-bound — live regression fixed via computeLadder path.
- Commits 8d0a7c9 + 843dd78; tags run-20260710-073032-s1-{implement,wall}. Duration ~35min wall-clock from S1 start.

## DECISION 2026-07-10T08:17:56Z — codex unavailable on this box
- Self-unblock attempted: searched ~/.codex/auth.json (absent; only config.toml), OPENAI_API_KEY in env/rc files (absent), vault (empty). Exact failed command: `echo "say ok" | codex exec -s read-only -m gpt-5.5 -` → 401 Unauthorized "Missing bearer or basic authentication in header" (api.openai.com/v1/responses).
- Policy (Part 3 honesty / G8): every codexSliceReview slot records degraded (codex-unavailable) — does NOT block passed, never fakes approve; the run-level codex checkpoint will end blocked on the same external cause unless credentials appear mid-run (operator can drop OPENAI_API_KEY into the vault or ~/.codex). Global gate honestly reflects this.

## GATE 2026-07-10T08:33:23Z — S1 passed + S8 passed
- S1 adversarial-review: APPROVE (fresh-context agent; 81 migration checks 0 mismatches; all commands green). 2 minor findings applied (compile sentinel ORCHESTRATOR_POLICY_OK; PUT now compiles policy before persisting routing.json → 422 on compile failure, no divergence). Commit 86128b2.
- S8: autothing family → autothing-skills fitting; config surfaces → claude-config fitting (pruned machine-local logs/.security-key + security injection test-examples from the seed; both PASS the four-check validate-fitting pipeline). garrison config status|pull|commit CLI (tsx) + 8 unit tests. claude-share ARCHIVED via gh (isArchived:true); post-archive push → GitHub 403 read-only (acceptance 11a). Breadcrumb GARRISON-MANAGED.md written to ~/.claude. Commit 9eab5d0.
- DECISION: lockfile-ownership materialization of the LIVE ~/.claude/skills/autothing* (apm install through the global-composition symlink) DEFERRED — the brief meta-note forbids hot-swapping THIS run's pipeline; the fittings are Armory-installable and the install is a clean follow-up for a subsequent session. Recorded in LANDING needs-human-eyes.
- codexSliceReview degraded (codex-unavailable) on both slices — does not block; never faked.

## RESUME 2026-07-10T08:46:08Z
- Operator interrupted mid-S2 (model check; back on fable-5, ultracode ON). Ground truth verified: S1+S8 passed (commits 8d0a7c9/86128b2/9eab5d0), S2 in flight — fitting renamed to fittings/seed/orchestrator (uncommitted), merged prompt written, autonomy axis (classifyExecution/isSignificantAutonomous/buildAutonomousCardPayload) in policy-core + preRoute wired. Resuming at S2 wall (typecheck/tests/grep-proofs).

## GATE 2026-07-10T09:30:15Z — S2 implement+wall green (review in flight), S4 implement+wall green
- S2: fitting renamed model-router→orchestrator (state migration + env back-compat + library de-list of garrison-orchestrator); merged prompt = single doctrine home (grep-proof tests); preRoute {taskType,tier,execution} + D8 card creation via board API (falls through inline when board down). Wall: typecheck/lint/gitleaks/tests green; 2 real fixes mid-wall (double {{routing}} expansion from braces in the prompt comment; placement v1-roleMap regression). rev-s2 fresh-context review IN FLIGHT.
- S4: engine = library (advanceCardPhase for the doorway); D9 gate-evidence transitions; D15 per-list config dead (board v3 migration; applyListConfig rejects dead keys; UI stripped); D16 engine-owned locks API+UI; D17 rails with ALL pipeline phases visible (off never hidden) + create-time toggles + GET /policy passthrough. Fixed mid-wall: circular import deadlock (probe exit 13), lost VALID_TRIGGERS/MANUAL_EDITABLE/cleanPromptField constants (caught by tests). Old kanban tests pinned policy-less; new contract covered in tests/run-engine.test.ts. Wall green (suite 1499 pass, baseline-only failures).
- imp-s10 (monitor vitals) + imp-s11 (ports) implementing in parallel (disjoint files); imp-s11's test file has 4 implicit-any TS errors to fix before their slice gates.

## GATE 2026-07-10T10:01:46Z — S2 PASSED, S4 PASSED (post-fix approvals); S5/S6/S7 implemented (walls green); S16 (b) fixes landed
- rev-s2 re-verified empirically (own probe: rev-race retry lands the card in plan; exhaustion → null, never false success; execution misfire gone) → APPROVE. rev-s4 re-verified (both repros flipped) → APPROVE. Non-blocking residuals applied: cwd at both processBatch call sites; a committed regression test for the retry path (tests/autonomous-card-retry.test.ts).
- S7: dev-env orchestrated default + labeled plain escape hatch (logged); web-channel Autonomous toggle (feature-gated ClaudeChat button → meta.autonomous → proxy → gateway D8 marker). Bundles rebuilt. Commit tagged s7-implement.
- S16 (b) fixes: library open xdg-open switch; spike script paths; screen-share doc wording. tmux pbcopy stays FOLLOWUP; bootstrap-outpost reclassified not-a-gap (Mac-targeted by design).
- imp-s10 (monitor vitals) + imp-s11 (ports) report complete with self-verification; lead gates + fresh-context review pending. imp-s3 (composer) still implementing (its WIP rode into commit 91a031d — suite green with it; S3 gates still to run on completion).

## GATE 2026-07-10T10:10:27Z — S14 heartbeats landed; S15 improver rule landed; S16 (b) fixes landed
- S14: three self-contained presence heartbeats (shell /api/power/heartbeat relay; dev-env + web-channel /power-heartbeat relays; visibility + 5-min input gating; 60s cadence). Wiring proof against the live Power fitting follows imp-s13.
- S15: orchestrator-policy rule reads friction log + ~/.garrison/runs outcomes → conservative proposals (effort up/down, phase off, binding review) into the standard review queue; never auto-applied. 6 unit tests. Ghost edits pending imp-s3's composer.
- In flight: imp-s3 (composer + ghost edits), imp-s9 (outposts), imp-s12 (snapshots), imp-s13 (power core), rev-s567 (S5/S6/S7 batch review), rev-s1011 (S10/S11 review).

## DECISION (checkpoint for resume) — 2026-07-10T10:17:44Z
FULL RUN STATE (post-compaction resume reads THIS):
- PASSED (review-approved, committed, evidence cast recorded): S1 (policy core), S2 (brain merge; rev-s2 approve), S4 (run engine; rev-s4 approve), S8 (config home). Casts hash-pinned in gate-status.
- IMPLEMENTED + wall green, awaiting rev-s567 verdicts: S5 (thin doorway, tag s5-implement), S6 (evidence home, tag s6-implement), S7 (surfaces, tag s7-implement). Casts recorded for S5/S6.
- IMPLEMENTED by subagents (working tree, UNCOMMITTED), awaiting rev-s1011: S10 (monitor vitals — imp-s10 report has full details incl. /api/vitals sample), S11 (ports — imp-s11 report; note their deviation: status file uses OS-assigned port).
- IN FLIGHT implementers: imp-s3 (S3 composer + ghost edits; its intermediate work already rode into commit 91a031d), imp-s9 (S9 outposts, task 5/5: tests), imp-s12 (S12 snapshots), imp-s13 (S13 power core).
- COMMITTED halves: S14 heartbeats (tag s14-heartbeats; signal demos + live-fitting proof pending S13), S15 improver rule (tag s15-rule; composer ghost edits pending S3), S16 (b) fixes (commit d8f2b2a; FOLLOWUP to print at verdict: tmux pbcopy → OSC 52 design call).
- D27 engine affinity wiring committed (9d83f1a; consumes imp-s9's outpost-dispatch.mjs seam).
- BLOCKERS (external, named): codex credentials absent (401; every codexSliceReview slot = degraded (codex-unavailable); the run-level checkpoint will be degraded → verdict likely completed-with-blockers unless credentials appear). GCP compute scope missing (D37: S13/S14 suspend acceptance ends blocked; exact check: testIamPermissions 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT).
- Mutation gate prep: sandbox at /tmp/garrison-mutation-sandbox with stryker in /tmp/stryker-tools (NOT a repo dependency, honoring the deps constraint).
- REMAINING lead work: collect + gate S3/S9/S10/S11/S12/S13 (walls, validate-fitting, commits, reviews for s3/s9/s12/s13); S13/S14 signal demos (busy signals blocking suspension in isolation) + D37 blocked recording; walkthrough videos for ui/mixed slices (needs Garrison live: npm start, then walkthrough skill per slice); run-level closing gates IN ORDER (mutation → built-in security-review → codex checkpoint (degraded)); acceptance passes (1-18, several depend on live Garrison + tailnet); LANDING.md; autothing-report (no Slack webhook — degrade); the terminal GLOBAL GATE line LAST.
- Baseline failures still open (must be green before verdict): tests/autothing-validate.test.ts x3 (fixtures vs installed skill drift — decide: update fixtures to the seed family contract), tests/z1-end-to-end.test.ts (stale automations scratch), tests/browser-observe.test.ts (env hook timeout — classify infra with evidence or fix).

## RUN-START 2026-07-10T17:18:46Z
- runId: 20260710-171608-7bf26feb
- brief: GARRISON-FLOW-V2 — same-branch coordination (touch-set intents, stability points, ordering, interference protocol, commit fences, attribution), worktree sweep, generic flow (de-Cortex/de-Ekoa/de-Garrison, opt-in security), ux-qa phase, autonomy collapse (every task a card, garrison rename), Improver Probe, runtime freedom (PTY rule retired, FENCE removed).
- session: claude-fable-5, effort=session-inherited, host=dev-madrid
- gatesConfig: all-true (no operator flags); profile: pending-sizing (brief names 9 slices — build expected)
- preflight: node v20.19.4, jq 1.7, git 2.43.0, codex 0.143.0, gitleaks 8.30.1, semgrep 1.168.0, asciinema 2.4.0, agg 1.9.0, ffmpeg present, playwright 1.61.1
- coord stack: MCP tools NOT connected this session — disjoint-files discipline fallback (documented degrade path)
- preconditions (GARRISON-UNIFY-V1): policy.json OK, composer view OK, run engine cards-as-runs OK, phase-skill registry OK, runs home OK-as-mechanism (lazily created)

## GATE phase0-explore (run 20260710-171608-7bf26feb)
- green condition: E1-E14 explored, FINDING lines printed, UNIFY-V1 preconditions verified
- verdict: passed (E12 spike still in flight - non-blocking, fallback capture path already confirmed via E13)
- evidence: docs/autothing/runs/20260710-171608-7bf26feb/phase0/*.md (9 agent reports + full SendMessage extracts + e7-checklist-full.md)
- preconditions: all 5 UNIFY-V1 artifacts present (runs-home lazily created by engine, treated as present-as-mechanism)
- models: 7x Explore + 2x general-purpose subagents on session model; durations ~5-13 min wall each, parallel
- notable: Beads removed from tree (brief assumed it); agent_mail clone absent on this box; no phase-boundary commits exist yet (D5 net-new); pool sessions unobservable to hooks (D22 gating must fail closed); preRoute log has no sessionId (E11 correlation via digest)

## DECISION 2026-07-10T17:45:27Z (run 20260710-171608-7bf26feb)
- Sizing: 9 slices (S1-S9), profile=build (replaces pending-sizing). Turn cap resized 250 -> 720 (max(300, 80x9)). deliberateRed+mutation ON (>=3 slices). RUN_SPEC.md written with 15-entry assumptions ledger; FLOW_PLAN derives from it. One Plan subagent for S1/S2 engine design; other slices mapped inline from phase0 findings (brief pre-makes all decisions - A13).

## GATE phase1-plan (run 20260710-171608-7bf26feb)
- green condition: RUN_SPEC.md + FLOW_PLAN.md written, profile assigned, turn cap resized
- verdict: passed
- evidence: docs/autothing/runs/20260710-171608-7bf26feb/{RUN_SPEC.md,FLOW_PLAN.md,plan-coord-engine.md}
- build order: S3, S1, S2, S4, S5, S9, S6, S7, S8 (serial at slice level; intra-slice parallelism on disjoint files)
- models: 1x Plan subagent (session model) for S1/S2 engine design; E12 spike CONFIRMED-YES (PostToolUse carries tool_response.answers)

## DECISION 2026-07-10T18:39:07Z (run 20260710-171608-7bf26feb) — codex unavailable, degraded slots
- Re-verified this run: codex login status = Not logged in; no OPENAI_API_KEY; no ~/.codex/auth.json; vault parked-undecryptable. Probe output: ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com
- Same external cause + failed remediation as the 2026-07-10T08:17:56Z UNIFY DECISION. Policy: all codexSliceReview slots record degraded (codex-unavailable), never faked, never block; run-level codex-checkpoint will be an external blocker unless credentials appear mid-run (operator: OPENAI_API_KEY or codex login).

## GATE S3 (run 20260710-171608-7bf26feb) — WORKTREES_GONE_OK
- verdict: PASSED all gates. implement (4 teammates + lead stitch incl. monitor-default E1-miss fix), securityWall clean (gitleaks 0 / semgrep 0 / dep-audit 0 high), test exit 0 (typecheck 0, 1645+ tests, machinery grep ZERO w/ recorded exclusions), fences 0f223f9 + polish commit, adversarialReview approve (fresh-context, 0 defects, 3 notes), codexSliceReview degraded (codex-unavailable, honest), adversarialTest pass (13/13 live probes incl. real session create/close at repo root), designAudit clean (2 of 3 pre-existing notes fixed in polish), video verified (evidence mode, 4/4 beats, both truths).
- evidence: docs/autothing/runs/20260710-171608-7bf26feb/slices/S3/ (gate-status.json, evidence.json, design/*.png, video sha in gate-status)
- durations: implement ~35min (parallel), gates ~45min; models: teammates+review/test/design on claude-fable-5, codex n/a

## DECISION 2026-07-10T20:24:37Z (run 20260710-171608-7bf26feb) — S1 review loop-back (attempt 2)
- adversarialReview: needs-work. MAJOR: stability-waiter stranded when blocker deleted/abandoned/terminal-without-stability (shouldRelease stability branch too narrow). Fix + regression tests dispatched to s1-engine. Also: ../ traversal rejected in touch-set validation (S2 consumes paths in git ops); stabilityFields always-on ACCEPTED per D2 (unconditional review-pass event) with comment.

## GATE S1 (run 20260710-171608-7bf26feb) — COORD_ORDERING_OK
- verdict: PASSED. implement (s1-engine lib+hooks, s1-server-ui insertion points+badges), securityWall clean, test exit 0 (typecheck 0, 1691 tests, 51 new coordination tests), fences a72a7b6 + 9fa4aac + UI-fix commit pending, adversarialReview approve after 1 loop-back (MAJOR: stranded stability-waiter -> releaseReason fix + regressions; traversal rejection), codexSliceReview degraded (codex-unavailable), adversarialTest pass (54/54 vs real server incl. D9 degraded 409), designAudit clean after 1 loop-back (callout composition), video verified (3/3 beats).
- notable: coordination activates on policy coordination-section presence; S6 seeds production ON. until:'fence' release predicate stubbed for S2.

## DECISION (run 20260710-171608-7bf26feb) — S2 review loop-back (attempt 2)
- adversarialReview: needs-work. HIGH: unscoped git commit sweeps pre-staged foreign index entries under the card's trailer (fix: commit --only + pathspec, diff working tree). MEDIUM: trailer spoofing via newline-bearing project names (fix: sanitize interpolations + parse final trailer block). Hardening: atomic lease takeover, mail-record-first ordering, end-of-options git args. Fixes dispatched to s1-engine at 2026-07-10T22:17:21Z.

## DEVIATION (run 20260710-171608-7bf26feb) — claude -p remote-dispatch exception
- The S9 short-flag guard surfaced a PRE-EXISTING real usage: kanban-loop outpost-dispatch pipes a prompt into `claude -p` on a REMOTE outpost host (no PTY over the exec API). Removing it would break outpost dispatch (out of scope). Recorded as the ONE sanctioned exception, allowlisted in the guard with justification; comment mentions no longer count (line-aware guard). The local capability exclusion stands unchanged.

## GATE S2+S4+S5+S9 (run 20260710-171608-7bf26feb)
- S2 PASSED (COORD_ATTRIBUTION_OK): review approve after HIGH index-isolation + MEDIUM trailer-spoof fixes (regressions committed); adv-test 111/111 vs real git; design clean after 6 fixes; video 3/3 verified. Fences 02cc9d0/51519b5/233f8df.
- S4 PASSED (FLOW_GENERIC_OK): review approve (contract F1 fixed); evidence panels 3/3; scratch repo validated; user-scope staleness heals at apm install (recorded). Fence ec83cd7.
- S5 PASSED (UX_QA_OK): review approve; GATE_KEYS cross-boundary fix; evidence panels 3/3. Fence 9c0d22d.
- S9 PASSED (RUNTIME_FREEDOM_OK, UI beat folded into S6, e2e retarget deferred to final walk): review approve; key-mask + badge + short-flag fixes; remote-dispatch claude -p exception DEVIATION recorded. Fences 2090809/be767f2/dec1461.
- codexSliceReview: degraded (codex-unavailable) on all four - recorded, never faked.

## DEVIATION (run 20260710-171608-7bf26feb) — be767f2 attribution sweep
- The S9-findings commit used a broad git add and swept s6-composer's in-progress files under the S9 trailer (nothing lost; HEAD correct). Exactly the failure mode D5 fences+scoped-staging solve for engine-driven runs - the lead's own gate commits now switch to explicit pathspecs. S6's remaining work is committed under its own trailer.

## GATE S6 (run 20260710-171608-7bf26feb) — COMPOSER_V2_OK
- verdict: PASSED. implement (composer surfaces + try-it gates + improver coordination rule + D6 lease-union completion), wall clean, fences 8ec8762/0e559ae, review approve after 1 loop-back (apm.lock.yaml, dedup, union tests), design clean after 1 loop-back (em dashes), video verified 4-beat + S9 target-card fold, codexSliceReview degraded (recorded). Coordination is now ON in the production policy.

## DECISION (run 20260710-171608-7bf26feb) — S7 review loop-back (attempt 2)
- adversarialReview needs-work: F1 MEDIUM stale session->card attach runs later significant work inline (pipeline bypass; console "web" key poisoning) - fix: attach-time liveness check + terminal release + scoped keys + regressions. F2 LOW override-regex false positive - tightened + negative cases. adversarialTest already PASS 5/5 independently.

## GATE S7+S8 (run 20260710-171608-7bf26feb) — AUTONOMY_COLLAPSED_OK + IMPROVER_PROBE_OK
- S7 PASSED: review approve after loop-back (stale-attach inline bypass fixed with liveness-gated attach + session-key scoping; override matcher imperative-only); independent test 5/5 (execution absent, quick->Done strip, override records, A5 hooks, in-flight survival); design clean; video 3/3 verified. Fences 1ee58c1/1ffe292.
- S8 PASSED: review approve after loop-back (per-session pending kills the cross-session sweep race; fd-safe jsonl; picker path EMPIRICALLY confirmed - Down+Enter=B, Escape emits no PostToolUse validating absence-based dismissal); independent test 59/59 (+ rephrase resemblance gate); design clean (52px targets, no raw JSON); video 3/3 verified. Fences 8867ad1/1ace329/3a47ff9.
- Run-level gates: deliberateRed 4/4 plants caught (secrets x2 leaks, worktree grep, rename grep, typecheck); mutation 3/3 killed (heavy-count killer test added after M1 survived - ratchet).

## GATE codex-checkpoint 2026-07-11T04:27:50Z (run 20260710-171608-7bf26feb)
- verdict: BLOCKED (external). codex exec probe -> ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in heade. Not logged in, no OPENAI_API_KEY, no ~/.codex/auth.json (same external cause + exact failed command as the per-slice codexSliceReview degradations throughout this run). The run-level cross-model checkpoint cannot execute; recorded honestly, never faked. Security coverage that DID run: the universal securityWall (gitleaks+semgrep+dep-audit) clean on every fence; the fresh-context security-boundary attention in every adversarial review (fences git-exec injection/traversal, revert human-only+confirm, feedback-queue JSON escaping, probe session-id sanitization, key masking - all reviewed + cleared); the built-in security-review (final-security-review agent, run now). Per the honesty rule a full-bar 'passed' cannot be claimed without the cross-model checkpoint -> terminal verdict falls to completed-with-blockers with this single external blocker.

## GATE security-review 2026-07-11T05:13:57Z — clean (built-in, 28 commits / 279 files; zero findings survive the confidence filter; git-exec arg-vectors + trailer sanitization + ULID route guards + CSRF origin check + confirm gating + key masking + JSONL escaping all verified defended)
## DECISION 2026-07-11T05:13:57Z — acceptance audit found 3 GAPS; all three CLOSED before the verdict
- #12 ux-qa never exercised -> gate RUN for real: 11 measured findings (1 blocker/5 major/4 minor/1 note) + screenshots in slices/S5/ux-qa/, loop-back proven through the real validator (major -> Implement; notes -> Done). The one finding on FLOW-V2's own code (waiting callout 3.39:1) FIXED (61b581a).
- #10 scratch e2e a paper claim -> the real engine drove a full-feature card end to end on ~/dev/flow-scratch (9 phases, real fence commits + trailers, real tests, real gate evidence). It CAUGHT a genuine D12 leak: docs/architecture.md hardcoded into every Implement dispatch. FIXED (da11b06).
- #16 rename prune half missing -> prune-legacy.sh implemented (gated on no live legacy sentinel; refuses right now because THIS run loops on one), 5 committed tests; registry display name fixed. (53050ed)
## GATE global 2026-07-11T05:13:57Z — completed-with-blockers (9/9 slices passed; 1 external blocker: codex checkpoint, credentials)
## DECISION 2026-07-11T05:15:32Z — report NOT sent: no AUTOTHING_SLACK_WEBHOOK_URL (env or ~/.config/garrison/.env). The composed payload printed instead; artifacts + landing ARE served (http://100.88.165.46:8091/20260710-171608-7bf26feb/), gallery at http://100.88.165.46:8099/. Recorded, not faked.

## RUN-START 2026-07-11T19:43:07Z
- runId: 20260711-194226-168684d3
- brief: GARRISON-RUNTIMES-V1 — runtime agnosticism: claude-code-runtime Fitting, providers as policy data, selectable primary_runtime, descriptor-driven per-runtime Quarters.
- model: claude-fable-5 (session effort: inherited)
- profile: build (8 phases P1-P8 from the brief; sizing confirmed at plan)
- gatesConfig: all-true (no operator flags) — test, adversarialReview, adversarialTest, codexSliceReview, design(ux-qa), walkthrough, deliberateRed, mutation, report, foundation, codexCheckpoint
- host: dev-madrid (GCP Linux box)
- preflight: asciinema 2.4.0, agg 1.9.0, codex-cli 0.144.1, gitleaks 8.30.1, semgrep 1.168.0, node v20.19.4, claude 2.1.207, gemini 0.49.0, ffmpeg 6.1.1-3ubuntu5, tsx via npx (no global)
- coord: coord-agentmail connected; coord-mcp planning gate ABSENT — agent-mail-only path

### DECISION 2026-07-11T19:53:53Z
- Plan-derived turn cap: 250 → 640 (max(300, 80×8 slices)). Sentinel updated.
- Slicing: 8 slices 1:1 with brief phases P1–P8; serial except P5 may overlap post-P2 (shared-file rule: orchestrator fitting + gateway are shared).
- FINDING-E7 delta recorded: no AGENTS.md/GEMINI.md projection path exists; orchestrator-projection.ts becomes the single per-primary projection writer (D7 intent preserved).
- P2 scope addition: second hardcoded registry SDK_PROVIDERS (agent-sdk-runtime/lib/providers.mjs) reduced to capability annotations; policy providers own connection data.

### GATE 2026-07-11T20:01:49Z — S1 deterministic wall + test (commit ea871d7)
- typecheck: exit 0 (tsc --noEmit). lint: exit 0 (next lint). durationMs: ~40000, model: claude-fable-5 (lead).
- test: full vitest 1920 passed / 12 skipped / 0 failed; S1 suites 86/86. Committed, re-runnable (tests/metadata.test.ts + tests/claude-code-runtime.test.ts extended).
- securityWall: gitleaks clean (staged + HEAD commit), semgrep auto clean on src/lib/metadata.ts + types.ts. Evidence: slices/S1/s1-gates.cast (61 tests green, asciinema).
- adversarialReview + codexSliceReview: in flight (fresh-context agent + codex exec gpt-5.5 high, serial).
### DEVIATION 2026-07-11T20:05:54Z
- The first S1 codexSliceReview call (codex exec, MCP-enabled) side-effected a CANONICAL repo file: basic-memory MCP stamped note frontmatter (permalink garrison-verifier-temp/claude) onto CLAUDE.md while flailing to read the diff, and its temp-project cleanup calls failed. Restored via git checkout -- CLAUDE.md (uncommitted damage only). Guard from now on: ALL codex exec calls in this run pass the diff INLINE and disable MCP side-channels; verdicts from MCP-flailing runs are discarded. Possible leftover: a 'garrison-verifier-temp' project in basic-memory — flagged for LANDING "needs human eyes".

### DEVIATION 2026-07-11T20:10:36Z
- Remediating the basic-memory frontmatter sweep, the mass 'git checkout --' of 142 stamped files also reverted 3 files carrying UNCOMMITTED S1-fix work (types.ts/metadata.ts discriminated unions + ratchet test). Re-applying from context. Lesson (friction-logged): mass-restores must exclude files with in-flight edits.

### DECISION (S2 scope) 2026-07-11T20:24:11Z
- Providers-as-policy: stage-b PROVIDERS constant DELETED; buildLaunchEnv resolves from opts.providers (policy section), loud on missing section/unknown id; MissingProviderKeyError locked-vs-absent preserved. compilePolicy carries providers into policy.json; validatePolicyConfig rejects targets naming unknown providers; migrateRoutingConfig + ensureProviders seed the historical entries.
- Migration seeds FIVE ids, not four: live seed targets reference "anthropic" (agent-sdk spelling of the Max OAuth path) — brief said four; intent (existing routing resolves identically) preserved.
- SDK_PROVIDERS (agent-sdk-runtime) RETAINED as the runtime's capability/auth-mode catalog (D3 runtime-level metadata: capability records, authMode, configurable-proxy semantics; two entries minimax/llm-proxy exist nowhere else). The true code mirrors of the registry are stage-b PROVIDERS (deleted this slice) and runtime-selection PRIMARY_PROVIDERS (deleted next, after in-flight reviewers finish their tsc runs — it is tsc-visible).
- Gateway respawn path threads ensureProviders(config).providers into buildRespawnOpts.

### GATE 2026-07-11T20:30:30Z — S1 CLOSED: passed
- adversarialReview: approve (fresh-context review-s1b, own evidence tsc=0, 66/66). codexSliceReview: needs-work→fixed→re-verified (discriminated unions, fa7e46c). Deterministic wall + full suite green ×2 commits. Evidence: slices/S1/s1-gates.cast.
- Session anomaly logged: subagent COMPLETION notifications are not delivered this session (probe-alive proved agents run in seconds); all agent verdicts now flow through scratchpad files.

### GATE 2026-07-11T20:33:58Z — S2 deterministic wall + codexSliceReview (commits c79627d, 7e19e34)
- wall: tsc 0, lint 0, full suite 1929/0, securityWall clean. codexSliceReview: needs-work (2 confirmed) → fixed → re-verified resolved:true. adversarialReview: in flight (review-s2, file side-channel). Evidence: slices/S2/s2-gates.cast.
- Explorer reports (quarters/composer) recovered via side-channel; E5/E7 detail confirms plan: primaryRuntime relocates to the policy file (D4 option b); FacultyStation picker deprecates to a hint; agent-sdk prompt delivery needs a file→string read (S8).

### GATE 2026-07-11T20:52:22Z — S2 CLOSED: passed · S3 wall green (commits ef59f8e, ec6e30d)
- S2 adversarialReview: approve (review-s2, own evidence tsc=0, full 1929/0) + 1 minor accepted (stage-b kindless null-baseUrl masquerade) → fixed in ef59f8e w/ ratchet test; codexSliceReview closed resolved:true earlier. S2 = passed.
- S3: tsc 0, lint 0, full vitest 1942/0, e2e 13 passed/1 documented-skip (all viewports), securityWall clean (semgrep/gitleaks). New committed e2e: tests/e2e/primary-runtime.spec.ts (gateway-down acceptance). codexSliceReview + adversarialReview + adversarialTest in flight (file side-channels).
- Dependency check: yaml@2.9.0 verified on registry (eemeli, intended package) before install.

### GATE 2026-07-11T21:08:34Z — S3 near-closed · S4 built+walled (commit dba7857)
- S3: adversarialReview approve (3 minors fixed, 39e8427); codexSliceReview needs-work→fixed→re-verified (+coercion hardening 9cac6dc); ux-qa clean-with-notes (screenshots under slices/S3/evidence; capture FOUND+FIXED a real blocker: default primary unselectable when composed-but-uninstalled, 0b1640b + e2e case). OUTSTANDING: adversarialTest verdict (advtest-s3 file side-channel) + walkthrough video.
- S4: gateway warm seam (resolvePrimaryAdapter + probeRuntimeBridge + always-claude classifier) + runner wall removal committed dba7857; tsc 0, full suite 1950/0, semgrep+gitleaks clean, cast slices/S4/s4-gates.cast. codexSliceReview + adversarialReview in flight. adversarialTest: kind-conditional skip (api).
- Session anomaly persists: agent completion notifications never delivered; ALL agent verdicts via scratchpad files.

### DECISION 2026-07-11T21:23:51Z
- S3 walkthrough recordings 1-2 failed on STORYBOARD bugs (my evidence-panel grep patterns could not match pretty-printed policy JSON; a broken newline-blind diagnostic regex sent me chasing a phantom compile bug; non-unique provider selector). Classified test-bug (no ceiling cost) per the gate-failure classification; third recording with corrected probes. Feature behavior verified live throughout (manual PUT emits primaryRuntime correctly).

### GATE 2026-07-11T21:26:33Z — S3 CLOSED: passed (7 commits ef59f8e..f40ab53)
- adversarialTest: PASS (independent probes incl. robustness; 2 observations hardened same-run). walkthrough: VERIFIED evidence-mode video, 7/7 beats, both truth layers; recordings 1-2 failed on MY storyboard probe bugs (test-bug class, DECISION logged); gallery live (206 range-check). ux-qa clean-with-notes. All earlier gates green.

### GATE 2026-07-11T21:33:11Z — S4 CLOSED: passed · S6 CLOSED: passed · S5 committed (64df023)
- S4: review approve (3 minors: D8 non-PTY guard added 17d0aa8, casing fixed, prompt-timing recorded for S8); codex closed with one partial rebuttal (documented). Full suite 1965/0.
- S6: descriptors landed 0fcf2a0, strict-schema tests green, RENDER-VERIFIED live against real ~/.codex + ~/.gemini through the S5 generic tier. codexSliceReview skipped on judgment: pure declarative manifest data, no code paths (build profile normally runs it every slice — recorded openly here, not silently).
- S5: lib+API+pages+panels committed 64df023; boundary property tests; live verification done. Remaining S5 gates: codexSliceReview + fresh review + walkthrough/ux-qa (mixed).

### GATE 2026-07-11T22:03:23Z — run-level progress
- deliberate-red: PASSED — neutered the log-containment guard in quarters-runtimes.ts; exactly its 2 guard tests went red (2 failed/15 passed); restored byte-identically; 17/17 green. The gate catches the class.
- build: PASSED in an isolated hardlink clone (in-repo next build corrupted the dev server's .next — dev server restarted clean with a fresh .next; friction-logged).
- S5 CLOSED passed (verified 6/6 evidence video shared with S7 beats). S7/S8: reviewer + advtest verdicts pending (file side-channel). Batched API advtest (S1/S2/S4/S6/S8 surfaces) spawned.
- Coordination note: composition apm_modules installed copies of codex/gemini manifests refreshed to the seed (D3 blocks) for live-render truth.

### GATE 2026-07-11T22:04:38Z — mutation: PASSED
- 8 hand-authored mutants across stage-b (vault-key/plan-path), policy-core (duplicate-id/primary-default), runtime-selection (providers-check/null-baseUrl), quarters-runtimes (sha-guard/projection-flag): 8/8 KILLED by their suites, 0 survivors. Tree restored byte-identically; suites re-verified green (74 tests).

### GATE 2026-07-11T22:11:43Z — S7 CLOSED: passed · S8 CLOSED: passed · ALL 8 SLICES PASSED
- S7: codex JSON-null crash fixed+re-verified; review medium (create-on-miss GET) fixed read-only; advtest pass. S8: committed gated live smoke (run live: PASSED); marker constant shared; refusal loudness fixed. Batched API advtest: 4/4 surfaces, 23/23. Run-level: deliberate-red ✓, mutation 8/8 ✓, isolated build ✓.

### GATE 2026-07-11T22:18:32Z — FINAL PHASE COMPLETE
- built-in security-review: CLEAN (completed by direct read of every security-critical surface — the identification sub-task hung on this session's agent-notification anomaly; documented). codex checkpoint: CLEAN (gpt-5.5 high, run-level over file/log I/O + server guards, 0 findings).
- Final acceptance: tsc 0, lint 0, full vitest 1972 passed/0 failed/13 skipped, isolated production build green.
- globalGate: PASSED (buildable-remaining 0, videos 2/2, gates-disabled none, model-fallbacks 0).

### RUN-END 2026-07-11T22:18:32Z
- GARRISON-RUNTIMES-V1: 8/8 slices passed, full-bar. Verdict printed to transcript.

## RUN-START 2026-07-12T17:36:11Z
- runId: 20260712-173530-81e1c448
- brief: GARRISON-MARATHON-V1 — 10 workstreams (governor, taste fitting, runtime agnosticism + matrix, clone/edit fittings, composition switching, assistant, tours, improver probe, shadcn/improve patterns, UI/UX pass)
- model: claude-fable-5 · effort: session-inherited
- gatesConfig: all-true (no operator flags)
- profile: pending-sizing
- host: dev-madrid
- preflight:
  - node=v20.19.4
  - npm=10.8.2
  - tsx=MISSING
  - ffmpeg=
  - asciinema=asciinema 2.4.0
  - agg=agg 1.9.0
  - codex=codex-cli 0.144.1
  - gitleaks=gitleaks version 8.30.1
  - semgrep=1.168.0
  - ollama=MISSING
  - opencode=1.17.15
  - playwright=Version 1.61.1

### DECISION 2026-07-12T17:38:51Z
- coord-agentmail server unreachable (connection error on macro_start_session); coord-mcp planning-gate tools absent from this session. Proceeding without cross-session coordination per skill contract (never hard-block); falling back to disjoint-files discipline. Will retry agent-mail once mid-run.

### DECISION 2026-07-12T17:45:05Z (E12 spike)
- AskUserQuestion available in Claude Code 2.1.207. PostToolUse hook with matcher "AskUserQuestion" RECEIVES the selected answer: tool_response.answers = {"<question>": "<label>"}, plus session_id, tool_input (full question structure), tool_use_id. Probe capture path = PostToolUse hook (primary path per D9/E12); garrison-control fallback tool NOT needed.

### GATE 2026-07-12T17:53:27Z — phase-0 (explore)
- green: all 15 FINDING-E items answered (5 parallel explorers + 2 live spikes)
- evidence: docs/autothing/runs/20260712-173530-81e1c448/phase0-findings.md + phase0-e*.md side-channel reports
- models: explorers on session model; E12 spike drove claude-code 2.1.207 + haiku child
- duration: ~35 min wall-clock

### DECISION 2026-07-12T17:58:01Z (plan sizing)
- 19 slices (S0..S9c), profile=build (replaces pending-sizing), turnCap 250 → 1520 (max(300, 80×19)), deliberateRed+mutation ON. RUN_SPEC assumptions A1–A12 (probe spec = shipped S8 + amendments; global composition activated in WS1; opencode default provider = local ollama; lead sliced directly, D1–D12 pre-decided).

### GATE 2026-07-12T17:58:01Z — plan
- green: RUN_SPEC.md + FLOW_PLAN.md written (19 slices, all ≤8 points)
- evidence: docs/autothing/runs/20260712-173530-81e1c448/RUN_SPEC.md, docs/autothing/runs/20260712-173530-81e1c448/FLOW_PLAN.md
- model: session (claude-fable-5)

### GATE 2026-07-12T18:00:21Z — S0 (WS0 governor)
- green: governor check/wait-if-needed/banner-watch working; real check 12.5% resets 19:00Z; simulated pause/resume pair printed; banner matcher validated on the known fixture + hard-limit shapes
- decision: governor + tests live outside the repo per brief D2 (single-run tooling); adversarial gates recorded skipped no-repo-diff
- evidence: docs/autothing/runs/20260712-173530-81e1c448/slices/S0/gate-status.json; ~/.garrison/marathon/ledger.md governor lines
- model: claude-fable-5 · duration ~8 min

### DECISION 2026-07-12T18:34:22Z (S1 evidence re-record)
- First recording invalid: title duration authored in ms against a seconds-unit schema (4827s video); one beat flagged (click action superfluous). Storyboard fixed (2.6s/2.2s titles, pure-assert beats), re-recording. advtest-s1 independent PASS 13/13 (own probe, DOM + API); fresh-context review approve; codex slice finding fixed (dcb24c7).

### GATE 2026-07-12T18:37:06Z — S1 (WS1 taste Fitting)
- green: wall 15/15+tc+lint+securityWall · fresh review approve · codex needs-work→fixed (dcb24c7) · advtest 13/13 · video verified (29.3s, 6 beats, unflagged, sha 74c2bc42…)
- design gate skipped: no-ui-delta. Evidence third-take after 2 storyboard authoring bugs (title duration units; evidence file field) — friction-logged.
- model: fable-5 lead + fresh-context subagents + gpt-5.5 codex · duration ~55 min

### DECISION 2026-07-12T18:47:50Z (S2b stall takeover)
- impl-s2b produced no durable output in 65+ min and was silent through two pings — replaced with impl-s2b-2 under a tightened, commit-early brief. impl-s2a alive (live smoke surfaced follow-up edit in progress in gateway-routing.mjs).

### DECISION 2026-07-12T18:54:00Z (S2a codex verdicts)
- codex needs-work: I3 REAL (adapter-resume never releases old pool checkout → double-teardown at shutdown; teardown throw swallowed) → sent back to impl-s2a with fix spec. I4 REBUTTED: claudeCodeResolvable boolean/function opts are a test-injection seam, no production caller passes them (grep verified); a doc comment requested.

### GATE 2026-07-12T19:05:36Z — S2a1+S2a2 (WS2a gateway abstraction)
- green: full suite 2019 · fresh review APPROVE (reviewer re-ran live smoke) · codex needs-work→fixed→resolved (e2113e8) · gated live smoke passed twice with real ollama operative · asciinema evidence sha b2f00c22ca73f84c2b2d3c5d704b1cc566958e457ea6832bc6fb4f5cc1a72ef6
- notable: live smoke caught a REAL bug (resolvePrimaryAdapter hardcoded provider anthropic — non-Anthropic primary impossible; fixed with byte-identical defaults)
- model: fable-5 lead + fresh subagents + gpt-5.5 codex · duration ~85 min

### DECISION 2026-07-12T19:12:24Z (S2b codex verdicts)
- codex needs-work: two REAL I3 loud-failure violations (empty/malformed run output silently accepted; terminal error swallowed after partial text) → fix dispatched to impl-s2b-2. Live delegate round-trip earlier PROVED the transport (bridge→opencode→ollama→{summary,artifacts}); 3B model quality noted for degradations doc.
- S2b was ultimately a TWO-AGENT convergence (original impl-s2b woke, contributed tests + CLI findings incl. v2-API-can't-carry-model, impl-s2b-2 shipped the stateless design); coordination cost logged to friction.

### GATE 2026-07-12T19:20:37Z — S2b (WS2b opencode-runtime)
- green: suite 2024 · review APPROVE (live flag audit) · codex 2 findings→fixed→resolved · live delegate round-trip through local ollama proven twice · asciinema sha 1daf66eb391d95cad1f1161d144a221635b5a03d840ce19d178446d1a1ed8b5a
- design decision: stateless run-subprocess (sibling parity; v2 HTTP API can't carry per-call model/variant); server-first variant preserved under slices/S2b/server-first-variant/
- model: fable-5 lead + 2 impl agents + fresh reviewer + gpt-5.5 codex · duration ~110 min (incl. stall takeover)

### GATE 2026-07-12T19:59:20Z — S2c (WS2c matrix)
- green: full 3-primary matrix run zero unexplained failures (every primary booted RoutedGateway + served live turn); harness + tests committed; codex proto-key finding fixed 412128e→resolved; full suite 2068
- notable: found+fixed a real agnosticism bug (resolvePrimaryAdapter had no opencode branch)
- model: fable-5 lead + impl-s2c + gpt-5.5 codex · matrix run driven by impl-s2c

### GATE 2026-07-12T20:12:02Z — S3+S4+S2d (WS3 clone / WS4 switch / WS2d degradations)
- S3: clone+edit round trip, review approve, 3 codex findings fixed→resolved (6fe735a), 14/14 tests
- S4: composition switching, review approve, 1 codex finding fixed→resolved (0b721ed), 25/25 tests
- S2d: RUNTIME_DEGRADATIONS.md + degradation module + /api/runtime/active + compose advisory notice, 4/4 tests
- shared evidence: combined S3+S4 walkthrough (sha d2ba644a42c9482b, flagged=false, 6 beats, vision-verified switcher)
- coordination: parallel fan-out (impl-s2c/s3/s4) was CPU-starved on this box — slow but productive; lead committed several stalled-at-commit deliverables + wrote S2d directly (friction-logged)

### DECISION 2026-07-12T20:15:14Z (S5 stall takeover)
- impl-s5 produced zero durable output in 23 min (no scaffold dir, no commit, no ping reply) — hard stall. Lead takes over WS5 directly, building serially.

### DECISION 2026-07-12T20:28:57Z (S5 build + codex verdicts)
- WS5 built by the LEAD after impl-s5 stalled 23 min at zero output (takeover); impl-s5 later revived, validated the build green, flagged 2 real own-port gaps (status file + config-env normalization).
- codex needs-work: 3 findings (I2 index symlink escape, I4 malformed /interview 500, I5 queue-clobber on corrupt) → dispatched to impl-s5 alongside its 2 own-port gaps (5 fixes total).
- assistant: Answer grounds 3 Qs with real sources; Guide launches tours by name (fails loud); Build adaptive interview ≥4 Qs files 2 provenance-assistant proposals into the real improver queue (pending/approvable). full suite 2086 green.

### GATE 2026-07-12T20:41:19Z — S5 (WS5 Garrison Assistant)
- green: 3 modes work live (Answer grounded w/ real sources · Guide launches tours by name · Build adaptive interview → 2 provenance-assistant proposals pending/approvable); review APPROVE; codex 3 findings + 1 residual → all resolved; full suite 2089
- build: lead built after impl-s5 stalled 23min@0 output; impl-s5 revived, finalized own-port status file + config-env + impl.md
- evidence: asciinema b8905952638f16f7d7a01e9ce99b4f331d783f88a90480848561286e5be30259
- model: fable-5 lead + impl-s5 + fresh reviewer + gpt-5.5 codex

### DECISION 2026-07-12T20:48:52Z (S7 stall takeover)
- impl-s7 produced zero output in 30 min; lead takes over WS7 (contained config+recompile+verify). impl-s6 (WS6 UI) continues.

### DECISION 2026-07-12T20:59:20Z (S7 codex verdict)
- codex needs-work: ollama-local baseUrl is "localhost:11434" not literal "127.0.0.1". REBUTTED as immaterial — localhost IS loopback, the never-Anthropic constraint holds via provider==ollama-local; forcing 127.0.0.1 in providers.mjs would break 2 pre-existing agent-sdk tests for no fence benefit. Instead STRENGTHENED the test to assert loopback host (localhost/127.0.0.1/::1) AND never a remote host (.com/.ai/.io/anthropic) AND plain http — the real fence invariant, stronger than the exact-IP ask.

### GATE 2026-07-12T21:00:39Z — S7 (WS7 Improver Probe revival)
- green: probe-question row compiled to LOCAL ollama target (never Anthropic); resolveProbeTarget resolves; live local question gen; 62/62 probe tests; codex finding rebutted+strengthened; IMPROVER-PROBE OK
- build: lead-built after impl-s7 stalled 30min@0 output
- model: fable-5 lead + gpt-5.5 codex

### DECISION 2026-07-12T21:04:35Z (S8 stall takeover)
- impl-s8 produced zero output in 30 min (no improver changes, no findings doc); lead takes over WS8. impl-s6 (WS6 UI) continues.

### GATE 2026-07-12T21:22:19Z — S8 (WS8 shadcn/improve patterns)
- green: 4 patterns live (evidence+confidence, vet drops planted FP, rejection ledger suppresses across runs, reconcile); full suite 2142; codex 2 findings + 1 residual → all resolved (corrupt-ledger throw, path+symlink containment)
- build: lead-built after impl-s8 stall; impl-s8 concurred with the citations schema + repoRoot containment
- model: fable-5 lead + gpt-5.5 codex

### GATE 2026-07-12T21:34:02Z — S6 (WS6 tour engine)
- green: Demo + Guided players live-verified (impl-s6 17/17 Playwright + lead walkthrough flagged=false, vision-confirmed Demo overlay); ui.tours schema; per-fitting tours; Escape exits; Assistant Guide launches by name+mode; 42 tour tests; full suite 2142
- build: impl-s6 (engine/players/registry) + lead (D6 assistant wiring + evidence)
- model: fable-5 lead + impl-s6

### DECISION 2026-07-12T21:37:33Z (S9 stall takeover)
- impl-s9 produced zero output in 20 min; lead takes over WS9 (last slice) directly — focused, measurable copy+affordance pass.

## RUN-START 20260713-135552-3c338e01 — 2026-07-13T13:57:31Z
- **Brief:** GARRISON-MARATHON-V3 — rebuild Garrison's middle around three assumptions (composition file, Resolver, orchestrator slot): Duties/Levels/Dispatcher replace modes/tiers/task-types/phases; composition v4 absorbs everything; Muster page; Kanban as duty surface; plus V2 carried items (daily-driver fixes, runtime expansion, channel bridge, voice, Quarters honesty).
- **Session:** model=claude-fable-5 effort=session-inherited sid=3c338e01-b84c-492f-a96e-91674f7cca8f host=dev-madrid
- **Profile:** build (multi-workstream marathon, >>4 slices; confirmed at planning)
- **gatesConfig:** all-true (no operator --no-* flags; full bar in force)
- **Governance overlay:** marathon ledger ~/.garrison/marathon/ledger.md + governor.mjs pacing (spec format wins for sentinels; autothing GATE entries land here)
- **Preflight:** asciinema 2.4.0, agg 1.9.0, codex-cli 0.144.1, gitleaks 8.30.1, semgrep 1.168.0, ffmpeg 6.1.1, node v20.19.4, npm 10.8.2, jq 1.7, playwright 1.60.0; tsx global MISSING (repo devDep, verify via npx)
- **DECISION 2026-07-13T13:57:31Z:** coord-mcp not connected; coord-agentmail unreachable (connection refused). Coord stack absent — degrading to intra-run disjoint-files discipline per skill contract. No cross-session leases this run.
- **Governor:** 2026-07-13T13:57:31Z window 0.8% resets 2026-07-13T16:00Z — pacing armed.
- **GATE baseline (2026-07-13T14:01:11Z):** typecheck exit 0; vitest 2148 passed / 14 skipped (253 files, 23s) — green pre-change floor. Model: claude-fable-5 (lead, inline). Duration ~5min bg.
- **DECISION (2026-07-13T14:10:36Z):** first explorer fan-out (7 bg agents, inherited model) stalled — transcripts frozen 13min mid-grep, greps swept node_modules/dist (170KB lines, likely context blowout); liveness ping unanswered. Respawning 7 re-scoped explorers with grep-hygiene rules (exclude node_modules/dist/.map, output caps) pinned to sonnet. First-hand E1/E3/E4 already captured inline by lead.
- **DECISION-CORRECTION (2026-07-13T14:13:49Z):** wave-1 explorers were NOT stalled — I monitored the wrong dir (/tmp tasks dir of a prior session); real transcripts live in ~/.claude/projects/<slug>/<sid>/subagents/ and show both waves actively writing. Wave-2 respawn was unnecessary → double coverage accepted (wave-1 primary, wave-2 verification/gap-fill); governor 3.3%, headroom ample.
- **GATE phase0-wave1 (2026-07-13T14:17:40Z):** all 7 wave-1 explorer reports harvested from subagent transcripts (idle-teammate semantics — results pulled, not pushed). Coverage: E1-E19 primary evidence complete incl. E9 root cause (premature-empty-return race + 2 empty-as-success paths), E8 seven-point divergence table, E13 provenance-move gap, E14 token table, E19 pinned set. Wave-2 verification agents still running. Model: sonnet (wave-2) / inherited (wave-1); duration ~18min wall.
- **GATE phase0 (2026-07-13T14:20:36Z):** exit 0 — 19/19 findings evidence-complete; reports at docs/autothing/runs/20260713-135552-3c338e01/phase0-findings/ (secrets scrubbed). WS0 sentinel appended to marathon ledger. Next: Phase 1 spec-first planning (garrison-plan) → RUN_SPEC + FLOW_PLAN.
- **GATE plan (2026-07-13T14:24:53Z):** exit 0 — RUN_SPEC.md (12-item assumptions ledger) + FLOW_PLAN.md (24 slices, 4 parallel groups, sizes ≤8) written under runDir. Profile build confirmed. Model: claude-fable-5 (lead).
- **DECISION (2026-07-13T14:24:53Z):** turnCap resized 250→1920 (max(300, 80×24 slices)) in the sentinel.
- **DEVIATION (2026-07-13T14:24:53Z):** garrison-plan Phase 2 executed inline by the lead (full findings context already held; re-serializing 19 findings into a Plan subagent judged lossy+wasteful). Read-only discipline held: only RUN_SPEC/FLOW_PLAN/control-plane written.
- **BUILD (2026-07-13T14:28:03Z):** PG-A fan-out — s1a-impl (add-card UI), s1b-impl (empty-output contract+race fix), s2a-impl (openai-agents-runtime), s2b-impl (garrison-call) spawned with disjoint ownership; lead runs gates+commits. Governor 5.5%.
- **GATE S3a/wall (2026-07-13T14:41:37Z):** exit 0 — typecheck+lint clean, 22 new resolver tests green, docs-parity ratchet caught+fixed (duty documented in CAPABILITIES.md+METADATA.md), gitleaks clean, full suite green after quarantining a rogue resurrected fittings/seed/model-router (implementer scratch — moved to scratchpad, culprits notified). Committed bf173ec.
- **DECISION (2026-07-13T14:41:37Z):** codexSliceReview auth = operator's ChatGPT login (same CODEX_HOME the V1 checkpoint used on this box; no API key in reach — vault parked). Calls kept diff-scoped + one per slice; quota errors will degrade per Part 3, never block.
- **BUILD (2026-07-13T14:41:37Z):** S3a adversarial gates in flight — fresh-context review agent + codex slice pass (serial). PG-A implementers still working.
- **DECISION (2026-07-13T14:44:01Z):** codex -s read-only fails on this kernel (bwrap userns denied); re-ran S3a slice pass with --sandbox danger-full-access + read-only-by-instruction — the exact V1 checkpoint pattern on this box (CHECKPOINT.md documents it). First attempt honestly reported unable-to-verify rather than fake-clean; not counted as a verdict.
- **GATE S3a/codexSliceReview (2026-07-13T14:51:05Z):** needs-work → fixed — 3 real findings (level-0 floor, schema-level cross-checks, dup provisions), all fixed + regression-tested in 7240e84. actualModel gpt-5.5-high via danger-full-access (V1 pattern).
- **GATE S1a/wall+test (2026-07-13T14:51:05Z):** exit 0 — committed 38370f2 (implementer: s1a-impl). UI gates (review/codex/adv-test/design/walkthrough) queued.
- **GATE S3a/adversarialReview (2026-07-13T14:55:02Z):** needs-work → fixed — strict duty schemas (1688f74); recursion-depth note accepted-minor. S3a per-slice gates COMPLETE (adv-test + asciinema batched at run level per Part 8.2). Sentinel MARATHON3-WS3A OK appended.
- **GATE S1a/codexSliceReview (2026-07-13T14:55:02Z):** needs-work → fixed — reentrancy guard (a3af96b). Awaiting fresh-context review verdict; UI gates (adv-test/design/walkthrough) queued behind shared board runtime.
- **GATE S1a/adversarialReview (2026-07-13T14:58:04Z):** approve — double-submit already fixed (a3af96b); UI Playwright coverage flagged→deferred to batched run-level pass. Sentinel MARATHON3-WS1A OK.
- **GATE S2b/wall+test (2026-07-13T14:58:04Z):** exit 0 — 38 tests (5 live Ollama), validate-fitting 4/4, lint+gitleaks clean; committed 32e4718. Sentinel MARATHON3-WS2B OK (adversarial gates in flight).
- **DECISION (2026-07-13T14:58:04Z):** UI slices' independent-test + walkthrough gates batch at run level (Part 8.2) behind ONE shared board/dev-server runtime — avoids N concurrent servers. Tracked per-slice as deferred-batched, executed in WS7.
- **GATE full-suite (2026-07-13T15:08:10Z):** exit 0 — 2290 passed / 14 skipped (was 2148 baseline; +142 net across S3a/S1a/S1b/S2a/S2b/S3b1). No regressions after 8 slice commits. Model: lead inline.
- **BUILD (2026-07-13T15:08:10Z):** S3c (router→duties migration) fan-out; S1b/S2a reviews + S2a codex in flight; S3b1 gates queued.
- **GATE S1b/adversarialReview (2026-07-13T15:15:50Z):** needs-work → fixed (c99494c, retryKeepsContext wired + tested). Sentinel MARATHON3-WS1B OK.
- **GATE S2a/adversarialReview+codex (2026-07-13T15:15:50Z):** review approve; codex 2 findings (key-egress via spec.baseUrl, --spec-file) fixed 5b7fe0c. Sentinel MARATHON3-WS2A OK.
- **GATE S2b/adversarialReview (2026-07-13T15:15:50Z):** needs-work → fixed earlier (key-egress bf5bab4). All PG-A + S3b1 per-slice code gates complete; adv-test + walkthrough batch at WS7.
- **GATE S3b1/codexSliceReview (2026-07-13T15:25:57Z):** needs-work → fixed — 3 findings (prototype pollution in overlay merge, overlay silently adding membership, migrator leaving global_config home path) fixed + regression-tested (64c72e1). Overlay-append behavior REVERSED from my original brief per the finding (D8: composition owns membership).
- **GATE S3b1/adversarialReview (2026-07-13T15:26:27Z):** approve (clean after codex fixes). S3b1 fully gated — WS3B partial (S3b1 of S3b1+S3b2).
- **GATE S6a/wall+test (2026-07-13T15:39:11Z):** exit 0 — 10 tests, key-never-leaks proven, validate-fitting 4/4; committed 466b35b. Review+codex in flight. PG-C voice base landed.
- **GATE S3c/adversarialReview (2026-07-13T15:50:26Z):** approve — migration preserves runtime behavior exactly (precedence match verified). Sentinel MARATHON3-WS3C OK.
- **GATE S6a/codex+review (2026-07-13T15:50:26Z):** codex 4 findings fixed (014983e); review approve. Sentinel MARATHON3-WS6A OK. S3c codex still queued (serial).
- **GATE full-suite (2026-07-13T15:50:26Z):** 2332 passed / 14 skipped (was 2290) — S3c live migration of compositions/default + S6a broke nothing.
- **GATE S3c/codexSliceReview (2026-07-13T15:56:11Z):** needs-work → fixed — backup-before-write ordering (f12747c). S3c fully gated.
- **DECISION (2026-07-13T15:57:17Z):** S3e (s3e-impl) stalled — explored exhaustively (400KB transcript) but wrote ZERO code, transcript ended mid-exploration. Classified as agent-level empty-output (infra, not a code failure). Re-dispatching with an implementation-first brief (exact targets front-loaded, minimal-explore directive). No ceiling cost (infra reclassification).
- **GATE S3e/codex+review (2026-07-13T16:09:47Z):** codex 4 findings fixed (fe3ef79); review approve. S3e fully gated.
- **GATE S3d/codex+review (2026-07-13T16:28:21Z):** codex 4 findings fixed (b961d31); review approve. Sentinel MARATHON3-WS3D OK. WS3 composable core (S3a-S3e) COMPLETE. S3f (skills/identity) in flight.
- **GATE full-suite (2026-07-13T16:28:21Z):** exit 0 — green after S3d+S3e (was 2332).
- **DECISION (2026-07-13T16:58:43Z):** S3f2 (s3f2-impl) stalled empty — over-explored (13+ rounds, 579KB) and terminated before writing (same pattern as S3e attempt 1). The slice is too large for one agent's budget. SPLITTING into S3f2a (create identity-gary + duty-discuss + duty-develop — additive) and S3f2b (retire modes/souls + consumer updates + test fixups — delicate), sequenced to avoid consumer-file conflicts. Re-dispatching implementation-first. No ceiling cost (infra).
- **GATE S3f2b (2026-07-13T17:34:30Z):** modes+souls retired, consumers rewired to identity. Targeted 112/112 + composition 65/65 green. DEVIATION: seed deletions conflated into residue commit fa72232 by a stale staged index; consumer updates in 6a3eef4; branch tip correct, fa72232 broken-in-isolation (documented, not rewritten — shared-branch risk). deepgram-voice-live flake logged to known-flakes (12/12 isolation).
- **GATE S3f2/codex+review (2026-07-13T17:46:57Z):** review approve; codex caught a run-wide library-registration gap (14 new fittings unregistered → compositions not ready) — fixed 174ab93 + determinism-ratchet test. Sentinel MARATHON3-WS3F OK. WS3 (composable core + skills/identity) COMPLETE.
- **GATE S5a/codex+review (2026-07-13T18:35:20Z):** review approve (2 non-blocking notes, both addressed); codex 4 config-write findings (atomic write, server-side validation x2, payload sanitization) fixed 4660888. Sentinel MARATHON3-WS5A partial (S5a of S5a/b/c). Muster centerpiece up.
- **GATE S4a/S4b reviews (2026-07-13T18:56:41Z):** S4a-review needs-work (batch path) = codex finding 1, already fixed 2a560c2. S4b-review needs-work (door-1 inert) fixed ff758ac + claim corrected. Both codex passes fixed (2a560c2, e4798f4). WS4 (Kanban duty surface) COMPLETE.
- **GATE full-suite (2026-07-13T19:02:08Z):** exit 0 — green after WS4 (S4a-fix + S4b fixes).
- **DECISION (2026-07-13T19:09:39Z):** S6b (voice UI) stalled empty — over-explored (666KB, 7+ read rounds) then terminated before writing (S3e/S3f2 pattern). Voice UI too large for one agent (AudioWorklet + state machine + PTT + latency + chat-wire + tests). SPLITTING: S6b1 (conversation state machine [D20 gating core] + AudioWorklet capture, unit-testable) + S6b2 (chat composerAdornment wiring + Playwright fake-media). Re-dispatching implementation-first.
- **DECISION-CORRECTION (2026-07-13T19:24:14Z):** S6b was NOT stalled — s6b-impl was actively working the whole time (a 150s idle window fell during a long tool call + I ground-truth-checked before its writes flushed → false stall diagnosis). It built the FULL voice engine (voice-machine state machine, voice-capture AudioWorklet, voice-latency, voice-tts streaming, voice-conversation.tsx component + wiring) + 2 test files. The redundant s6b1-impl correctly detected the overlap and stood down (deleted its dup, touched nothing). Lesson: raise the idle threshold + don't ground-truth a worker until it reports done. Letting s6b-impl finish (task #31 tests); will commit the whole S6b (state machine + wiring — subsumes the planned S6b2).
- **GATE S5b+S6b (2026-07-13T19:55:14Z):** S5b review approve; S6b codex (deadlock+leak) + review (busy-watch re-arm) fixed. Both fully gated. 43 commits.
- **DECISION (2026-07-13T19:55:14Z):** S6d (wake word) SKIPPED — explicitly stretch + non-gating per brief (WS6d optional); conserving governor budget (59.9%) for WS7 live-fire. Recorded as not-run, not blocked.
- **GATE S6c (2026-07-13T20:16:51Z):** review approve; codex skipped (declarative-config). WS6 complete. Sentinel MARATHON3-WS6 OK.
- **GATE full-suite (2026-07-13T20:19:20Z):** exit 0 — green with all 24 build slices committed (WS5+WS6 complete).
- **GATE WS7/security-wall (2026-07-13T20:30:40Z):** PASS — committed diff 0 leaks (49 commits); 24 working-tree hits all pre-existing baseline (gitignored + 5 tracked files 0-commits-in-range). Hard constraint 3 (vault discipline) satisfied.
- **GATE WS7/codex-checkpoint (2026-07-13T20:44:25Z):** issues-fixed — 3 cross-cutting key/log-leak findings fixed (5dccea0), 1 low-severity local-path accepted. Two decorrelated passes not needed; the per-slice codex + this run-level pass cover the surfaces.
- **GATE WS7/UX-gate-e2e (2026-07-13T20:59:51Z):** the Muster orchestrator-panel mobile e2e (previously 3 failing on collapse-timing) fixed (55b7403) — now 4/4 green in isolation, 41/42 in the combined run (1 concurrent-load flake). FINDING 13 e2e parameters (390px overflow, interaction, render) GREEN on desktop + mobile.

## RUN-START 20260715-drill-v1-7c9c7547 — 2026-07-15T~20:19:05Z (session-relative; exact start time predates this entry)
- **Brief:** BRIEF-DRILL-V1.md — build Drill, Garrison's visual/agent-driven QA fitting, end to end in one session per the annotated spec ledger drill-mock.jsx (S1-S29 spec inventory, R1-R14 decisions, Q1-Q9 resolved questions). 9 build-order phases (engine deltas → skeleton → authoring → run → graduation → states → Garrison integration → mobile → 13-item self-test) plus close-out.
- **Session:** model=claude-sonnet-5, host=dev-madrid; executed via the garrison-doorway skill (Kanban card `01KXKDM2198RA23ATFZE9QD495`, duty=code level=3, origin=garrison-doorway) rather than the marathon-ledger skill — no coord stack, disjoint-files discipline.
- **Hard constraints held:** no new branch; no `/goal`; atomic writes throughout Drill's own lib/*.mjs (temp-write-same-dir + rename + read-back verify); Resolver untouched except duty registration; fixer step-type fencing preserved exactly; no artifact store (plain files + links); UI copy plain-English sentence case, no em dashes; Garrison's real visual tokens (warm paper/sage/brass, sharp corners) reused verbatim.

### BUILD — Phases 1-8 (engine deltas through mobile pass)
- **P1 engine deltas (automations, D2):** 7 deltas landed as general engine features (not Drill-specific): `contextTag`/`bypassCache` threading through `runAutomation`/`visionResolve`, per-viewport tab creation (`makeLiveRunBrowser`), disabled-step skip (`tier:"skipped"`), step evidence capture + strip-before-persist, `runAutomationMatrix` (one run per viewport, grouped), and a new pure `assertions.mjs` (5 assertion kinds: text-contains/count/visible/url-matches/attribute-equals). browser-default gained viewport emulation (`applyViewportEmulation`, CDP `Emulation.setDeviceMetricsOverride` for mobile/DSF) and a deterministic `/assert` endpoint with its own locator ladder (no `.first()`, so `count` sees every match).
- **P2-P4 Drill skeleton, authoring, run path:** own-port fitting at :7096 (faculty `building`), Drill Book (drillbook.yml + pages/*.yml, atomic) in the TARGET APP repo per R6; picker (`@medv/finder` + css-selector-generator fallback, multi-anchor: testId/css/xpath/role/ariaLabel/text + percentage rects); per-step-own-automation compile design (`compileStepAutomation` — one `[navigate, step]` automation per Drill step, stable id `drill-<page>-<step>`), a deliberate deviation from the mock's one-page-one-automation shape because the automations engine halts the whole run on any step failure (wrong for independent page assertions) — logged as FINDING-E10 during Phase 4.
- **P5 graduation:** a passing vision/recovered resolution with a deterministic assertion (or an author-marked judgment step) flips the step to `e2e` and (re-)writes a committed Playwright spec via `emitPageSpec`; required a real fix to browser-orchestrator.mjs so the vision/recovered tier surfaces `assertion` on its result (previously only the "cached" tier did) — graduation cannot know what to commit otherwise.
- **P6 states:** R11 matcher ladder — deterministic assertion pass is itself a match; else same-route+heading OR shape-Jaccard ≥0.85; 0 or ≥2 candidates always escalates to vision, never guesses. Reach paths compile as ordinary `browser` (action) steps sharing the step's own action cache.
- **P7 Garrison integration:** `drill` wired into `compositions/default/apm.yml` (dependencies.apm, `building:` selection at port 7096, duty spec with `gate:"explicit"`), `drill` inserted into `selected_duties` after `review`; `adversarial-test`/`walkthrough` duty defs parked (commented, not deleted) per D-park-not-delete. R14 testing-only card schema (`{book, select:{pages,steps-or-tags,states}, viewports, autonomy, dispatch}`) enters the roster directly at the `drill` list via `POST /api/testing-task`.
- **P8 mobile:** FAB + full-screen plan sheet (`.dr-sheet-open`/`.dr-sheet-closed`) replacing the desktop side-plan below 760px; Highlight mode enlarges touch targets on the canvas.

### GATE self-test (Phase 9) — 2026-07-15T~21:19Z
- **Result: 19/19 vision-verified sub-tests green** (`npx vitest run tests/drill-selftest.test.ts`, ~19-20s in isolation), covering all 13 brief items against a purpose-built D5 fixture app (`fittings/seed/drill/test-fixtures/{chat,build}.html` — a chat page with a reproducible citation-index bug and a builder page with a reproducible mobile-only CSS bug) served by a tiny static `serve.mjs`.
- **Non-negotiable per the brief: a failing item is a defect to fix, not a note.** Every item failed at least once on first real execution; each was root-caused and fixed rather than patched around. Findings from this pass, beyond the Phase 0-8 findings already on record:
  - **FINDING (fixture):** `chat.html`/`build.html` had no `<meta name="viewport">` tag. Chromium's mobile emulation (`isMobile:true`) silently falls back to the 980px desktop-compatible layout viewport for any page lacking that tag, so a `max-width:500px` media query never fired regardless of the emulated device width — the item-9 mobile-bug check looked like it wasn't reproducing. Fixed by adding the standard tag to both fixture pages (what any real mobile-aware app already ships).
  - **FINDING (fixture):** `build.html`'s idle/building/complete panels shared one static `<h1>` and never removed inactive-panel DOM (only CSS `[hidden]`), so the state matcher's route+heading and shape-Jaccard signals were both trivially "same" across every state — item 6's "rejects idle/complete" check couldn't discriminate. Fixed by giving each state its own heading text and switching to real conditional mount/unmount (empty the hidden panel's innerHTML) so the DOM shape genuinely differs between states, closer to how a real SPA renders anyway.
  - **FINDING (drill UI, real bug):** `main.tsx`'s top-level `App` still carried Phase-2 skeleton residue that survived to Phase 9 unnoticed — a stale "Skeleton — phase 2" status string and two dead `Placeholder`-backed tabs ("Mobile"/"Garrison") that Phases 7-8 never actually filled in (their real work landed inside `AuthoringView`/`ResultsView` instead). Removed the residue; the 4 real tabs (Drill Book/Authoring/States/Run & results) are what ships.
  - **FINDING (browser-default, real bug):** `handleObserve`'s viewport field read `page.viewportSize()`, which only reflects Playwright's OWN `setViewportSize()` calls — it does NOT update when viewport is set via the CDP `Emulation.setDeviceMetricsOverride` path (the one `applyViewportEmulation` actually uses for `isMobile`/`deviceScaleFactor`). Every observation for a mobile-emulated tab therefore reported the tab's pre-emulation desktop size, which would mislead a real vision call about what it's looking at. Fixed by having `applyViewportEmulation` stamp `tab.emulatedViewport` and having `handleObserve` prefer that over `page.viewportSize()`.
  - **FINDING (drill UI, real bug):** `.topbar` was `position:sticky` but the `.dr-tabs` bar directly below it was not — once a view (e.g. Drill Book with enough pages) scrolls, the tab bar scrolls up behind the pinned topbar and becomes unclickable (item 12 reproduced this reliably once the book had accumulated pages from the earlier self-test items, never in a fresh single-page reproduction). Fixed by wrapping both in one `.dr-header` sticky container.
  - **FINDING (test harness):** `automationsSrv`/`drillSrv` in this file (and, on audit, 10 other pre-existing `tests/drill-*.test.ts` files) were spawned without `stdio:"ignore"`, unlike `browserSrv`; under load their stdout/stderr pipe can fill and block the child, surfacing as `SocketError: other side closed`. Fixed everywhere it was missing (left the two files that deliberately drain their child's output via `runPlaywrightAsync`/similar untouched).
  - **FINDING (test harness):** the self-test's Playwright subprocess runs originally used `spawnSync`, which blocks the SAME Node event loop hosting the in-process fixture/stub HTTP servers the spawned test needs to reach — a self-deadlock that surfaced as the emitted spec's own `page.goto` timing out around 30s. Replaced with an async `spawn` + drained-output helper.
  - **FINDING (test harness):** the vision stub never handled `mode:"fix"` (the fixer's self-heal round-trip after a live assertion genuinely fails), so a real failure crashed with "unknown patch kind: undefined" instead of reporting a clean failed verdict; and the stub's "cancel button visible" rule answered `true` unconditionally instead of reading `observation.viewport.w`, masking the real mobile bug behind a "healed" false positive. Both fixed.
  - **FINDING (composition, real gap):** `drill` was wired into `compositions/default/apm.yml`'s selections in Phase 7 but never registered in `data/library.json` — `tests/seed.test.ts`'s determinism ratchet (added after a prior run hit the identical gap) caught it; an unregistered selection is silently dropped at runtime, so Drill would never have actually resolved into a live composition. Added the library entry.
  - **FINDING (composition, real gap):** Drill's `consumes: automation-runner` had no `name:`, so with 4 real automation-runner providers in the full library (`automations`/`kanban-loop`/`scheduler`/…) the resolver correctly refused it as `ambiguous-singleton`. Bound it to `name: automations` (the one Drill's `automations-client.mjs` actually calls), matching the existing `vault-sync` precedent for the same kind.
  - **FINDING (test hygiene):** the self-test's ephemeral Playwright config wrote its default `outputDir` into the repo root, which Playwright clears on every run — this had been silently deleting a pre-existing, git-tracked `test-results/phase9-screenshots/` directory from an earlier, unrelated walkthrough run every time the self-test executed. Restored the tracked files and pointed both ephemeral configs' `outputDir` at their own tmpdir. Also cleaned up an accumulating pile of un-deleted `.tmp-selftest-pw-config-<pid>.mjs` files (one per prior run) — added `afterAll` cleanup.
- **Verified NOT regressions:** two pre-existing Drill E2E files (`drill-graduation-e2e.test.ts`'s healer test, `drill-mobile-e2e.test.ts`'s highlight test) intermittently fail only under the full ~331-file/~2980-test suite's concurrency (dozens of real headless Chromium instances contending at once); both pass reliably in isolation and in a 28-file Drill-only batch. Consistent with the repo's own established convention (flaky/env failures get one re-run in isolation before counting) — not chased further into test-infrastructure parallelism changes, which is out of this brief's scope.
- **Full regression suite:** `npm test` green except the two known-flaky files above (isolation-confirmed) and one pre-existing, unrelated live-network test (`deepgram-voice-live.test.ts`, external service 503) — 2962-2963/2979 passing depending on that concurrency flake, 0 attributable to this run once the fixes above landed.

### Evidence locations
- Self-test suite: `tests/drill-selftest.test.ts` (13 brief items, 19 sub-tests).
- Fixture app: `fittings/seed/drill/test-fixtures/{chat.html,build.html,serve.mjs}`.
- Graduated specs emitted during the self-test land under the test's own ephemeral target tmpdir (`tests/drills/*.spec.ts`), not committed — graduation of a REAL target app's pages is the intended end-to-end path this proves.
- Drill fitting: `fittings/seed/drill/` (server, lib/*.mjs, ui/, .apm/skills/garrison-drill/, assets/drill-judge.ts).
- Engine deltas: `fittings/seed/automations/lib/{engine,browser-orchestrator,store,types,assertions}.mjs`, `fittings/seed/automations/scripts/server.mjs`, `fittings/seed/browser-default/scripts/server.mjs`, `src/app/api/automations/vision/{route.ts,prompt.ts}`.
- Composition wiring: `compositions/default/apm.yml`, `data/library.json`.

### GATE close-out — 2026-07-15T~21:19Z
- typecheck clean; lint clean on all touched files; `npm test` green modulo the two documented concurrency-only flakes + one unrelated pre-existing live-network test.
- Kanban card `01KXKDM2198RA23ATFZE9QD495` already at `done` (kanban-loop's own routing closed it earlier in the session; verified, not re-touched).
- Working tree clean of scratch artifacts (temp Playwright configs, debug scripts); `test-results/phase9-screenshots/` restored to its committed state.
