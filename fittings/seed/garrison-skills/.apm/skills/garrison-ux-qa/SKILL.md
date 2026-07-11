---
name: garrison-ux-qa
description: The UX QA gate - walks the ACTUAL RUNNING UI and judges its user experience and interface quality (navigation clarity, feedback and affordances, consistency, error and empty states, responsive and mobile usability, accessibility basics) against a fixed six-section checklist, taking desktop (1440x900) and mobile (390x844) screenshots as durable evidence. It measures contrast mechanically (4.5:1 / 3:1) and tap targets against a 24px floor / 44px comfort target. It is NOT a functional correctness test (use garrison-test / garrison-adversarial-test) and NOT a code review (use garrison-review / garrison-adversarial-review) - it never opens the diff to hunt bugs; it drives the app as a user would. In a garrison build, findings at or above the policy severity threshold send the slice back to garrison-implement; standalone, report the verdict and findings. Use for "ux qa", "review the UX/UI of this", "is this usable", "walk the UI", or as the ux-qa gate of a build. Skip for non-UI changes.
---

# garrison-ux-qa

The user-experience and interface-quality gate. It does not read the diff to
find bugs and it does not judge code - it opens the app the change produced and
walks it the way a first-time user would, scoring what it sees against a fixed
rubric. Correctness is owned by `garrison-test` / `garrison-adversarial-test`;
code quality by `garrison-review` / `garrison-adversarial-review`; this gate
owns whether the thing is clear, consistent, responsive, and usable.

## Policy-read preamble (soft - D5/D12)

At the start of every invocation, look for the compiled Orchestrator policy at
`~/.garrison/orchestrator/policy.json` (or `$GARRISON_POLICY_PATH`).

- **Policy present** (a Garrison run): it is the single authority. This skill
  carries NO model/effort pins - its execution parameters come from the policy
  matrix cell for its phase (`matrix["ux-qa"][<tier>]`), and its gate duties from
  the bindable phase-skill contract (the Orchestrator fitting's
  PHASE_SKILL_CONTRACT.md): do the phase's work in the run context handed to you
  (runDir, card, phase), write the phase's gate-status entry under the runDir,
  and print the phase's `GATE ux-qa:` line before choosing the next list. Read
  `policy.uxQa.severityThreshold` for the loop-back threshold (below).
- **Policy absent** (standalone, any repo): proceed with the caller-supplied
  context and sensible defaults - NEVER stop. Default the severity threshold to
  `major`. Report the verdict + findings to the caller rather than writing
  gate-status/run artifacts, and skip any board/run-engine steps.

## When it runs - kind-conditional

Runs for **`kind: ui | mixed` slices ONLY.** An **`api`** slice has no UI surface
to walk, so it **skips** the gate - but never silently: record
`uxQa: {"verdict":"skipped","reason":"kind-conditional"}` in the slice
gate-status, an explicit skip an auditor can see, not an absent gate. For `ui` /
`mixed` slices the full mechanics below apply.

## What it runs

