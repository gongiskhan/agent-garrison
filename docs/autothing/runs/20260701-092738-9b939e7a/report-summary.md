# autothing run 20260701-092738-9b939e7a — periodic ecosystem-update mechanism

**Status: completed-with-blockers** (2/2 slices passed; blockers are external Codex-sandbox limits, not product defects)

Built a periodic ecosystem-update mechanism for Garrison's `improver` Fitting, addressing the
original ask: check whether Improver's nightly job works, and use it as the home for re-applying
tracked skill improvements after an update overwrites them.

**Premise confirmed:** the nightly cron (`improver-nightly`, `30 3 * * *`) is genuinely registered
and fires every night, but has crashed in an unrelated LLM "dream" phase bug (`claude-pty`) before
writing anything, for 6+ consecutive nights. Logged as a separate deferred bug, not fixed here.

**What shipped (both inside `fittings/seed/improver/`, zero Garrison-core changes):**
- Slice A — `lib/ecosystem-update.mjs` + `lib/reapply-sweep.mjs`, wired to run before the crashing
  dream phase so they succeed every night regardless of that bug.
- Slice B — the improver review UI (`:7088`) gained a new "Ecosystem" tab and a 4th proposal
  status (`reapply-failed`) with a safe dismiss action that never corrupts rule autonomy.

**Verification:** 79 tests, typecheck/lint clean, 2 same-model review passes (real fixes applied),
2 rounds of cross-model Codex review per slice (clean approve after fixing one real bug each: a
queue-clobber risk, an autonomy-corruption risk), 2 vision-verified evidence videos.

**Blockers:** Codex's own independent dynamic test pass (`codexPwTest`) hit external sandbox limits
on this machine for both slices — its filesystem sandbox blocked writing outside
`[workdir, /tmp, $TMPDIR]` for the CLI test, and no browser engine (Chromium/Firefox/WebKit) could
launch for the UI test. Not product defects — Codex's *static* review passed clean on both.
Substituted independent verification for both (a real CLI run outside Codex's sandbox; a real
claude-in-chrome browser session), both confirmed working with zero errors, plus the vision-gated
walkthrough videos.

**Evidence gallery:** http://100.108.210.116:8099/agent-garrison/improver/
- CLI evidence: http://100.108.210.116:8099/agent-garrison/improver/2026-07-01_12-09-50/final.mp4
- UI evidence: http://100.108.210.116:8099/agent-garrison/improver/2026-07-01_12-16-36/final.mp4
