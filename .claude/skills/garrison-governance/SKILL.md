---
name: garrison-governance
description: Enforce Agent Garrison's definition of done and write the durable gate markers for a slice — docs/autothing/slices/<slice>/gate-status.json and the docs/autothing/evidence-index.json upsert — then decide slice/global advance. Use after a slice's gates have run, and at the global gate. Do NOT use to run tests (that is garrison-testing) or judge visuals (that is garrison-design-audit).
---

# garrison-governance

Verbs: gate, record, advance. Nouns: `docs/GOVERNANCE.md` (the Honesty Test, verify-or-don't-ship) and the autothing gate schemas.

## Definition of done for a slice (ALL required)
tests=0 · typecheck=0 · lint=0 · build=0 · e2e=0 · design audit verdict `clean` · a `verified` walkthrough video · gate-status.json written · evidence-index.json upserted · FLOW_PLAN status updated.

## Markers — two traces each, always
- **File:** `docs/autothing/slices/<slice>/gate-status.json` (schema: autothing `assets/gate-status.example.json`) + upsert into `docs/autothing/evidence-index.json`.
- **Transcript:** print each gate's `GATE <name>: exit <code> — <summary>`, and at the very end the single `GLOBAL GATE:` line (the /goal evaluator reads only the transcript).

## Honesty (docs/GOVERNANCE.md §3)
Never fake a gate. A failing slice is recorded failing and flagged, never edited to look passed. A walkthrough STUCK → `video.status: failed-but-unblocking` + blocker in `docs/decisions.md` + continue (never wait for input). Global `passed` ONLY when every slice is `passed` with a `verified` video; otherwise `completed-with-blockers`.
