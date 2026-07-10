# The bindable phase-skill contract

A **phase skill** is any Claude Code skill that can execute one pipeline phase
of an autonomous Garrison run (plan, implement, review, adversarial-review,
test, adversarial-test, security-review, ux-qa, walkthrough, validate,
codex-checkpoint, report — the policy's `phases` list). The Orchestrator's phase-skill registry
(`phaseSkills.bindings`, per-work-kind `phaseSkills.overrides`) binds each
phase to the skill that executes it. Swapping a binding in the composer view
requires **zero code changes** — any skill honoring this contract can be
slotted in. The direction is fixed: **Garrison calls skills, never the
reverse.**

## What a bindable skill MUST do

1. **Read the compiled policy first.** At the start of every invocation, read
   `~/.garrison/orchestrator/policy.json`. When present, the policy is the
   sole authority: the skill's model/effort/runtime for the phase come from
   the policy matrix cell `matrix[<phase>][<tier>]` — a skill never carries
   `model:` frontmatter and never picks its own model while a policy governs.
   When the policy is missing or unreadable, a VERB skill proceeds standalone
   with the caller-supplied context and conservative defaults — it never
   stops (GARRISON-FLOW-V2 D12). Only the DOORWAY skill retains the hard
   no-standalone gate ("Start Garrison; the doorway does not run standalone"),
   because registering a card requires the board and engine to exist.

2. **Consume the run context it is handed.** The engine (or doorway) invokes
   the skill with: `runDir` (the run's evidence directory under
   `~/.garrison/runs/<project>/<runId>/`), the `card` (id, title, brief,
   project, tier, work kind, per-card phase toggles), and the `phase` it is
   executing. The skill does its phase's work scoped to that context.

3. **Write its phase's gate-status entry.** On completion (pass OR fail), the
   skill upserts its phase's slot in
   `<runDir>/slices/<slice>/gate-status.json` (or the run-level gate record
   for run-scoped phases) with at minimum: `{status, at, summary}` plus the
   phase-appropriate evidence fields (exit codes, verdicts, artifact paths).
   Durable evidence is what allows list transitions — a phase without its
   gate-status entry parks the card in needs-attention.

4. **Print its gate line.** In the session transcript, print exactly one
   `GATE <phase>: <verdict> — <summary>` line when the phase concludes. The
   goal loop and the run engine both read the transcript; a phase that never
   prints its line is a silent gate disappearance.

## What a bindable skill MUST NOT do

- Choose its own model, effort, or runtime (the policy cell owns that).
- Call other runtimes directly (`codex exec`, `gemini` CLI) — cross-model work
  goes through the runtime fitting's `delegate` bridge only.
- Advance the card/list itself — the run engine owns progression; the skill
  owns its phase's work + evidence.
- Fake a pass. A phase that is off is recorded off; a failing phase is
  recorded failing.

## Seed bindings

The verb skills are the seed bindings (`autothing-plan`,
`autothing-implement`, `autothing-review`, `autothing-adversarial-review`,
`autothing-test`, `autothing-adversarial-test`, `autothing-security-review`,
`garrison-ux-qa`, `autothing-walkthrough`, `autothing-validate`,
`autothing-codex-checkpoint`, `autothing-report`). Any work kind may
override any binding (e.g. a docs review bound to a different review skill
than a feature review).
