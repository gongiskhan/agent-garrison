# Pro recovery and Cursor output flicker — 2026-09-18

The Pro's app was reachable but default was idle, its session observer absent, its deployed bundle still at `98a6d976`, and no running-composition startup receipt existed. The supported observer start restored availability, followed by a normal guarded full redeploy of the startup fixes already verified on the mini. All 39 fitting verifiers passed; all 14 views became healthy. Existing Pro test-results were preserved.

A separate guarded launchd restart at 21:11:48Z proved automatic recovery without a manual Run: the startup companion wrote a fresh receipt and logged restoration at 21:12:09Z. At 22.6 seconds of app uptime, default was running, all 14 views healthy and no degradation reported. A real public Madrid WebKit journey at 393×852 rendered a recovered Pro Codex transcript, opened a visible shell, verified harmless printf output, and removed its temporary shell/thread. No connection warning appeared. Madrid lists five current Pro sessions connected.

## Flicker diagnosis and correction

A real idle CSG Cursor transcript on Madrid showed ten replacements of unchanged markdown during an 18-second observation. Each refresh removed and reinserted 1,157 child nodes, including images. No new output frames arrived during those refreshes. Transcript height repeatedly fluctuated between 29,497 and 29,713 pixels.

The Next App Router's compiled React DOM writes innerHTML when its wrapper object changes, even when the HTML string is identical. The transcript created a new wrapper on each background rail refresh or scroll-related render. Replacing images caused visible relayout. Commit `0370c09b` retains the wrapper while the rendered HTML is unchanged, covering ordinary markdown, expanded long user prompts and completion summaries. Actual content revisions and host-map link changes still update normally. Manual scrolling behavior is unchanged: opening and Jump to bottom can move the view; later output does not enable following.

The browser fixture now uses Next's compiled React and React DOM to match production. The new regression fails on the previous implementation with both paragraph and image nodes detached, then passes with the fix and proves a real text revision still appears. All 68 transcript/browser/live-resume regressions pass, plus all four phone-scroll tests in WebKit. Typecheck and whitespace checks pass.

Owner evidence: the Pro directory named by `/tmp/garrison-pro-recovery-20260918.path` contains deployment and automatic restart receipts. Madrid owns `/tmp/garrison-pro-session-live-check-20260918-dev-madrid.tail31efa.ts.net.json` and `/tmp/garrison-cursor-flicker-baseline-20260918.json`. Deployment logs for the viewer change are under the directory named by `/tmp/garrison-cursor-flicker-deploy-20260918.path`. Browser evidence is not physical-iPhone acceptance.

## Live viewer verification

CSG's guarded automatic rollout deployed `0370c09b`. The same real idle Cursor transcript, now viewed through its public CSG origin in WebKit, had zero markdown DOM replacements over 18 seconds. The repeated height oscillation disappeared; a single late image layout change left scrollTop unchanged. The preserved comparison is `/tmp/garrison-cursor-flicker-csg-after-20260918.json` on Madrid. This observation uses the real stream, with no synthetic session frames or transcript writes.

Madrid and the Pro then completed normal guarded full redeploys of `0370c09b` in sequence. Final public health reports Madrid 14/14, CSG 9/9 and Pro 14/14 healthy, all running and not degraded. Madrid's restart temporarily left the CSG forwards unhealthy while CSG itself remained healthy; the supported tether repair endpoint restored both forwards and the reverse leg. Final tether checks and public CSG probes pass. No CSG session or service was restarted for that transport repair.

After deployment, the real CSG transcript viewed through Madrid and the real mini Cursor transcript viewed through Pro both show zero markdown DOM mutations and zero reading-position/height changes across the observation window. The public-origin manual-scroll fixture also passes on both: opening lands at the bottom, later output and reading older output preserve position, and pressing Jump to bottom does not enable following. After the last append, both retain scrollTop 8232 with 799px of unread output below. This fixture supplies synthetic frames only inside its browser; the separate flicker measurements use real streams.

The recovered Pro transcript/shell journey passed again after the final viewer deployments, with actual command output, no connection warnings and test-owned artifacts removed. All five nodes received the committed source through Git; this rollout rebuilt the Madrid, CSG and Pro runtimes. Mini's four unrelated tracked edits remain byte-identical and its untracked files are preserved. Mini/Air app bundles were not rebuilt by this follow-up.
