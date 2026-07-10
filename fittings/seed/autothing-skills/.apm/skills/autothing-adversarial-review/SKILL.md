---
name: autothing-adversarial-review
model: fable
effort: xhigh
description: Decorrelated fresh-context code review — a FRESH-CONTEXT Anthropic session (no access to the implementer's notes, exploration, or rationale) reviews the current diff against ONLY the slice's acceptance criteria and the spec/plan sections it cites, gathers its own evidence (runs build/typecheck/lint/tests itself rather than trusting reported exit codes), and returns a structured approve/needs-work verdict. In an autothing build, real findings go back to autothing-implement; standalone, report the verdict and findings. Use for "review this fresh", "decorrelated review", "second opinion on this change", or as the fresh-context review gate of a build. NOT Claude's own same-context review (use autothing-review) and NOT the cross-model Codex checkpoint (use autothing-codex-checkpoint).
---

# autothing-adversarial-review

Decorrelated adversarial review — decorrelation comes from **fresh context**, not a different vendor. A reviewer that has never seen the implementer's session, notes, or rationale re-derives whether the change is correct from the acceptance criteria, the spec, and the diff alone, and backs every finding with evidence it gathered itself. The single per-slice review gate of an autothing build, and a standalone second-opinion reviewer.

> **The one per-slice review (Part 8.1).** The same-model `autothing-review` and this fresh-context review collapsed into a single per-slice review — this one. Once the deterministic wall (build/typecheck/lint/tests) plus the fresh-context and Codex passes existed, the same-model pass's unique catches were ~zero, so it was retired from the pipeline (it survives standalone). Every slice's review is therefore this one: **fresh-context** (no implementer notes, rationale, or exploration), **Fable-pinned** (`model: fable`), and **evidence-mandatory** (the reviewer runs the objective checks itself and never trusts a reported exit code).

## Why fresh context, not cross-vendor
The old per-slice gate ran a genuinely different vendor (OpenAI Codex), but at a low/cheap effort scoped to a single diff it mostly re-derived opinions Claude already had — documented weak-model churn (`~/.claude/skills/autothing/references/decisions.md`). **Decorrelation comes from what the reviewer is allowed to see, not which company trained it**: a session with a genuinely fresh context window — no implementer notes, no "why I did it this way" — catches a different class of bug (an implicit shared assumption between the code and its own author) than a second vendor at low effort ever did. Cross-vendor checking still has real value, so it is kept — repositioned to **`autothing-codex-checkpoint`**, a small number of high-effort, narrowly-scoped checks over security-critical surfaces, run once in the final phase rather than as a per-slice rubber stamp.

## What the fresh-context reviewer receives — and must NOT receive
- **Receives ONLY:** the slice's acceptance criteria (from FLOW_PLAN), the spec/plan sections the acceptance cites, and the diff (`git --no-pager diff <BASE>...HEAD` + uncommitted).
- **Must NOT receive:** the implementer's session transcript, its exploration notes, its self-check note, or any "here's why I did it this way" rationale. When autothing spawns this as a subagent/workflow, build the spawn prompt from ONLY the acceptance + spec + diff — never paste anything from the implementer's context. This is the entire mechanism of decorrelation; skipping it collapses the gate back into a same-context echo of `autothing-review`.

## It gathers its OWN evidence — opinions are not findings
An assertion with no evidence behind it is not a finding. Before writing any verdict:
1. Read the diff and the acceptance/spec sections it needs.
2. **Run the objective checks itself** — build, typecheck, lint, and the slice's own committed test suite (`autothing-test`'s tests) — rather than trusting the implementer's self-reported exit codes. A decorrelated gate re-derives the evidence, it does not inherit it.
3. For each concern, either (a) cite the exact spec/acceptance section it violates, or (b) attach the failing command + its output. A concern with neither is dropped before it reaches the verdict — "this looks off" is not admissible.

## Security-boundary rubric (Part 12.7)
When the diff touches **security-boundary code** — auth, crypto, egress, parsing, path containment — the review's rubric EXPLICITLY includes, alongside correctness:
- **authorization on every touched path** — no route, handler, or branch reachable without the check it should carry;
- **injection surfaces** — every interpolation into SQL, shell, HTML, a template, or a filesystem path;
- **secret handling** — no secret logged, echoed, committed, or returned to a caller that should not see it;
- **tenant/org scoping** — every query and mutation constrained to the caller's tenant/org;
- **input validation at the boundary** — untrusted input validated and normalised before it crosses inward.

A security-boundary diff gets this review **regardless of run profile** — a thinned/patch profile that would otherwise trim gates does not skip it.

## Verdict
- **`approve`** — no material, evidence-backed finding survives.
- **`needs-work`** — at least one material finding, each backed by a spec citation or failing evidence. **Sends the slice back to `autothing-implement`** (consumes the slice's 5-attempt retry ceiling); re-review after the fix.

There is no separate round budget or size-based skip here (that machinery existed to bound a cheap, low-effort external model's churn). This gate runs at a fixed high effort on every slice; the outer loop is exactly the slice's existing implement → review → re-review cycle, bounded by the same 5-attempt ceiling as every other gate.

## Scope
- **In an autothing build:** review the SLICE diff only — capture `BASE=$(git rev-parse HEAD)` before the slice, review `git diff $BASE...HEAD` + uncommitted.
- **Standalone:** review the diff/PR/range the user names (default: uncommitted + last commit).

## Loop role + output
- **In an autothing build:** report findings; **real findings send the slice back to `autothing-implement`** to fix (autothing owns the retry ceiling). Re-review after a fix.
- **Standalone:** report the verdict + findings and stop — do not auto-fix unless asked.

Print in the lead context: `GATE adversarial-review: <approve|needs-work> — <summary>`. Distinct from `autothing-review` (Claude's own same-context review) and `autothing-codex-checkpoint` (the cross-model, final-phase check).

## Durable record (gate-status.json — schema: `~/.claude/skills/autothing/assets/gate-status.example.json`)
```jsonc
"adversarialReview": {
  "verdict": "approve",           // approve | needs-work
  "by": "claude-fable-5",         // the fresh-context model actually used
  "evidence": ["npm test: 12 passed", "npm run typecheck: 0 errors"],
  "at": "<iso>",
  "findings": []                  // each cites a spec/acceptance section or attaches a failing command+output
}
```
