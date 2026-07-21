---
name: garrison-security-review
description: OPT-IN per-slice security review - a single consolidated checklist applying the security-boundary rubric (authorization, injection, secret handling, tenant/org scoping, boundary input validation), deciding whether the slice warrants a cross-model per-slice Codex pass, and checking the security-critical surfaces the run brief named. It runs only when the project is security-sensitive or the work kind explicitly opts in, and in a garrison build real findings send the slice back to garrison-implement. NOT the universal deterministic secrets/SAST wall (use garrison-test's securityWall, always on), NOT the fresh-context correctness review (use garrison-adversarial-review), and NOT the run-level cross-model checkpoint (use garrison-codex-checkpoint). Invoked by the Garrison run engine as its security-review step, or standalone only when the user explicitly asks for it. Do NOT auto-invoke this skill from task inference - Garrison decides when its phase skills run.
---

# garrison-security-review

The opt-in security phase. Garrison's generic flow keeps exactly one piece of
security scrutiny always ambient - the deterministic `securityWall`
(gitleaks + semgrep + dependency-audit) in `garrison-test`, run on every slice
regardless of profile. Everything deeper - the security-boundary review
rubric, the conditional per-slice cross-model Codex pass, and the
security-critical surface list - lives HERE, and runs only when a run opts in.
Most projects are not security-sensitive; for them this phase never runs, and
that is the intended default.

## Policy-read preamble (soft - D5/D12)

At the start of every invocation, look for the compiled Orchestrator policy at
`~/.garrison/orchestrator/policy.json` (or `$GARRISON_POLICY_PATH`).

- **Policy present** (a Garrison run): it is the single authority. This skill
  carries NO model/effort pins - its execution parameters come from the policy
  matrix cell for its phase (`matrix["security-review"][<tier>]`), and its gate
  duties from the bindable phase-skill contract (the Orchestrator fitting's
  PHASE_SKILL_CONTRACT.md): do the phase's work in the run context handed to you
  (runDir, card, phase), write the phase's gate-status entry under the runDir,
  and print the phase's `GATE security-review:` line before choosing the next
  list.
- **Policy absent** (standalone, any repo): proceed with the caller-supplied
  context and sensible defaults - NEVER stop. Report the verdict to the caller
  rather than writing gate-status/run artifacts.

## When this phase runs (opt-in only)

This phase is NOT in any default phase plan or work kind. It runs only when the
run has opted in, in one of two ways:

1. **Project-level.** `projects.<label>.security_sensitive === true` in the
   compiled policy for the card's project. A security-sensitive project gets
   this phase on every slice.
2. **Work-kind / card-level.** The work kind's phase plan (or a per-card phase
   toggle) explicitly includes `security-review`.

Absent both, the phase is off, recorded off, and never fired on a
"security-boundary looks likely" heuristic. The classifier never adds a
security phase on its own (see the Orchestrator prompt's build doctrine).

## The consolidated security checklist

When the phase runs on a slice, apply the checks below against the slice diff
(`git --no-pager diff <BASE>...HEAD` + uncommitted). Gather evidence - cite a
file:line for every finding; "this looks risky" without a located call site is
not a finding.

### 1. Security-boundary rubric

For any touched auth / crypto / egress / parsing / path-containment code, check:

- **authorization on every touched path** - no route, handler, or branch is
  reachable without the check it should carry;
- **injection surfaces** - every interpolation into SQL, shell, HTML, a
  template, or a filesystem path is parameterized or escaped;
- **secret handling** - no secret is logged, echoed, committed, or returned to
  a caller that should not see it;
- **tenant/org scoping** - every query and mutation is constrained to the
  caller's tenant/org;
- **input validation at the boundary** - untrusted input is validated and
  normalised before it crosses inward.

### 2. Per-slice cross-model Codex pass (conditional)

Decide whether this slice warrants a cross-model Codex adversarial pass
(`codexSliceReview`). Within an opted-in run, run it when the slice's diff
touches the security-boundary code above; skip it (recorded) otherwise. One
SERIAL Codex delegation, diff-scoped narrow rubric ("find violations of these
invariants"), verdict recorded as `codexSliceReview: {verdict, by, actualModel,
durationMs}`. A quota/auth/availability failure records
`{status:"degraded", reason:"codex-unavailable"}`, is notified, and CONTINUES -
never blocks, never fakes a verdict. All Codex calls serialize run-wide with the
final-phase `garrison-codex-checkpoint`. Auth via API key (not ChatGPT
sign-in) with a budget cap. Full Codex mechanics:
`garrison-codex-checkpoint/references/codex-checkpoint.md`.

### 3. Security-critical surfaces

Confirm the security-critical surfaces the slice touches hold their invariants.
The always-applicable surface is whole-repo security (authz/tenant-isolation
bypass, cross-tenant/cross-user data leakage, injection paths, secrets logged or
committed); auth/session middleware is a surface wherever the repo has it. Any
project-specific surface is one the run brief or the project's security profile
names - for example a shared contract package between services, or an
anonymisation/egress pipeline. These project-specific surfaces are illustrative
optional scopes, not defaults every repo carries; a named surface whose files
do not exist is recorded `skipped (reason: not-applicable)`.

## Verdict + durable record

- **`clean`** - no material, evidence-backed finding survives.
- **`needs-work`** - at least one material finding, each citing a file:line or a
  violated invariant. **Sends the slice back to `garrison-implement`**
  (consumes the slice's existing retry ceiling); re-review after the fix.

Write the phase's slot into the slice's `gate-status.json` under the runDir:

```jsonc
"securityReview": {
  "verdict": "clean",              // clean | needs-work | skipped
  "boundaryRubric": "clean",       // clean | issues
  "codexSliceReview": { "verdict": "approve", "by": "gpt-5.5", "at": "<iso>" },
  "surfaces": [ { "surface": "whole-repo-security", "verdict": "clean" } ],
  "at": "<iso>",
  "findings": []                   // each cites a file:line + the violated invariant
}
```

A phase that is off for this run records
`securityReview: {status:"skipped", reason:"not-security-sensitive"}` - visible,
never a silent pass.

## Loop role + output

- **In a garrison build:** report findings; real findings send the slice back
  to `garrison-implement` (garrison owns the retry ceiling). Print exactly one
  `GATE security-review: <clean|needs-work|skipped> — <summary>` line in the lead
  context.
- **Standalone:** report the verdict + findings and stop - do not auto-fix
  unless asked.

Distinct from the always-on `securityWall` (deterministic secrets/SAST floor in
`garrison-test`), the fresh-context correctness review
(`garrison-adversarial-review`), and the run-level cross-model checkpoint
(`garrison-codex-checkpoint`).
