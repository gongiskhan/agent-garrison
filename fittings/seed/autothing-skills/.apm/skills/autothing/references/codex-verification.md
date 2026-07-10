# Cross-model verification (Codex) — the cross-model gates

> **SUPERSEDED for cross-model duty (2026-07-06).** This file documents the OLD per-slice design: a cheap Codex pass (3A review + 3B Playwright test) on every slice diff. That design is retired — `autothing-adversarial-review` and `autothing-adversarial-test` are now fresh-context ANTHROPIC gates (no Codex call at all; decorrelation by context, not vendor). The genuine cross-model check now lives in **`autothing-codex-checkpoint`** — a small number of high-effort, narrowly-scoped Codex passes run ONCE, in the final phase, over security-critical surfaces — with its own operational reference at `~/.claude/skills/autothing-codex-checkpoint/references/codex-checkpoint.md`. This file is retained for history/decision context (see `references/decisions.md`, 2026-07-06 entry) — do not follow it for current behavior.

> These two sub-gates were each a STANDALONE skill that autothing orchestrated and that also ran on its own: **3A → `autothing-adversarial-review`**, **3B → `autothing-adversarial-test`**. This file was the shared operational reference both carried; the hard rules below (serial calls, `</dev/null`, preflight/auth) are unchanged as *general Codex CLI facts* and were carried forward into the new reference.

A **second model** (OpenAI Codex, via the local `codex` CLI) independently checks each slice after Claude's own correctness gate (`autothing-test`) and same-model review (`autothing-review`) are green, BEFORE the design audit and the walkthrough video. Two sub-gates, run in this order:

- **3A — Adversarial review loop:** Codex reviews the slice diff trying to break it; Claude fixes real findings and re-reviews; **iterate until both models agree the slice is good** (Codex returns `approve` AND Claude's objective gates are green).
- **3B — Independent Playwright test pass:** Codex drives the *running* app through the slice acceptance with its own `playwright` skill (playwright-cli) — a fresh functional pass that never saw Claude's committed test, so it catches "the code and its test share the same wrong assumption."

The point is genuine cross-model agreement: one model writes + tests, a different model adversarially reviews + re-drives. A slice is correctness-done only when **both** agree.

## Why the CLI, not `/codex:adversarial-review`
The `codex` plugin's slash commands are `disable-model-invocation: true` — a skill running autonomously **cannot** trigger them. autothing therefore drives `codex exec` directly (self-contained, no dependency on the plugin's `${CLAUDE_PLUGIN_ROOT}`). The plugin is still useful to the operator interactively; autothing just doesn't route through it.

## SERIALIZE every Codex call — hard rule (empirically required)
Codex uses one shared ChatGPT OAuth token. **Two `codex exec` processes running at the same time rotate and REVOKE that refresh token** ("your refresh token was revoked. Please log out and sign in again") — which then kills the gate for the rest of the run. So:
- Never run 3A and 3B concurrently; never run two slices' Codex calls concurrently.
- When slices are parallelized (agent teams / workflows), the Codex gate is **not** parallel: funnel all Codex calls through one serialized step, exactly like the shared dev-serve / bundle / `walkthrough` recorder (see the parallelism section of `build-loop.md` and the `autothing-parallel-work` skill). One Codex call in flight at a time, run-wide.

