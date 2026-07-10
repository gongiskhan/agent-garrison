---
name: autothing-review
description: Code-review the current change or diff for correctness bugs and quality cleanups (reuse, simplification, efficiency) using Claude Code's built-in review mechanism (the code-review skill). A standalone same-model review; the per-slice review gate is now autothing-adversarial-review (Part 8.1 merged this same-model pass into the fresh-context review). Standalone it just reports the findings. Use for "review this code", "review my diff/PR", "code review before shipping". NOT the fresh-context decorrelated review (use autothing-adversarial-review) and NOT a test runner (use autothing-test).
---

# autothing-review

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


Same-model (Claude) code review of the current change. A standalone code reviewer.

> **No longer a per-slice pipeline gate (Part 8.1).** The per-slice review merged into the fresh-context **`autothing-adversarial-review`** — once the deterministic wall (build/typecheck/lint/tests) plus the fresh-context and Codex passes existed, this same-model review's unique catches were ~zero, so it was retired from the build loop. It is retained here as a fully-functional **standalone** code-review skill (Claude's built-in `code-review`): use it directly — `/code-review before shipping`, a second look at a diff or PR — whenever you want Claude's own same-context review.

## What it runs
Invoke the built-in **`code-review`** skill on the current diff — it reviews for correctness bugs first, then reuse/simplification/efficiency cleanups, at the session effort. (`--comment` posts inline PR comments; `--fix` applies findings — use only when asked.)

If `code-review` is unavailable, run the equivalent yourself: read the diff (`git --no-pager diff <base>...HEAD` + uncommitted), and report **correctness bugs first**, then quality cleanups, each with `file:line` and a concrete fix. That is what the built-in does.

## Scope
- **In an autothing build:** review the SLICE diff only — capture `BASE=$(git rev-parse HEAD)` before the slice, review `git diff $BASE...HEAD` + uncommitted.
- **Standalone:** review the diff/PR/range the user names (default: uncommitted + last commit).

## Loop role + output
- **In an autothing build:** report findings; **real correctness findings send the slice back to `autothing-implement`** to fix (autothing owns the retry ceiling). Cheap quality nits are applied; larger ones are logged. Re-review after a fix.
- **Standalone:** report the findings and stop — do not auto-fix unless asked.

Print one line in the lead context: `GATE review: <clean|findings(n)> — <summary>`. In a build, fold the result into the slice gate-status. Distinct from `autothing-adversarial-review` (this same session's built-in review vs. a FRESH-CONTEXT Anthropic reviewer with no access to this session's rationale) and from `autothing-codex-checkpoint` (the genuine cross-model check, now run once in the final phase, not per slice).
