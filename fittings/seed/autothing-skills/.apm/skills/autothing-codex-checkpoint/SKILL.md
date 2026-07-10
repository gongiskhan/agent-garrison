---
name: autothing-codex-checkpoint
description: Targeted CROSS-MODEL security checkpoint — a small number of high-effort OpenAI Codex passes THROUGH THE codex-runtime DELEGATE BRIDGE (D14 — never a direct CLI call; the runtime fitting owns serialization) over the security-critical surfaces of the whole repo (authz/tenant/injection, the shared/ contract, the anonymisation/egress pipeline, auth middleware + session handling), each scoped to a narrow invariant rubric, not an open-ended review. Invoked ONCE by autothing's final phase (default ON); real findings loop the affected scope back to autothing-implement as an ad-hoc fix. Standalone, run it against any repo and report the verdict per scope. Use for "run the codex checkpoint", "final security pass with Codex", "cross-model check before shipping", or as the run-level cross-model gate of a build. NOT the per-slice gate (the conditional per-slice cross-model pass is codexSliceReview in the build loop — build/boundary-feature only; this checkpoint is the run-level whole-repo pass, unchanged) and NOT a general-purpose code review (Codex here only hunts the named invariants, never free-ranges).
---

# autothing-codex-checkpoint

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

## What this does

ONE run-level cross-model pass, executed as a few narrowly-scoped Codex
delegations over the security-critical surfaces (whole-repo security, the
shared/ contract, anonymisation/egress, auth middleware + session handling,
plus anything the brief named). Each scope is a "find violations of these
invariants" rubric, never an open-ended review.

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
