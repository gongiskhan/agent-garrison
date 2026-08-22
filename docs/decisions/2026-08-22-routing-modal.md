# Routing modal — the Turn Rail's pin surface becomes a dialog

**Date:** 2026-08-22
**Status:** In progress.

## Problem

The Turn Rail's inline expanding pin row breaks the composer layout (pickers
overlap the transcript, the row wraps badly on narrow widths), exposes stale
naming ("target" chips beside "codex-checkpoint L1" rows), hides `level`
entirely, and cannot express two things the run-spec system has grown:
tier-decided execution, and phase overrides beyond "turn a plan phase off".

## Decision

1. **One modal, vocabulary unchanged where it is right.** A `RoutingModal` in
   `@garrison/claude-chat` replaces the inline popovers for PINNING; the rail
   keeps rendering badges (what ran / what is pinned) and now opens the modal.
   Sections, in meaning order, each with real descriptions from the policy:
   duty (+ its levels with per-level descriptions), tier (tierDefinitions),
   execution (runtime → target → model → effort; disabled with an explanatory
   note while a tier is pinned — the tier decides execution), account,
   project (sticky), flow (auto = router derives it from the routed duty; a pin
   overrides), phases (the resolved plan's phases as toggles, plus the rest of
   the policy's phase catalog as addable).
2. **`phasesOn` joins the pin contract.** `phasesOff` (CSV) already rides
   every surface; `phasesOn` mirrors it: validated against the SAME global
   phase catalog, merged into the SAME `{phase: on}` toggle map the card
   stores, honored by `railForCard` as a union into the plan
   (`on: (planOn || toggledOn) && !toggledOff`). Lockstep files: web-channel
   threads.mjs ROUTING_FIELDS, gateway pin sanitizer + hint assembly, kanban
   CARD_ROUTING_FIELDS + railForCard, claude-chat TurnRouting/PinField.
3. **Options get their descriptions server-side.** `buildRouteOptions` now
   also serves `tierDefinitions` and the ordered `phaseCatalog`; the flow
   options' `levels`/`defaultLevel` (already served) are declared in
   RailOptions. No client-side copies of policy vocabulary.
4. **Runtime is a grouping, not a new pin.** The modal presents targets
   grouped by runtime (the users' mental model); choosing one pins `target`
   (+ optional free-text `model`). The pin contract keeps target/model —
   runtime stays a resolved-only fact.
5. **Project is sticky.** The web channel remembers the last explicit project
   pin (localStorage) and applies it to newly created threads, personal
   included; clearing the pin clears the memory.

## Notes

- Duty vs flow, as of the 2026-08-13 coherence work: the router derives the
  flow FROM the routed duty and the flow's level defines the plan; a flow pin
  overrides the derivation. The modal words the automatic rows exactly so.
- `csg-work` (remote-shell) was added to the compiled policy via
  /api/orchestrator/policy — targets live in `.garrison/routing.json`, NOT in
  apm.yml's vestigial `x-garrison.targets` list. The router reads the policy
  at spawn; a target edit needs an operative bounce to serve.