Drive the running app (launch it via the project's run/verify convention) and
walk each primary task and each screen the change touches. Take **playwright**
screenshots at **two viewports** and keep them as durable evidence:

- **Desktop** - 1440x900.
- **Mobile** - 390x844.

Do not judge from the code or from memory - judge from the pixels you captured.
Two measurements are mechanical, not subjective, and must be taken with tools
rather than eyeballed:

- **Contrast** - measure the ratio of text/UI foreground against its actual
  background; a pass is 4.5:1 for normal text, 3:1 for large text (>=24px, or
  >=18.66px bold) and for UI component/graphic boundaries.
- **Tap targets** - measure interactive target sizes in CSS px; the floor is
  24x24 (WCAG 2.2 AA), with 44px the mobile comfort target.

## The checklist (embed - evaluate every item verbatim)

Evaluate the running UI against every item below. Each item carries its severity
in brackets; that severity is what the loop-back threshold is compared against.

### 1. Navigation clarity
- For each primary task, walk it step by step; at every step confirm the next control is visible without scrolling-hunting or guessing. Flag any step where the action is not discoverable. [major]
- Confirm current location is indicated (active nav item, breadcrumb, or title matching the route). Flag if the user cannot tell where they are. [major]
- Confirm every navigation label predicts its destination; flag labels that require clicking to understand. [minor]
- Confirm a back/exit/cancel path exists from every non-home screen and modal. Flag dead ends. [major]

### 2. Feedback & affordances
- After each action that takes >1s (submit, load, save), confirm a loading/progress indicator appears; flag silent waits. [major]
- Confirm clickable elements look clickable (cursor, color, or affordance distinct from static text) and hover/focus states exist. [minor]
- Confirm success/completion of an action is confirmed visibly (toast, state change, redirect). Flag actions with no acknowledgement. [major]
- Confirm destructive or irreversible actions ask for confirmation or offer undo. Flag one-click irreversible actions. [major]

### 3. Consistency
- Confirm the same concept uses one term everywhere (no synonyms for the same object across screens). Flag term drift. [minor]
- Confirm primary buttons, spacing, and iconography are visually consistent across screens; flag one-off styling. [minor]
- Confirm identical actions sit in consistent locations (e.g. primary CTA position, nav order). Flag reshuffled layouts. [minor]
- Confirm the UI follows platform conventions (links, form controls, modals behave as users expect). Flag surprising behavior. [minor]

### 4. Error & empty states
- Trigger a validation error (bad input) and confirm the message is visible, in plain language, names what went wrong, and says how to fix it. Flag jargon/codes or blame. [major]
- Confirm errors are shown inline next to the offending field, not only in a generic banner. [major]
- Load a screen with no data and confirm it shows a heading, an explanation of what belongs there, and a clear next-step CTA - not a blank area or bare "no data". [major]
- Confirm error text does not rely on color alone (icon or text label also present). [minor]

### 5. Responsive & mobile usability
- Resize viewport to 375px wide; confirm no horizontal scroll and no content clipped or overlapping. [blocker]
- Confirm page declares width=device-width viewport meta; flag if a desktop layout is scaled down. [major]
- Confirm body text renders >=16px on mobile and text-input font-size >=16px (prevents iOS zoom). [major]
- At 375px, confirm primary actions sit within thumb reach (lower two-thirds) and are not crowded at screen edges (>=16px lateral padding). [minor]
- Confirm layout adapts (stacks/reflows) at common breakpoints (768px, 1024px) rather than truncating. [major]

### 6. Accessibility basics
- Measure contrast of body text against its background; flag below 4.5:1 (below 3:1 for large text >=24px or >=18.66px bold). [major]
- Measure contrast of UI component boundaries, icons, and focus indicators; flag below 3:1. [minor]
- Measure interactive target sizes; flag any below 24x24 CSS px (blocker on touch surfaces below ~44px comfort target). [major]
- Confirm every form control has an associated, visible label (not placeholder-only). [major]
- Tab through the page; confirm focus is always visible and order is logical. Flag focus traps or invisible focus. [major]
- Confirm every meaningful image/icon has alt text or an accessible name; flag empty/missing alt on informative images. [minor]

## Findings report + durable evidence

Write, under `<runDir>/slices/<slice>/ux-qa/`:

- `screenshots/` - the desktop + mobile captures (one per screen/state walked),
  named so a reviewer can tell what each shows.
- `findings.md` - one entry per finding, each carrying:
  - `id` - stable within the slice (e.g. `uxqa-1`).
  - `section` - one of the six section names above.
  - `severity` - `blocker | major | minor | note`.
  - `screenshot` - the path to the capture that shows it.
  - `what + where` - what is wrong and the exact screen/control it is on.
  - `fix` - a concrete, actionable fix (not "improve the UX").

A checklist item that passes is not a finding. A `note` is a real-but-below-bar
observation, recorded so it is never silent - not padding.

## Severity threshold + loop-back (A8)

Severity order, high to low: **blocker > major > minor > note**. The loop-back
threshold is `policy.uxQa.severityThreshold` (default **`major`**).

- A finding whose severity is **at or above** the threshold is **blocking**: it
  loops the slice back to `garrison-implement` exactly like a review finding
  (consumes the slice's retry ceiling); re-walk after the fix.
- A finding **below** the threshold is recorded as a **note** - visible in the
  report and the gate slot, never silent, but it does **not** block. A slice
  whose only findings are below threshold is **clean-with-notes** and advances.

This is the exact rule `garrison-validate` re-checks: for a `ui` slice the gate
passes when there is no blocking finding (verdict `clean`, or verdict `issues`
with every finding below threshold), and fails when any finding is at or above
threshold.

## Gate slot + gate line

Upsert the `uxQa` slot into the slice's `gate-status.json` under the runDir:

```jsonc
"uxQa": {
  "verdict": "issues",                 // clean (no findings) | issues (>=1 finding) | skipped
  "severityThreshold": "major",        // the threshold this run applied
  "findings": [
    {
      "id": "uxqa-1",
      "section": "Responsive & mobile usability",
      "severity": "blocker",
      "screenshot": "ux-qa/screenshots/checkout-mobile.png",
      "what": "horizontal scroll at 375px; the total overflows the viewport",
      "where": "/checkout on mobile",
      "fix": "wrap the summary row in a flex container with min-width:0 so the price can shrink"
    }
  ],
  "at": "<iso>"
}
```

- `verdict` is `clean` when the walk produced no findings, `issues` when it
  produced one or more (of any severity), `skipped` for a kind-conditional skip.
- Blocking is decided by comparing each finding's severity to the threshold, NOT
  by the verdict - a verdict of `issues` with only below-threshold notes still
  passes the gate (clean-with-notes).

Print exactly one line in the lead context when the phase concludes:

`GATE ux-qa: <clean|issues(n)> - <one-line summary>`

where `n` is the finding count. Example: `GATE ux-qa: issues(2) - 1 blocker
(mobile overflow), 1 note (button term drift)`.

## Loop role + output

- **In a garrison build:** write the gate slot + evidence, print the `GATE
  ux-qa:` line. A blocking finding sends the slice back to `garrison-implement`
  (garrison owns the retry ceiling); below-threshold notes advance the slice.
- **Standalone:** report the verdict + findings (with concrete fixes) and the
  screenshot paths; do not auto-fix unless asked.

Distinct from `garrison-review` / `garrison-adversarial-review` (code review),
`garrison-test` / `garrison-adversarial-test` (functional correctness), and
`garrison-security-review` (the opt-in security phase). No emoji; plain dashes.
