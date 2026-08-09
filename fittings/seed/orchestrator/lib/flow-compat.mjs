// flow-compat.mjs — mjs mirror of `src/lib/flow-compat.ts`.
//
// THE compatibility layer for the 2026-08-09 `workKind` -> `flow` rename
// (ORCHESTRATOR_COHERENCE.md, Phase 1), for the fitting side of the fence.
// Fittings cannot import from `src/`, so this is a deliberate mirror rather than a
// shared import; `tests/flow-compat-lockstep.test.ts` asserts the two agree on
// behaviour and on the retired-key map, so they can never drift apart silently.
//
// Contract: read either spelling, write only the new one. Shallow and key-exact —
// a deep or regex rewrite would also corrupt user prose (flow descriptions, card
// titles, decision reasons).
//
// See the ts original for why this is load-bearing (three separate live policy
// files, plus cards and decisions.jsonl).

/** Retired key -> current key. Kept identical to the ts original by the lockstep test. */
export const RETIRED_FLOW_KEYS = Object.freeze({
  workKinds: "flows",
  defaultWorkKind: "defaultFlow",
  workKind: "flow"
});

/**
 * Normalise a parsed JSON object that may predate the rename.
 * Returns the input unchanged (same reference) when there is nothing to adopt.
 */
export function adoptFlowKeys(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  let out = null;
  for (const [retired, current] of Object.entries(RETIRED_FLOW_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(input, retired)) continue;
    if (!out) out = { ...input };
    // The new key wins when both are present: nothing writes the retired key any
    // more, so its presence alongside the current key means it is stale.
    if (out[current] === undefined || out[current] === null) out[current] = input[retired];
    delete out[retired];
  }
  return out ?? input;
}

/** True when a parsed object still carries any retired spelling. */
export function hasRetiredFlowKeys(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  return Object.keys(RETIRED_FLOW_KEYS).some((k) => Object.prototype.hasOwnProperty.call(input, k));
}
