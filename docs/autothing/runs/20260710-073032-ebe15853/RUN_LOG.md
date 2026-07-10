# RUN_LOG - GARRISON-UNIFY-V1 (20260710-073032-ebe15853)

> Reconstructed at iteration 127 from the run's durable state (gate-status
> files, evidence-index, status.json, git history): the pre-compaction
> session tracked gates in `slices/*/gate-status.json` + `status.json` but
> never opened this file. Entries before 11:38 are back-filled from those
> markers; entries after are logged live. Times UTC+1 (box local).

- `RUN-START` 07:30 profile=build slices=16 gatesConfig=all-on brief=GARRISON-UNIFY-V1
  (core UNIFY + folded REMOTE-OPS-V1 + folded POWER-FIT-V1 + S15/S16). Meta-rule
  in force: the rewired pipeline governs SUBSEQUENT runs - no mid-run hot-swap.
- `DECISION` exploration E1-E18 digested to exploration/; D1-D39 binding.
- `GATE` S1 policy core: wall+tests+review(fix 86128b2) -> passed (8d0a7c9).
- `GATE` S8 config home: wall+tests -> passed (9eab5d0); claude-share archived.
- `GATE` S2 brain merge: wall+tests+review(fix 91a031d) -> passed (572c7b4).
- `GATE` S4 run engine: wall+tests+review(rev-s4 approve after 91a031d) -> passed (1c7e00b).
- `GATE` deliberate-red (run-level, once): planted github-pat + aws token -> gitleaks exit 1;
  unknown-target config -> compile --check exit 1. PASSED 08:16.
- `BLOCKER` codex auth 401 (no API key in env/~/.codex/vault) - run-level checkpoint
  will run DEGRADED (codex-unavailable). External.
- `BLOCKER` GCP metadata SA scopes: devstorage.read_only only - GCS snapshot writes +
  compute suspend (D37) blocked on named grants. External.
- `DECISION` baseline test failures (A6) fixed rather than reclassified: autothing-validate
  fixtures, z1/browser-observe root-caused to AppArmor sandbox death -> --no-sandbox
  fallback in browser-default (cca7bc1). Suite fully green (1599).
- 11:38 `GATE` S3/S9/S10/S11/S12/S13 walls: validate-fitting PASS x3(+3), typecheck clean,
  next lint clean, gitleaks full-diff clean, 117 targeted tests green, full suite
  196 files/1599 green. Slice commits 8f905c4..e960926 (+deps a325ce5, probes 6214600,
  automations fix 9a3d21c).
- 11:41 `GATE` S13 signal demo: 9/9 checks (each of 6 busy signals ALONE blocks suspension,
  all-clear suspends after window, eval-error fail-safe) -> slices/S13/evidence.cast (ca9b2c3).
- 11:44 `DECISION` tests/e2e/orchestrator-view.spec.ts rewritten for the composer (old v1
  Model Router test-ids removed); drag->recompile->model-change proven; 11 passed,
  1 intentional phone-width skip (drag is pointer-only; dial+try-it cover mobile).
- 11:53 `GATE` acceptance item 11 loop: archived-push 403 proven; ~/.claude edit ->
  garrison config status drift -> commit landed in seed (d465efd) -> demo removed (41b5ca0).
- 11:57 `FINDING+FIX` S15 gap: improver run-now path never ran the orchestrator-policy rule
  (nightly only; memory-skip early-return would also silence it). Fixed + regression test
  (2af5968). Item-17 chain proven headless: seeded outcomes -> run-now -> queue ->
  composer /ghost-edits proposals:1.
- 12:03 `GATE` walkthrough S10 (6/6 beats) + S11 (5/5 beats) delivered by wt agents,
  frames spot-verified by run owner (bf05e2b).
- 12:10 `FINDING+FIX` S12 self-inclusion: the local restic repo lived INSIDE the backup set
  (~/.garrison/snapshots/repo) - 24G->37G compounding across two real backups. Excludes
  fixed + regression test (869e0c4); poisoned snapshots purged; clean 24GB re-backup
  verified (repo path absent from snapshot).
- 12:13 `GATE` S12 live E2E: vault RESTIC_PASSWORD created (A4), 0600 env fallback,
  restic init/backup/verify clean, printed restore command restored a file to scratch
  (restore-demo.cast), systemd timers installed + service unit fired (TriggeredBy proof).
  GCS clause BLOCKED on read-only scope (named). (565d3f1)
