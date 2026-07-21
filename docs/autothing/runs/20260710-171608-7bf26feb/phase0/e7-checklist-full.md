E7 done. Adopted sources + consolidated agent-executable checklist below (77 lines, no emoji).

FINDING-E7: Jakob Nielsen's 10 Usability Heuristics (NN/g) — https://www.nngroup.com/articles/ten-usability-heuristics/ : the canonical rules of thumb (system status, real-world match, user control, consistency, error prevention, recognition-over-recall, flexibility, minimalist design, error recovery, help) that seed the navigation/feedback/consistency sections.
FINDING-E7: Cognitive Walkthroughs (NN/g) — https://www.nngroup.com/articles/cognitive-walkthroughs/ : the four per-step questions (right goal? action noticed? action associated with outcome? progress visible after?) that turn each task into a pass/fail learnability check an agent can run step-by-step.
FINDING-E7: Error-Message Guidelines (NN/g) — https://www.nngroup.com/articles/error-message-guidelines/ : errors must be visible, plain-language, precise about what went wrong, and offer a constructive fix without blaming the user — the error-state rubric.
FINDING-E7: Designing Empty States (NN/g) — https://www.nngroup.com/articles/empty-state-interface-design/ : empty/first-use screens need a heading, an explanation of the feature's value, and one clear CTA, not generic "no data" — the empty-state rubric.
FINDING-E7: WCAG 2.1 Understanding SC 1.4.3 Contrast (Minimum) (W3C) — https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html : 4.5:1 for normal text, 3:1 for large text (>=24px, or >=18.66px bold) and UI component/graphic boundaries — the contrast thresholds.
FINDING-E7: Contrast and Color Accessibility (WebAIM) — https://webaim.org/articles/contrast/ : practical algorithm and pass/fail treatment of the ratios above for mechanical checking.
FINDING-E7: WCAG 2.2 SC 2.5.8 Target Size (Minimum) + Apple HIG / Material — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html : tap targets >=24x24 CSS px (WCAG 2.2 AA floor), with 44pt (Apple HIG) / 48dp (Material) as the mobile comfort target.

## Garrison UX QA Checklist

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
- Load a screen with no data and confirm it shows a heading, an explanation of what belongs there, and a clear next-step CTA — not a blank area or bare "no data". [major]
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
