// State matcher ladder (R11/C6/Q7): a deterministic assertion passing IS a
// match. Fingerprint pre-filters only. Two states clearing the bar, or none,
// escalates to vision — never guesses. A vision confirmation writes back a
// deterministic assertion (handled by the caller, mirroring graduation).
//
// Pure decision logic — the caller gathers `deterministicResults` (running
// each state's matcher.assertion against the live/candidate page) and
// `candidateParts` (the observe() parts) and hands them in.

import { fingerprintPreFilterMatch } from "./state-fingerprint.mjs";

// deterministicResults: Map<stateId, boolean> — only states whose matcher
// has an assertion AND was actually checked should have an entry.
export function matchByAssertion(states, deterministicResults) {
  const passing = states.filter((s) => deterministicResults?.get(s.id) === true);
  if (passing.length === 1) return { matched: passing[0].id, via: "assertion" };
  return null; // 0 or >=2 passing (ambiguous or none) -> fall through
}

export function matchByFingerprint(states, candidateParts) {
  const clearing = states.filter((s) => s.fingerprint && fingerprintPreFilterMatch(candidateParts, s.fingerprint));
  if (clearing.length === 1) return { matched: clearing[0].id, via: "fingerprint" };
  return null; // ambiguous (0 or >=2) -> escalate to vision
}

// Full ladder. Returns { matched: <stateId>, via: "assertion"|"fingerprint" }
// or { matched: null, via: "vision" } when the caller must escalate.
export function matchState(states, { deterministicResults, candidateParts } = {}) {
  const byAssertion = matchByAssertion(states, deterministicResults);
  if (byAssertion) return byAssertion;
  const byFingerprint = matchByFingerprint(states, candidateParts);
  if (byFingerprint) return byFingerprint;
  return { matched: null, via: "vision" };
}