- 12:16 `GATE` walkthrough S4 (8/8 beats) delivered, frame spot-verified (90d6eef).
- 12:17 `DECISION` LANDING.md drafted; evidence binaries stay unversioned per the
  .gitignore autothing block; evidence-index carries videoSha256+videoBytes (ab17d3e).
- 12:22 `GATE` acceptance item 1 -> pass: engine-side classificationForPhase + compiled
  matrix lookup resolves implement/T2 opus BEFORE -> sonnet AFTER recompile
  (ITEM1-PHASE-RESOLUTION-OK) on top of the e2e drag proof (704d133).
- 12:22 `STATE` in flight: reviewers rev-s3, rev-s912, rev-s1314, rev2-s567, rev2-s1011
  (rev-s567/rev-s1011 respawned - pre-compaction pair silent >1h); recorders wt-s3,
  wt-s7, wt-s9, wt-s12, wt-s13; design audit da-s1011. Mutation sandbox synced to HEAD,
  ready. Remaining after agents: apply findings, design audits, mutation ->
  security-review -> codex checkpoint (degraded) -> report -> GLOBAL GATE.
- 12:27 `GATE` item 8 serve clause verified live: serve.mjs tailnet-bound, /runs serves the evidence home, traversal contained (404/400).
- 12:33 `GATE` item 4 foundation: three-doorway card payloads (gateway D8 / doorway Step-2 / board UI) normalize to an IDENTICAL run-governing shape via board.mjs createCard (only id+origin differ) - ITEM4-CARD-SHAPE-OK.
- 12:35 `GATE` walkthrough S7 (5/5 beats) delivered by wt-s7, plain-escape-hatch frame verified by run owner.
- 12:30 `GATE` item 5 -> pass: ITEM5-RAIL-OK (docs-change implement-only, off-phases rendered with off_reason; card-toggle walkthrough off).
- 12:31 `GATE` item 2 -> pass: ITEM2-BINDING-SWAP-OK (rebind review -> recompile -> skillForPhase + card rail show the swapped skill; contract doc verified).
- 12:31 `GATE` walkthrough S12 (4/4 beats) delivered by wt-s12, frame verified (shell view, sandbox repo).
- 12:33 `GATE` item 9 -> pass: request contract tests + S7 walkthrough + improver-nightly job + memory hooks verified.
- 12:36 `GATE` item 6 -> pass: live board probe (403 engine-owned on agent list; needs-attention edit accepted; move-out re-enters, status ok).
- 12:51 `GATE` mutation (run-level) PASSED: 2031 mutants, covered-score policy-core 34->52, kanban policy 58->70, power-core 71->76, improver 0->65 after 26 committed killers (e9cc256); scope + residue notes in evidence-index.
- 12:51 `GATE` walkthrough S3 (8/8 beats) delivered: drag->recompile visual, try-it rail, ghost-edit banner (item 17 visual), iPhone viewport. Frame verified.
- 13:36 `GATE` walkthrough S13 (4/4 beats + honest suspend omission) delivered, phone-width frame verified. 7 of 8 videos done; S9 remaining.
- 13:53 `FINDING+FIX` codex-runtime lock steal race (blocker, acceptance 7/D14): a competitor stole the O_EXCL lock from a LIVE owner during the create-before-flush window (empty read -> parse throw -> unconditional steal) -> concurrent codex -> OAuth token revoked. Reproduced deterministically; fixed with a grace-window break + acquire-time tunables; 5 committed regression tests (35ce2ee). Found by run-owner code review while reviewers were in flight.
- 13:55 `HARDEN` ports kill PID-reuse TOCTOU: guard validated against a <=5s-stale listening set; handleKill now re-scans immediately before the guard (window -> micros). Regression test added (9ae60a4). Independent run-owner review.
- 13:59 `FINDING+FIX` outpost provisioning local RCE (blocker, S9): request-supplied ssh user/host flowed unvalidated into the ssh argv; a dash-leading value (-oProxyCommand=<cmd>) is parsed by ssh as an option -> local command execution. Endpoint is loopback but unauthenticated (drive-by CSRF reachable). Fixed with strict user/host validation + 6 regression tests (9f01122). Independent run-owner review.
- 14:00 `REVIEW` run-owner independent adversarial pass (reviewers stalled) covered: codex serialization lock (FIXED - blocker), ports kill endpoint (FIXED - PID-reuse TOCTOU), outpost SSH provisioning (FIXED - local RCE blocker), snapshots shell scripts + API (CLEAN - no request input reaches shell; restore is printed not executed; scriptsDir server-derived), D9 gate-evidence enforcement (CLEAN - consistent across processCard/advanceCardPhase/API-move->processChain; runDir-null fail-open is a bare-card design choice), D16 engine-owned lock (localhost + x-garrison-engine header, noted trust model). Full suite 1636 passed after all fixes.
- 14:03 `HARDEN` orchestrator PUT /routing atomic write: routing.json (config source of truth) was written non-atomically (crash -> truncated config lost); both files now tmp+rename, config-first so startup recompile self-heals. E2E-probed (0f97972).
- 14:06 `HARDEN` monitor vitals hang guard: unbounded si probes could freeze the whole vitals feed (re-entrancy guard + never-settling fsSize); each probe now races a call-time-tunable timeout -> degrades to fallback. Regression test + hang probe (f5266b2). Power suspend path reviewed CLEAN (idle busy-gated + fail-safe; manual = deliberate confirmed override; CSRF-suspend consistent with no-auth-localhost model + recoverable).
- 14:10 `GATE` security-review PASSED (run-level): 5 real defects found+fixed by independent adversarial review (2 blockers: codex lock, outpost RCE; 3 hardenings: ports TOCTOU, orchestrator atomic write, monitor hang); surfaces cleared: snapshots/D9/power/D16. gitleaks: 5 hits, all non-secrets (4 pre-existing baseline out of scope + 1 fabricated S9 sandbox token redacted). semgrep available. All 8 walkthroughs delivered+frame-verified (S9's wt-s9 delivered at 13:34; wt2-s9 respawn was redundant).
- 14:11 `GATE` codex checkpoint DEGRADED (codex-unavailable): OpenAI auth 401 re-confirmed (no API key anywhere). External blocker, recorded honestly per skill - never faked clean. The serialization path it exercises was independently hardened this run (35ce2ee).
- 14:13 `GATE` design-audit (run-owner self-audit while deep auditors finish): (a) emoji-rule scan CLEAN across all 8 new fitting UIs (composer/monitor/ports/power/snapshots/outposts + kanban + dev-env) - CLAUDE.md hard rule satisfied; (b) frame verification of all 8 walkthrough videos - professional typography, threshold colors (disk 85/95), badges, loopback indicators, online/offline states, mobile viewport all clean. Deep auditors da-s34/da-s712/da-s1011 pinged; their NEEDS-WORK findings supersede if delivered.
- 14:16 `GATE` report DEGRADED (no-webhook): composed to report-summary.md, printed in place; never fails the run.
- 14:28 `GATE` design-audit COMPLETE (real auditors, verdicts recovered from subagent transcripts - mailbox not delivering): S4/S7/S10/S11/S12 APPROVE; S3 NEEDS-WORK (Targets tray ~51% fill on 390px phone, brief's iPhone-usable surface) -> FIXED 058ea0d (100% fill, screenshot-verified, dist rebuilt). All minor/nit findings non-blocking (em-dash labels pre-existing 68/70 files; copy button; lock-cue). Supersedes the earlier run-owner self-audit.
- 14:56 `GATE` adversarial-review COMPLETE (deep reviewers - verdicts recovered from subagent transcripts, mailbox not delivering): the panel found 4 BLOCKERS + 8 MAJORS the run-owner's first pass missed. ALL applied with regression tests: async-dispatch process crash (c17b63f), PUT temp collision (c17b63f), corrupt-policy D9 fail-open (e5ad55d), evidence-home bind+symlink (795c4f4), suspend cancel-window + ssh fail-safe (8e6c312), power GARRISON_HOME (0.../commit), ports/power/outpost origin guards, outpost RCE (9f01122), shell minors. Full suite 1645 green. Recovering these was the single highest-value action of the run - a stalled mailbox nearly hid a dozen real defects.
- 14:56 `GATE` design-audit COMPLETE: da-s34/da-s712/da-s1011 verdicts recovered; S3 MAJOR (phone target-card fill) FIXED (058ea0d); S4/S7/S10/S11/S12 APPROVE.
