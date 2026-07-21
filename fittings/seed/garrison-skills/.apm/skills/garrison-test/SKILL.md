---
name: garrison-test
description: Write a COMMITTED, re-runnable correctness test for the current change and run it, plus clean build/typecheck/lint — the objective correctness gate. The default is end-to-end THROUGH THE UI (Playwright / playwright-cli) plus unit tests; a CLI/TUI deliverable uses a committed driver + asciinema capture. In a garrison build a failure sends the slice back to garrison-implement (garrison owns the retry ceiling); standalone it just reports the findings. Use for "write and run tests for this change", "add a committed e2e test", or as the test gate of a build. NOT a one-off manual run (use /run or /verify) and NOT the independent fresh-context test pass (use garrison-adversarial-test).
---

# garrison-test

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


The objective correctness gate — write a COMMITTED, re-runnable test for the current change and run it, plus a clean build/typecheck/lint. A standalone test-writer/runner, and the test gate of a garrison build.

## What "test" means here (committed, not ephemeral) — prefer e2e through the UI
A test that survives the run and catches regressions. **Default to end-to-end through the UI** — most projects have a UI, and exercising a change through the real UI is the truest proof (it even covers the backend/API a flow touches):
- **Web flow** → a spec file (Playwright / vitest / jest), or a committed **playwright-cli driver** that re-drives the flow and asserts where no runner ships. Drive the real UI; ephemeral `.playwright-cli/` logs are exploration, NOT the gate.
- **CLI/TUI deliverable** → a committed driver + an asciinema capture of the real flow.

Plus unit tests where they fit. **No committed re-runnable assertion ⇒ the change is not done.**

## Run + gates
**Deterministic wall FIRST (Part 8.3 — cheapest gates before any model judgment).** Before the committed test, run the deterministic wall and capture each exit code: `typecheck`, `lint`, structural greps, and the universal **`securityWall`** — `gitleaks` (secrets) + `semgrep` (SAST) + a dependency-audit severity check (Part 12.5, installed by the foundation/preflight, zero tokens). **The floor never lowers:** the securityWall runs on EVERY slice regardless of profile or gate toggles; a non-zero exit / high-or-critical finding is a correctness failure that sends the slice back to `garrison-implement` like any other. Record `securityWall: {gitleaks, semgrep, depAudit, at, durationMs}` in the slice gate-status (schema: `~/.claude/skills/garrison/assets/gate-status.example.json`).

Then run the test and the remaining objective gates — `tests`, `e2e` (where applicable), `build` — and capture each exit code. Respect the dev-server hazard in `~/.claude/skills/garrison/references/build-loop.md` ("Gate builds must not clobber a live dev server").

**Concurrent-session typecheck flap:** if `tsc` exits non-zero on a file you did not edit (outside your slice), retry once — a concurrent session may have that file mid-edit. If the retry clears and your slice's own files typecheck clean, proceed. Only a failure on a file inside your slice is a real slice defect; cross-session noise is not.

**Size e2e waits for a LOADED machine, not an idle one:** a build run loads the machine with its own parallel work (batch e2e, concurrent builds, other sessions), so waits tuned on an isolated run flake in the batch (a 30 s login wait that passes alone times out under load). Write committed specs with generous waits for boot/login-class steps (60-90 s). When a batch failure is a pure timeout, re-run that spec once in isolation: if it passes alone, fix the spec's waits (the committed spec must pass IN the batch) rather than treating it as a slice defect.

## Loop role + output
- **In a garrison build:** any non-zero gate or failing assertion **sends the slice back to `garrison-implement`** to fix (garrison owns the retry ceiling, default 5); re-run after each fix. Record the gate exits in the slice gate-status.
- **Standalone:** write + run the test and **report the findings** (pass/fail + exit codes + what failed); do not loop to fix unless asked.

Print in the lead context, both lines: `GATE security: <clean|issues> — gitleaks:<exit> semgrep:<findings> depAudit:<high>/<critical> <summary>` (the deterministic security wall) and `GATE test: <pass|fail> — tests:<exit> typecheck:<exit> lint:<exit> build:<exit> <summary>`. Distinct from `garrison-adversarial-test` (this session's committed test vs. a FRESH-CONTEXT Anthropic session's own independent probes) and from `garrison-codex-checkpoint` (the genuine cross-model check, now run once in the final phase, not per slice).
