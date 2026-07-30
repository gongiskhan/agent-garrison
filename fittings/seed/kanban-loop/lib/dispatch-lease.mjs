// Dispatch claim lease — shared by the board engine and the host dispatch API.
//
// A card claimed by a remote worker is held by HEARTBEAT, not by a local pid.
// The board's other liveness checks (runOwner + isPidAlive, run age) are all
// single-machine and actively wrong here: a pid from another host either does
// not exist locally or, worse, matches an unrelated local process.
//
// DRIFT WARNING: DISPATCH_LEASE_SECONDS is duplicated from
// src/lib/dispatch.ts because a Fitting cannot import the app's TypeScript.
// tests/dispatch-lease-parity.test.ts pins the two against each other — if you
// change one, that test fails until you change the other.

export const DISPATCH_LEASE_SECONDS = 180;

// Terminal claim states. A finished claim is not "silent", it is done, and must
// never be reclaimed or counted as live.
const TERMINAL_STATES = new Set(["done", "failed"]);

export function dispatchClaimOf(card) {
  const d = card && typeof card.dispatch === "object" ? card.dispatch : null;
  if (!d || typeof d.machine !== "string" || typeof d.state !== "string") return null;
  return d;
}

// Is a remote worker still demonstrably alive on this card?
export function isDispatchClaimLive(card, { at = Date.now(), leaseSeconds = DISPATCH_LEASE_SECONDS } = {}) {
  const claim = dispatchClaimOf(card);
  if (!claim) return false;
  if (TERMINAL_STATES.has(claim.state)) return false;
  const beat = Date.parse(claim.heartbeatAt || claim.claimedAt || "");
  // A claim with no parsable timestamp is NOT live. Treating it as live would
  // let one malformed record pin a card forever.
  if (!Number.isFinite(beat)) return false;
  return at - beat <= leaseSeconds * 1000;
}

// Has a non-terminal claim gone quiet past its lease? (The complement of
// isDispatchClaimLive, restricted to cards that actually carry a claim.)
export function isDispatchClaimExpired(card, { at = Date.now(), leaseSeconds = DISPATCH_LEASE_SECONDS } = {}) {
  const claim = dispatchClaimOf(card);
  if (!claim) return false;
  if (TERMINAL_STATES.has(claim.state)) return false;
  return !isDispatchClaimLive(card, { at, leaseSeconds });
}
