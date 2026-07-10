---
name: autothing-implement
model: opus
effort: high
description: Implement an already-planned slice or a single well-scoped code change end-to-end — explore the relevant code first (vision-first for UI, reading the FLOW_PLAN acceptance and the project's area skill), then write the code to satisfy it, following existing conventions and fixing forward. This is the code-writing step of an autothing build and the step the gates (test, review, walkthrough) send work back to when they find issues. Usable standalone to implement one focused change with autothing discipline. Use for "implement this slice/change", "write the code for this planned feature", or when a gate sends a slice back to fix. NOT for planning (use autothing-plan), NOT the full multi-slice build (use autothing), and NOT bug-hunting or running/testing on their own.
---

# autothing-implement

The code-writing step of an autothing build, and a standalone implementer for one focused change. It EXPLORES first, then writes the code. It does NOT plan the slice list (that is `autothing-plan`) and does NOT run the gates (`autothing-test` / `autothing-review` / `autothing-adversarial-review` / `autothing-adversarial-test` / `autothing-walkthrough` are separate).

## Inputs
- The change to make — a FLOW_PLAN slice (id + acceptance) in an autothing build, or a described change standalone.
- The project's routing index + the relevant **area skill** — load it; this skill does not inherit the lead's context.

## Workflow
1. **Explore first (read-only).** Understand the code the change touches. For UI, be **vision-first** — drive the running app with `/run` + `/verify` + playwright-cli to see the real current behavior before changing it. Read the area skill, the acceptance, and the critical files `autothing-plan` flagged.
2. **Implement.** Write the code to satisfy the acceptance, following existing conventions and the area skill. Fix forward. Keep the change scoped to the slice; do not silently expand it.
3. **Self-check + note.** Confirm it builds/loads enough to hand to the gates, and leave a one-line note of what changed (the review/test gates and the durable record consume it).

## Escalate, never squeeze
If implementing DISCOVERS the work is larger than the run's profile (`patch | feature | build`) assumed, or touches security-boundary code (auth, crypto, egress, parsing, path containment) the sizing missed, ESCALATE the profile mid-run (patch → feature → build), log a `DECISION` to RUN_LOG.md (timestamped with `date -u +%Y-%m-%dT%H:%M:%SZ`, the only timestamp source), and signal that the turn cap must be re-derived and the slices re-planned if needed. Big work never ships through a small pipeline because of an initial label.

## Loop role
- **In an autothing build:** this is the step the gates return to. When `autothing-test`, `autothing-review`, `autothing-adversarial-review`, or `autothing-adversarial-test` report real findings, autothing re-invokes THIS skill to fix them (bounded by the slice retry ceiling, default 5). Address the specific findings; do not re-architect.
- **Findings become guards (the determinism ratchet).** Every ACCEPTED finding ships WITH a deterministic guard in the SAME fix wherever the bug class is mechanically expressible — a lint rule, a Semgrep pattern, a grep gate, or a test — so that class is machine-caught forever and reviews stop re-finding it. The fix commit references the guard; the gate entry records finding → guard. Over a project's life reviews trend toward judgment-only — that is the goal.
- **Standalone:** implement the requested change and stop; the user runs whatever gate they want next.

## Discipline
- Explore before editing; never edit blind.
- Stay within the slice's file-ownership boundary when run in a parallel batch.
- Honest: if the change cannot be completed, say what is blocking — never fake it.
- Boundary code — parser, validator, tokenizer, path-containment, any security boundary — ships WITH property-based tests (fast-check), not only example tests: the bypass families an adversarial review finds by hand (encoding tricks, normalization gaps, boundary straddles) are exactly what property testing catches for free.
- Verify every NEW package BEFORE install — it exists on the registry, is actively maintained, and is the intended package (not a typo/slopsquat neighbor); note the check in the slice's gate entry. Agent-written code makes hallucinated dependencies an attack surface — one lookup per new dependency closes it.
- Does NOT write the committed test (`autothing-test`) or record gate-status (autothing's build loop does).
