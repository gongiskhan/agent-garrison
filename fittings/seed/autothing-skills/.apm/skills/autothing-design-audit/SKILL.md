---
name: autothing-design-audit
model: fable
effort: xhigh
description: Subjective design and UX audit of the current UI change — judge the running app against the project's design tokens and conventions for visual hierarchy, spacing, consistency, responsiveness, and polish, using the design skills (frontend-design, huashu-design). In an autothing build, real issues send the slice back to autothing-implement to fix; standalone, report the verdict and issues. Use for "design audit", "review the UI/UX of this", "is this polished enough", or as the design gate of a build. Skip for non-UI changes. NOT a correctness test (use autothing-test) and NOT a code review (use autothing-review).
---

# autothing-design-audit

The subjective design/UX gate — judges the running UI against the project's design tokens + conventions. The design gate of an autothing build, and a standalone UI/UX auditor. **Skip entirely for non-UI changes.**

## When it runs — kind-conditional
Runs for **`kind: ui | mixed` slices ONLY.** An **`api`** slice has no UI surface to judge, so it **skips** the audit — but never silently: record `designAudit: {"status":"skipped","reason":"kind-conditional"}` in the slice gate-status, an explicit skip an auditor can see, not an absent gate. For `ui` / `mixed` slices the full subjective-design/UX mechanics below apply.

## What it runs
Drive the running app (`/run` + `/verify` + playwright-cli for screenshots) and audit the change using the design skills:
- **`frontend-design`** / **`huashu-design`** — apply their rubric: visual hierarchy, spacing/rhythm, type scale, color/contrast, consistency with existing components, responsive behavior, empty/loading/error states, motion, and overall polish.
- Compare against the project's **design tokens + existing screens**; flag regressions and off-system choices, each with a concrete fix.

## Scope
- **In an autothing build:** audit the SLICE's screens against its acceptance + the project design tokens.
- **Standalone:** audit the screen / flow / change the user names.

## Loop role + output
- **In an autothing build:** record `designAudit: {verdict, by, at, issues}` in the slice gate-status. **Real issues send the slice back to `autothing-implement`** to fix (consumes the slice retry ceiling); re-audit after a fix. `clean` advances the slice.
- **Standalone:** report the verdict + issues (with concrete fixes); do not auto-fix unless asked.

Print in the lead context: `GATE design: <clean|issues(n)> — <summary>`. Distinct from `autothing-review` (code review) and `autothing-test` (correctness).
