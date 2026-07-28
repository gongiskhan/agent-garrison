---
name: garrison-codex-checkpoint
description: Targeted cross-model security checkpoint - a small number of high-effort OpenAI Codex passes through the codex-runtime delegate bridge (D14; never a direct CLI call, the runtime fitting owns serialization) over the security-critical surfaces of the whole repo (authz/tenant/injection/secrets by default, auth middleware and session handling where present, plus any surface the run brief names), each scoped to a narrow invariant rubric rather than an open-ended review. Real findings loop the affected scope back to garrison-implement as an ad-hoc fix. This is the run-level whole-repo cross-model gate, not the per-slice pass (that is the opt-in garrison-security-review phase) and not a general-purpose code review (Codex here only hunts the named invariants). Invoked by the Garrison run engine as its cross-model security checkpoint step, or standalone only when the user explicitly asks for it. Do NOT auto-invoke this skill from task inference - Garrison decides when its phase skills run.
---

# garrison-codex-checkpoint

## Policy-read preamble (soft - D5/D12)

At the start of every invocation, look for the compiled Orchestrator policy at
`~/.garrison/orchestrator/policy.json` (or `$GARRISON_POLICY_PATH`).

- **Policy present** (a Garrison run): it is the single authority. This skill
  carries NO model/effort pins - its execution parameters come from the policy
  matrix cell for its phase (`matrix[<phase>][<tier>]`), and its gate duties
  from the bindable phase-skill contract (the Orchestrator fitting's
  PHASE_SKILL_CONTRACT.md): do the phase's work in the run context handed to you
  (runDir, card, phase), write the phase's gate-status entry under the runDir,
  and print the phase's `GATE <phase>: <verdict>` line before choosing the next
  list.
- **Policy absent** (standalone, any repo): proceed with the caller-supplied
  context and sensible defaults - NEVER stop. Report to the caller rather than
  writing gate-status/run artifacts, and skip any board/run-engine steps.

## What this does

ONE run-level cross-model pass, executed as a few narrowly-scoped Codex
delegations over the security-critical surfaces. The always-applicable default
is whole-repo security (authz/tenant/injection/secrets); auth middleware +
session handling is a default wherever the repo has it. Any project-specific
surface is a brief-supplied optional scope, not a default every repo has - for
example a shared contract package between services, or an anonymisation/egress
pipeline (these are illustrative, added only when the run brief or the
project's security profile names such a surface). Each scope is a "find
violations of these invariants" rubric, never an open-ended review.

## Mechanics (D14 — the delegate bridge is the ONLY path)

1. Resolve the target from the policy: `matrix["codex-checkpoint"][<tier>]`
   gives `{runtime: "codex", model, effort}`. If the resolved runtime is not
   `codex`, run the checkpoint on the resolved target instead (the policy is
   the authority).
2. Locate the codex-runtime bridge: the composition's
   `apm_modules/_local/codex-runtime/scripts/bridge.mjs` (fallback: the repo
   seed `fittings/seed/codex-runtime/scripts/bridge.mjs`). If the bridge is
   absent or `--probe` fails, that is a BLOCKER with a named cause
   ("codex-runtime bridge not connected") — record the checkpoint
   `degraded (codex-unavailable)`, notify, and continue. NEVER fall back to a
   direct `codex` CLI invocation.
3. For each scope, build a task spec and pipe it via STDIN (never argv):

   ```bash
   printf '%s' "$TASK_SPEC_JSON" | node <bridge>/scripts/bridge.mjs delegate
   ```

   Task spec shape: `{"task": "<the scope rubric + the invariants + the file
   list>", "paths": [...], "model": "<policy model>", "constraints":
   {"readOnly": true}, "expectedSchema": "checkpoint"}` (see
   assets/codex-checkpoint.schema.json). The bridge serializes calls
   RUN-WIDE itself (the fitting owns the OAuth constraint) — do not add
   caller-side serialization and do not parallelize scopes.
4. Parse the returned `{summary, artifacts}`; triage findings exactly as
   before: a real, agreed violation is fixed and the affected scope
   re-checked (ceiling: 2 rechecks per scope); rebut non-material findings
   with one line.
5. Record `codexCheckpoint: {status, scopes, at}` in the run's
   `evidence-index.json` globalGate and print
   `GATE codex-checkpoint: <clean|issues-fixed|issues-open|degraded|skipped> — <summary>`.

## Honesty

A quota/auth/availability failure records `degraded (codex-unavailable)` and
the run continues — never blocked on a dead meter, never a faked verdict. An
operator `--no-codex` records `skipped (operator-disabled)`.
