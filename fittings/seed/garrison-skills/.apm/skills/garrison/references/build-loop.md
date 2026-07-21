# build-loop — superseded pointer (GARRISON-UNIFY-V1 D13)

The per-slice gated loop this file used to describe is now owned by:

- **The run engine** (`fittings/seed/kanban-loop/lib/engine.mjs`) — phase
  progression as list transitions, durable gate-evidence enforcement (D9),
  rails with per-card phase toggles (D17), the in-process
  `advanceCardPhase` entry the doorway drives.
- **The merged Orchestrator prompt** (`fittings/seed/orchestrator/.apm/
  prompts/orchestrator.prompt.md`) — the build doctrine: the phase pipeline,
  the 5-attempt ceiling, fix-forward, no voluntary deferral, self-unblock,
  the honesty rules, the durable-markers contract.
- **The compiled policy** (`~/.garrison/orchestrator/policy.json`) — which
  skill/model/effort/runtime executes each phase.

The doorway's mechanical entry steps live in `../SKILL.md`. Cross-model calls
go through the codex-runtime delegate bridge only (D14).