## Always redirect Codex stdin from /dev/null — hard rule (empirically required)
`codex exec` reads stdin when it is not a TTY. In any non-interactive / piped context (a skill's Bash call, a background task) it will otherwise **block forever on "Reading additional input from stdin..."**. Every invocation below ends with `</dev/null`. Capture the structured result via `--output-last-message <file>` and read that file — do NOT pipe Codex stdout into `tail`/`head` (the pipe re-triggers the stdin-read hang and can truncate the JSONL).

## Keep each Codex call FOCUSED — hard rule (empirically required)
Scope every prompt to the slice's own diff and acceptance. Do NOT paste broad multi-file or whole-directory context (e.g. a `src/lib` dump) into a Codex prompt: an unfocused review listing many files empirically spun `codex exec` into a runaway — 50+ live processes, 14+ minutes, zero output — and had to be killed, while a focused single-concern prompt over just the diff completes reliably in ~30s. The 3A/3B recipes below already scope to `git diff <BASE>...HEAD` and one slice's acceptance; keep them that way. If a review genuinely needs more than the diff, add the few specific files by path — never a directory tree.

## Pin model + reasoning effort on EVERY call — hard rule (cost-aware, escalate on risk)
An **unpinned** `codex exec` inherits the account/CLI default model + reasoning effort, which can silently run a heavy model at xhigh — empirically the dominant token-burn multiplier (a focused diff review at default effort observed ~765k tokens/turn). So pin `-m` and `-c model_reasoning_effort=` on every real 3A/3B call; defaults are deliberately cheap, escalate only on the triggers below, and only for the call(s) that need it.

- **3A review — default `-m gpt-5.4 -c model_reasoning_effort=low`.** Escalate that round (and the slice's subsequent rounds) to `-c model_reasoning_effort=medium` if ANY of:
  - the low pass surfaced a **plausible material** finding (re-run the round at medium to confirm/deepen before acting on it);
  - the slice touches **auth / tenant-isolation / data / security / payments / migrations** (escalate from round 1);
  - the first review output was **low-confidence** or failed schema validation / came back unparseable.
  Never escalate the *model* for 3A — `gpt-5.4` is sufficient for diff review; the cross-model value is model *diversity*, not horsepower.
- **3B test — default `-m gpt-5.4 -c model_reasoning_effort=medium`.** Escalate to `-m gpt-5.5 -c model_reasoning_effort=xhigh` ONLY if the test **repeatedly fails for unclear reasons** (env/flaky already excluded — ≥2 unclear fails on the same slice) or the slice is **high-risk** (the same risk list). Browser drives are the most expensive gate; never run them at xhigh by default.

Record the model + effort actually used in the slice gate-status (`codexReview.by`/`.effort`, `codexPwTest.by`/`.effort`) so cost is auditable per slice.

### Required pre-call log line (print in the lead context, BEFORE each codex call)
Surfaces what each call will cost — model, effort, gate, round, diff size — at a glance:
```bash
DIFFSTAT="$(git --no-pager diff <BASE>...HEAD --shortstat 2>/dev/null | sed 's/^[[:space:]]*//')"
echo "CODEX CALL: gate=<3A-review|3B-pwtest> model=<gpt-5.4|gpt-5.5> effort=<low|medium|xhigh> round=<n> diff=[${DIFFSTAT:-no committed diff}]"
```
This line is informational (NOT a gate verdict — the `GATE …` verdict lines below are unchanged), and like every gate line it MUST print in the lead context, never from inside a workflow agent.

## Preflight — once per run (do it in Phase 1, re-check on first use)
```bash
codex --version            # present?
codex login status         # must print "Logged in ..."
```
- **Missing binary** → self-unblock per the standard rule: `npm i -g @openai/codex`, then re-check. Only a FAILED install is a blocker.
- **Not logged in / token revoked** → this needs operator credentials (`codex login` is interactive / opens a browser); a skill cannot do it. This is a **legitimate external blocker for the cross-model gate** — and `codex login status` can falsely report "Logged in" while `codex exec` still 401s, so confirm with a trivial serial `codex exec -m gpt-5.4 -c model_reasoning_effort=low 'reply OK'` during preflight (also confirms the pinned default model is reachable on this account). If exec genuinely fails, log a blocker in `docs/decisions.md` naming the exact failed command (`codex login` / the 401), mark affected slices accordingly, and let the global gate fall to `completed-with-blockers`. **Never silently skip the cross-model gate and report a slice `passed`** — a missing second opinion is an unmet gate, not a clean pass.

## 3A — Adversarial review loop (read-only)
Capture the slice's base commit BEFORE editing the slice (`BASE=$(git rev-parse HEAD)`), so the review sees exactly the slice's changes.

### Scale the iteration to the change size — FIRST set the round budget (avoid weak-model churn)
3A runs cheap by default (`gpt-5.4` / `low` effort). A weak, low-effort adversarial pass *will* surface low-value findings, so cap how many times a slice goes back-and-forth by how big the change actually is. Measure from the same `<BASE>...HEAD` shortstat — `lines = insertions + deletions`, plus files touched — and fix the round budget BEFORE the first call:

| bucket | size (heuristic) | 3A round budget (max) |
| --- | --- | --- |
| **very small** | `< 10` lines changed AND `≤ 1` file | **0 — skip 3A entirely.** Record `verdict: skipped`, `reason: size`. Counts as approved for `crossModel.reviewAllApproved` (a deliberate, recorded policy choice — NOT an unmet gate). |
| **small** | `< 60` lines changed AND `≤ 3` files | **1 round.** Review once, apply only the findings Claude agrees with, then stop — do NOT loop for a re-review. |
| **substantial** | anything larger | **2 rounds.** Review → fix → re-review once. |

- **High-risk overrides size — never skip, never collapse to 1.** If the slice touches the high-risk list (the same one the effort policy uses — **auth / tenant-isolation / data / security / payments / migrations**, schema migrations included), treat it as **substantial regardless of line count** (2 rounds, and escalate effort to `medium` per the effort policy). A 4-line change to an auth check is not "very small."
- **When unsure, round UP** to the larger bucket (more scrutiny). The buckets are heuristics — bump a slice up by judgment, never down.
- A "round" is review → fix → re-review. An **effort-escalation re-run over the *unchanged* diff** (low → medium to confirm a finding before acting) is part of the same round and does NOT consume the budget; only a review that follows a fix consumes one.
- These caps bound the 3A *review iteration* only. They do not change 3B (the independent functional test still runs) and never lower the slice's own objective gates — a real material bug is fixed even when the round budget is spent (see the ceiling below).

Each round below (skip the whole block for a very-small slice):

```bash
# Effort per the policy above: low default; medium if a material finding / high-risk slice / low-confidence first pass.
EFFORT=low   # -> medium on escalation (keep the model gpt-5.4 for 3A)
DIFFSTAT="$(git --no-pager diff <BASE>...HEAD --shortstat 2>/dev/null | sed 's/^[[:space:]]*//')"
echo "CODEX CALL: gate=3A-review model=gpt-5.4 effort=${EFFORT} round=<round> diff=[${DIFFSTAT:-no committed diff}]"
codex exec -s read-only -m gpt-5.4 -c model_reasoning_effort="${EFFORT}" \
  --skip-git-repo-check -C "<projectDir>" \
  --output-schema "<autothingAssets>/codex-review.schema.json" \
  --output-last-message "<runDir>/codex-review-<slice>-r<round>.json" \
  "You are doing an ADVERSARIAL review of slice '<slice>'. Inspect ONLY its changes:
   run \`git --no-pager diff <BASE>...HEAD\` and \`git --no-pager diff\` (uncommitted).
   Slice acceptance: <acceptance>.
   Find the strongest MATERIAL reasons this should not ship (auth/tenant isolation, data loss,
   rollback/idempotency, races, empty/null/timeout paths, schema/version skew, observability gaps).
   Return ONLY JSON matching the schema. verdict=approve only if you cannot support any material,
   defensible finding from the diff; otherwise needs-attention with grounded findings." </dev/null
```
Then read the JSON (`verdict`, `findings[]`):
- **Environment-blocked (not a product finding)** → if the report shows Codex could not READ the diff/files (e.g. a "finding" like *"cannot read files under read-only sandbox"*) rather than a defect in the code, treat it as a transient flake, NOT a `needs-attention`: retry the identical call ONCE. An immediate identical retry has been seen to read fine. Only if it recurs do you treat the output as a genuine result (and if it is a real permissions issue, fix the invocation — `-s read-only` must still allow reading the workspace). An env flake must never be counted as a finding or as an `approve`. (Same principle as 3B's flaky/env re-run.)
- **`approve`** → 3A passes. Both models agree.
- **`needs-attention`** → **Claude is the deciding authority; Codex findings are advisory inputs, not directives to apply.** A low-effort `gpt-5.4` pass will surface nitpicks, style/preference calls, speculative "could-maybe" risks, and findings that are simply wrong — on a weaker model these are the majority. Triage each finding on its own merits and apply NOTHING Claude is not independently convinced of:
  - **Claude independently agrees it is a real, material defect that should block this slice** → fix forward, re-run the objective gates (these fixes consume the slice's 5-attempt ceiling from step 2), then re-review IF the size budget still has a round.
  - **Anything Claude does not agree with** — false positive, nitpick, style/preference, speculative, out-of-scope for this slice, or correct-but-immaterial → do NOT apply it. Write a one-line rebuttal (file:line + why) and move on. The burden is on the finding to convince Claude, never on Claude to disprove the finding; never apply a change just because Codex recommended it.
- **Loop ceiling = the size bucket's round budget (0 / 1 / 2 above), not a flat 3.** Re-review after a fix only while a round remains. When the budget is spent, land the verdict on the *state of the findings* (check in this order):
  - **Any finding Claude agrees is real-and-material is still unfixed** → the slice is NOT correctness-done; treat like a failing gate (keep fixing within the slice's own 5-attempt ceiling, or `blocked` only via the genuine-external-blocker path). The size cap limits review *rounds*, not the duty to fix a real defect — a genuine material bug is never waved through because the budget ran out.
  - **Else, open findings remain but every one is a Claude rebuttal** (disagreed-with, not applied) → **appeal valve**: record the per-finding rebuttals in `docs/decisions.md` and in `gate-status.codexReview.overrides`, set verdict `approve-with-override`. Logged and visible; NOT a silent override, NOT a clean `approve`, and keeps the global gate out of `passed`.
  - **Else, no open findings** — Codex returned `approve`, OR every finding Claude agreed with was fixed (objective gates green) with none rebutted, OR the slice was size-`skipped` → clean `approve`. On a small (1-round) slice this clean `approve` is Claude-declared after the single round rather than a fresh Codex re-confirmation — the deliberate trade for not looping a weak model on a small change.

## 3B — Independent Playwright test pass (functional)
The dev server is already up from step 1 (testing skill, known port). Codex drives the live app itself:

```bash
# Default gpt-5.4 / medium; escalate to gpt-5.5 / xhigh ONLY on repeated unclear fails or a high-risk slice (policy above).
MODEL=gpt-5.4 ; EFFORT=medium   # -> MODEL=gpt-5.5 EFFORT=xhigh on escalation
DIFFSTAT="$(git --no-pager diff <BASE>...HEAD --shortstat 2>/dev/null | sed 's/^[[:space:]]*//')"
echo "CODEX CALL: gate=3B-pwtest model=${MODEL} effort=${EFFORT} round=<attempt> diff=[${DIFFSTAT:-no committed diff}]"
codex exec -s workspace-write -c sandbox_workspace_write.network_access=true \
  -m "${MODEL}" -c model_reasoning_effort="${EFFORT}" \
  --skip-git-repo-check -C "<projectDir>" \
  --output-schema "<autothingAssets>/codex-pwtest.schema.json" \
  --output-last-message "<runDir>/codex-pwtest-<slice>.json" \
  "Use your playwright skill (the playwright-cli wrapper) to INDEPENDENTLY test the running app
   at <devUrl> for slice '<slice>'. Acceptance: <acceptance>.
   Open the page, snapshot for refs, exercise the flow (click/fill/navigate), re-snapshot, and
   ASSERT the acceptance actually held. Watch for console errors. Return ONLY JSON per schema:
   result=pass only if every acceptance assertion held with no console error, else fail with what you saw." </dev/null
```
- Browser automation needs localhost network + a browser process. The flags above (workspace-write + `network_access=true`) are the principled choice on this trusted solo machine. If the browser cannot reach localhost in your environment, escalate that one call to `-s danger-full-access` (still non-interactive). Validate this at first real use.
- Read the JSON (`result`, `failures[]`):
  - **`pass`** → 3B passes.
  - **`fail`** with a real defect → fix forward, re-run Claude's objective gates AND re-run 3B (consumes the slice ceiling). A flaky/env failure (not a product defect) is re-run, not counted as a fix-attempt.

## What "both models agree" means
3A `approve` (or `approve-with-override`, or a size-`skipped` very-small slice) AND 3B `pass` AND Claude's own step-2 gates green. Only then does the slice advance to the design audit. A slice that reaches the global gate on an `approve-with-override` is recorded honestly and keeps the global gate out of clean `passed` (like a `flagged` video does) — it forces `completed-with-blockers` unless later resolved to a true `approve`.

## Durable record (add to the slice's gate-status.json — schema in assets/gate-status.example.json)
```jsonc
"codexReview": {
  "verdict": "approve",            // approve | approve-with-override | needs-attention | skipped
  "rounds": 2,                     // review rounds run, size-scaled: 0 (very-small, skipped) | 1 (small) | 2 (substantial / high-risk)
  "reason": "size",               // ONLY when verdict is "skipped" (very-small change, deliberately not cross-model reviewed)
  "by": "codex/gpt-5.4",          // actual model used (gpt-5.5 only if escalated); omit/"—" when skipped
  "effort": "low",                // low default; "medium" if escalated
  "at": "<iso>",
  "lastReport": "<runDir>/slices/<slice>/codex-review-<slice>-r2.json",
  "overrides": []                  // per-finding rebuttals when verdict is approve-with-override
},
"codexPwTest": {
  "result": "pass",               // pass | fail
  "by": "codex/gpt-5.4",          // actual model used (gpt-5.5 only if escalated)
  "effort": "medium",             // medium default; "xhigh" if escalated
  "at": "<iso>",
  "report": "<runDir>/slices/<slice>/codex-pwtest-<slice>.json"
}
```
And in `evidence-index.json` `globalGate`, add `crossModel: { reviewAllApproved: <bool>, pwTestAllPassed: <bool> }`.

## Printed lines (the transcript-only /goal evaluator can only confirm what is printed)
BEFORE each Codex call, print the `CODEX CALL: gate=… model=… effort=… round=… diff=[…]` line (see "Required pre-call log line" above). Then, per slice, after 3A/3B, print the verdicts:
```
GATE codex-review: <approve|approve-with-override|needs-attention(r<n>)|skipped(size)> — <summary>
GATE codex-pwtest: <pass|fail> — <summary>
```
And fold both into the global-gate line in `build-loop.md` Phase 4 (`codexReview:<approved>/<total> codexPwTest:<passed>/<total>`).
