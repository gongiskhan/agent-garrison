---
name: garrison-planning
description: Break the config-plane goal into slices and keep docs/FLOW_PLAN.md current — id, title, kind, route, parallel group, acceptance, status — sequencing and marking parallel groups by disjoint file ownership. Use when (re)planning or resuming the build. Do NOT use to implement code (the other area skills) or to gate (garrison-governance).
---

# garrison-planning

Verbs: slice, sequence, mark parallel groups. Noun: `docs/FLOW_PLAN.md`.

Rules: a slice owns a disjoint file set or it is serial; record the parallel-vs-serial reason per group. Resume reads `docs/FLOW_PLAN.md` + each `gate-status.json` first, never memory. The authoritative plan of record is `~/.claude/plans/brief-garrison-zippy-sparrow.md`, mirrored into FLOW_PLAN's slice table.
