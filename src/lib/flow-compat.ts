// flow-compat.ts — THE compatibility layer for the 2026-08-09 `workKind` -> `flow`
// rename (ORCHESTRATOR_COHERENCE.md, Phase 1).
//
// Everything outside this module speaks `flow` / `flows` / `defaultFlow`. That is
// enforced, not merely intended: `scripts/check-flow-rename.mjs` fails if a retired
// spelling appears anywhere but here and its mjs mirror.
//
// This exists because the rename lands on live persisted data in at least five
// places, none of which this run can rewrite in place safely:
//
//   1. each composition's `.garrison/routing.json`  (the source of truth)
//   2. its derived `.garrison/policy.json`          (recompiled on every write)
//   3. `$GARRISON_HOME/orchestrator/policy.json`    (the COMPILED policy the
//      Kanban Loop reads — a THIRD file, and at the time of the rename both the
//      prod and dev copies still carried `workKinds`)
//   4. card.json records on the board
//   5. decisions.jsonl records (2.1 MB of them on the live prod composition)
//
// Contract: **read either spelling, write only the new one.** A document that
// somehow carries both is resolved in favour of the new key, because the new key is
// the only one anything writes — an old key sitting beside it is stale by
// construction.
//
// The mjs mirror is `fittings/seed/orchestrator/lib/flow-compat.mjs`; fittings
// cannot import from `src/`, so the two are kept byte-equivalent in behaviour by
// `tests/flow-compat-lockstep.test.ts`.

/** Retired key -> current key. The single source for both the runtime shim and the
 *  repo-wide gate that forbids the retired spellings elsewhere. */
export const RETIRED_FLOW_KEYS: Readonly<Record<string, string>> = Object.freeze({
  workKinds: "flows",
  defaultWorkKind: "defaultFlow",
  workKind: "flow"
});

/**
 * Normalise a parsed JSON object that may have been written before the rename.
 *
 * Shallow and key-exact by design. A deep or regex-based rewrite would also
 * rewrite user prose (flow descriptions, card titles, decision reasons), which is
 * exactly the kind of silent data corruption a rename is supposed to avoid.
 *
 * Returns the input unchanged (same reference) when there is nothing to adopt, so
 * this is safe to call on every read without allocating.
 */
export function adoptFlowKeys<T>(input: T): T {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [retired, current] of Object.entries(RETIRED_FLOW_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(obj, retired)) continue;
    if (!out) out = { ...obj };
    // The new key wins when both are present: nothing writes the retired key any
    // more, so its presence alongside the current key means it is stale.
    if (out[current] === undefined || out[current] === null) out[current] = obj[retired];
    delete out[retired];
  }
  return (out ?? input) as T;
}

/** True when a parsed object still carries any retired spelling — used by the
 *  drift surface to report how much un-migrated data is still on disk. */
export function hasRetiredFlowKeys(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const obj = input as Record<string, unknown>;
  return Object.keys(RETIRED_FLOW_KEYS).some((k) => Object.prototype.hasOwnProperty.call(obj, k));
}
