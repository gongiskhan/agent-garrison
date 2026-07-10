---
name: autothing-adversarial-test
description: Independent functional test — a FRESH-CONTEXT Anthropic session that has seen neither the diff nor autothing-test's committed spec drives the running app/feature through ONLY the slice's acceptance criteria, writing and executing its OWN Playwright probes, and returns pass/fail with a reproducible probe. In an autothing build a failure sends the slice back to autothing-implement; standalone, report what it observed. Use for "independent test this", "fresh-context functional test", "second test pass", or as the independent test gate of a build. NOT Claude's own committed test (use autothing-test) and NOT the cross-model Codex checkpoint (use autothing-codex-checkpoint).
---

# autothing-adversarial-test

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


Independent functional test — decorrelated by **context and evidence**, not vendor. A session that has seen neither the diff nor `autothing-test`'s committed spec drives the *running* app through the acceptance itself, so it catches "the code and its test share the same wrong assumption" — the same failure mode the old cross-model Playwright pass targeted, without needing a second vendor to get it.

## When it runs — kind-conditional (Part 8.2)
- **`kind: ui` | `kind: mixed`** — runs **per-slice**, exactly as below.
- **`kind: api`** — does NOT run per-slice; it runs instead as ONE BATCHED, run-level pass over the API surface (a fresh-context session drives the assembled API through the acceptance of the api slices together, once). The per-slice slot is recorded `{"status":"skipped","reason":"kind-conditional"}` so the slice's gate stays explicit rather than silently empty.

The fresh-context / no-diff / no-committed-test / self-written-Playwright-probe mechanics below are unchanged in both modes — the batched api pass is the same independent test, run once over the API surface instead of once per slice.

## What it receives — and must NOT receive
- **Receives ONLY:** the slice's acceptance criteria and the running app's URL/entry point.
- **Must NOT receive:** the diff, `autothing-test`'s committed spec/assertions, or the implementer's notes. When spawned as a subagent/workflow, build its prompt from ONLY the acceptance + app URL — never paste the diff or the committed test file into it.

## What it does
1. Open the running app at the acceptance's entry point.
2. Write its OWN Playwright probes (via `playwright-cli`, or a throwaway spec) that exercise the acceptance from scratch — it does not read or adapt `autothing-test`'s spec.
3. Execute them; watch for console errors.
4. Return `pass` only if every self-written assertion held with no console error.

## Findings must be reproducible — never an impression
A `fail` verdict must carry either a failing probe (the exact Playwright script/commands that produced the failure) or the exact command sequence + observed output. "It felt broken" is not a finding.

## Loop role + output
- **In an autothing build:** `fail` with a real defect **sends the slice back to `autothing-implement`** (consumes the slice retry ceiling); re-run after each fix. A flaky/env failure (not a product defect) is re-run, not counted as a fix-attempt.
- **Standalone:** run the pass and report `pass|fail` + the reproducible probe.

Print in the lead context: `GATE adversarial-test: <pass|fail> — <summary>`. Distinct from `autothing-test` (Claude's own committed test) and `autothing-codex-checkpoint` (the cross-model, final-phase check).

## Durable record (gate-status.json — schema: `~/.claude/skills/autothing/assets/gate-status.example.json`)
```jsonc
"adversarialTest": {
  "result": "pass",              // pass | fail
  "by": "claude-sonnet-5",       // the fresh-context model actually used
  "probe": "<runDir>/slices/<slice>/adversarial-test-<slice>.spec.ts",  // the self-written, reproducible probe
  "at": "<iso>"
}
```
For a `kind: api` slice the per-slice slot is instead `"adversarialTest": {"status":"skipped","reason":"kind-conditional"}`; the batched run-level pass records its own `pass|fail` at the run level.
