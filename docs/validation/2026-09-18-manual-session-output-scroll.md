# Manual session output scrolling — 2026-09-18

The user reported that reading session output on a phone repeatedly pulled the view down. They requested scrolling to the bottom only when opening the output and when pressing Jump to bottom.

## Change

Commit `bedf7118` removes continuous frame-by-frame following and the resize-triggered bottom snap from the shared SessionStream renderer. The viewer lands at the first visible content once per opened session. Scroll and layout observers only update Jump to bottom visibility; pressing it performs one jump. New output never enables following, including after pressing the button. Search-result navigation keeps its explicit landing.

Reconnects retain the same session's rendered content and never re-arm its initial scroll. A URL change waits for the new session's own events before the initial jump, avoiding a jump against the old session's layout. A reader already scrolling before content arrives keeps control.

## Verification

- 67 tests pass: 26 browser transcript cases, 23 session-event cases, and 18 live-resume cases. Three new phone-scroll cases cover new output, touch activation, late layout growth, reconnects, opening another session, and explicit search landing.
- The three new cases also pass in WebKit with a mobile viewport and touch enabled. Typecheck and whitespace checks pass.
- A public HTTPS 393×852 WebKit check reproduced the original issue on Madrid's old deployment: the initial bottom landing worked, but new output moved the reader.
- After CSG deployed, the same public-origin journey passed: initial bottom landing, stable reading after new output and while scrolled up, working Jump to bottom, and no following after the jump. The final appended turn left scrollTop unchanged and created a 799px gap below the viewport.

The public check injects only synthetic EventSource frames inside its own browser. It creates no actual sessions, sends no agent messages and edits no journals. It exercises the deployed UI and CSS. This is browser evidence, not a claim of a physical iPhone run.

Owner-local deployment and browser receipts are under the directory named by `/tmp/garrison-manual-output-scroll-20260918.path` on Madrid. Code moved through origin/main to all five nodes. Mini's four pre-existing tracked edits were preserved byte-for-byte. Its stale empty Git index lock, dated September 17, had no lsof owner or Git process; it and an index backup were preserved on the mini under `/var/folders/2g/q17sw47d5m5cfm_sybhjrb140000gn/T/garrison-scroll-git-recovery-20260918-07d0hr3z` before the fast-forward. Pro's existing test-results directory was preserved.

Madrid's updated public deployment also passes the same WebKit journey: the view lands at the bottom on load, preserves the older reading position during new output, and the jump button does not enable following. After another appended turn, scrollTop remains 8312 with 799px of unread output below. Both public receipts are in the owner evidence directory; the pre-deployment failure is retained as `baseline-dev-madrid.json`.

Deployment scope: CSG and Madrid received normal guarded full redeploys in sequence. Pro, Air and Mini received the committed source through Git; this task does not claim their running app bundles were rebuilt. The mini's unrelated tracked work remains untouched.

Madrid's guarded redeploy exited successfully. Its composition has run since 11:12:43Z, all 39 fitting verifiers passed, and the public health check at 11:13:19Z reports 14/14 healthy views with no degradation.
