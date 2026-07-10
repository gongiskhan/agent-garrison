---
name: autothing-validate
description: Validate a slice's Definition of Done from its durable gate markers and decide Done vs Implement — read the gate-status.json under a passed-in runDir + sliceId, check every DoD gate (tests/typecheck/lint/build/e2e exit 0, design audit clean for UI, fresh-context review approve, independent test pass, and a VERIFIED walkthrough video), write the durable `validated` gate record, and end with a parseable Done|Implement last line. Use for "validate the Definition of Done", "check the gate markers and decide Done or Implement", "write the durable gate record for this slice", or as the engine of the Kanban Validate list. NOT a test runner (that is autothing-test) and NOT a code review (that is autothing-review).
---

# autothing-validate

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


Standalone Definition-of-Done validator for ONE slice. Reads the slice's durable
gate markers, checks the DoD (including a verified walkthrough video), writes a
durable `validated` record, and ends with a parseable `Done` | `Implement` verdict.
This is the engine of the Kanban **Validate** list — its verdict is the single
next-list name the router-prompt turns into the card's move (`Done` when the DoD
holds, `Implement` when it fails).

It is **standalone-runnable** from a normal session: it never runs gates, never
drives the app, never calls another model — it only reads markers that earlier
steps already wrote and renders a deterministic verdict.

## What it reads
- `<runDir>/slices/<sliceId>/gate-status.json` — the authoritative per-slice marker
  (schema: `~/.claude/skills/autothing/assets/gate-status.example.json`).
- `<runDir>/evidence-index.json` — read for context if present; non-fatal when absent.

## The DoD it checks (from `gate-status.gates`)
- `tests.exit === 0`, `typecheck.exit === 0`, `lint.exit === 0`, `build.exit === 0`,
  `e2e.exit === 0` — all required.
- `designAudit.verdict === "clean"` — required ONLY when `kind === "ui"`.
- `adversarialReview.verdict === "approve"` — the fresh-context Anthropic review
  (`autothing-adversarial-review`; renamed from `codexReview` — this gate is no
  longer a Codex call, see decisions.md). This is a per-slice DoD check only; the
  run-level cross-model Codex checkpoint (`autothing-codex-checkpoint`) lives in
  `evidence-index.json`'s `globalGate.codexCheckpoint` and is out of scope for a
  single slice's DoD.
- `adversarialTest.result === "pass"` — the independent Anthropic test pass
  (`autothing-adversarial-test`; renamed from `codexPwTest`) — required for
  `ui`/`mixed`; `n/a` tolerated (no running app to drive), and n/a for a pure-CLI
  slice.
- `video.status === "verified"` — REQUIRED. A `failed-but-unblocking` or missing
  video FAILS the DoD (matches the global gate's "every slice video verified").

Missing `gate-status.json` → verdict `Implement` with the reason printed. Missing
optional fields are handled per the rules above.

## The durable marker it writes
It adds a `validated` object to `gate-status.json` —
`{ status: "Done" | "Implement", at: <iso>, failed: [<reasons>] }` — via a
read-fresh → mutate → write-whole-document atomic pattern (temp file + rename),
so other fields are never clobbered.

## Output contract
Prints one human-readable line per check (`VALIDATE check tests: ok`,
`VALIDATE check video: FAIL — status="failed-but-unblocking" (need verified)`, …),
then a `VALIDATE verdict:` summary, and the **FINAL non-empty stdout line is EXACTLY
`Done` or `Implement`** — nothing after it. The Kanban engine parses that last line.

## Invocation
```bash
node ~/.claude/skills/autothing-validate/scripts/validate.mjs <runDir> <sliceId>
# flags also accepted: --run-dir <runDir> --slice <sliceId>
# --strict additionally exits non-zero on a Fail (for standalone CLI use)
```
Exit code is 0 by default (the verdict is the last stdout line, not the exit code);
`--strict` makes a failing DoD exit non-zero.

## Loop role
- **In the Kanban pipeline:** this is the **Validate → autothing-validate** list. Its
  `Done`|`Implement` last line is the next-list name — `Done` advances the card,
  `Implement` sends it back to be built again (the per-card iteration cap is the
  guard; this skill does NOT replicate the autothing goal loop).
- **Standalone:** report the verdict and the failed reasons; do not run or fix gates.
