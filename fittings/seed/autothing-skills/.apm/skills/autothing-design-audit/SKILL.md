---
name: autothing-design-audit
description: Subjective design and UX audit of the current UI change — judge the running app against the project's design tokens and conventions for visual hierarchy, spacing, consistency, responsiveness, and polish, using the design skills (frontend-design, huashu-design). In an autothing build, real issues send the slice back to autothing-implement to fix; standalone, report the verdict and issues. Use for "design audit", "review the UI/UX of this", "is this polished enough", or as the design gate of a build. Skip for non-UI changes. NOT a correctness test (use autothing-test) and NOT a code review (use autothing-review).
---

# autothing-design-audit

## Policy-read preamble (hard requirement, D5)

Before doing ANYTHING else, read the compiled Orchestrator policy at
`~/.garrison/orchestrator/policy.json` (or `$GARRISON_POLICY_PATH`). If the
file is missing or unreadable, STOP IMMEDIATELY and print exactly:

> Garrison Orchestrator policy not found at ~/.garrison/orchestrator/policy.json. Start Garrison; autothing does not run standalone.

This skill carries NO model/effort pins — its execution parameters come from
the policy matrix cell for its phase (`matrix[<phase>][<tier>]`), and its
gate duties from the bindable phase-skill contract (the Orchestrator fitting's
PHASE_SKILL_CONTRACT.md): do the phase's work in the run context handed to you
(runDir, card, phase), write the phase's gate-status entry under the runDir,
and print the phase's `GATE <phase>: <verdict>` line before choosing the next
list.


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
